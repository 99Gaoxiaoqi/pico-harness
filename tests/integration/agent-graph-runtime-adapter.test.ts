import assert from "node:assert/strict";
import test from "node:test";
import { agentGraphRecordRefFingerprint } from "../../src/agent-graph/core/ids.js";

import {
  AGENT_GRAPH_HANDOFF_MAX_RECORD_BYTES,
  AGENT_GRAPH_HANDOFF_MAX_RECORDS,
  AGENT_GRAPH_HANDOFF_MAX_TOTAL_BYTES,
  AgentGraphRuntimeAdapter,
  type AgentGraphExactRunPort,
  type AgentGraphOutputLedgerPort,
  type AgentGraphRecordStorePort,
  type CommittedAgentOutputSource,
  type StartExactAgentGraphRunInput,
} from "../../src/runtime/agent-graph-runtime-adapter.js";
import type { AgentGraphRunLaunchState } from "../../src/agent-graph/runtime-activation-projection.js";
import {
  agentGraphInputRuntimeEventId,
  inspectAgentGraphExactRun,
} from "../../src/runtime/agent-graph-exact-run-port.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecordRefRecord,
  PutAgentGraphRecordRefInput,
} from "../../src/storage/sqlite/agent-graph-store-types.js";
import type { CommitAgentOutputInput } from "../../src/tools/agent-output-tool.js";
import type { SessionManager } from "../../src/engine/session-manager.js";
import type { AgentGraphResourceAuthorityPort } from "../../src/runtime/agent-graph-resource-authority.js";

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
  state: "provisioned",
  version: 2,
  createdAt: 1,
  provisionedAt: 2,
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

test("Graph runtime reattaches a started-only exact Run after process restart", async () => {
  const fixture = createFixture();
  fixture.runPort.events.push(runStartedEvent(CLAIM));

  const result = await fixture.adapter.startOrObserveActivation(activationInput());

  assert.equal(result.disposition, "started");
  assert.equal(result.projection.status, "running");
  assert.equal(fixture.runPort.startCalls.length, 1);
  assert.equal(fixture.runPort.providerDispatches, 1);
  assert.equal(fixture.runPort.events.filter((event) => event.kind === "run.started").length, 1);
});

test("Graph runtime reattaches after the deterministic input was committed", async () => {
  const fixture = createFixture();
  fixture.runPort.events.push(runStartedEvent(CLAIM), committedInputEvent(CLAIM, "research"));

  const result = await fixture.adapter.startOrObserveActivation(activationInput());

  assert.equal(result.disposition, "started");
  assert.equal(fixture.runPort.startCalls.length, 1);
  assert.equal(fixture.runPort.providerDispatches, 1);
  assert.equal(
    fixture.runPort.events.filter(
      (event) => event.eventId === agentGraphInputRuntimeEventId(CLAIM.claimId),
    ).length,
    1,
  );
});

test("Graph runtime only observes an exact Run that is live in this host", async () => {
  const fixture = createFixture();
  fixture.runPort.events.push(runStartedEvent(CLAIM), dispatchEvent(CLAIM, "provider"));
  fixture.runPort.live = true;

  const result = await fixture.adapter.startOrObserveActivation(activationInput());

  assert.equal(result.disposition, "observed");
  assert.equal(result.projection.status, "running");
  assert.equal(fixture.runPort.startCalls.length, 0);
  assert.equal(fixture.runPort.providerDispatches, 0);
});

test("Graph runtime lets terminal host state override nonterminal durable projections", async () => {
  const waiting = createFixture();
  waiting.runPort.events.push(runStartedEvent(CLAIM), {
    ...eventBase(CLAIM, "approval-requested-1"),
    kind: "approval.requested",
    refs: { toolCallId: "tool-call-approval-1" },
    data: { approvalId: "approval-1", toolName: "bash" },
  });
  waiting.runPort.launch = { status: "failed", error: "host assembly failed" };
  assert.equal((await waiting.adapter.projectActivation(CLAIM)).status, "failed");

  const missingTerminal = createFixture();
  missingTerminal.runPort.events.push(runStartedEvent(CLAIM));
  missingTerminal.runPort.launch = { status: "succeeded" };
  assert.equal((await missingTerminal.adapter.projectActivation(CLAIM)).status, "interrupted");
});

