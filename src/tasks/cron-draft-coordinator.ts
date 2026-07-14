import { randomUUID } from "node:crypto";
import type { ToolExecutionContext } from "../tools/registry.js";
import type {
  CronCreationReceipt,
  CronDraft,
  CronDraftId,
  CronDraftReviewer,
  ScheduleDraftCoordinator as ScheduleDraftCoordinatorContract,
  ScheduleDraftOutcome,
  ScheduleTaskProposal,
} from "./cron-draft.js";
import { nextCronRuns } from "./cron-service.js";

export interface ScheduleDraftContextSnapshot {
  workspacePath: string;
  modelRouteId: string;
  allowedTools: readonly string[];
  credentialStatus: CronDraft["credentialStatus"];
  daemonStatus: string;
}

export interface ScheduleDraftCoordinatorOptions {
  reviewer: CronDraftReviewer;
  resolveContext: (
    proposal: ScheduleTaskProposal,
    context?: ToolExecutionContext,
  ) => ScheduleDraftContextSnapshot | Promise<ScheduleDraftContextSnapshot>;
  commit: (draft: CronDraft, signal?: AbortSignal) => Promise<CronCreationReceipt>;
  now?: () => number;
  defaultTimeZone?: () => string;
  generateDraftId?: () => CronDraftId;
}

/**
 * 前台 Cron 草案协调器。草案只存在于 propose 调用期间；唯一持久化边界是
 * reviewer 明确 confirm 后调用的 commit callback。
 */
export class ScheduleDraftCoordinator implements ScheduleDraftCoordinatorContract {
  private readonly reviewer: CronDraftReviewer;
  private readonly resolveContext: ScheduleDraftCoordinatorOptions["resolveContext"];
  private readonly commit: ScheduleDraftCoordinatorOptions["commit"];
  private readonly now: () => number;
  private readonly defaultTimeZone: () => string;
  private readonly generateDraftId: () => CronDraftId;

  constructor(options: ScheduleDraftCoordinatorOptions) {
    this.reviewer = options.reviewer;
    this.resolveContext = options.resolveContext;
    this.commit = options.commit;
    this.now = options.now ?? Date.now;
    this.defaultTimeZone =
      options.defaultTimeZone ?? (() => Intl.DateTimeFormat().resolvedOptions().timeZone);
    this.generateDraftId = options.generateDraftId ?? (() => randomUUID() as CronDraftId);
  }

  async propose(
    proposal: ScheduleTaskProposal,
    context?: ToolExecutionContext,
  ): Promise<ScheduleDraftOutcome> {
    if (context?.signal?.aborted) return { kind: "cancelled" };

    let draft: CronDraft;
    try {
      const normalized = normalizeProposal(proposal, this.defaultTimeZone());
      const nextRuns = nextCronRuns(normalized.cronExpression, normalized.timeZone, this.now(), 3);
      const snapshot = normalizeContext(await this.resolveContext(normalized, context));
      draft = Object.freeze({
        draftId: this.generateDraftId(),
        ...normalized,
        timeZone: normalized.timeZone,
        workspacePath: snapshot.workspacePath,
        modelRouteId: snapshot.modelRouteId,
        nextRuns: Object.freeze(nextRuns),
        allowedTools: Object.freeze([...snapshot.allowedTools]),
        toolNetworkPolicy: "allow" as const,
        credentialStatus: snapshot.credentialStatus,
        daemonStatus: snapshot.daemonStatus,
      });
    } catch (error) {
      if (context?.signal?.aborted || isAbortError(error)) return { kind: "cancelled" };
      return { kind: "rejected", reason: errorMessage(error) };
    }

    try {
      const decision = await this.reviewer.review(draft, context?.signal);
      if (context?.signal?.aborted) return { kind: "cancelled" };
      if (decision.draftId !== draft.draftId) {
        return { kind: "rejected", reason: "草案决定与当前草案不匹配" };
      }
      switch (decision.kind) {
        case "modify":
          return { kind: "modify_requested" };
        case "cancel":
          return { kind: "cancelled" };
        case "confirm": {
          if (context?.signal?.aborted) return { kind: "cancelled" };
          const receipt = await this.commit(draft, context?.signal);
          return { kind: "created", receipt };
        }
      }
    } catch (error) {
      if (context?.signal?.aborted || isAbortError(error)) return { kind: "cancelled" };
      throw error;
    }
  }
}

function normalizeProposal(
  proposal: ScheduleTaskProposal,
  defaultTimeZone: string,
): Required<ScheduleTaskProposal> {
  if (!proposal || typeof proposal !== "object") {
    throw new Error("Cron 草案参数必须是对象");
  }
  const title = requireNonEmptyString(proposal.title, "title");
  const prompt = requireNonEmptyString(proposal.prompt, "prompt");
  const scheduleText = requireNonEmptyString(proposal.scheduleText, "scheduleText");
  const cronExpression = requireNonEmptyString(proposal.cronExpression, "cronExpression");
  const timeZone = requireNonEmptyString(proposal.timeZone ?? defaultTimeZone, "timeZone");
  assertRecurringScheduleText(scheduleText);
  return { title, prompt, scheduleText, cronExpression, timeZone };
}

function normalizeContext(snapshot: ScheduleDraftContextSnapshot): ScheduleDraftContextSnapshot {
  if (!snapshot || typeof snapshot !== "object") throw new Error("Cron 草案上下文必须是对象");
  const workspacePath = requireNonEmptyString(snapshot.workspacePath, "workspacePath");
  const modelRouteId = requireNonEmptyString(snapshot.modelRouteId, "modelRouteId");
  const daemonStatus = requireNonEmptyString(snapshot.daemonStatus, "daemonStatus");
  if (!Array.isArray(snapshot.allowedTools)) throw new Error("allowedTools 必须是字符串数组");
  const allowedTools = snapshot.allowedTools.map((tool) =>
    requireNonEmptyString(tool, "allowedTools"),
  );
  if (!(["available", "missing", "unavailable"] as const).includes(snapshot.credentialStatus)) {
    throw new Error("credentialStatus 无效");
  }
  return {
    workspacePath,
    modelRouteId,
    allowedTools: [...new Set(allowedTools)],
    credentialStatus: snapshot.credentialStatus,
    daemonStatus,
  };
}

function requireNonEmptyString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${name} 必须是非空字符串`);
  }
  return value.trim();
}

function assertRecurringScheduleText(scheduleText: string): void {
  const explicitlyRecurring =
    /\b(?:every|each|daily|weekly|monthly|yearly|weekdays?|weekends?)\b/iu.test(scheduleText) ||
    /(?:每|工作日|周末|定期)/u.test(scheduleText);
  const explicitOneTime =
    /(?:^|\s)(?:once|today|tomorrow|tonight|next\s+(?:week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday))(?:\s|$)/iu.test(
      scheduleText,
    ) ||
    /(?:仅?一次|只(?:执行|运行)一次|今天|今晚|明天|后天|下(?:周|个月|月|年)|\d{4}[年/-]\d{1,2}(?:[月/-]\d{1,2})?)/u.test(
      scheduleText,
    );
  if (explicitOneTime && !explicitlyRecurring) {
    throw new Error("仅支持重复调度；一次性任务不会创建 Cron 草案");
  }
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
