import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentGraphActivationClaim,
  AgentGraphActivationIntent,
  AgentGraphOperationSource,
  AgentGraphOperator,
  AgentGraphScheduleCommand,
} from "../../src/agent-graph/core/index.js";
import {
  claimIdFor,
  intentIdFor,
  operatorIdFor,
  recordIdFor,
} from "../../src/agent-graph/core/index.js";
import {
  AgentGraphReconciler,
  deterministicAgentGraphIdentities,
} from "../../src/agent-graph/reconciler.js";
import type {
  AgentGraphRuntimePort,
  AgentGraphRuntimeProjection,
  EnsureAgentGraphOperatorRequest,
  ResolveAgentGraphInputsRequest,
  StartAgentGraphActivationRequest,
  StopAgentGraphActivationRequest,
} from "../../src/agent-graph/runtime-port.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

const SOURCE: AgentGraphOperationSource = {
  sessionId: "root-session",
  turnId: "root-turn",
  runId: "root-run",
  toolCallId: "root-tool",
};

test("reconciler drives dependent operators to a fixed point with exact durable identities", async () => {
  await withGraph(async ({ raw, store, graphId }) => {
    const upstream = addCommand(graphId, "researcher", 1);
    const upstreamEventId = `event:${upstream.intent.intentId}`;
    const expectedUpstreamRecordId = recordIdFor(
      claimIdFor(graphId, upstream.intent.intentId),
      upstreamEventId,
    );
    const downstream = addCommand(graphId, "reviewer", 1, [expectedUpstreamRecordId]);
    const independent = addCommand(graphId, "auditor", 1);
    store.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 0,
      operationId: "add-workers",
      source: SOURCE,
      commands: [upstream, downstream, independent],
    });

    const runtime = new CompletingRuntime();
    const reconciler = new AgentGraphReconciler({ store, runtime, now: () => 5_000 });
    const result = await reconciler.reconcile(graphId);

    assert.equal(result.quiescent, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.headRevision, 1);
    assert.ok(result.passes >= 3);
    assert.equal(raw.listOperatorProvisions(graphId).length, 3);
    assert.ok(
      raw.listOperatorProvisions(graphId).every((provision) => provision.state === "provisioned"),
    );
    assert.equal(raw.listActivationClaims(graphId).length, 3);
    assert.equal(raw.listRecordRefs(graphId).length, 3);
    assert.ok(runtime.maxConcurrentStarts >= 2, "independent operators should start concurrently");

    const upstreamClaim = raw
      .listActivationClaims(graphId)
      .find((claim) => claim.intentId === upstream.intent.intentId);
    assert.ok(upstreamClaim);
    assert.deepEqual(
      {
        claimId: upstreamClaim.claimId,
        sessionId: upstreamClaim.targetSessionId,
        turnId: upstreamClaim.targetTurnId,
        runId: upstreamClaim.targetRunId,
        invocationId: upstreamClaim.targetInvocationId,
        startedEventId: upstreamClaim.runStartedEventId,
      },
      {
        claimId: deterministicAgentGraphIdentities.activation(upstream.intent).claimId,
        sessionId: deterministicAgentGraphIdentities.provision(upstream.operator).childSessionId,
        turnId: deterministicAgentGraphIdentities.activation(upstream.intent).targetTurnId,
        runId: deterministicAgentGraphIdentities.activation(upstream.intent).targetRunId,
        invocationId: deterministicAgentGraphIdentities.activation(upstream.intent)
          .targetInvocationId,
        startedEventId: deterministicAgentGraphIdentities.activation(upstream.intent)
          .runStartedEventId,
      },
    );
    assert.equal(runtime.startsByIntent.get(downstream.intent.intentId), 1);

    const replay = await reconciler.reconcile(graphId);
    assert.equal(replay.progressCount, 0);
    assert.equal(raw.listActivationClaims(graphId).length, 3);
    assert.equal(raw.listRecordRefs(graphId).length, 3);
    assert.equal(runtime.startsByIntent.get(upstream.intent.intentId), 1);
    assert.ok(replay.wakeCandidates.every((wake) => wake.cause === "runtime_terminal"));

    const selectedRecordId = raw.listRecordRefs(graphId)[0]?.recordId;
    assert.ok(selectedRecordId);
    const finishInput = {
      graphId,
      expectedPreviousRevision: 1,
      operationId: "finish-with-record",
      source: { ...SOURCE, toolCallId: "finish-with-record-tool" },
      commands: [{ kind: "finish" as const, selectedRecordIds: [selectedRecordId] }],
    };
    assert.equal(store.commitScheduleRevision(finishInput).replayed, false);
    assert.equal(store.commitScheduleRevision(finishInput).replayed, true);
    assert.deepEqual(store.getScheduleState(graphId).graph.selectedRecordIds, [selectedRecordId]);
  });
});

