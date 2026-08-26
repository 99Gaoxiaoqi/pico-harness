import assert from "node:assert/strict";
import test from "node:test";

import type { AgentGraphExactRunInspection } from "../../src/runtime/agent-graph-exact-run-port.js";
import {
  AgentGraphRootWakeRuntimePort,
  renderRootWakePrompt,
  rootWakeState,
} from "../../src/runtime/agent-graph-root-wake-port.js";
import type { StartExactAgentGraphRunInput } from "../../src/runtime/agent-graph-runtime-adapter.js";

const identity = {
  wakeId: "wake-1",
  graphId: "graph-1",
  rootSessionId: "root-session-1",
  targetTurnId: "root-turn-2",
  targetRunId: "root-run-2",
} as const;

test("root wake starts one exact root RuntimeRun with deterministic identities", async () => {
  const starts: StartExactAgentGraphRunInput[] = [];
  let launchLive = false;
  let inspection: AgentGraphExactRunInspection = { status: "not_started" };
  const port = new AgentGraphRootWakeRuntimePort({
    workDir: "/tmp/graph-root",
    isLaunchLive: () => launchLive,
    exactRuns: {
      inspectExactRun: async () => inspection,
      startExactRun: async (input) => {
        starts.push(input);
        launchLive = true;
        inspection = {
          status: "attachable",
          input: "committed",
          startEvent: {
            schemaVersion: 2,
            eventId: input.runStartedEventId,
            sessionId: input.sessionId,
            invocationId: input.invocationId,
            runId: input.runId,
            turnId: input.turnId,
            at: "2026-08-27T00:00:00.000Z",
            partial: false,
            visibility: "internal",
            kind: "run.started",
            data: { workDir: input.workDir },
          },
        };
        return "started";
      },
    },
  });

  assert.deepEqual(await port.inspect(identity), { status: "not_started" });
  assert.deepEqual(await port.startOrResume({ ...identity, payload: { claimId: "claim-1" } }), {
    status: "running",
  });
  assert.equal(starts.length, 1);
  assert.equal(starts[0]!.claimId, "root-wake:wake-1");
  assert.equal(starts[0]!.turnId, identity.targetTurnId);
  assert.equal(starts[0]!.runId, identity.targetRunId);
  assert.match(starts[0]!.prompt, /view_agent_graph/);
  assert.doesNotMatch(starts[0]!.prompt, /claim-1/);
});

test("indeterminate exact root Run parks at manual intervention boundary", () => {
  const state = rootWakeState({
    status: "indeterminate",
    reason: "provider_dispatch_recorded",
    blockingEventIds: ["model-call-1"],
    startEvent: {} as never,
  });
  assert.equal(state.status, "manual_intervention");
  assert.deepEqual(
    state.status === "manual_intervention" ? state.blockingEventIds : undefined,
    ["model-call-1"],
  );
});

test("root wake prompt never interprets durable payload as model instructions", () => {
  const prompt = renderRootWakePrompt(identity);
  assert.match(prompt, /view_agent_graph/);
  assert.doesNotMatch(prompt, /payload/i);
});

test("root wake defers while the source root Session is still active", async () => {
  let starts = 0;
  const port = new AgentGraphRootWakeRuntimePort({
    workDir: "/tmp/graph-root",
    preflight: () => "source_root_active",
    exactRuns: {
      inspectExactRun: async () => ({ status: "not_started" }),
      startExactRun: async () => {
        starts += 1;
        return "started";
      },
    },
  });
  assert.deepEqual(await port.startOrResume({ ...identity, payload: {} }), {
    status: "deferred",
    reason: "source_root_active",
  });
  assert.equal(starts, 0);
});
