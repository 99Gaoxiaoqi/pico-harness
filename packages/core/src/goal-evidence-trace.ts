import type { RuntimeToolResultStatus } from "./tool-result.js";

export interface GoalEvidenceIdentity {
  readonly goalId: string;
  readonly goalRevision: number;
  readonly generation: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly invocationId: string;
  readonly runStartedEventId: string;
  readonly terminalEventId: string;
  readonly throughSequence: number;
}
export interface GoalEvidenceReference {
  readonly eventId: string;
  readonly kind: "tool" | "message";
  readonly toolCallId?: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
  readonly status?: RuntimeToolResultStatus;
  readonly truncated: boolean;
}
/** Immutable references to the frozen evidence input, persisted with Goal state. */
export interface GoalEvidenceTrace {
  readonly version: 1;
  readonly traceId: string;
  readonly sourceRunId: string;
  readonly identity: GoalEvidenceIdentity;
  readonly coverage: "complete" | "limited" | "unavailable";
  readonly providedEvidence: readonly GoalEvidenceReference[];
  readonly citedEvidenceIds: readonly string[];
  readonly gateReason?: string;
}
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: readonly string[]) =>
  Object.keys(v).every((k) => allowed.includes(k));
const text = (v: unknown) => typeof v === "string" && v.length <= 1024;
const nonempty = (v: unknown) => text(v) && (v as string).length > 0;
const integer = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
export function isGoalEvidenceTrace(v: unknown): v is GoalEvidenceTrace {
  if (
    !record(v) ||
    !keys(v, [
      "version",
      "traceId",
      "sourceRunId",
      "identity",
      "coverage",
      "providedEvidence",
      "citedEvidenceIds",
      "gateReason",
    ])
  )
    return false;
  const i = v["identity"];
  if (
    !record(i) ||
    !keys(i, [
      "goalId",
      "goalRevision",
      "generation",
      "sessionId",
      "runId",
      "turnId",
      "invocationId",
      "runStartedEventId",
      "terminalEventId",
      "throughSequence",
    ])
  )
    return false;
  return (
    v["version"] === 1 &&
    nonempty(v["traceId"]) &&
    nonempty(v["sourceRunId"]) &&
    v["sourceRunId"] === i["runId"] &&
    ["complete", "limited", "unavailable"].includes(v["coverage"] as string) &&
    ["goalId", "sessionId", "runId", "turnId", "invocationId"].every((k) => nonempty(i[k])) &&
    ["runStartedEventId", "terminalEventId"].every((k) => text(i[k])) &&
    ["goalRevision", "generation", "throughSequence"].every((k) => integer(i[k])) &&
    Array.isArray(v["providedEvidence"]) &&
    v["providedEvidence"].length <= 19 &&
    v["providedEvidence"].every(
      (r) =>
        record(r) &&
        keys(r, ["eventId", "kind", "toolCallId", "sha256", "sizeBytes", "status", "truncated"]) &&
        nonempty(r["eventId"]) &&
        ["tool", "message"].includes(r["kind"] as string) &&
        (r["toolCallId"] === undefined || nonempty(r["toolCallId"])) &&
        (r["sha256"] === undefined ||
          (typeof r["sha256"] === "string" && /^[a-f0-9]{64}$/.test(r["sha256"]))) &&
        integer(r["sizeBytes"]) &&
        (r["status"] === undefined ||
          ["succeeded", "failed", "rejected", "cancelled", "interrupted"].includes(
            r["status"] as string,
          )) &&
        typeof r["truncated"] === "boolean",
    ) &&
    Array.isArray(v["citedEvidenceIds"]) &&
    v["citedEvidenceIds"].length <= 19 &&
    v["citedEvidenceIds"].every(nonempty) &&
    (v["gateReason"] === undefined || text(v["gateReason"]))
  );
}
