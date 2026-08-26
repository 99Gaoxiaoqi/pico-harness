import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { claimIdFor, graphIdFor, recordIdFor } from "../../src/agent-graph/core/index.js";
import { createAgentGraphApplicationService } from "../../src/agent-graph/service.js";
import type { AgentGraphRootWakePort } from "../../src/daemon/agent-graph-supervisor-service.js";
import type { AgentGraphRuntimeApplicationPort } from "../../src/agent-graph/runtime-adapter-bridge.js";
import type { ResolvedAgentGraphHandoff } from "../../src/runtime/agent-graph-runtime-adapter.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
  AgentGraphRecordRefRecord,
} from "../../src/storage/sqlite/agent-graph-store-types.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";

test("workspace application drives add to records, durable yield wake, and finish", async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), "pico-agent-graph-service-"));
  const store = new SqliteAgentGraphControlStore({ storageRoot, now: monotonicClock() });
  const runtime = new CompletingRuntimeAdapter();
  const rootWake = new CompletingRootWakePort();
  const rootSessionId = "root-session";
  const graphId = graphIdFor(rootSessionId, 1);
  const upstreamIntentId = "intent-research";
  const upstreamClaimId = claimIdFor(graphId, upstreamIntentId);
  const upstreamRecordId = recordIdFor(upstreamClaimId, `output:${upstreamClaimId}`);
  const downstreamIntentId = "intent-review";
  const downstreamClaimId = claimIdFor(graphId, downstreamIntentId);
  const downstreamRecordId = recordIdFor(downstreamClaimId, `output:${downstreamClaimId}`);
  const service = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort: rootWake,
    resolveOperatorWorkspace: ({ operator }) => ({
      workDir: join(storageRoot, operator.operatorId),
    }),
  });

  try {
    await service.start();
    const source = {
      sessionId: rootSessionId,
      turnId: "root-turn-1",
      runId: "root-run-1",
      toolCallId: "update-call-1",
    };
    const updated = await service.toolPort.commitUpdate({
      graphId,
      expectedRevision: 0,
      operationId: "add-research-and-review",
      source,
      commands: [
        addCommand({ graphId, intentId: upstreamIntentId, operatorId: "researcher", source }),
        addCommand({
          graphId,
          intentId: downstreamIntentId,
          operatorId: "reviewer",
          source,
          inputRecordIds: [upstreamRecordId],
        }),
      ],
    });

    assert.equal(updated.revision, 1);
    await service.supervisor.notifyGraph(graphId);
    const reconciled = await service.toolPort.readProjection({ graphId, rootSessionId });
    assert.equal(reconciled.claims.length, 2);
    assert.deepEqual(
      reconciled.records.map((record) => record.recordId).sort(),
      [downstreamRecordId, upstreamRecordId].sort(),
    );
    assert.equal(store.listGraphs(rootSessionId).length, 1);
    assert.equal(store.listGraphs(rootSessionId)[0]?.epoch, 1);
    assert.equal(runtime.starts.length, 2);
    assert.match(runtime.starts[1]?.prompt ?? "", /review result/u);
    assert.match(runtime.starts[1]?.prompt ?? "", /handoff:1/u);

    const yielded = await service.toolPort.registerYield({
      graphId,
      rootSessionId,
      rootTurnId: "root-turn-1",
      rootRunId: "root-run-1",
      toolCallId: "yield-call-1",
    });

    assert.equal(yielded.snapshot.graph.headRevision, 1);
    assert.equal(store.listYieldInterests(graphId)[0]?.state, "consumed");
    assert.equal(rootWake.starts.length, 1);
    assert.equal(store.listRecoverableSupervisorWakes(Number.MAX_SAFE_INTEGER).length, 0);

    const finished = await service.toolPort.commitUpdate({
      graphId,
      expectedRevision: 1,
      operationId: "finish-graph",
      source: {
        sessionId: rootSessionId,
        turnId: "root-turn-2",
        runId: rootWake.starts[0]!.targetRunId,
        toolCallId: "finish-call-1",
      },
      commands: [{ kind: "finish", selectedRecordIds: [downstreamRecordId] }],
    });

    assert.equal(finished.revision, 2);
    assert.equal(finished.projection.graph.admissionPhase, "sealed");
    assert.deepEqual(finished.projection.graph.selectedRecordIds, [downstreamRecordId]);
  } finally {
    await service.close();
    store.close();
    await rm(storageRoot, { recursive: true, force: true });
  }

  assert.equal(runtime.releases, 2);
});

class CompletingRuntimeAdapter implements AgentGraphRuntimeApplicationPort {
  readonly starts: Array<{ claimId: string; prompt: string }> = [];
  readonly projections = new Map<string, ReturnType<typeof completedProjection>>();
  releases = 0;

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
    const projection = completedProjection(input.claim);
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
    return {
      records: [],
      totalBytes: 0,
      truncated: false,
      prompt: records.length === 0 ? "" : `handoff:${records.length}`,
    };
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
}) {
  return {
    kind: "add" as const,
    operator: {
      graphId: input.graphId,
      operatorId: input.operatorId,
      generation: 1,
      role: input.operatorId,
      profileSnapshot: {
        profileId: "default",
        tools: [],
        permissionPolicy: null,
        systemPromptVersion: "v1",
      },
      workspacePolicy: { kind: "shared" as const },
    },
    intent: {
      graphId: input.graphId,
      intentId: input.intentId,
      operatorId: input.operatorId,
      operatorGeneration: 1,
      instruction: input.operatorId === "reviewer" ? "review result" : "research topic",
      inputRefs: (input.inputRecordIds ?? []).map((recordId) => ({ recordId })),
      createdAtRevision: 1,
      requestedBy: input.source,
    },
  };
}

function completedProjection(claim: AgentGraphActivationClaimRecord) {
  return {
    claimId: claim.claimId,
    sessionId: claim.targetSessionId,
    turnId: claim.targetTurnId,
    runId: claim.targetRunId,
    invocationId: claim.targetInvocationId,
    status: "completed" as const,
    startedEventId: claim.runStartedEventId,
    terminalEventId: `terminal:${claim.claimId}`,
    outputEventIds: [`output:${claim.claimId}`],
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

function monotonicClock(): () => number {
  let now = 1_000;
  return () => now++;
}
