import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { agentOutputRecordIdFor } from "../../src/agent-graph/core/ids.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../src/agent-graph/operator-profile-catalog.js";
import {
  AgentGraphStoreConflictError,
  SqliteAgentGraphControlStore,
  type ClaimAgentGraphActivationInput,
  type CommitAgentGraphScheduleInput,
} from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { withWorkspaceSqliteLease } from "../../src/storage/sqlite/workspace-scopes.js";

test("agent graph store persists exact identities, fences finish, and drives durable wakes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-store-"));
  let now = 10_000;
  const store = new SqliteAgentGraphControlStore({ storageRoot: root, now: () => now });
  try {
    const graph = store.createGraph({
      graphId: "graph-1",
      rootSessionId: "root-session",
      epoch: 1,
    });
    assert.equal(graph.replayed, false);
    assert.equal(graph.record.headRevision, 0);
    assert.equal(
      store.createGraph({ graphId: "graph-1", rootSessionId: "root-session", epoch: 1 }).replayed,
      true,
    );
    assert.throws(
      () => store.createGraph({ graphId: "graph-1", rootSessionId: "other", epoch: 1 }),
      AgentGraphStoreConflictError,
    );
    assert.throws(
      () => store.createGraph({ graphId: "graph-2", rootSessionId: "root-session", epoch: 2 }),
      /already has open graph/u,
    );

    const add = scheduleInput({ operationId: "schedule-add", expectedRevision: 0, kind: "add" });
    const revision1 = store.commitScheduleRevision(add);
    assert.equal(revision1.replayed, false);
    assert.equal(revision1.revision.revision, 1);
    assert.equal(store.commitScheduleRevision(add).replayed, true);
    assert.throws(
      () => store.commitScheduleRevision({ ...add, requestFingerprint: "other-fingerprint" }),
      /another fingerprint/u,
    );
    assert.throws(
      () =>
        store.commitScheduleRevision(
          scheduleInput({ operationId: "stale-add", expectedRevision: 0, kind: "add" }),
        ),
      /revision changed/u,
    );

    const provisionInput = {
      provisionId: "provision-1",
      graphId: "graph-1",
      operatorId: "researcher",
      generation: 1,
      scheduleRevision: 1,
      provisionFingerprint: "provision-fingerprint",
      childSessionId: "child-session-1",
      profileSnapshot: { model: "test-model", tools: ["read"] },
      workspaceBinding: { kind: "isolated-worktree", path: "/tmp/worktree" },
    } as const;
    assert.equal(store.ensureOperatorProvision(provisionInput).replayed, false);
    assert.equal(store.getOperatorProvision("graph-1", "researcher", 1)?.state, "requested");
    assert.equal(store.ensureOperatorProvision(provisionInput).replayed, true);
    assert.throws(
      () =>
        store.ensureOperatorProvision({
          ...provisionInput,
          childSessionId: "another-child-session",
        }),
      /different immutable metadata/u,
    );

    assert.throws(() => store.claimActivation(activationClaimInput()), /not provisioned/u);
    const provisioned = store.transitionOperatorProvision({
      provisionId: "provision-1",
      expectedVersion: 1,
      from: "requested",
      to: "provisioned",
    });
    assert.equal(provisioned.record.state, "provisioned");
    assert.equal(provisioned.record.version, 2);
    assert.equal(
      store.transitionOperatorProvision({
        provisionId: "provision-1",
        expectedVersion: 1,
        from: "requested",
        to: "provisioned",
      }).replayed,
      true,
    );

    const claimInput = activationClaimInput();
    const claim = store.claimActivation(claimInput);
    assert.equal(claim.replayed, false);
    assert.equal(claim.record.state, "claimed");
    assert.equal(claim.record.targetRunId, "child-run-1");
    assert.equal(store.claimActivation(claimInput).replayed, true);
    assert.throws(
      () => store.claimActivation({ ...claimInput, targetRunId: "another-run" }),
      /another exact run/u,
    );

    now += 1;
    const executing = store.transitionActivationClaim({
      claimId: "claim-1",
      expectedVersion: 1,
      from: "claimed",
      to: "executing",
    });
    assert.equal(executing.replayed, false);
    assert.equal(executing.record.state, "executing");
    assert.equal(executing.record.version, 2);
    assert.equal(
      store.transitionActivationClaim({
        claimId: "claim-1",
        expectedVersion: 1,
        from: "claimed",
        to: "executing",
      }).replayed,
      true,
    );

    const recordInput = {
      recordId: "record-1",
      graphId: "graph-1",
      claimId: "claim-1",
      operatorId: "researcher",
      operatorGeneration: 1,
      recordFingerprint: "record-fingerprint",
      sourceSessionId: "child-session-1",
      sourceTurnId: "child-turn-1",
      sourceRunId: "child-run-1",
      sourceEventId: "agent-output-event-1",
      kind: "agent_output",
    } as const;
    assert.equal(store.putRecordRef(recordInput).replayed, false);
    assert.equal(store.putRecordRef(recordInput).replayed, true);
    assert.throws(
      () =>
        store.putRecordRef({
          ...recordInput,
          recordId: "record-with-wrong-source",
          sourceRunId: "wrong-run",
          sourceEventId: "agent-output-event-2",
        }),
      /source identity/u,
    );

    const wakeInput = {
      wakeId: "wake-1",
      graphId: "graph-1",
      dedupeKey: "runtime-terminal:child-run-1",
      wakeFingerprint: "wake-fingerprint",
      cause: "runtime_terminal",
      payload: { claimId: "claim-1" },
    } as const;
    assert.equal(store.enqueueSupervisorWake(wakeInput).replayed, false);
    assert.equal(
      store.enqueueSupervisorWake({ ...wakeInput, wakeId: "ignored-replay-id" }).record.wakeId,
      "wake-1",
    );
    assert.throws(
      () => store.enqueueSupervisorWake({ ...wakeInput, wakeFingerprint: "other" }),
      /another fingerprint/u,
    );
    assert.deepEqual(
      store.listDueSupervisorWakes().map((wake) => wake.wakeId),
      ["wake-1"],
    );
    assert.equal(store.listRecoverableSupervisorWakes()[0]?.attempt, undefined);

    const attempt1 = store.claimSupervisorWake({
      wakeId: "wake-1",
      expectedWakeVersion: 1,
      attemptId: "wake-attempt-1",
      rootSessionId: "root-session",
      targetTurnId: "root-turn-1",
      targetRunId: "root-run-1",
    });
    assert.equal(attempt1.replayed, false);
    assert.equal(attempt1.wake.status, "running");
    assert.equal(attempt1.wake.version, 2);
    assert.equal(
      store.getRecoverableSupervisorWake("wake-1")?.attempt?.attemptId,
      "wake-attempt-1",
    );
    assert.equal(
      store.claimSupervisorWake({
        wakeId: "wake-1",
        expectedWakeVersion: 1,
        attemptId: "wake-attempt-1",
        rootSessionId: "root-session",
        targetTurnId: "root-turn-1",
        targetRunId: "root-run-1",
      }).replayed,
      true,
    );

    const retryAt = now + 100;
    const retryable = store.settleSupervisorWake({
      wakeId: "wake-1",
      attemptId: "wake-attempt-1",
      expectedWakeVersion: 2,
      expectedAttemptVersion: 1,
      outcome: "retryable_failed",
      error: "root runtime temporarily unavailable",
      retryAt,
    });
    assert.equal(retryable.wake.status, "retryable_failed");
    assert.equal(retryable.attempt.status, "failed");
    assert.deepEqual(store.listDueSupervisorWakes(), []);
    assert.equal(store.listRecoverableSupervisorWakes()[0]?.wake.status, "retryable_failed");

    now = retryAt;
    const attempt2 = store.claimSupervisorWake({
      wakeId: "wake-1",
      expectedWakeVersion: 3,
      attemptId: "wake-attempt-2",
      rootSessionId: "root-session",
      targetTurnId: "root-turn-2",
      targetRunId: "root-run-2",
    });
    assert.equal(attempt2.attempt.attemptNumber, 2);
    const waitingPermission = store.settleSupervisorWake({
      wakeId: "wake-1",
      attemptId: "wake-attempt-2",
      expectedWakeVersion: 4,
      expectedAttemptVersion: 1,
      outcome: "waiting_permission",
      error: "approval required",
    });
    assert.equal(waitingPermission.wake.status, "waiting_permission");
    assert.equal(waitingPermission.attempt.status, "waiting_permission");
    assert.equal(waitingPermission.attempt.finishedAt, undefined);
    assert.equal(
      store.getRecoverableSupervisorWake("wake-1")?.attempt?.attemptId,
      "wake-attempt-2",
    );
    const delivered = store.settleSupervisorWake({
      wakeId: "wake-1",
      attemptId: "wake-attempt-2",
      expectedWakeVersion: 5,
      expectedAttemptVersion: 2,
      outcome: "delivered",
    });
    assert.equal(delivered.wake.status, "delivered");
    assert.equal(delivered.attempt.status, "completed");
    assert.equal(store.getRecoverableSupervisorWake("wake-1"), undefined);
    assert.equal(
      store.settleSupervisorWake({
        wakeId: "wake-1",
        attemptId: "wake-attempt-2",
        expectedWakeVersion: 5,
        expectedAttemptVersion: 2,
        outcome: "delivered",
      }).replayed,
      true,
    );

    const stop = store.commitScheduleRevision(
      scheduleInput({ operationId: "schedule-stop", expectedRevision: 1, kind: "stop" }),
    );
    assert.equal(stop.revision.revision, 2);
    const batch = store.commitScheduleRevision(
      scheduleInput({ operationId: "schedule-batch", expectedRevision: 2, kind: "batch" }),
    );
    assert.equal(batch.revision.revision, 3);
    const finish = store.commitScheduleRevision(
      scheduleInput({ operationId: "schedule-finish", expectedRevision: 3, kind: "finish" }),
    );
    assert.equal(finish.graph.phase, "finished");
    assert.equal(finish.graph.headRevision, 4);
    assert.throws(
      () =>
        store.commitScheduleRevision(
          scheduleInput({ operationId: "after-finish", expectedRevision: 4, kind: "add" }),
        ),
      /finished/u,
    );
    const stopAfterFinish = store.commitScheduleRevision(
      scheduleInput({ operationId: "stop-after-finish", expectedRevision: 4, kind: "stop" }),
    );
    assert.equal(stopAfterFinish.graph.phase, "finished");
    assert.equal(stopAfterFinish.graph.headRevision, 5);
    assert.equal(store.ensureOperatorProvision(provisionInput).replayed, true);
    assert.equal(store.claimActivation(claimInput).replayed, true);

    assert.deepEqual(
      store.listScheduleRevisions("graph-1").map(({ kind }) => kind),
      ["add", "stop", "batch", "finish", "stop"],
    );
    assert.equal(store.listOperatorProvisions("graph-1").length, 1);
    assert.equal(store.listActivationClaims("graph-1").length, 1);
    assert.equal(store.listRecordRefs("graph-1").length, 1);
    assert.equal(store.listSupervisorWakeAttempts("wake-1").length, 2);
  } finally {
    store.close();
  }

  const reopened = new SqliteAgentGraphControlStore({ storageRoot: root });
  try {
    assert.equal(reopened.getGraph("graph-1")?.phase, "finished");
    assert.equal(reopened.getActivationClaim("claim-1")?.targetRunId, "child-run-1");
    assert.equal(reopened.getRecordRef("record-1")?.sourceEventId, "agent-output-event-1");
    assert.equal(reopened.getSupervisorWake("wake-1")?.status, "delivered");
  } finally {
    reopened.close();
  }

  withWorkspaceSqliteLease(root, (lease) => {
    const version = lease.database
      .prepare("SELECT version FROM operational_schema_migrations WHERE scope = 'agent_graph'")
      .get() as { version: number } | undefined;
    assert.equal(version?.version, 3);
    const names = lease.database
      .prepare(
        `SELECT name FROM sqlite_schema
         WHERE type = 'table' AND name LIKE 'agent_graph_%' ORDER BY name`,
      )
      .all()
      .map((row) => (row as { name: string }).name);
    assert.deepEqual(names, [
      "agent_graph_activation_claims",
      "agent_graph_operator_provisions",
      "agent_graph_record_refs",
      "agent_graph_resource_refs",
      "agent_graph_schedule_revisions",
      "agent_graph_supervisor_wake_attempts",
      "agent_graph_supervisor_wakes",
      "agent_graph_workspace_resources",
      "agent_graph_yield_interests",
      "agent_graphs",
    ]);
  });

  await rm(root, { recursive: true, force: true });
});

