import type { MemoryItemSource } from "./atomic-memory-contracts.js";

export type ExecutionAcceptancePredicate = "test-target-pass.v1" | "command-conditions.v1";
export type ExecutionLearningState =
  | "waiting"
  | "ready"
  | "working"
  | "saved"
  | "insufficient"
  | "invalidated"
  | "discarded"
  | "expired";
export interface ExecutionLearningAdmission {
  readonly admissionId: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly workDir: string;
  readonly settingsVersion: number;
  readonly deletionRevision: number;
  readonly managementRevision: number;
  readonly inputEpoch: number;
  readonly createdAt: number;
  readonly modelRoute?: {
    readonly providerId: string;
    readonly modelId: string;
    readonly configRevision?: string;
  };
}
export interface ExecutionLearningTarget {
  readonly targetId: string;
  readonly label: string;
  readonly kind: "node-test" | "command";
  readonly command: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly scopeHash: string;
  readonly entryFiles: readonly { readonly path: string; readonly hash: string }[];
  readonly testFiles?: readonly string[];
}
export type ExecutionCondition =
  | { readonly kind: "cwd"; readonly path: string }
  | { readonly kind: "file"; readonly path: string; readonly hash: string }
  | {
      readonly kind: "json";
      readonly path: string;
      readonly field: readonly string[];
      readonly value: string | number | boolean | null;
    }
  | {
      readonly kind: "node-package";
      readonly path: string;
      readonly name: string;
      readonly version: string;
      readonly entryPath: string;
      readonly entryHash: string;
    };
export interface ExecutionConditionObservation {
  readonly complete: boolean;
  readonly matches: boolean;
  readonly fingerprint: string;
  readonly facts: readonly { readonly path: string; readonly hash: string | null }[];
}
export interface ExecutionFileCommitFact {
  readonly path: string;
  readonly beforeHash?: string | null;
  readonly afterHash: string;
  readonly content?: string;
  readonly source: MemoryItemSource;
}
export type ExecutionPreparation =
  | { readonly kind: "cwd"; readonly path: string; readonly source: MemoryItemSource }
  | {
      readonly kind: "file";
      readonly path: string;
      readonly beforeHash?: string | null;
      readonly afterHash: string;
      readonly content?: string;
      readonly source: MemoryItemSource;
    }
  | {
      readonly kind: "dependency";
      readonly command: string;
      readonly manifestHash: string;
      readonly source: MemoryItemSource;
    };
export interface ExecutionTestReport {
  readonly runner?: {
    readonly execPath: string;
    readonly version: string;
    readonly fingerprint?: string;
  };
  readonly complete: boolean;
  readonly passed: readonly string[];
  readonly failed: readonly string[];
  readonly skipped: readonly string[];
  readonly success: boolean;
}
export interface ExecutionAcceptanceClaim {
  readonly runner?: {
    readonly execPath: string;
    readonly version: string;
    readonly fingerprint?: string;
  };
  readonly candidateId: string;
  readonly revision: number;
  readonly failureKey: string;
  readonly predicateId: ExecutionAcceptancePredicate;
  readonly admission: ExecutionLearningAdmission;
  readonly target: ExecutionLearningTarget;
  readonly claimHash: string;
  readonly conditions: readonly ExecutionCondition[];
  readonly recipe: readonly ExecutionPreparation[];
  readonly failedTestIds: readonly string[];
  readonly failure: MemoryItemSource;
  readonly createdAt: number;
}
export interface ExecutionVerificationTicket {
  readonly ticketId: string;
  readonly candidateId: string;
  readonly claimRevision: number;
  readonly claimHash: string;
  readonly admissionId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly preparedEventId: string;
  readonly argumentsHash: string;
  readonly inputEpoch: number;
  readonly before: ExecutionConditionObservation;
  readonly createdAt: number;
}
export interface ExecutionVerificationResult {
  readonly ticketId: string;
  readonly source: MemoryItemSource;
  readonly after: ExecutionConditionObservation;
  readonly report?: ExecutionTestReport;
  readonly complete: boolean;
  readonly exitCode: number | null;
  readonly settledAt: number;
}
export interface ExecutionLearningCandidate {
  readonly claim: ExecutionAcceptanceClaim;
  readonly state: ExecutionLearningState;
  readonly updatedAt: number;
  readonly itemId?: string;
  readonly reason?: string;
  readonly hypothesis?: string;
}
export interface ExecutionLearningJob {
  readonly jobId: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly candidateId: string;
  readonly ticketId?: string;
  readonly kind: "verify" | "reflect";
  readonly state: "ready" | "working" | "completed" | "skipped";
  readonly inputEpoch: number;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly leaseUntil: number;
  readonly fencingToken: number;
  readonly ownerId?: string;
}
export interface ExecutionTaskAcceptance {
  readonly candidateId: string;
  readonly predicateId: ExecutionAcceptancePredicate;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly acceptedAt: number;
  readonly claimHash: string;
  readonly scopeHash: string;
}
export interface ExecutionLearningStatus {
  readonly candidateId: string;
  readonly revision: number;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly state: ExecutionLearningState;
  readonly predicateId: ExecutionAcceptancePredicate;
  readonly targetId: string;
  readonly targetLabel: string;
  readonly updatedAt: number;
  readonly itemId?: string;
  readonly reason?: string;
  readonly sources: readonly MemoryItemSource[];
}
export interface ExecutionLearningStore {
  /** Current policy/identity check before acquiring a model lease; no budget debit. */
  executionLearningAllowed?(claim: ExecutionAcceptanceClaim): boolean;
  readExecutionLearningInputEpoch(workspaceKey: string): Promise<number>;
  admitExecutionLearning(admission: ExecutionLearningAdmission): Promise<void>;
  advanceExecutionLearningInput(
    workspaceKey: string,
  ): Promise<{ inputEpoch: number; managementRevision: number }>;
  saveExecutionLearningClaim(claim: ExecutionAcceptanceClaim): Promise<ExecutionLearningCandidate>;
  readExecutionLearningCandidate(
    candidateId: string,
  ): Promise<ExecutionLearningCandidate | undefined>;
  listExecutionLearningCandidates(
    workspaceKey: string,
  ): Promise<readonly ExecutionLearningCandidate[]>;
  registerExecutionVerification(ticket: ExecutionVerificationTicket): Promise<void>;
  settleExecutionVerification(result: ExecutionVerificationResult): Promise<void>;
  readExecutionVerification(
    ticketId: string,
  ): Promise<
    { ticket: ExecutionVerificationTicket; result?: ExecutionVerificationResult } | undefined
  >;
  enqueueExecutionLearningJob(job: ExecutionLearningJob): Promise<void>;
  claimExecutionLearningJob(
    ownerId: string,
    now: number,
    leaseMs: number,
  ): Promise<ExecutionLearningJob | undefined>;
  completeExecutionLearningJob(input: {
    jobId: string;
    fencingToken: number;
    candidateRevision: number;
    content?: string;
    reason?: string;
    hypothesis?: string;
    now: number;
  }): Promise<ExecutionLearningCandidate>;
  reserveExecutionLearningModelAttempt(
    failureKey: string,
    workspaceKey: string,
    now: number,
  ): Promise<boolean>;
  listExecutionLearning(
    workspaceKey: string,
    sessionId?: string,
  ): Promise<readonly ExecutionLearningStatus[]>;
  discardExecutionLearning(
    candidateId: string,
    workspaceKey: string,
    revision: number,
  ): Promise<void>;
}
