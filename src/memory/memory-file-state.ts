import type { WorkspaceId } from "../paths/pico-paths.js";
import {
  FACT_STATES,
  MEMORY_JOB_STATUSES,
  MEMORY_KINDS,
  MEMORY_REVIEW_MODES,
  MUTATION_ACTIONS,
  MUTATION_ENTITY_TYPES,
  PROPOSAL_CONFLICT_STATUSES,
  PROPOSAL_STATUSES,
  SOURCE_AVAILABILITIES,
  type Fact,
  type Job,
  type Mutation,
  type Proposal,
  type Settings,
  type Source,
} from "./domain.js";
import { FileStorageIntegrityError } from "../storage/local-file-storage.js";
import { validateEvidenceRef } from "../engine/evidence-ref.js";

export const MEMORY_FILE_SCHEMA_VERSION = 2 as const;

export class MemoryFileSchemaVersionError extends FileStorageIntegrityError {
  constructor(message: string) {
    super(message);
    this.name = "MemoryFileSchemaVersionError";
  }
}

export class MemoryFileWorkspaceMismatchError extends FileStorageIntegrityError {
  constructor(expectedWorkspaceId: WorkspaceId, actualWorkspaceId: unknown) {
    super(
      `Memory state belongs to workspace ${String(actualWorkspaceId)}, not ${expectedWorkspaceId}`,
    );
    this.name = "MemoryFileWorkspaceMismatchError";
  }
}

export interface MemoryIdempotencyRecord {
  readonly operation: string;
  readonly keyHash: string;
  readonly requestHash: string;
  readonly marker: Readonly<Record<string, string>>;
  readonly createdAt: string;
}

export interface MemoryFileState {
  readonly schemaVersion: typeof MEMORY_FILE_SCHEMA_VERSION;
  readonly workspaceId: WorkspaceId;
  revision: number;
  settings: Settings;
  sources: Record<string, Source>;
  facts: Record<string, Fact>;
  proposals: Record<string, Proposal>;
  mutations: Mutation[];
  jobs: Record<string, Job>;
  idempotency: Record<string, MemoryIdempotencyRecord>;
}

export function createMemoryFileState(workspaceId: WorkspaceId, at: string): MemoryFileState {
  return {
    schemaVersion: MEMORY_FILE_SCHEMA_VERSION,
    workspaceId,
    revision: 0,
    settings: {
      workspaceId,
      enabled: true,
      autoPropose: true,
      autoCommit: false,
      injectionEnabled: true,
      reviewMode: "balanced",
      version: 1,
      updatedAt: at,
    },
    sources: {},
    facts: {},
    proposals: {},
    mutations: [],
    jobs: {},
    idempotency: {},
  };
}