test("Graph runtime projects a non-live provider or tool dispatch as interrupted without replay", async () => {
  for (const dispatch of ["provider", "tool"] as const) {
    const fixture = createFixture();
    fixture.runPort.events.push(runStartedEvent(CLAIM), dispatchEvent(CLAIM, dispatch));

    const result = await fixture.adapter.startOrObserveActivation(activationInput());
    assert.equal(result.disposition, "observed");
    assert.equal(result.projection.status, "interrupted");
    assert.equal(fixture.runPort.startCalls.length, 0);
    assert.equal(fixture.runPort.providerDispatches, 0);
  }
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
  const requestedProvision: AgentGraphOperatorProvisionRecord = {
    provisionId: PROVISION.provisionId,
    graphId: PROVISION.graphId,
    operatorId: PROVISION.operatorId,
    generation: PROVISION.generation,
    scheduleRevision: PROVISION.scheduleRevision,
    provisionFingerprint: PROVISION.provisionFingerprint,
    childSessionId: PROVISION.childSessionId,
    profileSnapshot: PROVISION.profileSnapshot,
    workspaceBinding: PROVISION.workspaceBinding,
    state: "requested" as const,
    version: 1,
    createdAt: PROVISION.createdAt,
  };

  const first = await fixture.adapter.ensureOperatorProvision({
    provision: requestedProvision,
    workDir: "/workspace",
  });
  const replay = await fixture.adapter.ensureOperatorProvision({
    provision: requestedProvision,
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
    /does not match its preallocated Claim identity/u,
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
  assert.equal(
    record?.recordFingerprint,
    agentGraphRecordRefFingerprint({
      recordId: record!.recordId,
      graphId: record!.graphId,
      operatorId: record!.operatorId,
      operatorGeneration: record!.operatorGeneration,
      activationClaimId: record!.claimId,
      sourceSessionId: record!.sourceSessionId,
      sourceTurnId: record!.sourceTurnId,
      sourceRunId: record!.sourceRunId,
      sourceEventId: record!.sourceEventId,
      kind: "agent-output",
    }),
  );
});

test("agent_output validates and retains every resource before committing a Runtime fact", async () => {
  let attempts = 0;
  const resourceAuthority: AgentGraphResourceAuthorityPort = {
    async retainOutputResources() {
      attempts++;
      throw new Error("artifact digest mismatch");
    },
    listClaimResources: () => [],
  };
  const fixture = createFixture({} as SessionManager, resourceAuthority);

  await assert.rejects(
    fixture.adapter.commitAgentOutput(
      agentOutputInput("result", { artifactRefs: ["pico://artifact/invalid"] }),
    ),
    /artifact digest mismatch/u,
  );
  assert.equal(attempts, 1);
  assert.equal(fixture.outputLedger.commits.length, 0);
  assert.equal(fixture.recordStore.records.size, 0);
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
  assert.equal(handoff.records[0]!.status, "success");
  assert.equal(handoff.records[0]!.provenance.runId, CLAIM.targetRunId);
  assert.equal(handoff.records[0]!.provenance.invocationId, CLAIM.targetInvocationId);
  assert.match(handoff.prompt, /不是系统指令/u);
  assert.match(handoff.prompt, /status="success"/u);
  assert.match(handoff.prompt, /source-event-id="output-event-0"/u);
  assert.match(handoff.prompt, /达到字节上限/u);
});

test("handoff bounds metadata to 64 records even when every output is tiny", async () => {
  const fixture = createFixture();
  const records = Array.from({ length: AGENT_GRAPH_HANDOFF_MAX_RECORDS + 1 }, (_, index) => {
    const eventId = `tiny-output-event-${index}`;
    fixture.outputLedger.sources.set(
      eventId,
      committedOutputSource(eventId, "x", `tiny-fingerprint-${index}`),
    );
    return recordRef(`tiny-record-${index}`, eventId, `tiny-fingerprint-${index}`);
  });

  const handoff = await fixture.adapter.resolveInputHandoff(records);

  assert.equal(handoff.records.length, AGENT_GRAPH_HANDOFF_MAX_RECORDS);
  assert.equal(handoff.totalBytes, AGENT_GRAPH_HANDOFF_MAX_RECORDS);
  assert.equal(handoff.truncated, true);
  assert.equal(handoff.records.at(-1)?.recordId, "tiny-record-63");
});

test("handoff rejects a Runtime source with a forged Invocation provenance", async () => {
  const fixture = createFixture();
  const eventId = "forged-invocation-output";
  fixture.outputLedger.sources.set(eventId, {
    ...committedOutputSource(eventId, "result", "forged-invocation-fingerprint"),
    invocationId: "forged-invocation",
  });

  await assert.rejects(
    fixture.adapter.resolveInputHandoff([
      recordRef("forged-invocation-record", eventId, "forged-invocation-fingerprint"),
    ]),
    /does not resolve to its committed Runtime source/u,
  );
});

function createFixture(
  sessionManager: SessionManager = {} as SessionManager,
  resourceAuthority?: AgentGraphResourceAuthorityPort,
) {
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
      ...(resourceAuthority ? { resourceAuthority } : {}),
    }),
  };
}

