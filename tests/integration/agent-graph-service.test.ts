import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  agentOutputRecordIdFor,
  claimIdFor,
  graphIdFor,
} from "../../src/agent-graph/core/index.js";
import { createAgentGraphApplicationService } from "../../src/agent-graph/service.js";
import { AgentGraphNeedsAttentionError } from "../../src/agent-graph/diagnostics.js";
import type { AgentGraphRootWakePort } from "../../src/daemon/agent-graph-supervisor-service.js";
import type { AgentGraphRuntimeApplicationPort } from "../../src/agent-graph/runtime-adapter-bridge.js";
import type { ResolvedAgentGraphHandoff } from "../../src/runtime/agent-graph-runtime-adapter.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecordRefRecord,
} from "../../src/storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

test("workspace application drives add and follow-up activate to records and finish", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-service-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const runtime = new CompletingRuntimeAdapter();
  const rootWake = new CompletingRootWakePort();
  const rootSessionId = "root-session";
  const graphId = graphIdFor(rootSessionId, 1);
  const upstreamIntentId = "intent-research";
  const upstreamClaimId = claimIdFor(graphId, upstreamIntentId);
  const upstreamRecordId = agentOutputRecordIdFor(graphId, upstreamIntentId);
  const downstreamIntentId = "intent-review";
  const downstreamClaimId = claimIdFor(graphId, downstreamIntentId);
  const downstreamRecordId = agentOutputRecordIdFor(graphId, downstreamIntentId);
  const service = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort: rootWake,
    resolveOperatorWorkspace: ({ operator }) => ({
      workDir: join(storageRoot, operator.operatorId),
    }),
    validateWorkspacePolicy: (policy) => {
      if (policy.kind !== "shared") throw new Error("isolated workspace unavailable");
    },
  });

  try {
    await service.start();
    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn-1",
      runId: "root-run-1",
      toolCallId: "update-call-1",
    };
    await assert.rejects(
      service.toolPort.commitUpdate({
        graphId,
        epoch: 1,
        expectedRevision: 0,
        operationId: "reject-unknown-profile",
        rootModelRouteId: "test-root-model",
        source,
        commands: [
          addCommand({
            graphId,
            intentId: "intent-unknown-profile",
            operatorId: "unknown-profile",
            profileId: "unknown",
            source,
          }),
        ],
      }),
      /Unknown Agent Graph Operator profile/u,
    );
    assert.equal(store.getGraph(graphId), undefined);
    const firstEpoch = service.openRootEpoch(rootSessionId);
    assert.equal(firstEpoch.graphId, graphId);
    assert.equal(firstEpoch.epoch, 1);
    const isolated = addCommand({
      graphId,
      intentId: "intent-isolated",
      operatorId: "isolated",
      source,
    });
    await assert.rejects(
      service.toolPort.commitUpdate({
        graphId,
        epoch: 1,
        expectedRevision: 0,
        operationId: "reject-unavailable-workspace",
        rootModelRouteId: "test-root-model",
        source,
        commands: [
          {
            ...isolated,
            operator: {
              ...isolated.operator,
              workspacePolicy: { kind: "isolated-worktree", baseRef: "HEAD" },
            },
          },
        ],
      }),
      /isolated workspace unavailable/u,
    );
    assert.equal(store.getGraph(graphId)?.headRevision, 0);
    const upstreamUpdated = await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "add-research",
      rootModelRouteId: "test-root-model",
      source,
      commands: [
        addCommand({ graphId, intentId: upstreamIntentId, operatorId: "researcher", source }),
      ],
    });

    assert.equal(upstreamUpdated.revision, 1);
    await service.supervisor.notifyGraph(graphId);
    const downstreamUpdated = await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 1,
      operationId: "activate-review",
      rootModelRouteId: "test-root-model",
      source,
      commands: [
        activateCommand({
          graphId,
          intentId: downstreamIntentId,
          operatorId: "researcher",
          source,
          inputRecordIds: [upstreamRecordId],
          createdAtRevision: 2,
          instruction: "review result",
        }),
      ],
    });
    assert.equal(downstreamUpdated.revision, 2);
    await service.supervisor.notifyGraph(graphId);
    const reconciled = await service.toolPort.readProjection({ graphId, epoch: 1, rootSessionId });
    assert.equal(reconciled.claims.length, 2);
    assert.equal(reconciled.operators.length, 1);
    assert.equal(reconciled.provisions.length, 1);
    assert.equal(reconciled.claims[0]?.targetSessionId, reconciled.claims[1]?.targetSessionId);
    assert.deepEqual(
      reconciled.records.map((record) => record.recordId).sort(),
      [downstreamRecordId, upstreamRecordId].sort(),
    );
    assert.deepEqual(
      reconciled.intentReadiness.map(({ intentId, status }) => ({ intentId, status })),
      [
        { intentId: upstreamIntentId, status: "resolved" },
        { intentId: downstreamIntentId, status: "resolved" },
      ],
    );
    assert.doesNotMatch(
      JSON.stringify(reconciled),
      /profileSnapshot|systemPrompt|modelRouteId|permissionPolicy|profileFingerprint/u,
    );
    assert.deepEqual(
      reconciled.runtimeClaims.map(({ claimId, status, terminalEventId }) => ({
        claimId,
        status,
        terminalEventId,
      })),
      [
        {
          claimId: upstreamClaimId,
          status: "completed",
          terminalEventId: `terminal:${upstreamClaimId}`,
        },
        {
          claimId: downstreamClaimId,
          status: "completed",
          terminalEventId: `terminal:${downstreamClaimId}`,
        },
      ],
    );
    assert.deepEqual(
      reconciled.results.records.map(({ recordId, status, content }) => ({
        recordId,
        status,
        content,
      })),
      [
        {
          recordId: upstreamRecordId,
          status: "success",
          content: `result:${upstreamRecordId}`,
        },
        {
          recordId: downstreamRecordId,
          status: "success",
          content: `result:${downstreamRecordId}`,
        },
      ],
    );
    const exact = await service.toolPort.readProjection({
      graphId,
      epoch: 1,
      rootSessionId,
      recordIds: [downstreamRecordId],
    });
    assert.deepEqual(
      exact.results.records.map((record) => record.recordId),
      [downstreamRecordId],
    );
    await assert.rejects(
      service.toolPort.readProjection({
        graphId,
        epoch: 1,
        rootSessionId,
        recordIds: ["record:unknown"],
      }),
      /RecordRef does not exist/u,
    );
    const otherRootSessionId = "other-root-session";
    const otherGraphId = graphIdFor(otherRootSessionId, 1);
    const otherSource = {
      sessionId: otherRootSessionId,
      turnId: "other-root-turn",
      runId: "other-root-run",
      toolCallId: "other-root-update",
    };
    const otherEpoch = service.openRootEpoch(otherRootSessionId);
    assert.equal(otherEpoch.graphId, otherGraphId);
    await service.toolPort.commitUpdate({
      graphId: otherGraphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "add-other-graph-record",
      rootModelRouteId: "test-root-model",
      source: otherSource,
      commands: [
        addCommand({
          graphId: otherGraphId,
          intentId: "other-intent",
          operatorId: "other-worker",
          source: otherSource,
        }),
      ],
    });
    await service.supervisor.notifyGraph(otherGraphId);
    const otherRecordId = store.listRecordRefs(otherGraphId)[0]?.recordId;
    assert.ok(otherRecordId);
    await assert.rejects(
      service.toolPort.readProjection({
        graphId,
        epoch: 1,
        rootSessionId,
        recordIds: [otherRecordId],
      }),
      /belongs to another Graph/u,
    );
    assert.equal(store.listGraphs(rootSessionId).length, 1);
    assert.equal(store.listGraphs(rootSessionId)[0]?.epoch, 1);
    assert.equal(runtime.starts.length, 3);
    assert.match(runtime.starts[1]?.prompt ?? "", /review result/u);
    assert.match(runtime.starts[1]?.prompt ?? "", /handoff:1/u);

    const finished = await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 2,
      operationId: "finish-graph",
      rootModelRouteId: "test-root-model",
      source: {
        sessionId: rootSessionId,
        turnId: "root-turn-2",
        runId: "root-run-2",
        toolCallId: "finish-call-1",
      },
      commands: [{ kind: "finish", selectedRecordIds: [downstreamRecordId] }],
    });

    assert.equal(finished.revision, 3);
    assert.equal(finished.projection.graph.admissionPhase, "sealed");
    assert.deepEqual(finished.projection.graph.selectedRecordIds, [downstreamRecordId]);
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }

  assert.equal(runtime.releases, 2);
});