export function decodeMemoryFileState(value: unknown, workspaceId: WorkspaceId): MemoryFileState {
  if (!isRecord(value)) throw integrity("state root must be an object");
  if (value["schemaVersion"] !== MEMORY_FILE_SCHEMA_VERSION) {
    throw new MemoryFileSchemaVersionError(
      `unsupported schemaVersion ${String(value["schemaVersion"])}; expected ${MEMORY_FILE_SCHEMA_VERSION}`,
    );
  }
  if (value["workspaceId"] !== workspaceId) {
    throw new MemoryFileWorkspaceMismatchError(workspaceId, value["workspaceId"]);
  }
  if (!Number.isSafeInteger(value["revision"]) || (value["revision"] as number) < 0) {
    throw integrity("revision must be a non-negative integer");
  }
  for (const field of ["settings", "sources", "facts", "proposals", "jobs", "idempotency"]) {
    if (!isRecord(value[field])) throw integrity(`${field} must be an object`);
  }
  if (!Array.isArray(value["mutations"])) throw integrity("mutations must be an array");
  assertSettings(value["settings"], workspaceId);
  assertEntityMap(value["sources"], workspaceId, "sourceId", "sources", assertSource);
  assertEntityMap(value["facts"], workspaceId, "factId", "facts", assertFact);
  assertEntityMap(value["proposals"], workspaceId, "proposalId", "proposals", assertProposal);
  assertEntityMap(value["jobs"], workspaceId, "jobId", "jobs", assertJob);
  let expectedSequence = 1;
  const mutationIds = new Set<string>();
  for (const mutation of value["mutations"]) {
    if (!isRecord(mutation)) throw integrity("mutation must be an object");
    assertWorkspaceRecord(mutation, workspaceId, "mutation");
    if (mutation["sequence"] !== expectedSequence) {
      throw integrity(`mutation sequence must be contiguous at ${expectedSequence}`);
    }
    for (const forbidden of ["title", "content", "reason", "body"]) {
      if (forbidden in mutation) throw integrity(`mutation audit must not contain ${forbidden}`);
    }
    const mutationId = requireString(mutation["mutationId"], "mutation.mutationId");
    if (mutationIds.has(mutationId)) throw integrity(`duplicate mutationId ${mutationId}`);
    mutationIds.add(mutationId);
    requireEnum(mutation["entityType"], MUTATION_ENTITY_TYPES, "mutation.entityType");
    requireString(mutation["entityId"], "mutation.entityId");
    requireEnum(mutation["action"], MUTATION_ACTIONS, "mutation.action");
    if (mutation["fromVersion"] !== undefined) {
      requirePositiveInteger(mutation["fromVersion"], "mutation.fromVersion");
    }
    requirePositiveInteger(mutation["toVersion"], "mutation.toVersion");
    if (mutation["idempotencyKeyHash"] !== undefined) {
      requireHash(mutation["idempotencyKeyHash"], "mutation.idempotencyKeyHash");
    }
    requireTimestamp(mutation["createdAt"], "mutation.createdAt");
    expectedSequence++;
  }
  const idempotencyMap = value["idempotency"];
  if (!isRecord(idempotencyMap)) throw integrity("idempotency must be an object");
  for (const [identity, idempotency] of Object.entries(idempotencyMap)) {
    if (!isRecord(idempotency)) throw integrity(`idempotency ${identity} must be an object`);
    if (
      typeof idempotency["operation"] !== "string" ||
      !isRecord(idempotency["marker"]) ||
      typeof idempotency["createdAt"] !== "string"
    ) {
      throw integrity(`idempotency ${identity} is malformed`);
    }
    requireString(idempotency["operation"], `idempotency.${identity}.operation`);
    const keyHash = requireHash(idempotency["keyHash"], `idempotency.${identity}.keyHash`);
    requireHash(idempotency["requestHash"], `idempotency.${identity}.requestHash`);
    requireTimestamp(idempotency["createdAt"], `idempotency.${identity}.createdAt`);
    if (identity !== `${idempotency["operation"]}:${keyHash}`) {
      throw integrity(`idempotency ${identity} has a mismatched identity`);
    }
    for (const [key, markerValue] of Object.entries(idempotency["marker"])) {
      requireString(markerValue, `idempotency.${identity}.marker.${key}`);
    }
  }
  assertSnapshotRelations(value);
  return structuredClone(value) as unknown as MemoryFileState;
}