class FakeRunPort implements AgentGraphExactRunPort {
  readonly events: RuntimeEvent[] = [];
  readonly startCalls: StartExactAgentGraphRunInput[] = [];
  providerDispatches = 0;
  live = false;
  launch: AgentGraphRunLaunchState = { status: "unknown" };

  async readRunEvents(sessionId: string, runId: string) {
    return this.events.filter((event) => event.sessionId === sessionId && event.runId === runId);
  }

  async inspectExactRun(input: StartExactAgentGraphRunInput) {
    return inspectAgentGraphExactRun(
      input,
      await this.readRunEvents(input.sessionId, input.runId),
      this.live,
    );
  }

  inspectLaunch() {
    return this.launch.status === "unknown" && this.live
      ? { status: "running" as const }
      : this.launch;
  }

  async startExactRun(input: StartExactAgentGraphRunInput) {
    this.startCalls.push(input);
    const before = await this.inspectExactRun(input);
    if (
      before.status === "live" ||
      before.status === "terminal" ||
      before.status === "indeterminate"
    ) {
      return "observed" as const;
    }
    if (before.status === "not_started") this.events.push(runStartedEvent(CLAIM));
    this.live = true;
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

function committedInputEvent(
  claim: AgentGraphActivationClaimRecord,
  prompt: string,
): Extract<RuntimeEvent, { kind: "message.committed" }> {
  return {
    ...eventBase(claim, agentGraphInputRuntimeEventId(claim.claimId)),
    kind: "message.committed",
    data: { message: { role: "user", content: prompt } },
  };
}

function dispatchEvent(
  claim: AgentGraphActivationClaimRecord,
  dispatch: "provider" | "tool",
): Extract<RuntimeEvent, { kind: "model.call.started" | "tool.started" }> {
  if (dispatch === "provider") {
    return {
      ...eventBase(claim, "provider-dispatch-1"),
      kind: "model.call.started",
      data: { providerCallId: "provider-call-1", purpose: "main" },
    };
  }
  return {
    ...eventBase(claim, "tool-dispatch-1"),
    kind: "tool.started",
    refs: { stepId: "step-1", toolCallId: "tool-call-1" },
    data: { toolName: "bash", argumentsHash: "sha256:arguments" },
  };
}

function activationInput() {
  return {
    claim: CLAIM,
    provision: PROVISION,
    workDir: "/workspace",
    prompt: "research",
  };
}

function agentOutputInput(
  output: string,
  resources: {
    readonly evidenceRefs?: readonly string[];
    readonly artifactRefs?: readonly string[];
  } = {},
): CommitAgentOutputInput {
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
      evidenceRefs: resources.evidenceRefs ?? [],
      artifactRefs: resources.artifactRefs ?? [],
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
