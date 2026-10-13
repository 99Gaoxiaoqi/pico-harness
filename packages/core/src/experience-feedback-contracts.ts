import type { MemoryItemSource } from './atomic-memory-contracts.js';
import type { ExperienceValidation, TaskExperienceReuse } from './task-experience-contracts.js';

/** Host assigned source identities. A native claim is never represented as a reviewed lesson. */
export type ExperienceSourceVersion =
  | { readonly kind: 'reviewed-reference'; readonly candidateId: string; readonly contentVersion: number }
  | { readonly kind: 'execution-validated'; readonly candidateId: string; readonly claimRevision: number; readonly claimHash: string; readonly scopeHash: string }
  | { readonly kind: 'execution-evidence'; readonly candidateId: string; readonly candidateVersion: number; readonly contentHash: string };
export interface ExperienceUse {
  readonly useId: string;
  readonly workspaceKey: string;
  readonly source: ExperienceSourceVersion;
  readonly itemId: string;
  readonly itemVersion: number;
  readonly contentHash: string;
  readonly taskId: string;
  readonly taskVersion: number;
  readonly sessionId: string;
  readonly runId: string;
  /** Frozen Desktop Host Run identity for the original v2 projection. */
  readonly hostRunId?: string;
  readonly referenceHash: string;
  readonly referenceContent?: string;
  readonly recallEventId?: string;
  readonly recallSequence?: number;
  readonly delivery: 'pending' | 'carried' | 'unknown';
  readonly deliverySequence?: number;
  readonly providerCallId?: string;
  readonly physicalAttemptId?: string;
  readonly historical: boolean;
  readonly managementRevision: number;
  readonly settingsVersion: number;
  readonly deletionRevision: number;
  readonly adoption: TaskExperienceReuse['adoption'];
  readonly validation: ExperienceValidation;
  readonly validationScope: 'unknown' | 'native-claim' | 'spreadsheet-range' | 'command';
  readonly excluded: boolean;
  readonly deleted: boolean;
  readonly sources: readonly MemoryItemSource[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface ExperienceEffect {
  readonly effectId: string;
  readonly useId: string;
  readonly preparedEventId: string;
  readonly outcomeEventId: string;
  readonly preparedSequence: number;
  readonly outcomeSequence: number;
  readonly adoption: ExperienceUse['adoption'];
  readonly validation: ExperienceValidation;
  readonly validationScope: ExperienceUse['validationScope'];
  readonly reason: string;
  readonly sources: readonly MemoryItemSource[];
  /** Only a trusted Host verifier can request a current-version control change. */
  readonly trustedContradiction: boolean;
  readonly createdAt: number;
}
export interface ExperienceFeedbackInput {
  readonly workspaceKey: string;
  readonly useId: string;
  readonly expectedItemVersion: number;
  readonly operationId: string;
  readonly action: 'not_applicable' | 'disable';
  readonly now: number;
}
export interface ExperienceDiagnostic {
  readonly diagnosticId: string;
  readonly workspaceKey: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly phase: 'identity' | 'proposal' | 'reference' | 'effect' | 'worker';
  /** Stable diagnostic code, never a raw exception, prompt, path or model response. */
  readonly reason: string;
  readonly createdAt: number;
}
export interface ExperienceUsePage {
  readonly uses: readonly ExperienceUse[];
  readonly nextCursor?: string;
}
export interface ExperienceLedgerStore {
  recordExperienceDiagnostic(diagnostic: ExperienceDiagnostic): Promise<void>;
  listExperienceDiagnostics(workspaceKey: string, sessionId?: string): Promise<readonly ExperienceDiagnostic[]>;
  readExperienceFence(workspaceKey: string): Promise<{ readonly settingsVersion: number; readonly deletionRevision: number; readonly managementRevision: number }>;
  recordExperienceUse(use: ExperienceUse): Promise<void>;
  readExperienceUse(useId: string): Promise<ExperienceUse | undefined>;
  queryExperienceUses(workspaceKey: string, options?: { readonly sessionId?: string; readonly itemId?: string; readonly cursor?: string; readonly limit?: number }): Promise<ExperienceUsePage>;
  deliverExperienceUse(input: { readonly useId: string; readonly providerCallId: string; readonly physicalAttemptId?: string; readonly deliverySequence: number; readonly now: number }): Promise<void>;
  appendExperienceEffect(effect: ExperienceEffect, options?: { readonly allowStateChange: boolean }): Promise<void>;
  listExperienceEffects(useId: string): Promise<readonly ExperienceEffect[]>;
  feedbackExperienceUse(input: ExperienceFeedbackInput): Promise<ExperienceUse>;
  /** Persistent current-task exclusion; it does not disable other tasks. */
  isExperienceExcluded(input: { readonly workspaceKey: string; readonly itemId: string; readonly taskId: string; readonly taskVersion: number }): Promise<boolean>;
}
