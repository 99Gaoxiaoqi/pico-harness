import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAgentGraphRuntimeActivation,
  type AgentGraphRunLaunchState,
} from "../../src/agent-graph/runtime-activation-projection.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import type { AgentGraphActivationClaimRecord } from "../../src/storage/sqlite/agent-graph-store-types.js";

const CLAIM: AgentGraphActivationClaimRecord = {
  claimId: "claim-1",
  graphId: "graph-1",
  intentId: "intent-1",
  operatorId: "operator-1",
  operatorGeneration: 1,
  scheduleRevision: 1,
  intentFingerprint: "sha256:intent",
  readinessFingerprint: "sha256:ready",
  state: "executing",
  targetSessionId: "session-1",
  targetTurnId: "turn-1",
  targetRunId: "run-1",
  targetInvocationId: "invocation-1",
  runStartedEventId: "run-started-1",
  version: 2,
  claimedAt: 1,
  executingAt: 2,
};

test("canonical Graph activation projection applies one host-liveness precedence table", () => {
  const started = runStartedEvent();
  const cases: readonly {
    readonly name: string;
    readonly events: readonly RuntimeEvent[];
    readonly launchState: AgentGraphRunLaunchState;
    readonly expected: string;
  }[] = [
    {
      name: "durable terminal wins over a stale host failure",
      events: [started, terminalEvent("completed")],
      launchState: { status: "failed", error: "stale" },
      expected: "completed",
    },
    {
      name: "live host keeps a started run running",
      events: [started],
      launchState: { status: "running" },
      expected: "running",
    },
    {
      name: "host failure refines a nonterminal ledger",
      events: [started],
      launchState: { status: "failed" },
      expected: "failed",
    },
    {
      name: "host cancellation remains distinct",
      events: [started],
      launchState: { status: "cancelled" },
      expected: "cancelled",
    },
    {
      name: "daemon restart remains interrupted",
      events: [started],
      launchState: { status: "interrupted" },
      expected: "interrupted",
    },
    {
      name: "host success without a durable terminal fails closed",
      events: [started],
      launchState: { status: "succeeded" },
      expected: "interrupted",
    },
    {
      name: "unknown host after provider dispatch is not attachable",
      events: [started, providerDispatchEvent()],
      launchState: { status: "unknown" },
      expected: "interrupted",
    },
    {
      name: "started-only unknown host remains attachable",
      events: [started],
      launchState: { status: "unknown" },
      expected: "running",
    },
  ];

  for (const fixture of cases) {
    assert.equal(
      projectAgentGraphRuntimeActivation({
        claim: CLAIM,
        events: fixture.events,
        launchState: fixture.launchState,
      }).status,
      fixture.expected,
      fixture.name,
    );
  }
});

function eventBase(eventId: string) {
  return {
    schemaVersion: 2 as const,
    eventId,
    sessionId: CLAIM.targetSessionId,
    invocationId: CLAIM.targetInvocationId,
    runId: CLAIM.targetRunId,
    turnId: CLAIM.targetTurnId,
    at: "2026-08-28T00:00:00.000Z",
    partial: false as const,
    visibility: "internal" as const,
  };
}

function runStartedEvent(): Extract<RuntimeEvent, { kind: "run.started" }> {
  return {
    ...eventBase(CLAIM.runStartedEventId),
    kind: "run.started",
    data: { workDir: "/workspace" },
  };
}

function terminalEvent(
  status: "completed" | "failed" | "cancelled",
): Extract<RuntimeEvent, { kind: "run.terminal" }> {
  return {
    ...eventBase(`terminal-${status}`),
    kind: "run.terminal",
    data: { status },
  };
}

function providerDispatchEvent(): Extract<RuntimeEvent, { kind: "model.call.started" }> {
  return {
    ...eventBase("provider-dispatch-1"),
    kind: "model.call.started",
    data: { providerCallId: "provider-call-1", purpose: "main" },
  };
}
