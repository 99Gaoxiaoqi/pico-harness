import type { WorkspaceId } from "../paths/pico-paths.js";
import type { Fact, Job, Mutation, Proposal, Settings, Source } from "./domain.js";
import { FileStorageIntegrityError } from "../storage/local-file-storage.js";

export const MEMORY_FILE_SCHEMA_VERSION = 1 as const;

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
    throw integrity(
      `unsupported schemaVersion ${String(value["schemaVersion"])}; expected ${MEMORY_FILE_SCHEMA_VERSION}`,
    );
  }
  if (value["workspaceId"] !== workspaceId) {
    throw integrity(`state belongs to workspace ${String(value["workspaceId"])}, not ${workspaceId}`);
  }
  if (!Number.isSafeInteger(value["revision"]) || (value["revision"] as number) < 0) {
    throw integrity("revision must be a non-negative integer");
  }
  for (const field of ["settings", "sources", "facts", "proposals", "jobs", "idempotency"]) {
    if (!isRecord(value[field])) throw integrity(`${field} must be an object`);
  }
  if (!Array.isArray(value["mutations"])) throw integrity("mutations must be an array");
  assertWorkspaceRecord(value["settings"], workspaceId, "settings");
  assertEntityMap(value["sources"], workspaceId, "sourceId", "sources");
  assertEntityMap(value["facts"], workspaceId, "factId", "facts");
  assertEntityMap(value["proposals"], workspaceId, "proposalId", "proposals");
  assertEntityMap(value["jobs"], workspaceId, "jobId", "jobs");
  let expectedSequence = 1;
  for (const mutation of value["mutations"]) {
    if (!isRecord(mutation)) throw integrity("mutation must be an object");
    assertWorkspaceRecord(mutation, workspaceId, "mutation");
    if (mutation["sequence"] !== expectedSequence) {
      throw integrity(`mutation sequence must be contiguous at ${expectedSequence}`);
    }
    for (const forbidden of ["title", "content", "reason", "body"]) {
      if (forbidden in mutation) throw integrity(`mutation audit must not contain ${forbidden}`);
    }
    expectedSequence++;
  }
  const idempotencyMap = value["idempotency"];
  if (!isRecord(idempotencyMap)) throw integrity("idempotency must be an object");
  for (const [identity, idempotency] of Object.entries(idempotencyMap)) {
    if (!isRecord(idempotency)) throw integrity(`idempotency ${identity} must be an object`);
    if (
      typeof idempotency["operation"] !== "string" ||
      typeof idempotency["keyHash"] !== "string" ||
      typeof idempotency["requestHash"] !== "string" ||
      !isRecord(idempotency["marker"]) ||
      typeof idempotency["createdAt"] !== "string"
    ) {
      throw integrity(`idempotency ${identity} is malformed`);
    }
  }
  return structuredClone(value) as unknown as MemoryFileState;
}

function assertEntityMap(
  value: unknown,
  workspaceId: WorkspaceId,
  idField: string,
  field: string,
): void {
  if (!isRecord(value)) throw integrity(`${field} must be an object`);
  for (const [id, entity] of Object.entries(value)) {
    if (!isRecord(entity)) throw integrity(`${field}.${id} must be an object`);
    assertWorkspaceRecord(entity, workspaceId, `${field}.${id}`);
    if (entity[idField] !== id) throw integrity(`${field}.${id} has a mismatched ${idField}`);
  }
}

function assertWorkspaceRecord(
  value: unknown,
  workspaceId: WorkspaceId,
  field: string,
): void {
  if (!isRecord(value) || value["workspaceId"] !== workspaceId) {
    throw integrity(`${field} belongs to another workspace`);
  }
}

function integrity(message: string): FileStorageIntegrityError {
  return new FileStorageIntegrityError(`Memory state is invalid: ${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
