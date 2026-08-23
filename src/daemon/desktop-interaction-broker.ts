import { createHash } from "node:crypto";
import {
  ApprovalManager,
  type ApprovalNotice,
  type ApprovalNotifier,
} from "../approval/manager.js";
import {
  AskUserHandler,
  type AskUserAnswer,
  type AskUserHandlerEvent,
  type AskUserRequestId,
} from "../tools/ask-user.js";
import type {
  DesktopInteractionRecord,
  DesktopInteractionResolution,
  DesktopInteractionStore,
} from "./desktop-interaction-store.js";

export type DesktopInteractionEvent =
  | {
      readonly kind: "approval.pending";
      readonly resourceVersion: number;
      readonly at: number;
      readonly notice: ApprovalNotice;
    }
  | {
      readonly kind: "approval.settled";
      readonly resourceVersion: number;
      readonly at: number;
      readonly taskId: string;
      readonly decision: "approve" | "approve-session" | "reject";
    }
  | {
      readonly kind: "prompt.pending";
      readonly resourceVersion: number;
      readonly at: number;
      readonly request: Extract<AskUserHandlerEvent, { kind: "pending" }>["request"];
    }
  | {
      readonly kind: "prompt.settled";
      readonly resourceVersion: number;
      readonly at: number;
      readonly requestId: AskUserRequestId;
      readonly outcome: Extract<AskUserHandlerEvent, { kind: "settled" }>["outcome"];
    };

type DesktopInteractionInput = DesktopInteractionEvent extends infer Event
  ? Event extends DesktopInteractionEvent
    ? Omit<Event, "resourceVersion" | "at">
    : never
  : never;

export interface DesktopInteractionBrokerOptions {
  readonly approvalManager?: ApprovalManager;
  readonly askUserHandler?: AskUserHandler;
  readonly store?: DesktopInteractionStore | undefined;
  readonly ownerKey?: string | undefined;
  readonly approvalTtlMs?: number | undefined;
  readonly now?: () => number;
  readonly onPersistenceError?: ((error: unknown) => void) | undefined;
  readonly onListenerError?: ((error: unknown) => void) | undefined;
}

export interface DesktopInteractionResolutionResult {
  readonly accepted: boolean;
  readonly alreadyResolved: boolean;
  readonly version?: number | undefined;
}

export class DesktopInteractionVersionConflictError extends Error {
  readonly code = "version_conflict" as const;

  constructor(
    readonly interactionId: string,
    readonly expectedVersion: number,
    readonly currentVersion: number | undefined,
  ) {
    super(
      `Interaction ${interactionId} version conflict: expected ${expectedVersion}, current ${String(currentVersion ?? "missing")}`,
    );
    this.name = "DesktopInteractionVersionConflictError";
  }
}

const DEFAULT_APPROVAL_TTL_MS = 30 * 60 * 1_000;

/**
 * Bridges the existing fail-closed interaction primitives to desktop event streams.
 * The renderer never owns approval or AskUser truth; it can only submit decisions
 * against IDs that are currently pending in this broker.
 */
export class DesktopInteractionBroker {
  readonly approvalManager: ApprovalManager;
  readonly askUserHandler: AskUserHandler;
  private readonly listeners = new Set<(event: DesktopInteractionEvent) => void>();
  private readonly pendingApprovals = new Map<string, ApprovalNotice>();
  private readonly interactionRecords = new Map<string, DesktopInteractionRecord>();
  private readonly approvalExpiryTimers = new Map<string, NodeJS.Timeout>();
  private readonly promptResolutionIntents = new Map<string, DesktopInteractionResolution>();
  private readonly promptAnswerFingerprints = new Map<string, ReadonlySet<string>>();
  private readonly now: () => number;
  private readonly store: DesktopInteractionStore | undefined;
  private readonly ownerKey: string;
  private readonly approvalTtlMs: number;
  private readonly onPersistenceError: ((error: unknown) => void) | undefined;
  private readonly onListenerError: ((error: unknown) => void) | undefined;
  private resourceVersion = 0;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private persistenceError: unknown;
  private closing = false;
  private closed = false;
  private ready: boolean;
  private recoveryPromise: Promise<readonly DesktopInteractionRecord[]> | undefined;
  private resolutionQueue: Promise<void> = Promise.resolve();