test("concurrent stop or finish wins revision CAS before a fresh claim", async () => {
  for (const fence of ["stop", "finish"] as const) {
    await withGraph(async ({ raw, store, graphId }) => {
      const command = addCommand(graphId, `worker-${fence}`, 1);
      store.commitScheduleRevision({
        graphId,
        expectedPreviousRevision: 0,
        operationId: `add-${fence}`,
        source: SOURCE,
        commands: [command],
      });
      let fenced = false;
      const runtime = new CompletingRuntime({
        onResolve: () => {
          if (fenced) return;
          fenced = true;
          store.commitScheduleRevision({
            graphId,
            expectedPreviousRevision: 1,
            operationId: `race-${fence}`,
            source: { ...SOURCE, toolCallId: `tool-${fence}` },
            commands:
              fence === "finish"
                ? [{ kind: "finish" }]
                : [
                    {
                      kind: "stop",
                      target: { kind: "intent", intentId: command.intent.intentId },
                      reason: "race won",
                    },
                  ],
          });
        },
      });
      const result = await new AgentGraphReconciler({ store, runtime }).reconcile(graphId);

      assert.equal(raw.listActivationClaims(graphId).length, 0);
      assert.equal(runtime.startsByIntent.size, 0);
      assert.deepEqual(result.errors, []);
      assert.equal(
        store.getScheduleState(graphId).graph.admissionPhase,
        fence === "finish" ? "sealed" : "open",
      );
    });
  }
});

test("finish preserves exact claimed work and failed stop callbacks do not rewrite it", async () => {
  await withGraph(async ({ raw, store, graphId }) => {
    const command = addCommand(graphId, "long-running", 1);
    store.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 0,
      operationId: "add-long-running",
      source: SOURCE,
      commands: [command],
    });
    const runtime = new RunningRuntime();
    const reconciler = new AgentGraphReconciler({ store, runtime });
    await reconciler.reconcile(graphId);
    const exactRunId = raw.listActivationClaims(graphId)[0]?.targetRunId;
    assert.ok(exactRunId);

    store.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 1,
      operationId: "finish-graph",
      source: { ...SOURCE, toolCallId: "finish-tool" },
      commands: [{ kind: "finish" }],
    });
    await reconciler.reconcile(graphId);
    assert.equal(raw.listActivationClaims(graphId)[0]?.state, "executing");
    assert.equal(raw.listActivationClaims(graphId)[0]?.targetRunId, exactRunId);
    assert.ok(runtime.observedRunIds.includes(exactRunId));
  });

  await withGraph(async ({ raw, store, graphId }) => {
    const command = addCommand(graphId, "stoppable", 1);
    store.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 0,
      operationId: "add-stoppable",
      source: SOURCE,
      commands: [command],
    });
    const runtime = new RunningRuntime();
    const reconciler = new AgentGraphReconciler({ store, runtime });
    await reconciler.reconcile(graphId);
    store.commitScheduleRevision({
      graphId,
      expectedPreviousRevision: 1,
      operationId: "stop-running",
      source: { ...SOURCE, toolCallId: "stop-tool" },
      commands: [
        {
          kind: "stop",
          target: { kind: "intent", intentId: command.intent.intentId },
          reason: "cancelled by test",
        },
      ],
    });

    runtime.failNextStop = true;
    const failedStop = await reconciler.reconcile(graphId);
    assert.equal(raw.listActivationClaims(graphId)[0]?.state, "executing");
    assert.ok(failedStop.errors.some((error) => error.phase === "stop"));

    await reconciler.reconcile(graphId);
    assert.equal(raw.listActivationClaims(graphId)[0]?.state, "cancelled");
    assert.equal(raw.listOperatorProvisions(graphId)[0]?.state, "stopped");
  });
});

class CompletingRuntime implements AgentGraphRuntimePort {
  readonly startsByIntent = new Map<string, number>();
  maxConcurrentStarts = 0;
  private concurrentStarts = 0;
  private readonly projections = new Map<string, AgentGraphRuntimeProjection>();
  private readonly onResolve?: () => void;

  constructor(options: { readonly onResolve?: () => void } = {}) {
    this.onResolve = options.onResolve;
  }

  async resolveInputFacts(input: ResolveAgentGraphInputsRequest) {
    this.onResolve?.();
    const resolvedIds = new Set(input.knownRecords.map((record) => record.recordId));
    return {
      records: input.knownRecords,
      inFlightRecordIds: input.intent.inputRefs
        .map((reference) => reference.recordId)
        .filter((recordId) => !resolvedIds.has(recordId)),
    };
  }

