import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type {
  AgentGraphActivationIntent,
  AgentGraphOperationSource,
  AgentGraphOperator,
  AgentGraphScheduleCommand,
} from "../../src/agent-graph/core/index.js";
import {
  agentOutputRecordIdFor,
  claimIdFor,
  deterministicFingerprint,
  graphIdFor,
  intentIdFor,
  operatorIdFor,
  provisionIdFor,
} from "../../src/agent-graph/core/index.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../src/agent-graph/operator-profile-catalog.js";
import {
  AgentGraphRuntimePortBridge,
  type AgentGraphRuntimeApplicationPort,
} from "../../src/agent-graph/runtime-adapter-bridge.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphRecordRefRecord,
} from "../../src/storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

const SOURCE: AgentGraphOperationSource = {
  sessionId: "readiness-root",
  turnId: "readiness-turn",
  runId: "readiness-run",
  toolCallId: "readiness-tool",
};

test("runtime bridge derives planned, running, terminal and resolved readiness facts", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-readiness-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot });
  const control = new SqliteAgentGraphControlStoreAdapter(store);
  const graphId = graphIdFor(SOURCE.sessionId, 1);
  const producer = addCommand(graphId, "producer", 1);
  const consumer = addCommand(graphId, "consumer", 1, [producer.intent.expectedOutputRecordId]);
  store.createGraph({ graphId, rootSessionId: SOURCE.sessionId, epoch: 1 });
  control.commitScheduleRevision({
    graphId,
    expectedPreviousRevision: 0,
    operationId: "schedule-readiness",
    source: SOURCE,
    commands: [producer, consumer],
  });
  const runtime = new ReadinessRuntime();
  const bridge = new AgentGraphRuntimePortBridge({
    store,
    runtime,
    resolveOperatorWorkspace: () => ({ workDir: storageRoot }),
  });

  try {
    let state = control.getScheduleState(graphId);
    let facts = await bridge.resolveInputFacts({
      intent: consumer.intent,
      knownRecords: [],
      claims: [],
      producerIntents: state.intents,
      failedIntentIds: [],
    });
    assert.deepEqual(facts.inFlightRecordIds, [producer.intent.expectedOutputRecordId]);

    facts = await bridge.resolveInputFacts({
      intent: { ...consumer.intent, inputRefs: [{ recordId: "unowned-record" }] },
      knownRecords: [],
      claims: [],
      producerIntents: state.intents,
      failedIntentIds: [],
    });
    assert.deepEqual(facts, { records: [], inFlightRecordIds: [], failedRecordIds: [] });

    const claim = claimProducer(store, producer.operator, producer.intent, 1);
    runtime.setProjection(claim, "running", []);
    let claims = control.listActivationClaims(graphId);
    facts = await bridge.resolveInputFacts({
      intent: consumer.intent,
      knownRecords: [],
      claims,
      producerIntents: state.intents,
      failedIntentIds: [],
    });
    assert.deepEqual(facts.inFlightRecordIds, [producer.intent.expectedOutputRecordId]);

    runtime.setProjection(claim, "completed", []);
    facts = await bridge.resolveInputFacts({
      intent: consumer.intent,
      knownRecords: [],
      claims,
      producerIntents: state.intents,
      failedIntentIds: [],
    });
    assert.deepEqual(facts.failedRecordIds, [producer.intent.expectedOutputRecordId]);

    runtime.setProjection(claim, "failed", ["agent-output-event"]);
    facts = await bridge.resolveInputFacts({
      intent: consumer.intent,
      knownRecords: [],
      claims,
      producerIntents: state.intents,
      failedIntentIds: [],
    });
    assert.deepEqual(facts.inFlightRecordIds, [producer.intent.expectedOutputRecordId]);

    store.putRecordRef({
      recordId: producer.intent.expectedOutputRecordId,
      graphId,
      claimId: claim.claimId,
      operatorId: claim.operatorId,
      operatorGeneration: claim.operatorGeneration,
      recordFingerprint: deterministicFingerprint({ formal: "output" }),
      sourceSessionId: claim.targetSessionId,
      sourceTurnId: claim.targetTurnId,
      sourceRunId: claim.targetRunId,
      sourceEventId: "agent-output-event",
      kind: "agent_output",
    });
    const knownRecords = control.listRecordRefs(graphId);
    facts = await bridge.resolveInputFacts({
      intent: consumer.intent,
      knownRecords,
      claims,
      producerIntents: state.intents,
      failedIntentIds: [],
    });
    assert.deepEqual(
      facts.records.map((record) => record.recordId),
      [producer.intent.expectedOutputRecordId],
    );
    assert.deepEqual(facts.inFlightRecordIds, []);
    assert.deepEqual(facts.failedRecordIds, []);

    state = control.getScheduleState(graphId);
    claims = control.listActivationClaims(graphId);
    facts = await bridge.resolveInputFacts({
      intent: consumer.intent,
      knownRecords: [],
      claims,
      producerIntents: state.intents,
      failedIntentIds: [producer.intent.intentId],
    });
    assert.deepEqual(facts.failedRecordIds, [producer.intent.expectedOutputRecordId]);
  } finally {
    bridge.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }
});