  constructor(options: DesktopInteractionBrokerOptions = {}) {
    this.approvalManager = options.approvalManager ?? new ApprovalManager();
    this.askUserHandler = options.askUserHandler ?? new AskUserHandler();
    this.now = options.now ?? Date.now;
    this.store = options.store;
    this.ownerKey = boundedOwnerKey(options.ownerKey ?? "desktop");
    this.approvalTtlMs = positiveInteger(
      options.approvalTtlMs ?? DEFAULT_APPROVAL_TTL_MS,
      "approvalTtlMs",
    );
    this.onPersistenceError = options.onPersistenceError;
    this.onListenerError = options.onListenerError;
    this.ready = this.store === undefined;
    this.askUserHandler.subscribe((event) => this.onAskUserEvent(event));
  }

  readonly notifyApproval: ApprovalNotifier = (notice) => {
    // Plan proposals are durable Runtime projections. The broker may derive a live card,
    // but must never become their owner or erase them when the proposing Run ends.
    if (this.closed || !this.ready) {
      this.approvalManager.cancelApproval(
        notice.taskId,
        this.closed ? "桌面交互宿主已关闭。" : "桌面交互宿主尚未完成恢复。",
      );
      return;
    }
    const planApproval = isPlanApprovalNotice(notice);
    if (!planApproval) {
      this.pendingApprovals.set(notice.taskId, notice);
      this.scheduleApprovalExpiry(notice.taskId);
    }
    if (!planApproval) {
      const version = this.nextVersion();
      const at = this.now();
      if (
        !this.recordPending(
          {
            kind: "approval",
            interactionId: notice.taskId,
            metadata: { toolName: notice.toolName, providerCallId: notice.providerCallId },
          },
          version,
          at,
        )
      ) {
        this.pendingApprovals.delete(notice.taskId);
        this.clearApprovalExpiry(notice.taskId);
        this.approvalManager.cancelApproval(notice.taskId, "重复的桌面交互 ID 已被拒绝。");
        return;
      }
      this.publish({ kind: "approval.pending", notice }, version, at);
    } else {
      this.emit({ kind: "approval.pending", notice });
    }
  };

  async recover(): Promise<readonly DesktopInteractionRecord[]> {
    if (!this.store) return this.listInteractionRecords();
    if (this.ready) return this.listInteractionRecords();
    if (this.recoveryPromise) return this.recoveryPromise;
    if (this.pendingApprovals.size > 0 || this.askUserHandler.pendingCount > 0) {
      throw new Error("Desktop interaction recovery must finish before accepting live requests");
    }
    this.recoveryPromise = (async () => {
      const records = await this.store?.interruptPending(this.ownerKey, this.now());
      this.interactionRecords.clear();
      for (const record of records ?? []) {
        this.interactionRecords.set(interactionRecordKey(record), record);
      }
      this.resourceVersion = (records ?? []).reduce(
        (maximum, record) => Math.max(maximum, record.version),
        0,
      );
      this.persistenceError = undefined;
      this.ready = true;
      return this.listInteractionRecords();
    })();
    try {
      return await this.recoveryPromise;
    } finally {
      this.recoveryPromise = undefined;
    }
  }

