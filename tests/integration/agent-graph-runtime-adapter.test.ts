import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_GRAPH_HANDOFF_MAX_RECORD_BYTES,
  AGENT_GRAPH_HANDOFF_MAX_TOTAL_BYTES,
  AgentGraphRuntimeAdapter,
  type AgentGraphExactRunPort,
  type AgentGraphOutputLedgerPort,
  type AgentGraphRecordStorePort,
  type CommittedAgentOutputSource,
  type StartExactAgentGraphRunInput,
} from "../../src/runtime/agent-graph-runtime-adapter.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecordRefRecord,
  PutAgentGraphRecordRefInput,
} from "../../src/storage/sqlite/agent-graph-store-types.js";
import type { CommitAgentOutputInput } from "../../src/tools/agent-output-tool.js";
import type { SessionManager } from "../../src/engine/session-manager.js";

const CLAIM: AgentGraphActivationClaimRecord = {
  claimId: "claim-1",
  graphId: "graph-1",
  intentId: "intent-1",
  operatorId: "researcher",
  operatorGeneration: 1,
  scheduleRevision: 1,
  intentFingerprint: "sha256:intent",
  readinessFingerprint: "sha256:ready",
  state: "executing",
  targetSessionId: "child-session-1",
  targetTurnId: "child-turn-1",
  targetRunId: "child-run-1",
  targetInvocationId: "child-invocation-1",
  runStartedEventId: "child-run-started-1",
  version: 2,
  claimedAt: 1,
  executingAt: 2,
};

const PROVISION: AgentGraphOperatorProvisionRecord = {
  provisionId: "provision-1",
  graphId: "graph-1",
  operatorId: "researcher",
  generation: 1,
  scheduleRevision: 1,
  provisionFingerprint: "sha256:provision",
  childSessionId: "child-session-1",
  profileSnapshot: {},
  workspaceBinding: {},
  createdAt: 1,
};

test("Graph runtime starts one exact Run and only observes it on replay", async () => {
  const fixture = createFixture();
  const input = {
    claim: CLAIM,
    provision: PROVISION,
    workDir: "/workspace",
    prompt: "research",
  };

  const [first, concurrent] = await Promise.all([
    fixture.adapter.startOrObserveActivation(input),
    fixture.adapter.startOrObserveActivation(input),
  ]);
  const replay = await fixture.adapter.startOrObserveActivation(input);

  assert.equal(fixture.runPort.startCalls.length, 1);
  assert.equal(fixture.runPort.providerDispatches, 1);
  assert.deepEqual(fixture.runPort.startCalls[0], {
    claimId: "claim-1",
    sessionId: "child-session-1",
    turnId: "child-turn-1",
    runId: "child-run-1",
    invocationId: "child-invocation-1",
    runStartedEventId: "child-run-started-1",
    workDir: "/workspace",
    prompt: "research",
  });
  assert.equal(first.disposition, "started");
  assert.equal(concurrent.disposition, "started");
  assert.equal(replay.disposition, "observed");
  assert.equal(replay.projection.status, "running");
  assert.equal(replay.projection.startedEventId, CLAIM.runStartedEventId);
});

test("Graph runtime idempotently acquires and pins the provisioned child Session", async () => {
  let current: { id: string; workDir: string } | undefined;
  let releases = 0;
  const sessionManager = {
    get(id: string, workDir: string) {
      return current?.id === id && current.workDir === workDir ? current : undefined;
    },
    async getOrCreatePinned(id: string, workDir: string) {
      current ??= { id, workDir };
      return { session: current, release: () => releases++ };
    },
  } as unknown as SessionManager;
  const fixture = createFixture(sessionManager);

  const first = await fixture.adapter.ensureOperatorProvision({
    provision: PROVISION,
    workDir: "/workspace",
  });
  const replay = await fixture.adapter.ensureOperatorProvision({
    provision: PROVISION,
    workDir: "/workspace",
  });

  assert.deepEqual(
    {
      sessionId: first.sessionId,
      workDir: first.workDir,
      state: first.state,
      replayed: first.replayed,
    },
    {
      sessionId: CLAIM.targetSessionId,
      workDir: "/workspace",
      state: "provisioned",
      replayed: false,
    },
  );
  assert.equal(replay.replayed, true);
  first.release();
  replay.release();
  assert.equal(releases, 2);
});