class ReadinessRuntime implements AgentGraphRuntimeApplicationPort {
  private readonly projections = new Map<
    string,
    Awaited<ReturnType<AgentGraphRuntimeApplicationPort["projectActivation"]>>
  >();

  setProjection(
    claim: AgentGraphActivationClaimRecord,
    status: "running" | "completed" | "failed",
    outputEventIds: readonly string[],
  ): void {
    this.projections.set(claim.claimId, {
      claimId: claim.claimId,
      sessionId: claim.targetSessionId,
      turnId: claim.targetTurnId,
      runId: claim.targetRunId,
      invocationId: claim.targetInvocationId,
      status,
      terminalEventId: status === "running" ? undefined : `terminal:${claim.claimId}`,
      outputEventIds,
    });
  }

  ensureOperatorProvision(
    _input: Parameters<AgentGraphRuntimeApplicationPort["ensureOperatorProvision"]>[0],
  ): ReturnType<AgentGraphRuntimeApplicationPort["ensureOperatorProvision"]> {
    return Promise.reject(new Error("not used"));
  }

  startOrObserveActivation(
    _input: Parameters<AgentGraphRuntimeApplicationPort["startOrObserveActivation"]>[0],
  ): ReturnType<AgentGraphRuntimeApplicationPort["startOrObserveActivation"]> {
    return Promise.reject(new Error("not used"));
  }

  async projectActivation(claim: AgentGraphActivationClaimRecord) {
    const projection = this.projections.get(claim.claimId);
    if (!projection) throw new Error(`missing projection: ${claim.claimId}`);
    return projection;
  }

  async stopActivation() {
    return "already_terminal" as const;
  }

  async resolveInputHandoff(_records: readonly AgentGraphRecordRefRecord[]) {
    return { records: [], totalBytes: 0, truncated: false, prompt: "" };
  }
}

function addCommand(
  graphId: string,
  role: string,
  revision: number,
  inputRecordIds: readonly string[] = [],
): Extract<AgentGraphScheduleCommand, { kind: "add" }> {
  const operatorId = operatorIdFor(graphId, role);
  const intentId = intentIdFor(graphId, `add-${role}`, 0);
  return {
    kind: "add",
    operator: {
      graphId,
      operatorId,
      generation: 1,
      role,
      profileSnapshot: createBuiltinAgentGraphOperatorProfileCatalog().resolve({
        profileId: "implement",
        rootModelRouteId: "test/model",
      }),
      workspacePolicy: { kind: "shared" },
    },
    intent: {
      graphId,
      intentId,
      operatorId,
      operatorGeneration: 1,
      instruction: `complete ${role}`,
      expectedOutputRecordId: agentOutputRecordIdFor(graphId, intentId),
      inputRefs: inputRecordIds.map((recordId) => ({ recordId })),
      createdAtRevision: revision,
      requestedBy: SOURCE,
    },
  };
}

function claimProducer(
  store: SqliteAgentGraphControlStore,
  operator: AgentGraphOperator,
  intent: AgentGraphActivationIntent,
  expectedGraphRevision: number,
): AgentGraphActivationClaimRecord {
  const provisionId = provisionIdFor(operator.graphId, operator.operatorId, operator.generation);
  const provision = store.ensureOperatorProvision({
    provisionId,
    graphId: operator.graphId,
    operatorId: operator.operatorId,
    generation: operator.generation,
    scheduleRevision: intent.createdAtRevision,
    provisionFingerprint: deterministicFingerprint(operator),
    childSessionId: `session:${provisionId}`,
    profileSnapshot: operator.profileSnapshot,
    workspaceBinding: { kind: "shared" },
  }).record;
  store.transitionOperatorProvision({
    provisionId,
    expectedVersion: provision.version,
    from: "requested",
    to: "provisioned",
  });
  const claimId = claimIdFor(intent.graphId, intent.intentId);
  return store.claimActivation({
    claimId,
    graphId: intent.graphId,
    intentId: intent.intentId,
    operatorId: intent.operatorId,
    operatorGeneration: intent.operatorGeneration,
    expectedGraphRevision,
    intentFingerprint: deterministicFingerprint(intent),
    readinessFingerprint: deterministicFingerprint({ ready: true }),
    targetSessionId: `session:${provisionId}`,
    targetTurnId: `turn:${claimId}`,
    targetRunId: `run:${claimId}`,
    targetInvocationId: `invocation:${claimId}`,
    runStartedEventId: `run-started:${claimId}`,
  }).record;
}
