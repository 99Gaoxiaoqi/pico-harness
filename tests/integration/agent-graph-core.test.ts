import assert from "node:assert/strict";
import { test } from "node:test";

import type {
  AgentGraph,
  AgentGraphActivationIntent,
  AgentGraphOperationSource,
  AgentGraphOperator,
  AgentGraphRecordRef,
  AgentGraphScheduleCommand,
  AgentGraphScheduleRevision,
  AgentGraphScheduleState,
} from "../../src/agent-graph/core/index.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../src/agent-graph/operator-profile-catalog.js";
import {
  AgentGraphConflictError,
  AgentGraphReadinessError,
  applyScheduleRevision,
  agentOutputRecordIdFor,
  canAdmitIntent,
  claimIdFor,
  createAgentGraphScheduleState,
  createScheduleRevision,
  deterministicFingerprint,
  graphIdFor,
  intentIdFor,
  isIntentStopped,
  operatorIdFor,
  provisionIdFor,
  recordIdFor,
  resolveIntentReadiness,
  wakeIdFor,
} from "../../src/agent-graph/core/index.js";

const SOURCE: AgentGraphOperationSource = {
  sessionId: "root-session",
  turnId: "root-turn-1",
  runId: "root-run-1",
  toolCallId: "tool-call-1",
};

function graph(): AgentGraph {
  return {
    graphId: graphIdFor("root-session", 1),
    rootSessionId: "root-session",
    epoch: 1,
    admissionPhase: "open",
    headRevision: 0,
    selectedRecordIds: [],
    createdAt: 100,
  };
}

function addCommand(
  graphId: string,
  revision: number,
  suffix = "researcher",
  inputRecordIds: readonly string[] = [],
): Extract<AgentGraphScheduleCommand, { kind: "add" }> {
  const operatorId = operatorIdFor(graphId, suffix);
  const operator: AgentGraphOperator = {
    graphId,
    operatorId,
    generation: 1,
    role: suffix,
    profileSnapshot: createBuiltinAgentGraphOperatorProfileCatalog().resolve({
      profileId: "implement",
      rootModelRouteId: "test-model",
    }),
    workspacePolicy: { kind: "isolated-worktree", baseRef: "main" },
  };
  const intent: AgentGraphActivationIntent = {
    graphId,
    intentId: intentIdFor(graphId, `operation-${revision}`, 0),
    operatorId,
    operatorGeneration: 1,
    instruction: `Complete ${suffix} work`,
    expectedOutputRecordId: agentOutputRecordIdFor(
      graphId,
      intentIdFor(graphId, `operation-${revision}`, 0),
    ),
    inputRefs: inputRecordIds.map((recordId) => ({ recordId })),
    createdAtRevision: revision,
    requestedBy: SOURCE,
  };
  return { kind: "add", operator, intent };
}

function activateCommand(
  graphId: string,
  revision: number,
  operator: AgentGraphOperator,
  suffix = "follow-up",
): Extract<AgentGraphScheduleCommand, { kind: "activate" }> {
  return {
    kind: "activate",
    intent: {
      graphId,
      intentId: intentIdFor(graphId, `operation-${revision}-${suffix}`, 0),
      operatorId: operator.operatorId,
      operatorGeneration: operator.generation,
      instruction: `Complete ${suffix} work`,
      expectedOutputRecordId: agentOutputRecordIdFor(
        graphId,
        intentIdFor(graphId, `operation-${revision}-${suffix}`, 0),
      ),
      inputRefs: [],
      createdAtRevision: revision,
      requestedBy: SOURCE,
    },
  };
}

function revision(
  graphId: string,
  number: number,
  operationId: string,
  commands: readonly AgentGraphScheduleCommand[],
): AgentGraphScheduleRevision {
  return createScheduleRevision({
    graphId,
    revision: number,
    expectedPreviousRevision: number - 1,
    operationId,
    source: SOURCE,
    commands,
    createdAt: 100 + number,
  });
}