test("transient reconciler diagnostics survive restart, retry the same identity, and resolve", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-diagnostic-retry-"));
  let now = 100;
  const rootSessionId = "diagnostic-retry-root";
  const graphId = graphIdFor(rootSessionId, 1);
  const source = {
    sessionId: rootSessionId,
    turnId: "root-turn",
    runId: "root-run",
    toolCallId: "root-update",
  };
  const firstStore = new SqliteAgentGraphControlStore({ storageRoot, now: () => now });
  const failingRuntime = new ProvisionFailureRuntime(
    new Error("Bearer private-token token=another-private-value temporarily unavailable"),
  );
  const first = createAgentGraphApplicationService({
    store: firstStore,
    runtime: failingRuntime,
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
    now: () => now,
  });
  try {
    await first.start();
    first.openRootEpoch(rootSessionId);
    await first.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "schedule-transient-failure",
      rootModelRouteId: "test-root-model",
      source,
      commands: [addCommand({ graphId, intentId: "intent-1", operatorId: "worker", source })],
    });
    await first.supervisor.notifyGraph(graphId);
    const diagnostic = firstStore.listGraphDiagnostics(graphId, { unresolvedOnly: true })[0];
    assert.equal(diagnostic?.classification, "transient");
    assert.equal(diagnostic?.state, "retry_scheduled");
    assert.ok((diagnostic?.attemptCount ?? 0) >= 1);
    assert.doesNotMatch(diagnostic?.message ?? "", /private-token|another-private-value/u);
    await first.close();
    firstStore.close();

    now = diagnostic!.nextRetryAt!;
    const reopened = new SqliteAgentGraphControlStore({ storageRoot, now: () => now });
    const completingRuntime = new CompletingRuntimeAdapter();
    const recovered = createAgentGraphApplicationService({
      store: reopened,
      runtime: completingRuntime,
      rootWakePort: new CompletingRootWakePort(),
      resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
      now: () => now,
    });
    try {
      await recovered.start();
      assert.equal(reopened.listOperatorProvisions(graphId)[0]?.state, "provisioned");
      assert.equal(reopened.listActivationClaims(graphId)[0]?.intentId, "intent-1");
      assert.equal(reopened.listGraphDiagnostics(graphId)[0]?.state, "resolved");
      assert.equal(
        reopened.listGraphDiagnostics(graphId)[0]?.attemptCount,
        diagnostic?.attemptCount,
      );
    } finally {
      await recovered.close();
      reopened.close();
    }
  } finally {
    try {
      await first.close();
    } catch {
      // The first service may already be closed by the restart boundary above.
    }
    firstStore.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("configuration reconciler diagnostics remain needs-attention across restart", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-diagnostic-attention-"));
  const rootSessionId = "diagnostic-attention-root";
  const graphId = graphIdFor(rootSessionId, 1);
  const source = {
    sessionId: rootSessionId,
    turnId: "root-turn",
    runId: "root-run",
    toolCallId: "root-update",
  };
  const firstStore = new SqliteAgentGraphControlStore({ storageRoot });
  const failure = new AgentGraphNeedsAttentionError(
    "configuration",
    "operator route is not configured",
  );
  const firstRuntime = new ProvisionFailureRuntime(failure);
  const first = createAgentGraphApplicationService({
    store: firstStore,
    runtime: firstRuntime,
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });
  try {
    await first.start();
    first.openRootEpoch(rootSessionId);
    await first.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "schedule-configuration-failure",
      rootModelRouteId: "test-root-model",
      source,
      commands: [addCommand({ graphId, intentId: "intent-1", operatorId: "worker", source })],
    });
    await first.supervisor.notifyGraph(graphId);
    assert.equal(firstStore.listGraphDiagnostics(graphId)[0]?.state, "needs_attention");
    await first.close();
    firstStore.close();

    const reopened = new SqliteAgentGraphControlStore({ storageRoot });
    const recoveredRuntime = new ProvisionFailureRuntime(failure);
    const recovered = createAgentGraphApplicationService({
      store: reopened,
      runtime: recoveredRuntime,
      rootWakePort: new CompletingRootWakePort(),
      resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
    });
    try {
      await recovered.start();
      assert.equal(recoveredRuntime.ensureCalls, 0, "startup must not retry permanent failures");
      assert.equal(reopened.listGraphDiagnostics(graphId)[0]?.state, "needs_attention");
    } finally {
      await recovered.close();
      reopened.close();
    }
  } finally {
    try {
      await first.close();
    } catch {
      // The first service may already be closed by the restart boundary above.
    }
    firstStore.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("root epochs advance only after finish and read paths never create Graphs", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-epochs-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const rootSessionId = "multi-epoch-root";
  const epochOneGraphId = graphIdFor(rootSessionId, 1);
  const epochTwoGraphId = graphIdFor(rootSessionId, 2);
  const service = createAgentGraphApplicationService({
    store,
    runtime: new CompletingRuntimeAdapter(),
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });

  try {
    await service.start();
    await assert.rejects(
      service.toolPort.readProjection({
        graphId: epochOneGraphId,
        epoch: 1,
        rootSessionId,
      }),
      /does not match root Session/u,
    );
    assert.deepEqual(store.listGraphs(rootSessionId), []);

    const epochOne = service.openRootEpoch(rootSessionId);
    assert.equal(epochOne.graphId, epochOneGraphId);
    assert.equal(epochOne.epoch, 1);
    assert.equal(service.openRootEpoch(rootSessionId).graphId, epochOneGraphId);

    const source = {
      sessionId: rootSessionId,
      turnId: "epoch-one-turn",
      runId: "epoch-one-run",
      toolCallId: "epoch-one-finish",
    };
    await service.toolPort.commitUpdate({
      graphId: epochOneGraphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "finish-epoch-one",
      rootModelRouteId: "test-root-model",
      source,
      commands: [{ kind: "finish" }],
    });

    const epochTwo = service.openRootEpoch(rootSessionId);
    assert.equal(epochTwo.graphId, epochTwoGraphId);
    assert.equal(epochTwo.epoch, 2);
    assert.equal(service.openRootEpoch(rootSessionId).graphId, epochTwoGraphId);
    assert.equal(
      (
        await service.toolPort.readProjection({
          graphId: epochOneGraphId,
          epoch: 1,
          rootSessionId,
        })
      ).graph.admissionPhase,
      "sealed",
    );
    await assert.rejects(
      service.toolPort.readProjection({
        graphId: epochTwoGraphId,
        epoch: 1,
        rootSessionId,
      }),
      /does not match root Session/u,
    );
    assert.deepEqual(
      store.listGraphs(rootSessionId).map(({ graphId, epoch, phase }) => ({
        graphId,
        epoch,
        phase,
      })),
      [
        { graphId: epochOneGraphId, epoch: 1, phase: "finished" },
        { graphId: epochTwoGraphId, epoch: 2, phase: "open" },
      ],
    );
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("view exposes a terminal Claim without agent_output so root does not wait for another wake", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-outputless-view-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const runtime = new CompletingRuntimeAdapter(false);
  const rootSessionId = "outputless-root-session";
  const graphId = graphIdFor(rootSessionId, 1);
  const service = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });

  try {
    await service.start();
    service.openRootEpoch(rootSessionId);
    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn",
      runId: "root-run",
      toolCallId: "root-update",
    };
    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "add-outputless-operator",
      rootModelRouteId: "test-root-model",
      source,
      commands: [
        addCommand({ graphId, intentId: "outputless-intent", operatorId: "worker", source }),
      ],
    });
    await service.supervisor.notifyGraph(graphId);

    const view = await service.toolPort.readProjection({ graphId, epoch: 1, rootSessionId });
    assert.equal(view.claims.length, 1);
    assert.deepEqual(view.records, []);
    assert.deepEqual(view.results, { records: [], totalBytes: 0, truncated: false });
    assert.deepEqual(view.runtimeClaims, [
      {
        claimId: view.claims[0]!.claimId,
        status: "completed",
        terminalEventId: `terminal:${view.claims[0]!.claimId}`,
        outputEventIds: [],
      },
    ]);

    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 1,
      operationId: "stop-outputless-intent",
      rootModelRouteId: "test-root-model",
      source,
      commands: [
        {
          kind: "stop",
          target: { kind: "intent", intentId: "outputless-intent" },
          reason: "该次执行未提交正式输出",
        },
      ],
    });
    await service.supervisor.notifyGraph(graphId);
    assert.equal(store.listActivationClaims(graphId)[0]?.state, "cancelled");
    assert.equal(store.listOperatorProvisions(graphId)[0]?.state, "provisioned");

    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 2,
      operationId: "follow-up-after-outputless",
      rootModelRouteId: "test-root-model",
      source,
      commands: [
        activateCommand({
          graphId,
          intentId: "outputless-follow-up",
          operatorId: "worker",
          source,
          createdAtRevision: 3,
          instruction: "重新执行并明确提交结果",
        }),
      ],
    });
    await service.supervisor.notifyGraph(graphId);
    const recovered = await service.toolPort.readProjection({ graphId, epoch: 1, rootSessionId });
    assert.equal(recovered.provisions.length, 1);
    assert.equal(recovered.claims.length, 2);
    assert.equal(recovered.claims[0]?.targetSessionId, recovered.claims[1]?.targetSessionId);
    assert.equal(runtime.starts.length, 2);
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("a rejected no-progress yield leaves the same root Run free to schedule and yield again", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-dead-yield-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const rootSessionId = "dead-yield-root";
  const graphId = graphIdFor(rootSessionId, 1);
  const service = createAgentGraphApplicationService({
    store,
    runtime: new RunningRuntimeAdapter(),
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });

  try {
    await service.start();
    service.openRootEpoch(rootSessionId);
    await assert.rejects(
      service.toolPort.registerYield({
        graphId,
        epoch: 1,
        rootSessionId,
        rootTurnId: "root-turn",
        rootRunId: "root-run",
        toolCallId: "yield-without-work",
      }),
      /没有可等待的未来进展/u,
    );
    assert.equal(store.listYieldInterests(graphId).length, 0);
    assert.equal(store.listRecoverableSupervisorWakes(Number.MAX_SAFE_INTEGER).length, 0);

    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn",
      runId: "root-run",
      toolCallId: "update-after-rejected-yield",
    };
    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "schedule-after-rejected-yield",
      rootModelRouteId: "test-root-model",
      source,
      commands: [addCommand({ graphId, intentId: "retry-intent", operatorId: "worker", source })],
    });
    const yielded = await service.toolPort.registerYield({
      graphId,
      epoch: 1,
      rootSessionId,
      rootTurnId: "root-turn",
      rootRunId: "root-run",
      toolCallId: "yield-after-scheduling",
    });
    assert.equal(store.getYieldInterest(yielded.permitId)?.state, "registered");
    service.toolPort.cancelYield(yielded.permitId, rootSessionId);
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("yield remains registered while an Operator activation is still executing", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-live-yield-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const runtime = new RunningRuntimeAdapter();
  const rootSessionId = "live-yield-root";
  const graphId = graphIdFor(rootSessionId, 1);
  const service = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });

  try {
    await service.start();
    service.openRootEpoch(rootSessionId);
    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn",
      runId: "root-run",
      toolCallId: "root-update",
    };
    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "add-running-work",
      rootModelRouteId: "test-root-model",
      source,
      commands: [addCommand({ graphId, intentId: "running-intent", operatorId: "worker", source })],
    });
    await service.supervisor.notifyGraph(graphId);

    const yielded = await service.toolPort.registerYield({
      graphId,
      epoch: 1,
      rootSessionId,
      rootTurnId: "root-turn",
      rootRunId: "root-run",
      toolCallId: "yield-running-work",
    });
    assert.equal(store.getYieldInterest(yielded.permitId)?.state, "registered");
    service.toolPort.cancelYield(yielded.permitId, rootSessionId);
    assert.equal(store.getYieldInterest(yielded.permitId)?.state, "cancelled");
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("host recovery yield wakes the root after a scheduled Run fails before yielding", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-host-recovery-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const rootWake = new CompletingRootWakePort();
  const rootSessionId = "failed-root";
  const graphId = graphIdFor(rootSessionId, 1);
  const service = createAgentGraphApplicationService({
    store,
    runtime: new CompletingRuntimeAdapter(),
    rootWakePort: rootWake,
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });
  try {
    await service.start();
    service.openRootEpoch(rootSessionId);
    const source = {
      sessionId: rootSessionId,
      turnId: "failed-root-turn",
      runId: "failed-root-run",
      toolCallId: "failed-root-update",
    };
    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "schedule-before-provider-failure",
      rootModelRouteId: "test-root-model",
      source,
      commands: [addCommand({ graphId, intentId: "completed-intent", operatorId: "worker", source })],
    });
    assert.equal(
      await service.recoverFailedRootRun({
        graphId,
        epoch: 1,
        rootSessionId,
        rootTurnId: source.turnId,
        rootRunId: source.runId,
        toolCallId: "host-failure-recovery",
      }),
      true,
    );
    assert.equal(store.listYieldInterests(graphId)[0]?.state, "consumed");
    assert.equal(rootWake.starts.length, 1);
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

