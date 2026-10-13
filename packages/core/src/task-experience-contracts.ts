import type { MemoryItemSource } from "./atomic-memory-contracts.js";
import type {
  ExecutionLearningJob,
  ExecutionLearningState,
} from "./execution-learning-contracts.js";

export type ExperienceReview = "unneeded" | "pending" | "approved" | "rejected" | "deferred";
export type ExperienceValidation = "unknown" | "pass" | "fail" | "stale";
/** Host-owned evidence attachment, never a model-provided approval or public review input. */
export interface TaskExperienceNativeEvidence {
  readonly candidateId: string;
  readonly claimRevision: number;
  readonly claimHash: string;
  readonly scopeHash: string;
}
export interface ExperienceApplicability {
  readonly taskFamily: "general" | "coding" | "spreadsheet";
  readonly toolNames: readonly string[];
  readonly conditions: readonly string[];
  /** Assigned by Host from canonical observations, never from model output. */
  readonly spreadsheet?: {
    readonly operation: "sum";
    readonly header: false;
    readonly dataKind: "finite-numbers";
  };
}
export interface TaskExperienceTask {
  readonly taskId: string;
  readonly taskVersion: number;
  readonly workspaceKey: string;
  readonly workDir: string;
  readonly sessionId: string;
  /** Desktop Host Run identity; standalone callers use the canonical Run identity. */
  readonly runId: string;
  /** Exact canonical execution Run when the Host commits input separately. */
  readonly executionRunId?: string;
  readonly goal: string;
  readonly goalSource: MemoryItemSource;
  readonly goalId?: string;
  readonly goalRevision?: number;
  readonly previousTaskId?: string;
  readonly coverage: "complete" | "limited" | "unavailable";
  readonly throughSequence: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface TaskExperienceObservation {
  readonly observationId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly kind: "user-input" | "tool-result" | "terminal";
  readonly source: MemoryItemSource;
  readonly sequence: number;
  readonly summary: string;
  readonly coverage: "complete" | "limited" | "unavailable";
  readonly status?: "succeeded" | "failed" | "rejected" | "cancelled" | "interrupted";
  readonly toolName?: string;
  readonly preparedEventId?: string;
  readonly correction?: boolean;
  readonly arguments?: Readonly<Record<string, string | number | boolean | null>>;
  readonly createdAt: number;
}
export interface TaskExperienceSummary {
  readonly candidateId: string;
  readonly contentVersion: number;
  readonly recordRevision: number;
  readonly review: ExperienceReview;
  readonly validation: ExperienceValidation;
  readonly enabled: boolean;
  readonly applicability: ExperienceApplicability;
}
/** The single review lifecycle; optional native evidence only proves its frozen operation scope. */
export interface TaskExperienceCandidate extends TaskExperienceSummary {
  readonly kind: "task-lesson";
  readonly lifecycleState: "active" | "archived";
  readonly taskId: string;
  readonly taskVersion: number;
  readonly workspaceKey: string;
  readonly workDir: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly failureKey: string;
  readonly inputEpoch: number;
  readonly settingsVersion: number;
  readonly deletionRevision: number;
  readonly state: ExecutionLearningState;
  readonly goal: string;
  readonly content: string;
  readonly sources: readonly MemoryItemSource[];
  readonly observationIds: readonly string[];
  /** Internal Host attachment; excluded from the existing public protocol projection. */
  readonly nativeEvidence?: TaskExperienceNativeEvidence;
  readonly modelRoute?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly configRevision?: string;
  };
  readonly itemId?: string;
  readonly reason?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface TaskExperienceReuse {
  readonly reuseId: string;
  readonly workspaceKey: string;
  readonly candidateId: string;
  readonly contentVersion: number;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly referenceHash: string;
  /** Exact bounded excerpt injected in this task; deleted with derived experience content. */
  readonly referenceContent?: string;
  readonly adoption: "unknown" | "observed" | "not_applied";
  readonly validation: ExperienceValidation;
  readonly excluded: boolean;
  readonly sources: readonly MemoryItemSource[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
export type ExperienceReviewAction =
  | "accept"
  | "edit_accept"
  | "defer"
  | "reject"
  | "disable"
  | "archive"
  | "restore"
  | "delete";
export interface TaskExperienceReviewInput {
  readonly workspaceKey: string;
  readonly candidateId: string;
  readonly expectedRecordRevision: number;
  readonly expectedContentVersion: number;
  readonly operationId: string;
  readonly action: ExperienceReviewAction;
  readonly content?: string;
  readonly applicability?: ExperienceApplicability;
  readonly now: number;
}
export interface TaskExperienceFeedbackInput {
  readonly workspaceKey: string;
  readonly candidateId: string;
  readonly expectedContentVersion: number;
  readonly operationId: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly action: "not_applicable" | "correct" | "disable";
  readonly now: number;
}
/** Host audit identity only; contains no task prose or model-provided authority. */
export interface TaskExperienceRunBinding {
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly executionRunId: string;
  readonly hostRunId: string;
  readonly createdAt: number;
}
export interface TaskExperienceStore {
  /** Current policy/identity check before acquiring a model lease; no budget debit. */
  taskExperienceAllowed?(candidate: TaskExperienceCandidate): boolean;
  saveTaskExperienceRunBinding?(binding: TaskExperienceRunBinding): Promise<void>;
  readTaskExperienceRunBinding?(
    workspaceKey: string,
    sessionId: string,
    executionRunId: string,
  ): Promise<TaskExperienceRunBinding | undefined>;
  saveTaskExperienceTask(task: TaskExperienceTask): Promise<void>;
  readTaskExperienceTask(taskId: string): Promise<TaskExperienceTask | undefined>;
  latestTaskExperienceTask(
    workspaceKey: string,
    sessionId: string,
  ): Promise<TaskExperienceTask | undefined>;
  appendTaskExperienceObservations(
    task: TaskExperienceTask,
    observations: readonly TaskExperienceObservation[],
  ): Promise<void>;
  listTaskExperienceObservations(taskId: string): Promise<readonly TaskExperienceObservation[]>;
  createTaskExperienceCandidate(
    candidate: TaskExperienceCandidate,
  ): Promise<TaskExperienceCandidate>;
  readTaskExperienceCandidate(candidateId: string): Promise<TaskExperienceCandidate | undefined>;
  queryTaskExperiences(
    workspaceKey: string,
    options?: {
      readonly sessionId?: string;
      readonly review?: ExperienceReview;
      readonly limit?: number;
    },
  ): Promise<readonly TaskExperienceCandidate[]>;
  completeTaskExperienceJob(input: {
    readonly job: ExecutionLearningJob;
    readonly expectedRecordRevision: number;
    readonly content?: string;
    readonly applicability?: ExperienceApplicability;
    readonly sources?: readonly MemoryItemSource[];
    readonly nativeEvidence?: TaskExperienceNativeEvidence;
    readonly reason?: string;
    readonly now: number;
  }): Promise<TaskExperienceCandidate | undefined>;
  reviewTaskExperience(input: TaskExperienceReviewInput): Promise<TaskExperienceCandidate>;
  feedbackTaskExperience(input: TaskExperienceFeedbackInput): Promise<TaskExperienceCandidate>;
  recordTaskExperienceReuse(reuse: TaskExperienceReuse): Promise<void>;
  listTaskExperienceReuse(
    workspaceKey: string,
    sessionId?: string,
  ): Promise<readonly TaskExperienceReuse[]>;
  settleTaskExperienceReuse(input: {
    readonly reuseId: string;
    readonly candidateId: string;
    readonly contentVersion: number;
    readonly taskVersion: number;
    readonly adoption: TaskExperienceReuse["adoption"];
    readonly validation: ExperienceValidation;
    readonly sources: readonly MemoryItemSource[];
    readonly now: number;
  }): Promise<void>;
}