function apply(
  state: AgentGraphScheduleState,
  nextRevision: AgentGraphScheduleRevision,
): AgentGraphScheduleState {
  return applyScheduleRevision(state, nextRevision).state;
}

function record(recordId: string, graphId = "graph"): AgentGraphRecordRef {
  return {
    recordId,
    graphId,
    operatorId: "operator",
    operatorGeneration: 1,
    activationClaimId: "claim",
    sourceSessionId: "session",
    sourceTurnId: "turn",
    sourceRunId: "run",
    sourceEventId: `event-${recordId}`,
    kind: "agent-output",
  };
}

test("Graph core derives stable identities and canonical fingerprints", () => {
  assert.equal(
    deterministicFingerprint({ second: 2, first: { b: true, a: false } }),
    deterministicFingerprint({ first: { a: false, b: true }, second: 2 }),
  );
  const graphId = graphIdFor("root-session", 1);
  const operatorId = operatorIdFor(graphId, "researcher");
  const intentId = intentIdFor(graphId, "operation-1", 0);
  const claimId = claimIdFor(graphId, intentId);
  assert.match(graphId, /^graph_[a-f0-9]{32}$/u);
  assert.match(operatorId, /^operator_[a-f0-9]{32}$/u);
  assert.equal(provisionIdFor(graphId, operatorId, 1), provisionIdFor(graphId, operatorId, 1));
  assert.match(claimId, /^claim_[a-f0-9]{32}$/u);
  assert.notEqual(recordIdFor(claimId, "event-1"), recordIdFor(claimId, "event-2"));
  assert.equal(wakeIdFor(graphId, "terminal:run-1"), wakeIdFor(graphId, "terminal:run-1"));
});

test("Schedule revisions enforce CAS and operation identity without mutating prior state", () => {
  const initial = createAgentGraphScheduleState(graph());
  const firstRevision = revision(initial.graph.graphId, 1, "operation-1", [
    addCommand(initial.graph.graphId, 1),
  ]);
  const firstResult = applyScheduleRevision(initial, firstRevision);
  assert.equal(firstResult.applied, true);
  assert.equal(firstResult.state.graph.headRevision, 1);
  assert.equal(firstResult.state.operators.length, 1);
  assert.equal(initial.graph.headRevision, 0);
  assert.equal(initial.operators.length, 0);

  const retry = applyScheduleRevision(firstResult.state, firstRevision);
  assert.equal(retry.applied, false);
  assert.equal(retry.revision, 1);
  assert.strictEqual(retry.state, firstResult.state);

  const staleRevision = createScheduleRevision({
    ...revision(firstResult.state.graph.graphId, 2, "operation-2", [
      addCommand(firstResult.state.graph.graphId, 2, "reviewer"),
    ]),
    expectedPreviousRevision: 0,
  });
  assert.throws(
    () => applyScheduleRevision(firstResult.state, staleRevision),
    /expected 0, current is 1/u,
  );

  const conflictingRetry = createScheduleRevision({
    ...firstRevision,
    commands: [{ kind: "finish" }],
  });
  assert.throws(
    () => applyScheduleRevision(firstResult.state, conflictingRetry),
    /reused with a different payload/u,
  );
  assert.throws(
    () => applyScheduleRevision(firstResult.state, { ...firstRevision, fingerprint: "sha256:bad" }),
    /fingerprint does not match/u,
  );
});