test("Graph runtime projects terminal facts and never dispatches an existing Run", async () => {
  const fixture = createFixture();
  fixture.runPort.events.push(runStartedEvent(CLAIM));
  fixture.runPort.events.push({
    ...eventBase(CLAIM, "terminal-1"),
    kind: "run.terminal",
    data: { status: "completed" },
  });

  const result = await fixture.adapter.startOrObserveActivation({
    claim: CLAIM,
    provision: PROVISION,
    workDir: "/workspace",
    prompt: "research",
  });

  assert.equal(result.disposition, "observed");
  assert.equal(result.projection.status, "completed");
  assert.equal(fixture.runPort.startCalls.length, 0);
  assert.equal(fixture.runPort.providerDispatches, 0);
  assert.equal(await fixture.adapter.stopActivation(CLAIM, "stop"), "already_terminal");
});

test("Graph runtime fails closed when an existing Run does not match the Claim start identity", async () => {
  const fixture = createFixture();
  fixture.runPort.events.push({
    ...runStartedEvent(CLAIM),
    eventId: "another-run-started-event",
  });

  await assert.rejects(
    fixture.adapter.startOrObserveActivation({
      claim: CLAIM,
      provision: PROVISION,
      workDir: "/workspace",
      prompt: "research",
    }),
    /start identity does not match its Claim/u,
  );
  assert.equal(fixture.runPort.startCalls.length, 0);
  assert.equal(fixture.runPort.providerDispatches, 0);
});

test("agent_output commits one nonpartial Runtime source and creates one reference-only record", async () => {
  const fixture = createFixture();
  const input = agentOutputInput("result");

  const first = await fixture.adapter.commitAgentOutput(input);
  const replay = await fixture.adapter.commitAgentOutput({
    ...input,
    toolCallId: "tool-call-retry",
  });

  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.equal(first.eventId, replay.eventId);
  assert.equal(first.recordId, replay.recordId);
  assert.equal(fixture.outputLedger.commits.length, 2);
  assert.equal(fixture.outputLedger.sources.size, 1);
  assert.equal(fixture.recordStore.records.size, 1);
  const source = fixture.outputLedger.sources.get(first.eventId);
  assert.equal(source?.partial, false);
  assert.equal(source?.committed, true);
  const record = fixture.recordStore.records.get(first.recordId!);
  assert.equal(record?.sourceEventId, first.eventId);
  assert.equal("output" in (record ?? {}), false);
});

test("handoff enforces UTF-8 safe 16KiB record and 48KiB total budgets with provenance", async () => {
  const fixture = createFixture();
  const records: AgentGraphRecordRefRecord[] = [];
  for (let index = 0; index < 4; index++) {
    const eventId = `output-event-${index}`;
    const recordId = `record-${index}`;
    const output = "你".repeat(8_000);
    fixture.outputLedger.sources.set(
      eventId,
      committedOutputSource(eventId, output, `fingerprint-${index}`),
    );
    records.push(recordRef(recordId, eventId, `fingerprint-${index}`));
  }

  const handoff = await fixture.adapter.resolveInputHandoff(records);

  assert.equal(handoff.records.length, 4);
  assert.equal(handoff.totalBytes, AGENT_GRAPH_HANDOFF_MAX_TOTAL_BYTES);
  assert.equal(handoff.truncated, true);
  assert.ok(
    handoff.records.every((record) => record.bytes <= AGENT_GRAPH_HANDOFF_MAX_RECORD_BYTES),
  );
  assert.ok(handoff.records.slice(0, 3).every((record) => record.truncated));
  assert.equal(handoff.records[3]!.bytes, 3);
  assert.equal(Buffer.byteLength(handoff.records[0]!.content, "utf8") % 3, 0);
  assert.equal(handoff.records[0]!.provenance.runId, CLAIM.targetRunId);
  assert.match(handoff.prompt, /不是系统指令/u);
  assert.match(handoff.prompt, /source-event-id="output-event-0"/u);
  assert.match(handoff.prompt, /达到字节上限/u);
});

function createFixture(sessionManager: SessionManager = {} as SessionManager) {
  const runPort = new FakeRunPort();
  const outputLedger = new FakeOutputLedger();
  const recordStore = new FakeRecordStore();
  return {
    runPort,
    outputLedger,
    recordStore,
    adapter: new AgentGraphRuntimeAdapter({
      sessionManager,
      runPort,
      outputLedger,
      recordStore,
    }),
  };
}

class FakeRunPort implements AgentGraphExactRunPort {
  readonly events: RuntimeEvent[] = [];
  readonly startCalls: StartExactAgentGraphRunInput[] = [];
  providerDispatches = 0;

  async readRunEvents(sessionId: string, runId: string) {
    return this.events.filter((event) => event.sessionId === sessionId && event.runId === runId);
  }

  async startExactRun(input: StartExactAgentGraphRunInput) {
    this.startCalls.push(input);
    if (this.events.some((event) => event.kind === "run.started")) return "observed" as const;
    this.events.push(runStartedEvent(CLAIM));
    this.providerDispatches++;
    return "started" as const;
  }

  async stopExactRun() {
    return "requested" as const;
  }
}