  async ensureOperator(_input: EnsureAgentGraphOperatorRequest): Promise<void> {
    await Promise.resolve();
  }

  async startOrObserveActivation(
    input: StartAgentGraphActivationRequest,
  ): Promise<AgentGraphRuntimeProjection> {
    const existing = this.projections.get(input.claim.claimId);
    if (existing) return existing;
    this.concurrentStarts += 1;
    this.maxConcurrentStarts = Math.max(this.maxConcurrentStarts, this.concurrentStarts);
    await new Promise<void>((resolve) => setImmediate(resolve));
    this.concurrentStarts -= 1;
    this.startsByIntent.set(
      input.intent.intentId,
      (this.startsByIntent.get(input.intent.intentId) ?? 0) + 1,
    );
    const eventId = `event:${input.intent.intentId}`;
    const projection: AgentGraphRuntimeProjection = {
      status: "completed",
      terminalEventId: `terminal:${input.intent.intentId}`,
      records: [
        {
          kind: "agent-output",
          sourceSessionId: input.claim.targetSessionId,
          sourceTurnId: input.claim.targetTurnId,
          sourceRunId: input.claim.targetRunId,
          sourceEventId: eventId,
          committed: true,
          partial: false,
        },
        {
          kind: "agent-output",
          sourceSessionId: input.claim.targetSessionId,
          sourceTurnId: input.claim.targetTurnId,
          sourceRunId: input.claim.targetRunId,
          sourceEventId: `${eventId}:partial`,
          committed: true,
          partial: true,
        },
      ],
    };
    this.projections.set(input.claim.claimId, projection);
    return projection;
  }

  async observeActivation(claim: AgentGraphActivationClaim) {
    return this.projections.get(claim.claimId) ?? { status: "not-started" as const, records: [] };
  }

  async stopActivation(_input: StopAgentGraphActivationRequest): Promise<void> {}
}

class RunningRuntime implements AgentGraphRuntimePort {
  readonly observedRunIds: string[] = [];
  failNextStop = false;

  async resolveInputFacts(input: ResolveAgentGraphInputsRequest) {
    return { records: input.knownRecords };
  }

  async ensureOperator(_input: EnsureAgentGraphOperatorRequest): Promise<void> {}

  async startOrObserveActivation(input: StartAgentGraphActivationRequest) {
    this.observedRunIds.push(input.claim.targetRunId);
    return { status: "running" as const, records: [] };
  }

  async observeActivation(_claim: AgentGraphActivationClaim) {
    return { status: "running" as const, records: [] };
  }

  async stopActivation(_input: StopAgentGraphActivationRequest): Promise<void> {
    if (this.failNextStop) {
      this.failNextStop = false;
      throw new Error("runtime stop failed");
    }
  }
}

function addCommand(
  graphId: string,
  role: string,
  revision: number,
  inputRecordIds: readonly string[] = [],
): Extract<AgentGraphScheduleCommand, { kind: "add" }> {
  const operatorId = operatorIdFor(graphId, role);
  const operator: AgentGraphOperator = {
    graphId,
    operatorId,
    generation: 1,
    role,
    profileSnapshot: {
      profileId: `profile:${role}`,
      model: "fake-model",
      tools: ["read_file"],
      permissionPolicy: { mode: "read-only" },
      systemPromptVersion: "1",
    },
    workspacePolicy: { kind: "shared" },
  };
  const intent: AgentGraphActivationIntent = {
    graphId,
    intentId: intentIdFor(graphId, `add-${role}`, 0),
    operatorId,
    operatorGeneration: 1,
    instruction: `Complete ${role} work`,
    inputRefs: inputRecordIds.map((recordId) => ({ recordId })),
    createdAtRevision: revision,
    requestedBy: SOURCE,
  };
  return { kind: "add", operator, intent };
}

async function withGraph(
  run: (context: {
    readonly raw: SqliteAgentGraphControlStore;
    readonly store: SqliteAgentGraphControlStoreAdapter;
    readonly graphId: string;
  }) => Promise<void>,
): Promise<void> {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-graph-reconciler-"));
  const raw = new SqliteAgentGraphControlStore({ storageRoot });
  const graphId = `graph-${storageRoot.split("/").at(-1)}`;
  raw.createGraph({ graphId, rootSessionId: "root-session", epoch: 1 });
  try {
    await run({ raw, store: new SqliteAgentGraphControlStoreAdapter(raw), graphId });
  } finally {
    raw.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
}