test("host seals only empty assembly epochs and retires scheduled work", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-host-retire-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const rootSessionId = "retired-root";
  const graphId = graphIdFor(rootSessionId, 1);
  const runtime = new RunningRuntimeAdapter();
  const service = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort: new CompletingRootWakePort(),
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });
  try {
    await service.start();
    service.openRootEpoch("empty-root");
    assert.equal(service.sealEmptyRootEpoch("empty-root"), true);
    assert.equal(store.getGraph(graphIdFor("empty-root", 1))?.phase, "finished");

    service.openRootEpoch(rootSessionId);
    const source = {
      sessionId: rootSessionId,
      turnId: "retire-turn",
      runId: "retire-run",
      toolCallId: "retire-update",
    };
    await service.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "schedule-before-retire",
      rootModelRouteId: "test-root-model",
      source,
      commands: [addCommand({ graphId, intentId: "retire-intent", operatorId: "worker", source })],
    });
    assert.equal(service.sealEmptyRootEpoch(rootSessionId), false);
    await service.supervisor.notifyGraph(graphId);
    assert.equal(await service.retireRootSession(rootSessionId, "root deleted"), true);
    assert.equal(store.getGraph(graphId)?.phase, "finished");
    assert.equal(store.listActivationClaims(graphId)[0]?.state, "cancelled");
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