test("agent graph store atomically consumes durable yield interest when admitting a wake", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-yield-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot: root, now: () => 50 });
  try {
    store.createGraph({ graphId: "yield-graph", rootSessionId: "yield-root", epoch: 1 });
    const wake = {
      wakeId: "yield-wake",
      graphId: "yield-graph",
      dedupeKey: "runtime-terminal:child-run",
      wakeFingerprint: "yield-wake-fingerprint",
      cause: "runtime_terminal",
      payload: { runId: "child-run" },
    } as const;
    assert.deepEqual(store.enqueueSupervisorWakeForYield(wake), { status: "not_waiting" });

    const interest = {
      permitId: "yield-permit",
      graphId: "yield-graph",
      rootSessionId: "yield-root",
      rootTurnId: "yield-root-turn",
      rootRunId: "yield-root-run",
      toolCallId: "yield-tool-call",
    } as const;
    assert.equal(store.registerYieldInterest(interest).replayed, false);
    assert.equal(store.registerYieldInterest(interest).replayed, true);
    const admitted = store.enqueueSupervisorWakeForYield(wake);
    assert.equal(admitted.status, "enqueued");
    if (admitted.status !== "enqueued") throw new Error("expected admitted yield wake");
    assert.equal(admitted.replayed, false);
    assert.equal(admitted.wake.yieldPermitId, "yield-permit");
    assert.equal(admitted.interest.state, "consumed");
    assert.equal(store.listYieldInterests("yield-graph", "registered").length, 0);
    const cancel = store.registerYieldInterest({
      ...interest,
      permitId: "cancel-permit",
      rootTurnId: "cancel-turn",
      rootRunId: "cancel-run",
      toolCallId: "cancel-tool",
    });
    const replayedWake = store.enqueueSupervisorWakeForYield(wake);
    assert.equal(replayedWake.status, "enqueued");
    if (replayedWake.status !== "enqueued") throw new Error("expected replayed yield wake");
    assert.equal(replayedWake.interest.permitId, "yield-permit");
    assert.equal(store.getYieldInterest("cancel-permit")?.state, "registered");
    assert.equal(
      store.cancelYieldInterest({
        permitId: cancel.record.permitId,
        expectedVersion: cancel.record.version,
      }).record.state,
      "cancelled",
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("finish atomically accepts only selected RecordRefs from the same Graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-finish-records-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot: root });
  try {
    const ownRecordId = seedGraphRecord(store, {
      graphId: "finish-graph",
      rootSessionId: "finish-root",
      suffix: "own",
    });
    const foreignRecordId = seedGraphRecord(store, {
      graphId: "foreign-graph",
      rootSessionId: "foreign-root",
      suffix: "foreign",
    });

    assert.throws(
      () =>
        store.commitScheduleRevision(
          scheduleInput({
            graphId: "finish-graph",
            rootSessionId: "finish-root",
            operationId: "finish-unknown",
            expectedRevision: 1,
            kind: "finish",
            selectedRecordIds: ["missing-record"],
          }),
        ),
      /Selected RecordRef missing-record does not exist/u,
    );
    assert.throws(
      () =>
        store.commitScheduleRevision(
          scheduleInput({
            graphId: "finish-graph",
            rootSessionId: "finish-root",
            operationId: "finish-foreign",
            expectedRevision: 1,
            kind: "finish",
            selectedRecordIds: [foreignRecordId],
          }),
        ),
      /belongs to Graph foreign-graph/u,
    );
    assert.equal(store.getGraph("finish-graph")?.headRevision, 1);
    assert.equal(store.getGraph("finish-graph")?.phase, "open");
    assert.equal(store.listScheduleRevisions("finish-graph").length, 1);

    const finishInput = scheduleInput({
      graphId: "finish-graph",
      rootSessionId: "finish-root",
      operationId: "finish-valid",
      expectedRevision: 1,
      kind: "finish",
      selectedRecordIds: [ownRecordId],
    });
    const committed = store.commitScheduleRevision(finishInput);
    assert.equal(committed.replayed, false);
    assert.equal(committed.graph.phase, "finished");
    assert.equal(committed.graph.headRevision, 2);
    assert.equal(store.commitScheduleRevision(finishInput).replayed, true);
    assert.equal(store.listScheduleRevisions("finish-graph").length, 2);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule add atomically accepts only committed input RecordRefs from the same Graph", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-input-records-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot: root });
  const control = new SqliteAgentGraphControlStoreAdapter(store);
  try {
    const ownRecordId = seedGraphRecord(store, {
      graphId: "input-graph",
      rootSessionId: "input-root",
      suffix: "input-own",
    });
    const foreignRecordId = seedGraphRecord(store, {
      graphId: "input-foreign-graph",
      rootSessionId: "input-foreign-root",
      suffix: "input-foreign",
    });
    const before = graphMutationSnapshot(store, "input-graph");

    assert.throws(
      () =>
        control.commitScheduleRevision({
          graphId: "input-graph",
          expectedPreviousRevision: 1,
          operationId: "add-unknown-input",
          source: operationSource("input-root", "add-unknown-input"),
          commands: [
            graphAddCommand({
              graphId: "input-graph",
              suffix: "unknown-input",
              revision: 2,
              inputRecordIds: ["missing-record"],
            }),
          ],
        }),
      /Input RecordRef missing-record does not exist/u,
    );
    assert.deepEqual(graphMutationSnapshot(store, "input-graph"), before);

    assert.throws(
      () =>
        control.commitScheduleRevision({
          graphId: "input-graph",
          expectedPreviousRevision: 1,
          operationId: "add-foreign-input",
          source: operationSource("input-root", "add-foreign-input"),
          commands: [
            graphAddCommand({
              graphId: "input-graph",
              suffix: "foreign-input",
              revision: 2,
              inputRecordIds: [foreignRecordId],
            }),
          ],
        }),
      /belongs to Graph input-foreign-graph/u,
    );
    assert.deepEqual(graphMutationSnapshot(store, "input-graph"), before);

    const committed = control.commitScheduleRevision({
      graphId: "input-graph",
      expectedPreviousRevision: 1,
      operationId: "add-own-input",
      source: operationSource("input-root", "add-own-input"),
      commands: [
        graphAddCommand({
          graphId: "input-graph",
          suffix: "own-input",
          revision: 2,
          inputRecordIds: [ownRecordId],
        }),
      ],
    });
    assert.equal(committed.record.revision, 2);
    assert.equal(store.getGraph("input-graph")?.headRevision, 2);
    assert.deepEqual(
      store.listScheduleRevisions("input-graph").map((revision) => revision.operationId),
      ["add-input-own", "add-own-input"],
    );
    assert.equal(
      (store.listScheduleRevisions("input-graph")[1]?.command as { schemaVersion?: number })
        .schemaVersion,
      2,
    );
    assert.deepEqual(store.listOperatorProvisions("input-graph"), before.provisions);
    assert.deepEqual(store.listActivationClaims("input-graph"), before.claims);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("schedule accepts declared same-Graph future outputs and rejects foreign future outputs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-future-inputs-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot: root });
  const control = new SqliteAgentGraphControlStoreAdapter(store);
  try {
    store.createGraph({ graphId: "future-batch", rootSessionId: "future-batch-root", epoch: 1 });
    const batchProducer = graphAddCommand({
      graphId: "future-batch",
      suffix: "batch-producer",
      revision: 1,
      inputRecordIds: [],
    });
    const batchConsumer = graphAddCommand({
      graphId: "future-batch",
      suffix: "batch-consumer",
      revision: 1,
      inputRecordIds: [batchProducer.intent.expectedOutputRecordId],
    });
    assert.equal(
      control.commitScheduleRevision({
        graphId: "future-batch",
        expectedPreviousRevision: 0,
        operationId: "future-batch",
        source: operationSource("future-batch-root", "future-batch"),
        commands: [batchProducer, batchConsumer],
      }).record.revision,
      1,
    );

    store.createGraph({
      graphId: "future-persisted",
      rootSessionId: "future-persisted-root",
      epoch: 1,
    });
    const persistedProducer = graphAddCommand({
      graphId: "future-persisted",
      suffix: "persisted-producer",
      revision: 1,
      inputRecordIds: [],
    });
    control.commitScheduleRevision({
      graphId: "future-persisted",
      expectedPreviousRevision: 0,
      operationId: "persist-producer",
      source: operationSource("future-persisted-root", "persist-producer"),
      commands: [persistedProducer],
    });
    const persistedConsumer = graphAddCommand({
      graphId: "future-persisted",
      suffix: "persisted-consumer",
      revision: 2,
      inputRecordIds: [persistedProducer.intent.expectedOutputRecordId],
    });
    assert.equal(
      control.commitScheduleRevision({
        graphId: "future-persisted",
        expectedPreviousRevision: 1,
        operationId: "persist-consumer",
        source: operationSource("future-persisted-root", "persist-consumer"),
        commands: [persistedConsumer],
      }).record.revision,
      2,
    );

    store.createGraph({ graphId: "future-target", rootSessionId: "future-target-root", epoch: 1 });
    assert.throws(
      () =>
        control.commitScheduleRevision({
          graphId: "future-target",
          expectedPreviousRevision: 0,
          operationId: "foreign-future",
          source: operationSource("future-target-root", "foreign-future"),
          commands: [
            graphAddCommand({
              graphId: "future-target",
              suffix: "foreign-future-consumer",
              revision: 1,
              inputRecordIds: [persistedProducer.intent.expectedOutputRecordId],
            }),
          ],
        }),
      /belongs to Graph future-persisted/u,
    );
    assert.equal(store.getGraph("future-target")?.headRevision, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("agent graph store serializes schedule, activation, and finish races across processes", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-race-"));
  try {
    const seed = new SqliteAgentGraphControlStore({ storageRoot: root });
    seed.createGraph({ graphId: "race-graph", rootSessionId: "race-root", epoch: 1 });
    seed.close();

    const scheduleResults = await raceIndependentStores(root, "schedule");
    assert.deepEqual(scheduleResults.map(({ ok }) => ok).sort(), [false, true]);
    assert.match(scheduleResults.find(({ ok }) => !ok)?.message ?? "", /revision changed/u);

    const provisioner = new SqliteAgentGraphControlStore({ storageRoot: root });
    try {
      assert.equal(provisioner.getGraph("race-graph")?.headRevision, 1);
      provisioner.ensureOperatorProvision({
        provisionId: "race-provision",
        graphId: "race-graph",
        operatorId: "race-operator",
        generation: 1,
        scheduleRevision: 1,
        provisionFingerprint: "race-provision-fingerprint",
        childSessionId: "race-child-session",
        profileSnapshot: { model: "test" },
        workspaceBinding: { kind: "shared" },
      });
      provisioner.transitionOperatorProvision({
        provisionId: "race-provision",
        expectedVersion: 1,
        from: "requested",
        to: "provisioned",
      });
    } finally {
      provisioner.close();
    }

    const claimResults = await raceIndependentStores(root, "claim");
    assert.deepEqual(claimResults.map(({ ok }) => ok).sort(), [false, true]);
    assert.match(claimResults.find(({ ok }) => !ok)?.message ?? "", /another exact run/u);

    const inspect = new SqliteAgentGraphControlStore({ storageRoot: root });
    try {
      assert.equal(inspect.listScheduleRevisions("race-graph").length, 1);
      const claims = inspect.listActivationClaims("race-graph");
      assert.equal(claims.length, 1);
      assert.equal(claims[0]?.targetSessionId, "race-child-session");
      assert.match(claims[0]?.targetRunId ?? "", /^race-child-run-[12]$/u);
      const claim = claims[0];
      assert.ok(claim);
      inspect.putRecordRef({
        recordId: "race-record",
        graphId: claim.graphId,
        claimId: claim.claimId,
        operatorId: claim.operatorId,
        operatorGeneration: claim.operatorGeneration,
        recordFingerprint: "race-record-fingerprint",
        sourceSessionId: claim.targetSessionId,
        sourceTurnId: claim.targetTurnId,
        sourceRunId: claim.targetRunId,
        sourceEventId: "race-record-event",
        kind: "agent_output",
      });
    } finally {
      inspect.close();
    }

    const finishResults = await raceIndependentStores(root, "finish");
    assert.deepEqual(finishResults.map(({ ok }) => ok).sort(), [false, true]);
    assert.match(finishResults.find(({ ok }) => !ok)?.message ?? "", /finished|revision changed/u);
    const finished = new SqliteAgentGraphControlStore({ storageRoot: root });
    try {
      const revisions = finished.listScheduleRevisions("race-graph");
      assert.equal(revisions.length, 2);
      assert.equal(revisions[1]?.kind, "finish");
      assert.equal(finished.getGraph("race-graph")?.headRevision, 2);
      assert.equal(finished.getGraph("race-graph")?.phase, "finished");
      const winner = revisions[1];
      assert.ok(winner);
      const racer = winner.operationId.endsWith("-1") ? 1 : 2;
      assert.equal(
        finished.commitScheduleRevision({
          graphId: "race-graph",
          expectedRevision: 1,
          operationId: `race-finish-${racer}`,
          requestFingerprint: `race-finish-fingerprint-${racer}`,
          kind: "finish",
          command: { kind: "finish", selectedRecordIds: ["race-record"] },
          sourceSessionId: "race-root",
          sourceTurnId: `race-finish-turn-${racer}`,
          sourceRunId: `race-finish-run-${racer}`,
          sourceToolCallId: `race-finish-tool-${racer}`,
        }).replayed,
        true,
      );
      assert.equal(finished.listScheduleRevisions("race-graph").length, 2);
    } finally {
      finished.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function scheduleInput(options: {
  graphId?: string;
  rootSessionId?: string;
  operationId: string;
  expectedRevision: number;
  kind: CommitAgentGraphScheduleInput["kind"];
  selectedRecordIds?: readonly string[];
}): CommitAgentGraphScheduleInput {
  const selectedRecordIds = options.selectedRecordIds ?? [];
  return {
    graphId: options.graphId ?? "graph-1",
    expectedRevision: options.expectedRevision,
    operationId: options.operationId,
    requestFingerprint: `fingerprint:${options.operationId}`,
    kind: options.kind,
    command: { kind: options.kind, operatorId: "researcher", selectedRecordIds },
    sourceSessionId: options.rootSessionId ?? "root-session",
    sourceTurnId: "root-source-turn",
    sourceRunId: "root-source-run",
    sourceToolCallId: `tool:${options.operationId}`,
  };
}

function activationClaimInput(): ClaimAgentGraphActivationInput {
  return {
    claimId: "claim-1",
    graphId: "graph-1",
    intentId: "intent-1",
    operatorId: "researcher",
    operatorGeneration: 1,
    expectedGraphRevision: 1,
    intentFingerprint: "intent-fingerprint",
    readinessFingerprint: "readiness-fingerprint",
    targetSessionId: "child-session-1",
    targetTurnId: "child-turn-1",
    targetRunId: "child-run-1",
    targetInvocationId: "child-invocation-1",
    runStartedEventId: "child-run-started-1",
  };
}

function graphAddCommand(options: {
  readonly graphId: string;
  readonly suffix: string;
  readonly revision: number;
  readonly inputRecordIds: readonly string[];
}) {
  const source = operationSource(`root-${options.suffix}`, `add-${options.suffix}`);
  return {
    kind: "add" as const,
    operator: {
      graphId: options.graphId,
      operatorId: `operator-${options.suffix}`,
      generation: 1,
      role: `role-${options.suffix}`,
      profileSnapshot: createBuiltinAgentGraphOperatorProfileCatalog().resolve({
        profileId: "implement",
        rootModelRouteId: "test-model",
      }),
      workspacePolicy: { kind: "shared" as const },
    },
    intent: {
      graphId: options.graphId,
      intentId: `intent-${options.suffix}`,
      operatorId: `operator-${options.suffix}`,
      operatorGeneration: 1,
      instruction: `instruction-${options.suffix}`,
      expectedOutputRecordId: agentOutputRecordIdFor(options.graphId, `intent-${options.suffix}`),
      inputRefs: options.inputRecordIds.map((recordId) => ({ recordId })),
      createdAtRevision: options.revision,
      requestedBy: source,
    },
  };
}

function operationSource(rootSessionId: string, suffix: string) {
  return {
    sessionId: rootSessionId,
    turnId: `turn-${suffix}`,
    runId: `run-${suffix}`,
    toolCallId: `tool-${suffix}`,
  };
}

function graphMutationSnapshot(store: SqliteAgentGraphControlStore, graphId: string) {
  return {
    graph: store.getGraph(graphId),
    revisions: store.listScheduleRevisions(graphId),
    provisions: store.listOperatorProvisions(graphId),
    claims: store.listActivationClaims(graphId),
    records: store.listRecordRefs(graphId),
  };
}

function seedGraphRecord(
  store: SqliteAgentGraphControlStore,
  options: {
    readonly graphId: string;
    readonly rootSessionId: string;
    readonly suffix: string;
  },
): string {
  const operatorId = `operator-${options.suffix}`;
  const claimId = `claim-${options.suffix}`;
  const childSessionId = `child-session-${options.suffix}`;
  const childTurnId = `child-turn-${options.suffix}`;
  const childRunId = `child-run-${options.suffix}`;
  const recordId = `record-${options.suffix}`;
  store.createGraph({ graphId: options.graphId, rootSessionId: options.rootSessionId, epoch: 1 });
  new SqliteAgentGraphControlStoreAdapter(store).commitScheduleRevision({
    graphId: options.graphId,
    expectedPreviousRevision: 0,
    operationId: `add-${options.suffix}`,
    source: operationSource(options.rootSessionId, `add-${options.suffix}`),
    commands: [
      graphAddCommand({
        graphId: options.graphId,
        suffix: options.suffix,
        revision: 1,
        inputRecordIds: [],
      }),
    ],
  });
  store.ensureOperatorProvision({
    provisionId: `provision-${options.suffix}`,
    graphId: options.graphId,
    operatorId,
    generation: 1,
    scheduleRevision: 1,
    provisionFingerprint: `provision-fingerprint-${options.suffix}`,
    childSessionId,
    profileSnapshot: { model: "test" },
    workspaceBinding: { kind: "shared" },
  });
  store.transitionOperatorProvision({
    provisionId: `provision-${options.suffix}`,
    expectedVersion: 1,
    from: "requested",
    to: "provisioned",
  });
  store.claimActivation({
    claimId,
    graphId: options.graphId,
    intentId: `intent-${options.suffix}`,
    operatorId,
    operatorGeneration: 1,
    expectedGraphRevision: 1,
    intentFingerprint: `intent-fingerprint-${options.suffix}`,
    readinessFingerprint: `readiness-fingerprint-${options.suffix}`,
    targetSessionId: childSessionId,
    targetTurnId: childTurnId,
    targetRunId: childRunId,
    targetInvocationId: `invocation-${options.suffix}`,
    runStartedEventId: `run-started-${options.suffix}`,
  });
  store.putRecordRef({
    recordId,
    graphId: options.graphId,
    claimId,
    operatorId,
    operatorGeneration: 1,
    recordFingerprint: `record-fingerprint-${options.suffix}`,
    sourceSessionId: childSessionId,
    sourceTurnId: childTurnId,
    sourceRunId: childRunId,
    sourceEventId: `record-event-${options.suffix}`,
    kind: "agent_output",
  });
  return recordId;
}

interface RaceResult {
  readonly ok: boolean;
  readonly message?: string;
}

async function raceIndependentStores(
  storageRoot: string,
  action: "schedule" | "claim" | "finish",
): Promise<readonly RaceResult[]> {
  const syncRoot = await mkdtemp(join(tmpdir(), `pico-agent-graph-${action}-barrier-`));
  const startPath = join(syncRoot, "start");
  const racers = [1, 2].map((racer) => {
    const readyPath = join(syncRoot, `ready-${racer}`);
    return {
      readyPath,
      process: spawnRaceProcess({ storageRoot, action, racer, readyPath, startPath }),
    };
  });
  try {
    await Promise.all(racers.map(({ readyPath }) => waitUntilExists(readyPath)));
    await writeFile(startPath, "go", { mode: 0o600 });
    return await Promise.all(racers.map(({ process }) => collectRaceResult(process)));
  } finally {
    for (const racer of racers) {
      if (racer.process.exitCode === null) racer.process.kill("SIGKILL");
    }
    await rm(syncRoot, { recursive: true, force: true });
  }
}

function spawnRaceProcess(options: {
  storageRoot: string;
  action: "schedule" | "claim" | "finish";
  racer: number;
  readyPath: string;
  startPath: string;
}): ChildProcess {
  const storeUrl = pathToFileURL(
    join(process.cwd(), "src", "storage", "sqlite", "sqlite-agent-graph-control-store.ts"),
  ).href;
  const script = `
    import { existsSync, writeFileSync } from "node:fs";
    import { SqliteAgentGraphControlStore } from ${JSON.stringify(storeUrl)};
    const config = JSON.parse(process.env.PICO_GRAPH_RACER_CONFIG);
    const store = new SqliteAgentGraphControlStore({ storageRoot: config.storageRoot });
    writeFileSync(config.readyPath, "ready", { mode: 0o600 });
    const signal = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(config.startPath)) Atomics.wait(signal, 0, 0, 5);
    let result;
    try {
      if (config.action === "schedule") {
        store.commitScheduleRevision({
          graphId: "race-graph",
          expectedRevision: 0,
          operationId: "race-operation-" + config.racer,
          requestFingerprint: "race-operation-fingerprint-" + config.racer,
          kind: "add",
          command: { operatorId: "race-operator" },
          sourceSessionId: "race-root",
          sourceTurnId: "race-source-turn-" + config.racer,
          sourceRunId: "race-source-run-" + config.racer,
          sourceToolCallId: "race-tool-" + config.racer,
        });
      } else if (config.action === "claim") {
        store.claimActivation({
          claimId: "race-claim-" + config.racer,
          graphId: "race-graph",
          intentId: "shared-race-intent",
          operatorId: "race-operator",
          operatorGeneration: 1,
          expectedGraphRevision: 1,
          intentFingerprint: "shared-intent-fingerprint",
          readinessFingerprint: "shared-readiness-fingerprint",
          targetSessionId: "race-child-session",
          targetTurnId: "race-child-turn-" + config.racer,
          targetRunId: "race-child-run-" + config.racer,
          targetInvocationId: "race-child-invocation-" + config.racer,
          runStartedEventId: "race-run-started-" + config.racer,
        });
      } else {
        store.commitScheduleRevision({
          graphId: "race-graph",
          expectedRevision: 1,
          operationId: "race-finish-" + config.racer,
          requestFingerprint: "race-finish-fingerprint-" + config.racer,
          kind: "finish",
          command: { kind: "finish", selectedRecordIds: ["race-record"] },
          sourceSessionId: "race-root",
          sourceTurnId: "race-finish-turn-" + config.racer,
          sourceRunId: "race-finish-run-" + config.racer,
          sourceToolCallId: "race-finish-tool-" + config.racer,
        });
      }
      result = { ok: true };
    } catch (error) {
      result = { ok: false, message: error instanceof Error ? error.message : String(error) };
    } finally {
      store.close();
    }
    process.stdout.write("GRAPH_RACE_RESULT:" + JSON.stringify(result) + "\\n");
  `;
  return spawn(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PICO_GRAPH_RACER_CONFIG: JSON.stringify(options),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function collectRaceResult(child: ChildProcess): Promise<RaceResult> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const exitCode = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  assert.equal(exitCode, 0, `race process failed: ${stderr}`);
  const marker = "GRAPH_RACE_RESULT:";
  const line = stdout.split("\n").find((candidate) => candidate.startsWith(marker));
  assert.ok(line, `race process returned no result: ${stdout}\n${stderr}`);
  return JSON.parse(line.slice(marker.length)) as RaceResult;
}

async function waitUntilExists(path: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for race barrier ${path}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  await access(path);
}
