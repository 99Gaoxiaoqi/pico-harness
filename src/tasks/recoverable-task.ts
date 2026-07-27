import { createHash } from "node:crypto";
import {
  RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION,
  type RecoverableTaskAdapterIdentity,
  type RecoverableTaskLaunchReceipt,
  type TaskSafeBoundary,
} from "./task-run-contract.js";

export interface RecoverableTaskResumeContext {
  readonly taskRunId: string;
  readonly sourceAttemptId: string;
  readonly attemptId: string;
  readonly attemptNumber: number;
  /** Stable across lease takeover and retries; the adapter must deduplicate the actual launch. */
  readonly launchId: string;
  readonly ownerId: string;
  readonly leaseEpoch: number;
  readonly executionLeaseExpiresAt: string;
  readonly runtimeSessionId: string;
  readonly expectedRuntimeRunId: string;
  readonly expectedRunStartedEventId: string;
  readonly expectedSessionHighWater: number;
  readonly boundary: TaskSafeBoundary;
  readonly checkpointRef: string;
}

export interface RecoverableTaskRuntimeLaunchIdentity {
  readonly runId: string;
  readonly runStartedEventId: string;
}

/**
 * A task is recoverable only when a named, versioned adapter explicitly opts in.
 * The adapter receives the immutable input persisted in the TaskRun header and a
 * fresh Attempt context; it never receives or revives the old JavaScript stack.
 */
export interface RecoverableTaskAdapter {
  readonly adapterId: string;
  readonly version: number;
  /**
   * Repeated calls with one launchId must install or confirm one durable execution intent/worker
   * for the deterministic Runtime run without repeating provider, tool, or other external effects.
   *
   * The adapter must publish the expected run.started with the supplied Session high-water CAS
   * before starting provider, tool, or other external effects. A failed CAS must leave side effects
   * at zero. The run.started fact proves only Runtime admission: `resume` must not return its receipt
   * until the durable worker intent has also been installed or confirmed. A coordinator may call
   * `resume` again after observing run.started when a prior call crashed before TaskRun settlement.
   */
  readonly launchMode: "idempotent";
  readonly validateInput?: (input: Readonly<Record<string, unknown>>) => void;
  readonly resume: (
    input: Readonly<Record<string, unknown>>,
    context: RecoverableTaskResumeContext,
  ) => RecoverableTaskLaunchReceipt | Promise<RecoverableTaskLaunchReceipt>;
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

export function deriveRecoverableTaskRuntimeLaunchIdentity(
  launchId: string,
): RecoverableTaskRuntimeLaunchIdentity {
  if (!launchId.trim()) throw new Error("Recoverable task launchId must not be empty");
  const digest = createHash("sha256")
    .update(JSON.stringify(["recoverable-task-runtime-launch-v1", launchId]))
    .digest("hex");
  return {
    runId: `run:task-resume:${digest}`,
    runStartedEventId: `runtime-event:task-resume-started:${digest}`,
  };
}

export function validateRecoverableTaskLaunchReceipt(value: unknown): RecoverableTaskLaunchReceipt {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "launchId",
      "runId",
      "runStartedEventId",
      "runStartedSequence",
      "schemaVersion",
      "sessionId",
    ]) ||
    value["schemaVersion"] !== RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION ||
    !isNonEmptyString(value["launchId"]) ||
    !isNonEmptyString(value["sessionId"]) ||
    !isNonEmptyString(value["runId"]) ||
    !isNonEmptyString(value["runStartedEventId"]) ||
    !Number.isSafeInteger(value["runStartedSequence"]) ||
    (value["runStartedSequence"] as number) <= 0
  ) {
    throw new Error("Recoverable task adapter returned an invalid launch receipt");
  }
  return Object.freeze({
    schemaVersion: RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION,
    launchId: value["launchId"],
    sessionId: value["sessionId"],
    runId: value["runId"],
    runStartedEventId: value["runStartedEventId"],
    runStartedSequence: value["runStartedSequence"] as number,
  });
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

function hasExactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
