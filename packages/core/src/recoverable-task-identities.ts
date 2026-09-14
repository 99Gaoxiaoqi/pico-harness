import { createHash } from "node:crypto";
import {
  RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION,
  type RecoverableTaskLaunchReceipt,
} from "./task-run-contract.js";

export interface RecoverableTaskRuntimeLaunchIdentity {
  readonly runId: string;
  readonly runStartedEventId: string;
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

export function deriveRecoverableTaskResumeIdentity(
  taskRunId: string,
  sourceAttemptId: string,
  attemptNumber: number,
): string {
  if (!taskRunId.trim()) throw new Error("Recoverable task taskRunId must not be empty");
  if (!sourceAttemptId.trim()) {
    throw new Error("Recoverable task sourceAttemptId must not be empty");
  }
  if (!Number.isSafeInteger(attemptNumber) || attemptNumber <= 0) {
    throw new Error("Recoverable task attemptNumber must be a positive safe integer");
  }
  return createHash("sha256")
    .update(JSON.stringify(["task-resume-v1", taskRunId, sourceAttemptId, attemptNumber]))
    .digest("hex");
}

export function deriveRecoverableTaskLaunchId(
  taskRunId: string,
  sourceAttemptId: string,
  attemptNumber: number,
): string {
  return `launch:${deriveRecoverableTaskResumeIdentity(taskRunId, sourceAttemptId, attemptNumber)}`;
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