test("Stop fences admission by Intent or Operator while finish only fences fresh add", () => {
  let state = createAgentGraphScheduleState(graph());
  const firstAdd = addCommand(state.graph.graphId, 1);
  state = apply(state, revision(state.graph.graphId, 1, "operation-1", [firstAdd]));
  assert.equal(canAdmitIntent(state, firstAdd.intent), true);

  state = apply(
    state,
    revision(state.graph.graphId, 2, "operation-2", [
      {
        kind: "stop",
        target: {
          kind: "operator",
          operatorId: firstAdd.operator.operatorId,
          generation: 1,
        },
        reason: "Supervisor stopped this generation",
      },
    ]),
  );
  assert.equal(isIntentStopped(state, firstAdd.intent), true);
  assert.equal(canAdmitIntent(state, firstAdd.intent), false);

  state = apply(
    state,
    revision(state.graph.graphId, 3, "operation-3", [
      { kind: "finish", selectedRecordIds: ["record-final"] },
    ]),
  );
  assert.equal(state.graph.admissionPhase, "sealed");
  assert.deepEqual(state.graph.selectedRecordIds, ["record-final"]);
  assert.throws(
    () =>
      applyScheduleRevision(
        state,
        revision(state.graph.graphId, 4, "operation-4", [
          addCommand(state.graph.graphId, 4, "late-worker"),
        ]),
      ),
    /sealed and cannot admit/u,
  );

  const stopAfterFinish = revision(state.graph.graphId, 4, "operation-stop-after-finish", [
    { kind: "stop", target: { kind: "intent", intentId: firstAdd.intent.intentId } },
  ]);
  assert.equal(applyScheduleRevision(state, stopAfterFinish).applied, true);
  assert.throws(
    () =>
      applyScheduleRevision(
        state,
        revision(state.graph.graphId, 4, "operation-unknown-stop", [
          { kind: "stop", target: { kind: "intent", intentId: "unknown" } },
        ]),
      ),
    /unknown Graph target/u,
  );
});

test("activate reuses an existing Operator generation and respects permanent stop fences", () => {
  let state = createAgentGraphScheduleState(graph());
  const added = addCommand(state.graph.graphId, 1);
  state = apply(state, revision(state.graph.graphId, 1, "operation-add", [added]));
  const followUp = activateCommand(state.graph.graphId, 2, added.operator);
  state = apply(state, revision(state.graph.graphId, 2, "operation-follow-up", [followUp]));

  assert.equal(state.operators.length, 1);
  assert.equal(state.intents.length, 2);
  assert.equal(state.intents[1]?.operatorId, added.operator.operatorId);

  const unknown = activateCommand(state.graph.graphId, 3, {
    ...added.operator,
    operatorId: "unknown-operator",
  });
  assert.throws(
    () => apply(state, revision(state.graph.graphId, 3, "operation-unknown", [unknown])),
    /unknown Operator generation/u,
  );

  state = apply(
    state,
    revision(state.graph.graphId, 3, "operation-stop-intent", [
      { kind: "stop", target: { kind: "intent", intentId: followUp.intent.intentId } },
    ]),
  );
  const afterIntentStop = activateCommand(
    state.graph.graphId,
    4,
    added.operator,
    "after-intent-stop",
  );
  state = apply(
    state,
    revision(state.graph.graphId, 4, "operation-after-intent-stop", [afterIntentStop]),
  );
  assert.equal(state.intents.length, 3);

  state = apply(
    state,
    revision(state.graph.graphId, 5, "operation-stop-operator", [
      {
        kind: "stop",
        target: {
          kind: "operator",
          operatorId: added.operator.operatorId,
          generation: added.operator.generation,
        },
      },
    ]),
  );
  assert.throws(
    () =>
      apply(
        state,
        revision(state.graph.graphId, 6, "operation-after-operator-stop", [
          activateCommand(state.graph.graphId, 6, added.operator, "blocked"),
        ]),
      ),
    /stopped Operator generation/u,
  );
});

test("finish rejects dead work admitted in the same schedule revision", () => {
  const initial = createAgentGraphScheduleState(graph());
  const added = addCommand(initial.graph.graphId, 1);
  assert.throws(
    () =>
      apply(
        initial,
        revision(initial.graph.graphId, 1, "operation-add-finish", [added, { kind: "finish" }]),
      ),
    /finish cannot be combined with add or activate/u,
  );
});