function assertSnapshotRelations(state: Record<string, unknown>): void {
  const sources = state["sources"] as Record<string, Record<string, unknown>>;
  const facts = state["facts"] as Record<string, Record<string, unknown>>;
  const proposals = state["proposals"] as Record<string, Record<string, unknown>>;
  const jobs = state["jobs"] as Record<string, Record<string, unknown>>;

  for (const [factId, fact] of Object.entries(facts)) {
    requireReference(fact["sourceId"], sources, `facts.${factId}.sourceId`);
  }
  for (const [proposalId, proposal] of Object.entries(proposals)) {
    requireReference(proposal["sourceId"], sources, `proposals.${proposalId}.sourceId`);
    requireReference(proposal["conflictFactId"], facts, `proposals.${proposalId}.conflictFactId`);
    requireReference(proposal["resolvedFactId"], facts, `proposals.${proposalId}.resolvedFactId`);
  }
  const jobIdentities = new Set<string>();
  for (const [jobId, job] of Object.entries(jobs)) {
    requireReference(job["sourceId"], sources, `jobs.${jobId}.sourceId`);
    const identity = `${String(job["terminalEventId"])}\0${String(job["extractorVersion"])}`;
    if (jobIdentities.has(identity)) {
      throw integrity(`duplicate job terminalEventId/extractorVersion identity at jobs.${jobId}`);
    }
    jobIdentities.add(identity);
  }
}

function requireReference(
  value: unknown,
  targets: Readonly<Record<string, unknown>>,
  field: string,
): void {
  if (value !== undefined && typeof value === "string" && targets[value] === undefined) {
    throw integrity(`${field} references missing entity ${value}`);
  }
}

function assertEntityMap(
  value: unknown,
  workspaceId: WorkspaceId,
  idField: string,
  field: string,
  validate: (value: Record<string, unknown>, field: string) => void,
): void {
  if (!isRecord(value)) throw integrity(`${field} must be an object`);
  for (const [id, entity] of Object.entries(value)) {
    if (!isRecord(entity)) throw integrity(`${field}.${id} must be an object`);
    assertWorkspaceRecord(entity, workspaceId, `${field}.${id}`);
    if (entity[idField] !== id) throw integrity(`${field}.${id} has a mismatched ${idField}`);
    validate(entity, `${field}.${id}`);
  }
}

function assertSettings(value: unknown, workspaceId: WorkspaceId): void {
  if (!isRecord(value)) throw integrity("settings must be an object");
  assertWorkspaceRecord(value, workspaceId, "settings");
  requireBoolean(value["enabled"], "settings.enabled");
  requireBoolean(value["autoPropose"], "settings.autoPropose");
  requireBoolean(value["autoCommit"], "settings.autoCommit");
  requireBoolean(value["injectionEnabled"], "settings.injectionEnabled");
  requireEnum(value["reviewMode"], MEMORY_REVIEW_MODES, "settings.reviewMode");
  requirePositiveInteger(value["version"], "settings.version");
  requireTimestamp(value["updatedAt"], "settings.updatedAt");
}

function assertSource(value: Record<string, unknown>, field: string): void {
  requireString(value["sourceId"], `${field}.sourceId`);
  requireString(value["sessionId"], `${field}.sessionId`);
  requireOptionalString(value["runId"], `${field}.runId`);
  requireOptionalString(value["branchId"], `${field}.branchId`);
  requireStringArray(value["eventIds"], `${field}.eventIds`);
  requireOptionalPositiveInteger(value["startSequence"], `${field}.startSequence`);
  requireOptionalPositiveInteger(value["endSequence"], `${field}.endSequence`);
  requireString(value["digest"], `${field}.digest`);
  requireEnum(value["availability"], SOURCE_AVAILABILITIES, `${field}.availability`);
  requireOptionalTimestamp(value["extractionSuppressedAt"], `${field}.extractionSuppressedAt`);
  requireOptionalTimestamp(value["invalidatedAt"], `${field}.invalidatedAt`);
  requireOptionalString(value["invalidationCode"], `${field}.invalidationCode`);
  // evidenceRef overlay：校验失败时 soft 降级（剥离字段），不 throw 整个 memory。
  // overlay 是可选溯源元数据，与投影层 soft/hard 分级思想一致——
  // 写路径（normalizeSourceInput）也是静默降级，读路径应对称。
  if (value["evidenceRef"] !== undefined) {
    const validation = validateEvidenceRef(value["evidenceRef"]);
    if (!validation.ok) {
      delete value["evidenceRef"];
    }
  }
  requireVersionAndDates(value, field);
}