class CompletingRuntimeAdapter implements AgentGraphRuntimeApplicationPort {
  readonly starts: Array<{ claimId: string; prompt: string }> = [];
  readonly projections = new Map<string, ReturnType<typeof completedProjection>>();
  releases = 0;

  constructor(private readonly emitOutput = true) {}

  async ensureOperatorProvision(input: {
    readonly provision: AgentGraphOperatorProvisionRecord;
    readonly workDir: string;
  }) {
    return {
      sessionId: input.provision.childSessionId,
      workDir: input.workDir,
      state: "provisioned" as const,
      replayed: false,
      release: () => {
        this.releases += 1;
      },
    };
  }

  async startOrObserveActivation(input: {
    readonly claim: AgentGraphActivationClaimRecord;
    readonly provision: AgentGraphOperatorProvisionRecord;
    readonly workDir: string;
    readonly prompt: string;
  }) {
    const existing = this.projections.get(input.claim.claimId);
    if (existing) return { disposition: "observed" as const, projection: existing };
    this.starts.push({ claimId: input.claim.claimId, prompt: input.prompt });
    const projection = completedProjection(input.claim, this.emitOutput);
    this.projections.set(input.claim.claimId, projection);
    return { disposition: "started" as const, projection };
  }

  async projectActivation(claim: AgentGraphActivationClaimRecord) {
    return this.projections.get(claim.claimId) ?? notStartedProjection(claim);
  }

