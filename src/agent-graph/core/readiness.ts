import type { AgentGraphActivationIntent, AgentGraphRecordRef } from "./contracts.js";
import { deterministicFingerprint } from "./ids.js";

export type AgentGraphReadinessStatus = "resolved" | "in_flight" | "failed" | "unknown";

export interface AgentGraphReadinessFacts {
  readonly records: readonly AgentGraphRecordRef[];
  readonly inFlightRecordIds?: readonly string[];
  readonly failedRecordIds?: readonly string[];
}

export interface AgentGraphReadiness {
  readonly status: AgentGraphReadinessStatus;
  readonly resolvedRecords: readonly AgentGraphRecordRef[];
  readonly inFlightRecordIds: readonly string[];
  readonly failedRecordIds: readonly string[];
  readonly unknownRecordIds: readonly string[];
  readonly fingerprint: string;
}

export class AgentGraphReadinessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentGraphReadinessError";
  }
}

function assertDisjointFacts(facts: AgentGraphReadinessFacts): void {
  const classifications = new Map<string, string>();
  const entries: readonly [string, readonly string[]][] = [
    ["resolved", facts.records.map((record) => record.recordId)],
    ["in_flight", facts.inFlightRecordIds ?? []],
    ["failed", facts.failedRecordIds ?? []],
  ];
  for (const [classification, ids] of entries) {
    for (const id of ids) {
      const prior = classifications.get(id);
      if (prior && prior !== classification) {
        throw new AgentGraphReadinessError(
          `Input record ${id} has conflicting ${prior} and ${classification} facts`,
        );
      }
      classifications.set(id, classification);
    }
  }
}

export function resolveIntentReadiness(
  intent: AgentGraphActivationIntent,
  facts: AgentGraphReadinessFacts,
): AgentGraphReadiness {
  assertDisjointFacts(facts);
  for (const record of facts.records) {
    if (record.graphId !== intent.graphId) {
      throw new AgentGraphReadinessError(
        `Input record ${record.recordId} belongs to another Graph`,
      );
    }
  }
  const recordsById = new Map(facts.records.map((record) => [record.recordId, record]));
  const inFlightIds = new Set(facts.inFlightRecordIds ?? []);
  const failedIds = new Set(facts.failedRecordIds ?? []);
  const resolvedRecords: AgentGraphRecordRef[] = [];
  const inFlightRecordIds: string[] = [];
  const failedRecordIds: string[] = [];
  const unknownRecordIds: string[] = [];

  for (const input of intent.inputRefs) {
    const record = recordsById.get(input.recordId);
    if (record) resolvedRecords.push(record);
    else if (inFlightIds.has(input.recordId)) inFlightRecordIds.push(input.recordId);
    else if (failedIds.has(input.recordId)) failedRecordIds.push(input.recordId);
    else unknownRecordIds.push(input.recordId);
  }

  const status: AgentGraphReadinessStatus =
    unknownRecordIds.length > 0
      ? "unknown"
      : failedRecordIds.length > 0
        ? "failed"
        : inFlightRecordIds.length > 0
          ? "in_flight"
          : "resolved";
  const fingerprint = deterministicFingerprint({
    intentId: intent.intentId,
    resolvedRecordIds: resolvedRecords.map((record) => record.recordId),
    inFlightRecordIds,
    failedRecordIds,
    unknownRecordIds,
  });
  return {
    status,
    resolvedRecords,
    inFlightRecordIds,
    failedRecordIds,
    unknownRecordIds,
    fingerprint,
  };
}
