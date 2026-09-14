import { createHash } from "node:crypto";

import type { RuntimeEvent, RuntimeRunStartedEvent } from "@pico/core";
import { RuntimeEventStoreIntegrityError } from "@pico/storage/runtime-event-store-contracts";
import { canonicalizeWorkspacePath } from "@pico/storage/workspace-path";

import type {
  AgentGraphExactRunInspection,
  StartExactAgentGraphRunInput,
} from "./agent-graph-runtime-adapter.js";

export function inspectAgentGraphExactRun(
  input: StartExactAgentGraphRunInput,
  events: readonly RuntimeEvent[],
  live = false,
): AgentGraphExactRunInspection {
  if (events.length === 0) return { status: "not_started" };
  const start = requireExactStart(input, events);
  const terminals = events.filter(
    (event): event is Extract<RuntimeEvent, { kind: "run.terminal" }> =>
      event.kind === "run.terminal",
  );
  if (terminals.length > 1) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph RuntimeRun ${input.runId} has conflicting terminal facts`,
    );
  }
  if (terminals[0]) {
    return { status: "terminal", startEvent: start, terminalEvent: terminals[0] };
  }
  if (live) return { status: "live", startEvent: start };

  const providerDispatches = events.filter((event) => event.kind === "model.call.started");
  if (providerDispatches.length > 0) {
    return {
      status: "indeterminate",
      reason: "provider_dispatch_recorded",
      startEvent: start,
      blockingEventIds: providerDispatches.map((event) => event.eventId),
    };
  }
  const toolDispatches = events.filter((event) => event.kind === "tool.started");
  if (toolDispatches.length > 0) {
    return {
      status: "indeterminate",
      reason: "tool_dispatch_recorded",
      startEvent: start,
      blockingEventIds: toolDispatches.map((event) => event.eventId),
    };
  }

  const inputEventId = agentGraphInputRuntimeEventId(input.claimId);
  const allowedInput = events.find((event) => event.eventId === inputEventId);
  if (
    allowedInput &&
    (allowedInput.kind !== "message.committed" || allowedInput.data.message.role !== "user")
  ) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph input event ${inputEventId} is bound to an incompatible Runtime fact`,
    );
  }
  const unexpected = events.filter(
    (event) => event.kind !== "run.started" && event.eventId !== inputEventId,
  );
  if (unexpected.length > 0) {
    return {
      status: "indeterminate",
      reason: "unexpected_runtime_fact",
      startEvent: start,
      blockingEventIds: unexpected.map((event) => event.eventId),
    };
  }
  return {
    status: "attachable",
    startEvent: start,
    input: allowedInput ? "committed" : "missing",
  };
}

export function agentGraphInputMessageId(claimId: string): string {
  return `agent-graph-input:${createHash("sha256").update(claimId).digest("hex")}`;
}

export function agentGraphInputRuntimeEventId(claimId: string): string {
  return `user-message:${agentGraphInputMessageId(claimId)}`;
}

function requireExactStart(
  input: StartExactAgentGraphRunInput,
  events: readonly RuntimeEvent[],
): RuntimeRunStartedEvent {
  for (const event of events) {
    if (
      event.sessionId !== input.sessionId ||
      event.runId !== input.runId ||
      event.invocationId !== input.invocationId
    ) {
      throw new RuntimeEventStoreIntegrityError(
        `Graph RuntimeRun ${input.runId} contains a conflicting event identity`,
      );
    }
  }
  const starts = events.filter(
    (event): event is RuntimeRunStartedEvent => event.kind === "run.started",
  );
  if (starts.length !== 1) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph RuntimeRun ${input.runId} must contain exactly one run.started fact`,
    );
  }
  const start = starts[0]!;
  if (
    start.eventId !== input.runStartedEventId ||
    start.turnId !== input.turnId ||
    canonicalizeWorkspacePath(start.data.workDir) !== canonicalizeWorkspacePath(input.workDir)
  ) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph RuntimeRun ${input.runId} does not match its preallocated Claim identity`,
    );
  }
  return start;
}