  async stopActivation() {
    return "already_terminal" as const;
  }

  async resolveInputHandoff(
    records: readonly AgentGraphRecordRefRecord[],
  ): Promise<ResolvedAgentGraphHandoff> {
    const resolved = records.map((record) => ({
      recordId: record.recordId,
      status: "success" as const,
      provenance: {
        graphId: record.graphId,
        operatorId: record.operatorId,
        operatorGeneration: record.operatorGeneration,
        claimId: record.claimId,
        sessionId: record.sourceSessionId,
        turnId: record.sourceTurnId,
        runId: record.sourceRunId,
        invocationId: `invocation:${record.claimId}`,
        eventId: record.sourceEventId,
      },
      content: `result:${record.recordId}`,
      bytes: Buffer.byteLength(`result:${record.recordId}`, "utf8"),
      truncated: false,
      resources: [],
    }));
    return {
      records: resolved,
      totalBytes: resolved.reduce((total, record) => total + record.bytes, 0),
      truncated: false,
      prompt: records.length === 0 ? "" : `handoff:${records.length}`,
    };
  }
}

class ProvisionFailureRuntime extends CompletingRuntimeAdapter {
  ensureCalls = 0;

  constructor(private readonly failure: Error) {
    super();
  }

  override async ensureOperatorProvision(
    _input: Parameters<AgentGraphRuntimeApplicationPort["ensureOperatorProvision"]>[0],
  ): Promise<never> {
    this.ensureCalls += 1;
    throw this.failure;
  }
}

