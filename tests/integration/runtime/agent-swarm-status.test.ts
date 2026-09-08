import assert from "node:assert/strict";
import test from "node:test";
import {
  projectAgentSwarmStatus,
  swarmCheckpointKey,
} from "../../../src/agent-graph/swarm-status.js";
import { createAgentSwarmStatusTool } from "../../../src/tools/agent-swarm-status-tool.js";
import type {
  AgentGraphRootToolContext,
  AgentGraphSupervisorClaimRuntime,
  AgentGraphSupervisorProjection,
} from "../../../src/tools/agent-graph-tools.js";

const root: AgentGraphRootToolContext = {
  kind: "graph_root_supervisor",
  graphId: "swarm",
  epoch: 1,
  rootSessionId: "root",
  rootTurnId: "turn",
  rootRunId: "run",
};

function fixture(ids: string[]): AgentGraphSupervisorProjection {
  return {
    graph: {
      graphId: "swarm",
      rootSessionId: "root",
      epoch: 1,
      admissionPhase: "open",
      headRevision: 1,
      selectedRecordIds: [],
      createdAt: 1,
    },
    operators: [],
    provisions: [],
    records: [],
    stops: [],
    intents: ids.map((id) => ({
      graphId: "swarm",
      intentId: id,
      operatorId: `operator-${id}`,
      operatorGeneration: 1,
      instruction: "private task instruction",
      expectedOutputRecordId: `output-${id}`,
      inputRefs: [],
      createdAtRevision: 1,
      requestedBy: { sessionId: "root", turnId: "turn", runId: "run", toolCallId: "call" },
    })),
    claims: ids.map((id) => ({
      claimId: `claim-${id}`,
      graphId: "swarm",
      intentId: id,
      operatorId: `operator-${id}`,
      operatorGeneration: 1,
      scheduleRevision: 1,
      intentFingerprint: "intent",
      readinessFingerprint: "ready",
      state: "executing",
      targetSessionId: `child-${id}`,
      targetTurnId: `turn-${id}`,
      targetRunId: `run-${id}`,
      targetInvocationId: `invoke-${id}`,
      runStartedEventId: `start-${id}`,
      claimedAt: 1,
    })),
  };
}

function runtime(
  id: string,
  status: AgentGraphSupervisorClaimRuntime["status"],
  outputStatus?: "success" | "failure",
) {
  return {
    claimId: `claim-${id}`,
    status,
    outputEventIds: outputStatus ? [`event-${id}`] : [],
    ...(outputStatus ? { outputStatus } : {}),
  };
}

test("Swarm read tool projects runtime truth, bounded statuses and aggregate checkpoints", async () => {
  const projection = fixture(["a", "b"]);
  const running = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [runtime("a", "completed", "success"), runtime("b", "running")],
  });
  assert.deepEqual(
    running.items.map((item) => item.status),
    ["completed", "running"],
  );
  assert.equal(swarmCheckpointKey(running), undefined);
  const queued = projectAgentSwarmStatus({ projection, runtimeClaims: [] });
  assert.equal(queued.counts.queued, 2, "persisted executing claims are not runtime truth");
  const completed = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [runtime("a", "completed", "success"), runtime("b", "completed", "success")],
  });
  assert.equal(completed.status, "settled");
  assert.ok(swarmCheckpointKey(completed));

  const requests: unknown[] = [];
  const tool = createAgentSwarmStatusTool({
    getRootContext: () => root,
    port: {
      async readSwarmStatus(input) {
        requests.push(input);
        return {
          ...completed,
          results: "SECRET",
          items: completed.items.map((item) => ({
            ...item,
            content: "SECRET",
            logs: ["SECRET"],
          })),
        };
      },
    },
  });
  assert.equal(tool.name(), "agent_swarm_status");
  assert.equal(tool.readOnly, true);
  const text = await tool.execute("{}");
  assert.equal(text.includes("SECRET"), false);
  assert.equal(text.includes("private task instruction"), false);
  assert.deepEqual(requests, [{ graphId: "swarm", epoch: 1, rootSessionId: "root" }]);
  assert.equal(JSON.parse(text).counts.completed, 2);

  const large = createAgentSwarmStatusTool({
    getRootContext: () => root,
    port: {
      async readSwarmStatus() {
        return {
          ...completed,
          items: Array.from({ length: 500 }, (_, i) => ({
            ...completed.items[0]!,
            workId: `${i}`,
            failureReason: "大".repeat(5000),
          })),
        };
      },
    },
  });
  const bounded = await large.execute("{}");
  assert.ok(Buffer.byteLength(bounded) <= 48 * 1024);
  assert.equal(JSON.parse(bounded).truncated, true);
  assert.ok(JSON.parse(bounded).items.length <= 128);
});

