import { createHash } from "node:crypto";

import type {
  AgentGraphOperationSource,
  AgentGraphScheduleCommand,
  AgentGraphScheduleRevision,
} from "./contracts.js";

export class AgentGraphIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGraphIdentityError";
  }
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AgentGraphIdentityError("Graph identity input numbers must be finite");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(",")}]`;
  }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalize(item)}`)
      .join(",")}}`;
  }
  throw new AgentGraphIdentityError("Graph identity input must contain only plain JSON values");
}

export function deterministicFingerprint(value: unknown): string {
  const digest = createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
  return `sha256:${digest}`;
}

function deterministicId(prefix: string, parts: readonly (number | string)[]): string {
  return `${prefix}_${deterministicFingerprint(parts).slice("sha256:".length, 39)}`;
}

export function graphIdFor(rootSessionId: string, epoch: number): string {
  return deterministicId("graph", [rootSessionId, epoch]);
}

export function operatorIdFor(graphId: string, stableKey: string): string {
  return deterministicId("operator", [graphId, stableKey]);
}

export function intentIdFor(graphId: string, operationId: string, index: number): string {
  return deterministicId("intent", [graphId, operationId, index]);
}

export function provisionIdFor(graphId: string, operatorId: string, generation: number): string {
  return deterministicId("provision", [graphId, operatorId, generation]);
}

export function claimIdFor(graphId: string, intentId: string): string {
  return deterministicId("claim", [graphId, intentId]);
}

export function recordIdFor(claimId: string, sourceEventId: string): string {
  return deterministicId("record", [claimId, sourceEventId]);
}

export function wakeIdFor(graphId: string, dedupeKey: string): string {
  return deterministicId("wake", [graphId, dedupeKey]);
}

export interface AgentGraphScheduleOperationIdentity {
  readonly graphId: string;
  readonly operationId: string;
  readonly source: AgentGraphOperationSource;
  readonly commands: readonly AgentGraphScheduleCommand[];
}

export function scheduleOperationFingerprint(
  operation: AgentGraphScheduleOperationIdentity,
): string {
  return deterministicFingerprint({
    graphId: operation.graphId,
    operationId: operation.operationId,
    source: operation.source,
    commands: operation.commands,
  });
}

export function createScheduleRevision(
  input: Omit<AgentGraphScheduleRevision, "fingerprint">,
): AgentGraphScheduleRevision {
  return {
    ...input,
    fingerprint: scheduleOperationFingerprint(input),
  };
}