class RunningRuntimeAdapter implements AgentGraphRuntimeApplicationPort {
  private readonly delegate = new CompletingRuntimeAdapter();
  private readonly running = new Map<string, ReturnType<typeof runningProjection>>();

  ensureOperatorProvision(
    input: Parameters<AgentGraphRuntimeApplicationPort["ensureOperatorProvision"]>[0],
  ) {
    return this.delegate.ensureOperatorProvision(input);
  }

  async startOrObserveActivation(input: {
    readonly claim: AgentGraphActivationClaimRecord;
    readonly provision: AgentGraphOperatorProvisionRecord;
    readonly workDir: string;
    readonly prompt: string;
  }) {
    const existing = this.running.get(input.claim.claimId);
    if (existing) return { disposition: "observed" as const, projection: existing };
    const projection = runningProjection(input.claim);
    this.running.set(input.claim.claimId, projection);
    return { disposition: "started" as const, projection };
  }

  async projectActivation(claim: AgentGraphActivationClaimRecord) {
    return this.running.get(claim.claimId) ?? notStartedProjection(claim);
  }

  async stopActivation() {
    return "already_terminal" as const;
  }

  resolveInputHandoff(records: readonly AgentGraphRecordRefRecord[]) {
    return this.delegate.resolveInputHandoff(records);
  }
}