test("Swarm failures, replacement and blocked dependencies produce stable attention checkpoints", async () => {
  const projection = fixture(["a", "b", "c"]);
  const failure = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [runtime("a", "completed", "failure"), runtime("b", "running")],
  });
  assert.equal(failure.status, "needs_attention");
  assert.equal(failure.items[0]!.failureReason, "agent_output reported failure");
  const otherSuccess = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [runtime("a", "completed", "failure"), runtime("b", "completed", "success")],
  });
  assert.equal(swarmCheckpointKey(failure), swarmCheckpointKey(otherSuccess));
  const missingOutput = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [runtime("a", "completed")],
  });
  assert.equal(missingOutput.items[0]!.status, "failed");
  assert.match(missingOutput.items[0]!.failureReason!, /without agent_output/);

  const replacement = projectAgentSwarmStatus({
    projection: {
      ...projection,
      intents: projection.intents.map((intent) =>
        intent.intentId === "b" ? { ...intent, replacesIntentId: "a" } : intent,
      ),
    },
    runtimeClaims: [runtime("a", "failed"), runtime("b", "running")],
  });
  assert.equal(replacement.items[0]!.status, "superseded");
  assert.equal(swarmCheckpointKey(replacement), undefined);

  const dependencies = {
    ...projection,
    intents: projection.intents.map((intent) => ({
      ...intent,
      inputRefs:
        intent.intentId === "b"
          ? [{ recordId: "output-a" }]
          : intent.intentId === "c"
            ? [{ recordId: "output-b" }]
            : [],
    })),
  };
  const blocked = projectAgentSwarmStatus({
    projection: dependencies,
    runtimeClaims: [runtime("a", "failed")],
  });
  assert.deepEqual(
    blocked.items.map((item) => item.status),
    ["failed", "blocked", "blocked"],
  );
  const permission = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [
      runtime("a", "waiting-permission"),
      runtime("b", "interrupted"),
      runtime("c", "cancelled"),
    ],
  });
  assert.deepEqual(
    permission.items.map((item) => item.status),
    ["blocked", "aborted", "cancelled"],
  );
  const stopped = projectAgentSwarmStatus({
    projection: {
      ...projection,
      stops: [{ kind: "stop", target: { kind: "intent", intentId: "a" } }],
    },
    runtimeClaims: [runtime("a", "cancelled")],
  });
  assert.equal(stopped.items[0]!.status, "stopped");

  let reads = 0;
  const makeTool = (context: AgentGraphRootToolContext | undefined) =>
    createAgentSwarmStatusTool({
      getRootContext: () => context,
      port: {
        async readSwarmStatus() {
          reads++;
          return failure;
        },
      },
    });
  await assert.rejects(makeTool(undefined).execute("{}"), /root/);
  await assert.rejects(makeTool(root).execute('{"graphId":"other"}'), /空 JSON/);
  await assert.rejects(makeTool(root).execute("[]"), /空 JSON/);
  assert.equal(reads, 0);
  const wrong = createAgentSwarmStatusTool({
    getRootContext: () => root,
    port: {
      async readSwarmStatus() {
        return { ...failure, swarmId: "other" };
      },
    },
  });
  await assert.rejects(wrong.execute("{}"), /不属于/);
});

test("Stopping failed work allows the remaining branch to reach a fresh settled checkpoint", () => {
  const projection = fixture(["a", "b"]);
  for (const failed of [runtime("a", "failed"), runtime("a", "completed", "failure")]) {
    const initial = projectAgentSwarmStatus({
      projection,
      runtimeClaims: [failed, runtime("b", "running")],
    });
    const stoppedProjection = {
      ...projection,
      stops: [{ kind: "stop" as const, target: { kind: "intent" as const, intentId: "a" } }],
    };
    const stopped = projectAgentSwarmStatus({
      projection: stoppedProjection,
      runtimeClaims: [failed, runtime("b", "running")],
    });
    assert.equal(stopped.items[0]!.status, "stopped");
    assert.equal(stopped.status, "running");
    assert.equal(swarmCheckpointKey(stopped), undefined);
    const completed = projectAgentSwarmStatus({
      projection: stoppedProjection,
      runtimeClaims: [failed, runtime("b", "completed", "success")],
    });
    assert.equal(completed.status, "settled");
    assert.notEqual(swarmCheckpointKey(completed), swarmCheckpointKey(initial));

    for (const [observed, expected] of [
      [runtime("a", "running"), "running"],
      [runtime("a", "waiting-permission"), "blocked"],
      [runtime("a", "completed", "success"), "completed"],
    ] as const) {
      assert.equal(
        projectAgentSwarmStatus({ projection: stoppedProjection, runtimeClaims: [observed] })
          .items[0]!.status,
        expected,
      );
    }
  }
});

test("Swarm status exposes reconciliation failure phases without content and keeps unknown terminal outputs failed", async () => {
  const projection = fixture(["a", "b"]);
  for (const failurePhase of ["schedule", "topology", "stop", "render", "dispatch"] as const) {
    const status = projectAgentSwarmStatus({
      projection,
      runtimeClaims: [runtime("b", "running")],
      diagnostics: [{ subjectId: "a", failurePhase, message: "Cannot schedule work" }],
    });
    assert.equal(status.items[0]!.status, "failed");
    const tool = createAgentSwarmStatusTool({
      getRootContext: () => root,
      port: {
        async readSwarmStatus() {
          return status;
        },
      },
    });
    const result = JSON.parse(await tool.execute("{}"));
    assert.equal(result.items[0].failurePhase, failurePhase);
    assert.equal(result.items[0].failureReason, "Cannot schedule work");
  }
  const unknown = projectAgentSwarmStatus({
    projection,
    runtimeClaims: [{ ...runtime("a", "completed"), outputEventIds: ["unreadable-output"] }],
  });
  assert.equal(unknown.items[0]!.status, "failed");
  assert.match(unknown.items[0]!.failureReason!, /status is unavailable/);
});