function assertFact(value: Record<string, unknown>, field: string): void {
  requireString(value["factId"], `${field}.factId`);
  requireEnum(value["kind"], MEMORY_KINDS, `${field}.kind`);
  requireNullableString(value["title"], `${field}.title`);
  requireNullableString(value["content"], `${field}.content`);
  requireConfidence(value["confidence"], `${field}.confidence`);
  requireOptionalString(value["sourceId"], `${field}.sourceId`);
  const state = requireEnum(value["state"], FACT_STATES, `${field}.state`);
  if (state === "forgotten") {
    if (value["title"] !== null || value["content"] !== null) {
      throw integrity(`${field} forgotten tombstone retains text`);
    }
    requireTimestamp(value["forgottenAt"], `${field}.forgottenAt`);
  } else {
    requireString(value["title"], `${field}.title`);
    requireString(value["content"], `${field}.content`);
    if (value["forgottenAt"] !== undefined) {
      throw integrity(`${field} non-forgotten fact has forgottenAt`);
    }
  }
  requireBoolean(value["pinned"], `${field}.pinned`);
  requireOptionalTimestamp(value["expiresAt"], `${field}.expiresAt`);
  requireOptionalTimestamp(value["lastUsedAt"], `${field}.lastUsedAt`);
  requireVersionAndDates(value, field);
  requireOptionalTimestamp(value["forgottenAt"], `${field}.forgottenAt`);
}

function assertProposal(value: Record<string, unknown>, field: string): void {
  requireString(value["proposalId"], `${field}.proposalId`);
  requireEnum(value["kind"], MEMORY_KINDS, `${field}.kind`);
  requireNullableString(value["title"], `${field}.title`);
  requireNullableString(value["content"], `${field}.content`);
  requireNullableString(value["reason"], `${field}.reason`);
  requireConfidence(value["confidence"], `${field}.confidence`);
  requireOptionalString(value["sourceId"], `${field}.sourceId`);
  const status = requireEnum(value["status"], PROPOSAL_STATUSES, `${field}.status`);
  if (
    status === "deleted" &&
    (value["title"] !== null || value["content"] !== null || value["reason"] !== null)
  ) {
    throw integrity(`${field} deleted tombstone retains text`);
  }
  if (status === "deleted") {
    requireTimestamp(value["deletedAt"], `${field}.deletedAt`);
  } else {
    requireString(value["title"], `${field}.title`);
    requireString(value["content"], `${field}.content`);
    requireString(value["reason"], `${field}.reason`);
    if (value["deletedAt"] !== undefined) {
      throw integrity(`${field} non-deleted proposal has deletedAt`);
    }
  }
  requireEnum(value["conflictStatus"], PROPOSAL_CONFLICT_STATUSES, `${field}.conflictStatus`);
  requireOptionalString(value["conflictFactId"], `${field}.conflictFactId`);
  requireOptionalString(value["resolvedFactId"], `${field}.resolvedFactId`);
  requireVersionAndDates(value, field);
  requireOptionalTimestamp(value["reviewedAt"], `${field}.reviewedAt`);
  requireOptionalTimestamp(value["deletedAt"], `${field}.deletedAt`);
}