class CompletingRootWakePort implements AgentGraphRootWakePort {
  readonly starts: Array<{
    readonly wakeId: string;
    readonly graphId: string;
    readonly rootSessionId: string;
    readonly targetTurnId: string;
    readonly targetRunId: string;
  }> = [];

  async inspect() {
    return { status: "not_started" as const };
  }

  async startOrResume(input: (typeof this.starts)[number]) {
    this.starts.push(input);
    return { status: "completed" as const };
  }
}

function addCommand(input: {
  readonly graphId: string;
  readonly intentId: string;
  readonly operatorId: string;
  readonly source: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly toolCallId: string;
  };
  readonly inputRecordIds?: readonly string[];
  readonly createdAtRevision?: number;
  readonly profileId?: string;
}) {
  return {
    kind: "add" as const,
    operator: {
      graphId: input.graphId,
      operatorId: input.operatorId,
      generation: 1,
      role: input.operatorId,
      profileId: input.profileId ?? "implement",
      workspacePolicy: { kind: "shared" as const },
    },
    intent: {
      graphId: input.graphId,
      intentId: input.intentId,
      operatorId: input.operatorId,
      operatorGeneration: 1,
      instruction: input.operatorId === "reviewer" ? "review result" : "research topic",
      expectedOutputRecordId: agentOutputRecordIdFor(input.graphId, input.intentId),
      inputRefs: (input.inputRecordIds ?? []).map((recordId) => ({ recordId })),
      createdAtRevision: input.createdAtRevision ?? 1,
      requestedBy: input.source,
    },
  };
}

