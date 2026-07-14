import {
  ApprovalManager,
  type ApprovalNotice,
  type ApprovalNotifier,
} from "../approval/manager.js";
import {
  AskUserHandler,
  type AskUserHandlerEvent,
  type AskUserRequestId,
} from "../tools/ask-user.js";

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
  readonly now?: () => number;
}

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
  private readonly now: () => number;
  private readonly unsubscribeAskUser: () => void;
  private resourceVersion = 0;

  constructor(options: DesktopInteractionBrokerOptions = {}) {
    this.approvalManager = options.approvalManager ?? new ApprovalManager();
    this.askUserHandler = options.askUserHandler ?? new AskUserHandler();
    this.now = options.now ?? Date.now;
    this.unsubscribeAskUser = this.askUserHandler.subscribe((event) => this.onAskUserEvent(event));
  }

  readonly notifyApproval: ApprovalNotifier = (notice) => {
    this.pendingApprovals.set(notice.taskId, notice);
    this.emit({ kind: "approval.pending", notice });
  };

  subscribe(listener: (event: DesktopInteractionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  listPendingApprovals(): readonly ApprovalNotice[] {
    return [...this.pendingApprovals.values()];
  }

  resolveApproval(input: {
    readonly taskId: string;
    readonly decision: "approve" | "approve-session" | "reject";
    readonly reason?: string;
  }): boolean {
    if (!this.pendingApprovals.has(input.taskId)) return false;
    const reason = input.reason?.trim() || desktopDecisionReason(input.decision);
    const resolved =
      input.decision === "approve-session"
        ? this.approvalManager.resolveApprovalForSession(input.taskId, reason)
        : this.approvalManager.resolveApproval(input.taskId, input.decision === "approve", reason);
    if (!resolved) {
      this.pendingApprovals.delete(input.taskId);
      return false;
    }
    this.pendingApprovals.delete(input.taskId);
    this.emit({
      kind: "approval.settled",
      taskId: input.taskId,
      decision: input.decision,
    });
    return true;
  }

  answerPrompt(requestId: string, answer: string): boolean {
    const request = this.askUserHandler
      .getPendingRequests()
      .find((candidate) => candidate.requestId === requestId);
    const option = request?.options.find(
      (candidate) => candidate.optionId === answer || candidate.label === answer,
    );
    return option
      ? this.askUserHandler.select(requestId as AskUserRequestId, option.optionId)
      : false;
  }

  cancelPrompt(requestId: string, reason?: string): boolean {
    return this.askUserHandler.cancel(
      requestId as AskUserRequestId,
      reason?.trim() || "用户在桌面端取消了问题。",
    );
  }

  close(): void {
    for (const taskId of this.pendingApprovals.keys()) {
      this.approvalManager.cancelApproval(taskId, "桌面交互宿主已关闭。");
    }
    this.pendingApprovals.clear();
    this.askUserHandler.cancelAll("桌面交互宿主已关闭。");
    this.unsubscribeAskUser();
    this.listeners.clear();
  }

  private onAskUserEvent(event: AskUserHandlerEvent): void {
    if (event.kind === "pending") {
      this.emit({ kind: "prompt.pending", request: event.request });
      return;
    }
    this.emit({
      kind: "prompt.settled",
      requestId: event.request.requestId,
      outcome: event.outcome,
    });
  }

  private emit(event: DesktopInteractionInput): void {
    const envelope = {
      ...event,
      resourceVersion: ++this.resourceVersion,
      at: this.now(),
    } as DesktopInteractionEvent;
    for (const listener of [...this.listeners]) listener(envelope);
  }
}

function desktopDecisionReason(decision: "approve" | "approve-session" | "reject"): string {
  if (decision === "approve") return "用户在桌面端批准了本次操作。";
  if (decision === "approve-session") return "用户在桌面端批准了本会话同类操作。";
  return "用户在桌面端拒绝了本次操作。";
}