function assertJob(value: Record<string, unknown>, field: string): void {
  requireString(value["jobId"], `${field}.jobId`);
  requireString(value["type"], `${field}.type`);
  const status = requireEnum(value["status"], MEMORY_JOB_STATUSES, `${field}.status`);
  requireString(value["terminalEventId"], `${field}.terminalEventId`);
  requireString(value["extractorVersion"], `${field}.extractorVersion`);
  const cursor = value["cursor"];
  if (!isRecord(cursor)) throw integrity(`${field}.cursor must be an object`);
  requireString(cursor["sessionId"], `${field}.cursor.sessionId`);
  requireOptionalNonNegativeInteger(cursor["sequence"], `${field}.cursor.sequence`);
  requireOptionalString(cursor["eventId"], `${field}.cursor.eventId`);
  requireOptionalString(value["sourceId"], `${field}.sourceId`);
  requireNonNegativeInteger(value["attemptCount"], `${field}.attemptCount`);
  requirePositiveInteger(value["maxAttempts"], `${field}.maxAttempts`);
  requireOptionalTimestamp(value["nextAttemptAt"], `${field}.nextAttemptAt`);
  requireOptionalString(value["errorCode"], `${field}.errorCode`);
  requireNonNegativeInteger(value["modelCalls"], `${field}.modelCalls`);
  requireNonNegativeInteger(value["inputTokens"], `${field}.inputTokens`);
  requireNonNegativeInteger(value["outputTokens"], `${field}.outputTokens`);
  requireNonNegativeNumber(value["costUsd"], `${field}.costUsd`);
  requireVersionAndDates(value, field);
  if (status === "succeeded" || status === "failed" || status === "cancelled") {
    requireTimestamp(value["terminalAt"], `${field}.terminalAt`);
  } else if (value["terminalAt"] !== undefined) {
    throw integrity(`${field} non-terminal job has terminalAt`);
  }
}

function requireVersionAndDates(value: Record<string, unknown>, field: string): void {
  requirePositiveInteger(value["version"], `${field}.version`);
  requireTimestamp(value["createdAt"], `${field}.createdAt`);
  requireTimestamp(value["updatedAt"], `${field}.updatedAt`);
}

function assertWorkspaceRecord(value: unknown, workspaceId: WorkspaceId, field: string): void {
  if (!isRecord(value) || value["workspaceId"] !== workspaceId) {
    throw integrity(`${field} belongs to another workspace`);
  }
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw integrity(`${field} must be a non-empty string`);
  }
  return value;
}

function requireOptionalString(value: unknown, field: string): void {
  if (value !== undefined) requireString(value, field);
}

function requireNullableString(value: unknown, field: string): void {
  if (value !== null) requireString(value, field);
}

function requireBoolean(value: unknown, field: string): void {
  if (typeof value !== "boolean") throw integrity(`${field} must be a boolean`);
}

function requireEnum<const Value extends string>(
  value: unknown,
  allowed: readonly Value[],
  field: string,
): Value {
  if (typeof value !== "string" || !allowed.includes(value as Value)) {
    throw integrity(`${field} has an unsupported value`);
  }
  return value as Value;
}

function requireStringArray(value: unknown, field: string): void {
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== "string" || item.length === 0)
  ) {
    throw integrity(`${field} must be an array of non-empty strings`);
  }
}

function requirePositiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw integrity(`${field} must be a positive integer`);
  }
  return value as number;
}

function requireOptionalPositiveInteger(value: unknown, field: string): void {
  if (value !== undefined) requirePositiveInteger(value, field);
}

function requireNonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw integrity(`${field} must be a non-negative integer`);
  }
  return value as number;
}

function requireOptionalNonNegativeInteger(value: unknown, field: string): void {
  if (value !== undefined) requireNonNegativeInteger(value, field);
}

function requireNonNegativeNumber(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw integrity(`${field} must be a non-negative number`);
  }
}

function requireConfidence(value: unknown, field: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw integrity(`${field} must be between 0 and 1`);
  }
}

function requireTimestamp(value: unknown, field: string): void {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw integrity(`${field} must be an ISO timestamp`);
  }
}

function requireOptionalTimestamp(value: unknown, field: string): void {
  if (value !== undefined) requireTimestamp(value, field);
}

function requireHash(value: unknown, field: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw integrity(`${field} must be a SHA-256 digest`);
  }
  return value;
}

function integrity(message: string): FileStorageIntegrityError {
  return new FileStorageIntegrityError(`Memory state is invalid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
