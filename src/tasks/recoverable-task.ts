import { createHash } from "node:crypto";
import type { RecoverableTaskAdapterIdentity, TaskSafeBoundary } from "./task-run-contract.js";

export interface RecoverableTaskResumeContext {
  readonly taskRunId: string;
  readonly sourceAttemptId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  /** Stable across lease takeover and retries; the adapter must deduplicate the actual launch. */
  readonly launchId: string;
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly boundary: TaskSafeBoundary;
  readonly checkpointRef: string;
}

/**
 * A task is recoverable only when a named, versioned adapter explicitly opts in.
 * The adapter receives the immutable input persisted in the TaskRun header and a
 * fresh Attempt context; it never receives or revives the old JavaScript stack.
 */
export interface RecoverableTaskAdapter {
  readonly adapterId: string;
  readonly version: number;
  /** Explicit promise that repeated resume calls with one launchId produce one actual launch. */
  readonly launchMode: "idempotent";
  readonly validateInput?: (input: Readonly<Record<string, unknown>>) => void;
  readonly resume: (
    input: Readonly<Record<string, unknown>>,
    context: RecoverableTaskResumeContext,
  ) => void | Promise<void>;
}

export type RecoverableTaskAdapterResolution =
  | {
      readonly status: "found";
      readonly adapter: RecoverableTaskAdapter;
    }
  | {
      readonly status: "missing";
      readonly adapterId: string;
    }
  | {
      readonly status: "version_mismatch";
      readonly adapterId: string;
      readonly requestedVersion: number;
      readonly availableVersions: readonly number[];
    };

export class RecoverableTaskRegistry {
  private readonly adapters = new Map<string, Map<number, RecoverableTaskAdapter>>();

  register(adapter: RecoverableTaskAdapter): () => void {
    assertAdapter(adapter);
    const versions = this.adapters.get(adapter.adapterId) ?? new Map();
    if (versions.has(adapter.version)) {
      throw new Error(
        `Recoverable task adapter ${adapter.adapterId}@${adapter.version} is already registered`,
      );
    }
    versions.set(adapter.version, Object.freeze({ ...adapter }));
    this.adapters.set(adapter.adapterId, versions);
    return () => {
      const current = this.adapters.get(adapter.adapterId);
      if (!current || current.get(adapter.version) !== versions.get(adapter.version)) return;
      current.delete(adapter.version);
      if (current.size === 0) this.adapters.delete(adapter.adapterId);
    };
  }

  resolve(adapterId: string, version: number): RecoverableTaskAdapterResolution {
    const versions = this.adapters.get(adapterId);
    if (!versions) return { status: "missing", adapterId };
    const adapter = versions.get(version);
    if (adapter) return { status: "found", adapter };
    return {
      status: "version_mismatch",
      adapterId,
      requestedVersion: version,
      availableVersions: [...versions.keys()].sort((left, right) => left - right),
    };
  }
}

export function prepareRecoverableTaskInput(
  identity: RecoverableTaskAdapterIdentity,
  adapter: RecoverableTaskAdapter,
): Readonly<Record<string, unknown>> {
  const input = immutableJsonRecord(identity.input);
  const actualHash = hashRecoverableTaskInput(input);
  if (actualHash !== identity.inputHash) {
    throw new Error(
      `Recoverable task input hash mismatch for ${identity.id}@${identity.version}: expected ${identity.inputHash}, got ${actualHash}`,
    );
  }
  adapter.validateInput?.(input);
  return input;
}

export function hashRecoverableTaskInput(input: Readonly<Record<string, unknown>>): string {
  return createHash("sha256")
    .update(canonicalJson(input, "$", new Set()))
    .digest("hex");
}

function assertAdapter(adapter: RecoverableTaskAdapter): void {
  if (!adapter.adapterId.trim()) throw new Error("Recoverable task adapterId must not be empty");
  if (!Number.isSafeInteger(adapter.version) || adapter.version <= 0) {
    throw new Error("Recoverable task adapter version must be a positive safe integer");
  }
  if (typeof adapter.resume !== "function") {
    throw new Error(`Recoverable task adapter ${adapter.adapterId} must implement resume`);
  }
  if (adapter.launchMode !== "idempotent") {
    throw new Error(
      `Recoverable task adapter ${adapter.adapterId} must promise idempotent launch semantics`,
    );
  }
}

function immutableJsonRecord(
  input: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  const cloned = cloneJson(input, "$", new Set());
  if (!isRecord(cloned)) throw new Error("Recoverable task input must be a JSON object");
  return cloned;
}

function cloneJson(value: unknown, path: string, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return Object.is(value, -0) ? 0 : value;
  }
  if (Array.isArray(value)) {
    assertNotCyclic(value, path, seen);
    const cloned = value.map((entry, index) => cloneJson(entry, `${path}[${index}]`, seen));
    seen.delete(value);
    return Object.freeze(cloned);
  }
  if (!isRecord(value)) {
    throw new Error(`${path} must contain only JSON values`);
  }
  assertNotCyclic(value, path, seen);
  const cloned: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    cloned[key] = cloneJson(value[key], `${path}.${key}`, seen);
  }
  seen.delete(value);
  return Object.freeze(cloned);
}

function canonicalJson(value: unknown, path: string, seen: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Recoverable task input must be valid JSON");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) {
    assertNotCyclic(value, path, seen);
    const json = `[${value
      .map((entry, index) => canonicalJson(entry, `${path}[${index}]`, seen))
      .join(",")}]`;
    seen.delete(value);
    return json;
  }
  if (!isRecord(value)) throw new Error("Recoverable task input must be valid JSON");
  assertNotCyclic(value, path, seen);
  const json = `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key], `${path}.${key}`, seen)}`)
    .join(",")}}`;
  seen.delete(value);
  return json;
}

function assertNotCyclic(value: object, path: string, seen: Set<object>): void {
  if (seen.has(value)) throw new Error(`${path} must not contain cyclic values`);
  seen.add(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