test("finish validates selected RecordRefs when the transition receives authoritative records", () => {
  const initial = createAgentGraphScheduleState(graph());
  const selectedRecordId = "record-final";
  const finish = revision(initial.graph.graphId, 1, "operation-finish", [
    { kind: "finish", selectedRecordIds: [selectedRecordId] },
  ]);

  const applied = applyScheduleRevision(initial, finish, {
    knownRecords: [record(selectedRecordId, initial.graph.graphId)],
  });
  assert.deepEqual(applied.state.graph.selectedRecordIds, [selectedRecordId]);
  assert.throws(
    () => applyScheduleRevision(initial, finish, { knownRecords: [] }),
    /does not exist/u,
  );
  assert.throws(
    () =>
      applyScheduleRevision(initial, finish, {
        knownRecords: [record(selectedRecordId, "another-graph")],
      }),
    /belongs to another Graph/u,
  );
});

test("Readiness distinguishes resolved, in-flight, failed, and unknown inputs", () => {
  const command = addCommand("graph", 1, "reviewer", ["resolved", "pending"]);
  const pending = resolveIntentReadiness(command.intent, {
    records: [record("resolved")],
    inFlightRecordIds: ["pending"],
  });
  assert.equal(pending.status, "in_flight");
  assert.deepEqual(
    pending.resolvedRecords.map((item) => item.recordId),
    ["resolved"],
  );
  assert.deepEqual(pending.inFlightRecordIds, ["pending"]);

  const resolved = resolveIntentReadiness(command.intent, {
    records: [record("resolved"), record("pending")],
  });
  assert.equal(resolved.status, "resolved");
  assert.notEqual(resolved.fingerprint, pending.fingerprint);

  assert.equal(
    resolveIntentReadiness(command.intent, {
      records: [record("resolved")],
      failedRecordIds: ["pending"],
    }).status,
    "failed",
  );
  assert.equal(
    resolveIntentReadiness(command.intent, { records: [record("resolved")] }).status,
    "unknown",
  );
  assert.throws(
    () =>
      resolveIntentReadiness(command.intent, {
        records: [record("resolved")],
        failedRecordIds: ["resolved"],
      }),
    AgentGraphReadinessError,
  );
  assert.throws(
    () =>
      resolveIntentReadiness(command.intent, {
        records: [{ ...record("resolved"), graphId: "another-graph" }],
      }),
    /belongs to another Graph/u,
  );
});

test("Graph schedule rejects cyclic future-output dependencies", () => {
  const initial = createAgentGraphScheduleState(graph());
  const left = addCommand(initial.graph.graphId, 1, "left");
  const rawRight = addCommand(initial.graph.graphId, 1, "right");
  const rightIntentId = intentIdFor(initial.graph.graphId, "cyclic-right", 0);
  const right = {
    ...rawRight,
    intent: {
      ...rawRight.intent,
      intentId: rightIntentId,
      expectedOutputRecordId: agentOutputRecordIdFor(initial.graph.graphId, rightIntentId),
    },
  };
  const cyclic = revision(initial.graph.graphId, 1, "cyclic-dependencies", [
    {
      ...left,
      intent: {
        ...left.intent,
        inputRefs: [{ recordId: right.intent.expectedOutputRecordId }],
      },
    },
    {
      ...right,
      intent: {
        ...right.intent,
        inputRefs: [{ recordId: left.intent.expectedOutputRecordId }],
      },
    },
  ]);
  assert.throws(() => applyScheduleRevision(initial, cyclic), /dependencies must be acyclic/u);
});

test("Graph schedule rejects malformed add commands", () => {
  const state = createAgentGraphScheduleState(graph());
  const command = addCommand(state.graph.graphId, 1);
  assert.throws(
    () =>
      applyScheduleRevision(
        state,
        revision(state.graph.graphId, 1, "operation-1", [
          {
            ...command,
            intent: { ...command.intent, operatorId: "different-operator" },
          },
        ]),
      ),
    AgentGraphConflictError,
  );
});
