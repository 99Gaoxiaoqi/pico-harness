import type { ToolExecutionContext } from "../tools/registry.js";

declare const cronDraftIdBrand: unique symbol;

/** Ephemeral identifier for a foreground-only schedule review. */
export type CronDraftId = string & { readonly [cronDraftIdBrand]: true };

/** Structured arguments produced by the model from an explicit recurring-task request. */
export interface ScheduleTaskProposal {
  title: string;
  prompt: string;
  scheduleText: string;
  cronExpression: string;
  timeZone?: string;
}

export interface CronDraft {
  draftId: CronDraftId;
  title: string;
  prompt: string;
  scheduleText: string;
  cronExpression: string;
  timeZone: string;
  workspacePath: string;
  modelRouteId: string;
  nextRuns: readonly number[];
  allowedTools: readonly string[];
  toolNetworkPolicy: "allow";
  credentialStatus: "available" | "missing" | "unavailable";
  daemonStatus: string;
}

export type CronDraftDecision =
  | { kind: "confirm"; draftId: CronDraftId }
  | { kind: "modify"; draftId: CronDraftId }
  | { kind: "cancel"; draftId: CronDraftId };

export interface CronCreationReceipt {
  cronJobId: string;
  enabled: boolean;
  schedule: string;
  timeZone: string;
  nextRun?: number;
  daemonMessage: string;
}

export type ScheduleDraftOutcome =
  | { kind: "created"; receipt: CronCreationReceipt }
  | { kind: "modify_requested" }
  | { kind: "cancelled" }
  | { kind: "rejected"; reason: string };

/** UI-neutral review boundary. Only the foreground host can mint a decision. */
export interface CronDraftReviewer {
  review(draft: CronDraft, signal?: AbortSignal): Promise<CronDraftDecision>;
}

/** Tool-facing application boundary; implementations own validation and durable commit. */
export interface ScheduleDraftCoordinator {
  propose(
    proposal: ScheduleTaskProposal,
    context?: ToolExecutionContext,
  ): Promise<ScheduleDraftOutcome>;
}