function activateCommand(input: {
  readonly graphId: string;
  readonly intentId: string;
  readonly operatorId: string;
  readonly source: {
    readonly sessionId: string;
    readonly turnId: string;
    readonly runId: string;
    readonly toolCallId: string;
  };
  readonly inputRecordIds?: readonly string[];
  readonly createdAtRevision: number;
  readonly instruction: string;
}) {
  return {
    kind: "activate" as const,
    intent: {
      graphId: input.graphId,
      intentId: input.intentId,
      operatorId: input.operatorId,
      operatorGeneration: 1,
      instruction: input.instruction,
      expectedOutputRecordId: agentOutputRecordIdFor(input.graphId, input.intentId),
      inputRefs: (input.inputRecordIds ?? []).map((recordId) => ({ recordId })),
      createdAtRevision: input.createdAtRevision,
      requestedBy: input.source,
    },
  };
}

function completedProjection(claim: AgentGraphActivationClaimRecord, emitOutput = true) {
  return {
    claimId: claim.claimId,
    sessionId: claim.targetSessionId,
    turnId: claim.targetTurnId,
    runId: claim.targetRunId,
    invocationId: claim.targetInvocationId,
    status: "completed" as const,
    startedEventId: claim.runStartedEventId,
    terminalEventId: `terminal:${claim.claimId}`,
    outputEventIds: emitOutput ? [`output:${claim.claimId}`] : [],
  };
}

function notStartedProjection(claim: AgentGraphActivationClaimRecord) {
  return {
    claimId: claim.claimId,
    sessionId: claim.targetSessionId,
    turnId: claim.targetTurnId,
    runId: claim.targetRunId,
    invocationId: claim.targetInvocationId,
    status: "not_started" as const,
    outputEventIds: [],
  };
}

function runningProjection(claim: AgentGraphActivationClaimRecord) {
  return {
    claimId: claim.claimId,
    sessionId: claim.targetSessionId,
    turnId: claim.targetTurnId,
    runId: claim.targetRunId,
    invocationId: claim.targetInvocationId,
    status: "running" as const,
    startedEventId: claim.runStartedEventId,
    outputEventIds: [],
  };
}

function monotonicClock(): () => number {
  let now = 1_000;
  return () => now++;
}