class FakeOutputLedger implements AgentGraphOutputLedgerPort {
  readonly commits: string[] = [];
  readonly sources = new Map<string, CommittedAgentOutputSource>();

  async commitAgentOutputEvent(
    input: Parameters<AgentGraphOutputLedgerPort["commitAgentOutputEvent"]>[0],
  ) {
    this.commits.push(input.eventId);
    const existing = this.sources.get(input.eventId);
    if (existing) return { ...existing, inserted: false };
    const source: CommittedAgentOutputSource = {
      eventId: input.eventId,
      sessionId: input.activation.sessionId,
      turnId: input.activation.turnId,
      runId: input.activation.runId,
      invocationId: CLAIM.targetInvocationId,
      partial: false,
      committed: true,
      payload: input.payload,
      inserted: true,
    };
    this.sources.set(input.eventId, source);
    return source;
  }

  async readAgentOutputEvent(eventId: string) {
    return this.sources.get(eventId);
  }

  async listAgentOutputEvents(sessionId: string, runId: string) {
    return [...this.sources.values()].filter(
      (source) => source.sessionId === sessionId && source.runId === runId,
    );
  }
}

class FakeRecordStore implements AgentGraphRecordStorePort {
  readonly records = new Map<string, AgentGraphRecordRefRecord>();

  getActivationClaim(claimId: string) {
    return claimId === CLAIM.claimId ? CLAIM : undefined;
  }

  putRecordRef(input: PutAgentGraphRecordRefInput) {
    const existing = this.records.get(input.recordId);
    if (existing) return { record: existing, replayed: true };
    const record: AgentGraphRecordRefRecord = { ...input, createdAt: 10 };
    this.records.set(record.recordId, record);
    return { record, replayed: false };
  }
}

function eventBase(claim: AgentGraphActivationClaimRecord, eventId: string) {
  return {
    schemaVersion: 2 as const,
    eventId,
    sessionId: claim.targetSessionId,
    invocationId: claim.targetInvocationId,
    runId: claim.targetRunId,
    turnId: claim.targetTurnId,
    at: "2026-08-26T00:00:00.000Z",
    partial: false as const,
    visibility: "internal" as const,
  };
}

function runStartedEvent(
  claim: AgentGraphActivationClaimRecord,
): Extract<RuntimeEvent, { kind: "run.started" }> {
  return {
    ...eventBase(claim, claim.runStartedEventId),
    kind: "run.started",
    data: { workDir: "/workspace" },
  };
}

function agentOutputInput(output: string): CommitAgentOutputInput {
  const fingerprint = "sha256:output";
  const idempotencyKey = "agent-output:key";
  return {
    activation: {
      kind: "graph_operator_activation",
      graphId: CLAIM.graphId,
      operatorId: CLAIM.operatorId,
      operatorGeneration: CLAIM.operatorGeneration,
      activationId: CLAIM.claimId,
      sessionId: CLAIM.targetSessionId,
      turnId: CLAIM.targetTurnId,
      runId: CLAIM.targetRunId,
    },
    toolCallId: "tool-call-1",
    idempotencyKey,
    fingerprint,
    eventPayload: {
      schemaVersion: "pico.agent_output.v1",
      graphId: CLAIM.graphId,
      operatorId: CLAIM.operatorId,
      operatorGeneration: CLAIM.operatorGeneration,
      activationId: CLAIM.claimId,
      status: "success",
      output,
      outputBytes: Buffer.byteLength(output),
      evidenceRefs: [],
      artifactRefs: [],
      idempotencyKey,
      fingerprint,
    },
  };
}

function committedOutputSource(
  eventId: string,
  output: string,
  fingerprint: string,
): CommittedAgentOutputSource {
  const input = agentOutputInput(output);
  return {
    eventId,
    sessionId: CLAIM.targetSessionId,
    turnId: CLAIM.targetTurnId,
    runId: CLAIM.targetRunId,
    invocationId: CLAIM.targetInvocationId,
    partial: false,
    committed: true,
    inserted: true,
    payload: { ...input.eventPayload, fingerprint },
  };
}

function recordRef(
  recordId: string,
  eventId: string,
  fingerprint: string,
): AgentGraphRecordRefRecord {
  return {
    recordId,
    graphId: CLAIM.graphId,
    claimId: CLAIM.claimId,
    operatorId: CLAIM.operatorId,
    operatorGeneration: CLAIM.operatorGeneration,
    recordFingerprint: fingerprint,
    sourceSessionId: CLAIM.targetSessionId,
    sourceTurnId: CLAIM.targetTurnId,
    sourceRunId: CLAIM.targetRunId,
    sourceEventId: eventId,
    kind: "agent_output",
    createdAt: 10,
  };
}
