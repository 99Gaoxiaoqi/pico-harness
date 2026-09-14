declare const cronDraftIdBrand: unique symbol;

/** Ephemeral identifier for a foreground-only schedule review. */
export type CronDraftId = string & { readonly [cronDraftIdBrand]: true };

/** Structured arguments produced by the model from an explicit recurring-task request. */
export interface ScheduleTaskProposal {
  readonly title: string;
  readonly prompt: string;
  readonly scheduleText: string;
  readonly cronExpression: string;
  readonly timeZone?: string;
}

export interface CronDraft {
  readonly draftId: CronDraftId;
  readonly title: string;
  readonly prompt: string;
  readonly scheduleText: string;
  readonly cronExpression: string;
  readonly timeZone: string;
  readonly workspacePath: string;
  readonly modelRouteId: string;
  readonly nextRuns: readonly number[];
  readonly allowedTools: readonly string[];
  readonly toolNetworkPolicy: "allow";
  readonly credentialStatus: "available" | "missing" | "unavailable";
  readonly daemonStatus: string;
}

export type CronDraftDecision =
  | { readonly kind: "confirm"; readonly draftId: CronDraftId }
  | { readonly kind: "modify"; readonly draftId: CronDraftId }
  | { readonly kind: "cancel"; readonly draftId: CronDraftId };

export interface CronCreationReceipt {
  readonly cronJobId: string;
  readonly enabled: boolean;
  readonly schedule: string;
  readonly timeZone: string;
  readonly nextRun?: number;
  readonly daemonMessage: string;
}

export type ScheduleDraftOutcome =
  | { readonly kind: "created"; readonly receipt: CronCreationReceipt }
  | { readonly kind: "modify_requested" }
  | { readonly kind: "cancelled" }
  | { readonly kind: "rejected"; readonly reason: string };

/** UI-neutral review boundary. Only the foreground host can mint a decision. */
export interface CronDraftReviewer {
  review(draft: CronDraft, signal?: AbortSignal): Promise<CronDraftDecision>;
}

/** Tool-facing application boundary; implementations own validation and durable commit. */
export interface ScheduleDraftCoordinator<Context = unknown> {
  propose(proposal: ScheduleTaskProposal, context?: Context): Promise<ScheduleDraftOutcome>;
}