  subscribe(listener: (event: DesktopInteractionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listPendingApprovals(): readonly ApprovalNotice[] {
    this.sweepExpiredApprovals();
    return [...this.pendingApprovals.values()];
  }

  listInteractionRecords(): readonly DesktopInteractionRecord[] {
    return [...this.interactionRecords.values()].toSorted(
      (left, right) => left.version - right.version,
    );
  }

  resolveApproval(input: {
    readonly taskId: string;
    readonly decision: "approve" | "approve-session" | "reject";
    readonly reason?: string;
    readonly expectedVersion?: number | undefined;
  }): boolean {
    if (this.store) {
      const current = this.interactionRecords.get(interactionKey("approval", input.taskId));
      const resolution: DesktopInteractionResolution = {
        kind: "approval",
        decision: input.decision,
      };
      if (sameResolution(current, resolution)) return true;
      this.assertExpectedVersion(input.taskId, input.expectedVersion, current?.version);
      if (current?.status === "resolved") {
        throw new DesktopInteractionVersionConflictError(
          input.taskId,
          input.expectedVersion ?? current.version,
          current.version,
        );
      }
      return false;
    }
    return this.resolveApprovalInternal(input).accepted;
  }

  async resolveApprovalVersioned(input: {
    readonly taskId: string;
    readonly decision: "approve" | "approve-session" | "reject";
    readonly reason?: string;
    readonly expectedVersion?: number | undefined;
  }): Promise<DesktopInteractionResolutionResult> {
    return this.serializeResolution(async () => {
      await this.idle();
      return this.resolveApprovalDurably(input);
    });
  }

  private resolveApprovalInternal(input: {
    readonly taskId: string;
    readonly decision: "approve" | "approve-session" | "reject";
    readonly reason?: string;
    readonly expectedVersion?: number | undefined;
  }): DesktopInteractionResolutionResult {
    const current = this.interactionRecords.get(interactionKey("approval", input.taskId));
    const resolution: DesktopInteractionResolution = {
      kind: "approval",
      decision: input.decision,
    };
    if (sameResolution(current, resolution)) {
      return { accepted: true, alreadyResolved: true, version: current?.version };
    }
    this.assertExpectedVersion(input.taskId, input.expectedVersion, current?.version);
    if (current?.status === "resolved") {
      throw new DesktopInteractionVersionConflictError(
        input.taskId,
        input.expectedVersion ?? current.version,
        current.version,
      );
    }
    if (!this.pendingApprovals.has(input.taskId) || current?.status !== "pending") {
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }
    const reason = input.reason?.trim() || desktopDecisionReason(input.decision);
    const resolved =
      input.decision === "approve-session"
        ? this.approvalManager.resolveApprovalForSession(input.taskId, reason)
        : this.approvalManager.resolveApproval(input.taskId, input.decision === "approve", reason);
    if (!resolved) {
      this.pendingApprovals.delete(input.taskId);
      this.clearApprovalExpiry(input.taskId);
      const expired = this.transitionRecord(
        current,
        "expired",
        { kind: "system", reason: "expired" },
        this.nextVersion(),
        this.now(),
      );
      return { accepted: false, alreadyResolved: false, version: expired.version };
    }
    this.pendingApprovals.delete(input.taskId);
    this.clearApprovalExpiry(input.taskId);
    const version = this.nextVersion();
    const at = this.now();
    const settled = this.transitionRecord(current, "resolved", resolution, version, at);
    this.publish(
      { kind: "approval.settled", taskId: input.taskId, decision: input.decision },
      version,
      at,
    );
    return { accepted: true, alreadyResolved: false, version: settled.version };
  }

  private async resolveApprovalDurably(input: {
    readonly taskId: string;
    readonly decision: "approve" | "approve-session" | "reject";
    readonly reason?: string;
    readonly expectedVersion?: number | undefined;
  }): Promise<DesktopInteractionResolutionResult> {
    const current = this.interactionRecords.get(interactionKey("approval", input.taskId));
    const resolution: DesktopInteractionResolution = {
      kind: "approval",
      decision: input.decision,
    };
    if (sameResolution(current, resolution)) {
      return { accepted: true, alreadyResolved: true, version: current?.version };
    }
    this.assertExpectedVersion(input.taskId, input.expectedVersion, current?.version);
    if (current?.status === "resolved") {
      throw new DesktopInteractionVersionConflictError(
        input.taskId,
        input.expectedVersion ?? current.version,
        current.version,
      );
    }
    if (
      this.closed ||
      !this.ready ||
      !this.pendingApprovals.has(input.taskId) ||
      current?.status !== "pending" ||
      !this.approvalManager.getPendingTask(input.taskId)
    ) {
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }

    const settled = {
      ...current,
      status: "resolved" as const,
      resolution,
      version: this.nextVersion(),
      updatedAt: this.now(),
    };
    await this.persistAuthoritative(settled, current.version);
    const reason = input.reason?.trim() || desktopDecisionReason(input.decision);
    const resolved =
      input.decision === "approve-session"
        ? this.approvalManager.resolveApprovalForSession(input.taskId, reason)
        : this.approvalManager.resolveApproval(input.taskId, input.decision === "approve", reason);
    this.pendingApprovals.delete(input.taskId);
    this.clearApprovalExpiry(input.taskId);
    if (!resolved) {
      const failed = this.transitionRecord(
        settled,
        this.closing ? "interrupted" : "expired",
        this.closing
          ? { kind: "system", reason: "host_closed" }
          : { kind: "system", reason: "expired" },
        this.nextVersion(),
        this.now(),
      );
      await this.idle();
      return { accepted: false, alreadyResolved: false, version: failed.version };
    }
    this.emit({ kind: "approval.settled", taskId: input.taskId, decision: input.decision });
    return { accepted: true, alreadyResolved: false, version: settled.version };
  }

  answerPrompt(requestId: string, answer: string, expectedVersion?: number): boolean {
    if (this.store) {
      const current = this.interactionRecords.get(interactionKey("prompt", requestId));
      if (
        isPromptAnswerRetry(
          current,
          this.promptAnswerFingerprints.get(requestId),
          answerFingerprint(answer.trim()),
        )
      ) {
        return true;
      }
      this.assertExpectedVersion(requestId, expectedVersion, current?.version);
      if (current?.status === "resolved") {
        throw new DesktopInteractionVersionConflictError(
          requestId,
          expectedVersion ?? current.version,
          current.version,
        );
      }
      return false;
    }
    return this.answerPromptInternal(requestId, answer, expectedVersion).accepted;
  }

  async answerPromptVersioned(input: {
    readonly requestId: string;
    readonly answer: string;
    readonly expectedVersion?: number | undefined;
  }): Promise<DesktopInteractionResolutionResult> {
    return this.serializeResolution(async () => {
      await this.idle();
      return this.answerPromptDurably(input.requestId, input.answer, input.expectedVersion);
    });
  }

  private answerPromptInternal(
    requestId: string,
    answer: string,
    expectedVersion?: number,
  ): DesktopInteractionResolutionResult {
    const current = this.interactionRecords.get(interactionKey("prompt", requestId));
    const request = this.askUserHandler
      .getPendingRequests()
      .find((candidate) => candidate.requestId === requestId);
    if (!request) {
      const fingerprint = answerFingerprint(answer.trim());
      if (isPromptAnswerRetry(current, this.promptAnswerFingerprints.get(requestId), fingerprint)) {
        return { accepted: true, alreadyResolved: true, version: current?.version };
      }
      this.assertExpectedVersion(requestId, expectedVersion, current?.version);
      if (current?.status === "resolved") {
        throw new DesktopInteractionVersionConflictError(
          requestId,
          expectedVersion ?? current.version,
          current.version,
        );
      }
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }
    this.assertExpectedVersion(requestId, expectedVersion, current?.version);
    // 选项优先（optionId 或 label 匹配）；声明了 freeText 的请求未命中选项时
    // 按自由文本提交（3-D Phase 3——engine 侧 submitText 再校验声明与 trim）。
    const option = request.options.find(
      (candidate) => candidate.optionId === answer || candidate.label === answer,
    );
    let resolution: DesktopInteractionResolution;
    let accepted: boolean;
    if (option) {
      resolution = {
        kind: "prompt",
        outcome: "answered",
      };
      this.promptAnswerFingerprints.set(
        requestId,
        new Set([answerFingerprint(option.optionId), answerFingerprint(option.label)]),
      );
      this.promptResolutionIntents.set(requestId, resolution);
      accepted = this.askUserHandler.select(requestId as AskUserRequestId, option.optionId);
    } else if (request.freeText === true && answer.trim()) {
      resolution = {
        kind: "prompt",
        outcome: "answered",
      };
      this.promptAnswerFingerprints.set(requestId, new Set([answerFingerprint(answer.trim())]));
      this.promptResolutionIntents.set(requestId, resolution);
      accepted = this.askUserHandler.submitText(requestId as AskUserRequestId, answer);
    } else {
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }
    if (!accepted) {
      this.promptResolutionIntents.delete(requestId);
      this.promptAnswerFingerprints.delete(requestId);
    }
    const settled = this.interactionRecords.get(interactionKey("prompt", requestId));
    return {
      accepted,
      alreadyResolved: false,
      ...(settled ? { version: settled.version } : {}),
    };
  }

  private async answerPromptDurably(
    requestId: string,
    answer: string,
    expectedVersion?: number,
  ): Promise<DesktopInteractionResolutionResult> {
    const current = this.interactionRecords.get(interactionKey("prompt", requestId));
    const request = this.askUserHandler
      .getPendingRequests()
      .find((candidate) => candidate.requestId === requestId);
    if (!request) {
      const fingerprint = answerFingerprint(answer.trim());
      if (isPromptAnswerRetry(current, this.promptAnswerFingerprints.get(requestId), fingerprint)) {
        return { accepted: true, alreadyResolved: true, version: current?.version };
      }
      this.assertExpectedVersion(requestId, expectedVersion, current?.version);
      if (current?.status === "resolved") {
        throw new DesktopInteractionVersionConflictError(
          requestId,
          expectedVersion ?? current.version,
          current.version,
        );
      }
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }
    this.assertExpectedVersion(requestId, expectedVersion, current?.version);
    if (this.closed || !this.ready || current?.status !== "pending") {
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }
    const option = request.options.find(
      (candidate) => candidate.optionId === answer || candidate.label === answer,
    );
    const resolution: DesktopInteractionResolution | undefined = option
      ? {
          kind: "prompt",
          outcome: "answered",
        }
      : request.freeText === true && answer.trim()
        ? {
            kind: "prompt",
            outcome: "answered",
          }
        : undefined;
    if (!resolution) {
      return { accepted: false, alreadyResolved: false, version: current.version };
    }
    const settled = {
      ...current,
      status: "resolved" as const,
      resolution,
      version: this.nextVersion(),
      updatedAt: this.now(),
    };
    await this.persistAuthoritative(settled, current.version);
    this.promptAnswerFingerprints.set(
      requestId,
      new Set(
        option
          ? [answerFingerprint(option.optionId), answerFingerprint(option.label)]
          : [answerFingerprint(answer.trim())],
      ),
    );
    const accepted = option
      ? this.askUserHandler.select(requestId as AskUserRequestId, option.optionId)
      : this.askUserHandler.submitText(requestId as AskUserRequestId, answer);
    if (!accepted) {
      const failed = this.transitionRecord(
        settled,
        this.closing ? "interrupted" : "expired",
        this.closing
          ? { kind: "system", reason: "host_closed" }
          : { kind: "system", reason: "expired" },
        this.nextVersion(),
        this.now(),
      );
      await this.idle();
      return { accepted: false, alreadyResolved: false, version: failed.version };
    }
    this.emit({
      kind: "prompt.settled",
      requestId: requestId as AskUserRequestId,
      outcome: "answered",
    });
    return { accepted: true, alreadyResolved: false, version: settled.version };
  }

  cancelPrompt(requestId: string, reason?: string, expectedVersion?: number): boolean {
    if (this.store) {
      const current = this.interactionRecords.get(interactionKey("prompt", requestId));
      const resolution: DesktopInteractionResolution = { kind: "prompt", outcome: "cancelled" };
      if (sameResolution(current, resolution)) return true;
      this.assertExpectedVersion(requestId, expectedVersion, current?.version);
      if (current?.status === "resolved") {
        throw new DesktopInteractionVersionConflictError(
          requestId,
          expectedVersion ?? current.version,
          current.version,
        );
      }
      return false;
    }
    return this.cancelPromptInternal(requestId, reason, expectedVersion).accepted;
  }

  async cancelPromptVersioned(input: {
    readonly requestId: string;
    readonly reason?: string | undefined;
    readonly expectedVersion?: number | undefined;
  }): Promise<DesktopInteractionResolutionResult> {
    return this.serializeResolution(async () => {
      await this.idle();
      return this.cancelPromptDurably(input.requestId, input.reason, input.expectedVersion);
    });
  }

  private cancelPromptInternal(
    requestId: string,
    reason?: string,
    expectedVersion?: number,
  ): DesktopInteractionResolutionResult {
    const current = this.interactionRecords.get(interactionKey("prompt", requestId));
    const resolution: DesktopInteractionResolution = { kind: "prompt", outcome: "cancelled" };
    if (sameResolution(current, resolution)) {
      return { accepted: true, alreadyResolved: true, version: current?.version };
    }
    this.assertExpectedVersion(requestId, expectedVersion, current?.version);
    if (current?.status === "resolved") {
      throw new DesktopInteractionVersionConflictError(
        requestId,
        expectedVersion ?? current.version,
        current.version,
      );
    }
    this.promptResolutionIntents.set(requestId, resolution);
    const accepted = this.askUserHandler.cancel(
      requestId as AskUserRequestId,
      reason?.trim() || "用户在桌面端取消了问题。",
    );
    if (!accepted) this.promptResolutionIntents.delete(requestId);
    const settled = this.interactionRecords.get(interactionKey("prompt", requestId));
    return {
      accepted,
      alreadyResolved: false,
      ...(settled ? { version: settled.version } : {}),
    };
  }

  private async cancelPromptDurably(
    requestId: string,
    reason?: string,
    expectedVersion?: number,
  ): Promise<DesktopInteractionResolutionResult> {
    const current = this.interactionRecords.get(interactionKey("prompt", requestId));
    const resolution: DesktopInteractionResolution = { kind: "prompt", outcome: "cancelled" };
    if (sameResolution(current, resolution)) {
      return { accepted: true, alreadyResolved: true, version: current?.version };
    }
    this.assertExpectedVersion(requestId, expectedVersion, current?.version);
    if (current?.status === "resolved") {
      throw new DesktopInteractionVersionConflictError(
        requestId,
        expectedVersion ?? current.version,
        current.version,
      );
    }
    if (
      this.closed ||
      !this.ready ||
      current?.status !== "pending" ||
      !this.askUserHandler
        .getPendingRequests()
        .some((candidate) => candidate.requestId === requestId)
    ) {
      return { accepted: false, alreadyResolved: false, version: current?.version };
    }
    const settled = {
      ...current,
      status: "resolved" as const,
      resolution,
      version: this.nextVersion(),
      updatedAt: this.now(),
    };
    await this.persistAuthoritative(settled, current.version);
    const accepted = this.askUserHandler.cancel(
      requestId as AskUserRequestId,
      reason?.trim() || "用户在桌面端取消了问题。",
    );
    if (!accepted) {
      const failed = this.transitionRecord(
        settled,
        this.closing ? "interrupted" : "expired",
        this.closing
          ? { kind: "system", reason: "host_closed" }
          : { kind: "system", reason: "expired" },
        this.nextVersion(),
        this.now(),
      );
      await this.idle();
      return { accepted: false, alreadyResolved: false, version: failed.version };
    }
    this.emit({
      kind: "prompt.settled",
      requestId: requestId as AskUserRequestId,
      outcome: "cancelled",
    });
    return { accepted: true, alreadyResolved: false, version: settled.version };
  }

  close(): void {
    if (this.closed) return;
    this.closing = true;
    for (const taskId of [...this.pendingApprovals.keys()]) {
      this.approvalManager.cancelApproval(taskId, "桌面交互宿主已关闭。");
      const record = this.interactionRecords.get(interactionKey("approval", taskId));
      if (record?.status === "pending") {
        this.transitionRecord(
          record,
          "interrupted",
          { kind: "system", reason: "host_closed" },
          this.nextVersion(),
          this.now(),
        );
      }
      this.clearApprovalExpiry(taskId);
    }
    this.pendingApprovals.clear();
    for (const request of this.askUserHandler.getPendingRequests()) {
      this.promptResolutionIntents.set(request.requestId, {
        kind: "system",
        reason: "host_closed",
      });
    }
    this.askUserHandler.cancelAll("桌面交互宿主已关闭。");
    this.listeners.clear();
    this.closed = true;
  }

  async closeAsync(): Promise<void> {
    this.close();
    await this.idle();
  }

  async idle(): Promise<void> {
    this.sweepExpiredApprovals();
    await this.persistenceQueue;
    if (this.persistenceError !== undefined) throw this.persistenceError;
  }

  private onAskUserEvent(event: AskUserHandlerEvent): void {
    if (event.kind === "pending") {
      if (this.closed || !this.ready) {
        this.askUserHandler.cancel(
          event.request.requestId,
          this.closed ? "桌面交互宿主已关闭。" : "桌面交互宿主尚未完成恢复。",
        );
        return;
      }
      const version = this.nextVersion();
      const at = this.now();
      const recorded = this.recordPending(
        {
          kind: "prompt",
          interactionId: event.request.requestId,
          metadata: {
            optionCount: event.request.options.length,
            freeText: event.request.freeText === true,
          },
        },
        version,
        at,
      );
      if (!recorded) {
        this.askUserHandler.cancel(event.request.requestId, "重复的桌面交互 ID 已被拒绝。");
        return;
      }
      this.publish({ kind: "prompt.pending", request: event.request }, version, at);
      return;
    }
    const current = this.interactionRecords.get(interactionKey("prompt", event.request.requestId));
    if (!current || current.status !== "pending") return;
    const intent = this.promptResolutionIntents.get(event.request.requestId);
    this.promptResolutionIntents.delete(event.request.requestId);
    const transition = promptTransition(event, intent, this.closing);
    const answerFingerprints = fingerprintsForAnswer(event.answer);
    if (answerFingerprints) {
      this.promptAnswerFingerprints.set(event.request.requestId, answerFingerprints);
    }
    const version = this.nextVersion();
    const at = this.now();
    this.transitionRecord(current, transition.status, transition.resolution, version, at);
    this.publish(
      {
        kind: "prompt.settled",
        requestId: event.request.requestId,
        outcome: event.outcome,
      },
      version,
      at,
    );
  }

  private emit(event: DesktopInteractionInput): DesktopInteractionEvent {
    return this.publish(event, this.nextVersion(), this.now());
  }

  private publish(
    event: DesktopInteractionInput,
    resourceVersion: number,
    at: number,
  ): DesktopInteractionEvent {
    const envelope = {
      ...event,
      resourceVersion,
      at,
    } as DesktopInteractionEvent;
    for (const listener of [...this.listeners]) {
      try {
        listener(envelope);
      } catch (error) {
        try {
          this.onListenerError?.(error);
        } catch {
          // Monitoring cannot change the interaction lifecycle.
        }
      }
    }
    return envelope;
  }

  private nextVersion(): number {
    return ++this.resourceVersion;
  }

  private recordPending(
    input:
      | {
          readonly kind: "approval";
          readonly interactionId: string;
          readonly metadata: { readonly toolName: string; readonly providerCallId: string };
        }
      | {
          readonly kind: "prompt";
          readonly interactionId: string;
          readonly metadata: { readonly optionCount: number; readonly freeText: boolean };
        },
    version: number,
    at: number,
  ): boolean {
    const key = interactionKey(input.kind, input.interactionId);
    const previous = this.interactionRecords.get(key);
    if (previous) return false;
    const record = {
      ownerKey: this.ownerKey,
      interactionId: input.interactionId,
      kind: input.kind,
      status: "pending" as const,
      version,
      createdAt: at,
      updatedAt: at,
      metadata: input.metadata,
    } as DesktopInteractionRecord;
    this.interactionRecords.set(key, record);
    this.persist(record, null);
    return true;
  }

  private transitionRecord(
    current: DesktopInteractionRecord,
    status: Exclude<DesktopInteractionRecord["status"], "pending">,
    resolution: DesktopInteractionResolution,
    version: number,
    at: number,
  ): DesktopInteractionRecord {
    const record = { ...current, status, resolution, version, updatedAt: at };
    this.interactionRecords.set(interactionRecordKey(record), record);
    this.persist(record, current.version);
    return record;
  }

  private persist(record: DesktopInteractionRecord, expectedVersion: number | null): void {
    if (!this.store) return;
    const pending = this.persistenceQueue.then(async () => {
      await this.store?.commit({ record, expectedVersion });
    });
    this.persistenceQueue = pending.then(
      () => undefined,
      (error: unknown) => {
        this.persistenceError ??= error;
        try {
          this.onPersistenceError?.(error);
        } catch {
          // Monitoring cannot change the interaction's in-memory resolution semantics.
        }
      },
    );
  }

  private async persistAuthoritative(
    record: DesktopInteractionRecord,
    expectedVersion: number,
  ): Promise<void> {
    if (this.persistenceError !== undefined) throw this.persistenceError;
    if (this.store) {
      const commit = this.persistenceQueue.then(async () => {
        await this.store?.commit({ record, expectedVersion });
      });
      this.persistenceQueue = commit.then(
        () => undefined,
        (error: unknown) => {
          this.persistenceError ??= error;
          try {
            this.onPersistenceError?.(error);
          } catch {
            // Monitoring cannot change fail-closed persistence semantics.
          }
        },
      );
      await commit;
    }
    this.interactionRecords.set(interactionRecordKey(record), record);
  }

  private serializeResolution<T>(operation: () => Promise<T>): Promise<T> {
    const execution = this.resolutionQueue.then(operation, operation);
    this.resolutionQueue = execution.then(
      () => undefined,
      () => undefined,
    );
    return execution;
  }

  private assertExpectedVersion(
    interactionId: string,
    expectedVersion: number | undefined,
    currentVersion: number | undefined,
  ): void {
    if (expectedVersion === undefined) return;
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new DesktopInteractionVersionConflictError(
        interactionId,
        expectedVersion,
        currentVersion,
      );
    }
    if (expectedVersion !== currentVersion) {
      throw new DesktopInteractionVersionConflictError(
        interactionId,
        expectedVersion,
        currentVersion,
      );
    }
  }

  private scheduleApprovalExpiry(taskId: string): void {
    this.clearApprovalExpiry(taskId);
    const timer = setTimeout(() => {
      const current = this.interactionRecords.get(interactionKey("approval", taskId));
      if (!current || current.status !== "pending") return;
      this.pendingApprovals.delete(taskId);
      this.approvalManager.cancelApproval(taskId, "审批请求已过期。");
      this.transitionRecord(
        current,
        "expired",
        { kind: "system", reason: "expired" },
        this.nextVersion(),
        this.now(),
      );
      this.approvalExpiryTimers.delete(taskId);
    }, this.approvalTtlMs);
    timer.unref?.();
    this.approvalExpiryTimers.set(taskId, timer);
  }

  private clearApprovalExpiry(taskId: string): void {
    const timer = this.approvalExpiryTimers.get(taskId);
    if (timer) clearTimeout(timer);
    this.approvalExpiryTimers.delete(taskId);
  }

  private sweepExpiredApprovals(): void {
    for (const [taskId] of this.pendingApprovals) {
      if (this.approvalManager.getPendingTask(taskId)) continue;
      const current = this.interactionRecords.get(interactionKey("approval", taskId));
      this.pendingApprovals.delete(taskId);
      this.clearApprovalExpiry(taskId);
      if (current?.status === "pending") {
        this.transitionRecord(
          current,
          "expired",
          { kind: "system", reason: "expired" },
          this.nextVersion(),
          this.now(),
        );
      }
    }
  }
}

function promptTransition(
  event: Extract<AskUserHandlerEvent, { kind: "settled" }>,
  intent: DesktopInteractionResolution | undefined,
  closing: boolean,
): {
  status: "resolved" | "expired" | "interrupted";
  resolution: DesktopInteractionResolution;
} {
  if (closing || (intent?.kind === "system" && intent.reason === "host_closed")) {
    return {
      status: "interrupted",
      resolution: { kind: "system", reason: "host_closed" },
    };
  }
  if (event.outcome === "aborted") {
    return { status: "expired", resolution: { kind: "system", reason: "expired" } };
  }
  if (intent?.kind === "prompt") return { status: "resolved", resolution: intent };
  if (event.outcome === "cancelled") {
    return {
      status: "resolved",
      resolution: { kind: "prompt", outcome: "cancelled" },
    };
  }
  return {
    status: "resolved",
    resolution: resolutionForAnswer(event.answer),
  };
}

function resolutionForAnswer(answer: AskUserAnswer | undefined): DesktopInteractionResolution {
  if (!answer || answer.kind === "cancelled") {
    return { kind: "prompt", outcome: "cancelled" };
  }
  return {
    kind: "prompt",
    outcome: "answered",
  };
}

function fingerprintsForAnswer(answer: AskUserAnswer | undefined): ReadonlySet<string> | undefined {
  if (!answer || answer.kind === "cancelled") return undefined;
  return new Set(
    answer.kind === "selected"
      ? [answerFingerprint(answer.optionId), answerFingerprint(answer.label)]
      : [answerFingerprint(answer.text)],
  );
}

function sameResolution(
  record: DesktopInteractionRecord | undefined,
  resolution: DesktopInteractionResolution,
): boolean {
  return (
    record?.status === "resolved" &&
    JSON.stringify(record.resolution) === JSON.stringify(resolution)
  );
}

function isPromptAnswerRetry(
  record: DesktopInteractionRecord | undefined,
  fingerprints: ReadonlySet<string> | undefined,
  fingerprint: string,
): boolean {
  return (
    record?.status === "resolved" &&
    record.resolution?.kind === "prompt" &&
    record.resolution.outcome === "answered" &&
    fingerprints?.has(fingerprint) === true
  );
}

function answerFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function interactionKey(kind: "approval" | "prompt", interactionId: string): string {
  return `${kind}\0${interactionId}`;
}

function interactionRecordKey(record: DesktopInteractionRecord): string {
  return interactionKey(record.kind, record.interactionId);
}

function boundedOwnerKey(value: string): string {
  const ownerKey = value.trim();
  if (!ownerKey || ownerKey.length > 2_048 || ownerKey.includes("\0")) {
    throw new Error("Desktop interaction ownerKey must be a bounded non-empty string");
  }
  return ownerKey;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isPlanApprovalNotice(notice: ApprovalNotice): boolean {
  return notice.toolName === "exit_plan_mode" || notice.toolName === "submit_plan";
}

function desktopDecisionReason(decision: "approve" | "approve-session" | "reject"): string {
  if (decision === "approve") return "用户在桌面端批准了本次操作。";
  if (decision === "approve-session") return "用户在桌面端批准了本会话同类操作。";
  return "用户在桌面端拒绝了本次操作。";
}
