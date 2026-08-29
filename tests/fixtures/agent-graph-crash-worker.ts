import { AgentGraphWorkspaceResourceAuthority } from "../../src/runtime/agent-graph-workspace-resource-authority.js";
import {
  SqliteAgentGraphOutputLedger,
  agentOutputRuntimeEventId,
} from "../../src/runtime/agent-graph-output-ledger.js";
import {
  agentOutputFingerprint,
  agentOutputIdempotencyKey,
} from "../../src/tools/agent-output-tool.js";
import { SqliteAgentGraphControlStore } from "../../src/storage/sqlite/sqlite-agent-graph-control-store.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import type { AgentGraphProfileSnapshot } from "../../src/agent-graph/core/contracts.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";

interface Config {
  readonly mode: "prepare" | "recover";
  readonly repoRoot: string;
  readonly storageRoot: string;
}

const config = JSON.parse(requiredEnv("PICO_GRAPH_CRASH_CONFIG")) as Config;
const graphStore = new SqliteAgentGraphControlStore({ storageRoot: config.storageRoot });
const runtimeStore = new SqliteRuntimeEventStore({ storageRoot: config.storageRoot });

try {
  if (config.mode === "prepare") await prepareCrashBoundary();
  else await recoverAndExit();
} catch (error) {
  process.send?.({ type: "fatal", error: error instanceof Error ? error.stack : String(error) });
  process.exitCode = 1;
  graphStore.close();
  runtimeStore.close();
}

async function prepareCrashBoundary(): Promise<void> {
  seedGraphControlFacts();
  await seedRuntimeFacts();
  const workspaceProvision = domainProvision("workspace-provision");
  let interrupted = false;
  const authority = new AgentGraphWorkspaceResourceAuthority({
    repoRoot: config.repoRoot,
    storageRoot: config.storageRoot,
    store: graphStore,
    afterGitSideEffect: async (operation) => {
      if (operation === "add" && !interrupted) {
        interrupted = true;
        throw new Error("checkpoint after git worktree add");
      }
    },
  });
  try {
    await authority.resolve(workspaceProvision);
  } catch (error) {
    if (!(error instanceof Error) || !/checkpoint after git worktree add/u.test(error.message)) {
      throw error;
    }
  }
  const snapshot = await readSnapshot();
  await send({ type: "checkpoint", snapshot });
  await new Promise<never>(() => undefined);
}

async function recoverAndExit(): Promise<void> {
  const authority = new AgentGraphWorkspaceResourceAuthority({
    repoRoot: config.repoRoot,
    storageRoot: config.storageRoot,
    store: graphStore,
  });
  await authority.recover();
  const snapshot = await readSnapshot();
  graphStore.close();
  runtimeStore.close();
  await send({ type: "recovered", snapshot });
}

function seedGraphControlFacts(): void {
  graphStore.createGraph({ graphId: "crash-graph", rootSessionId: "crash-root", epoch: 1 });
  graphStore.commitScheduleRevision({
    graphId: "crash-graph",
    expectedRevision: 0,
    operationId: "crash-schedule",
    requestFingerprint: "crash-schedule-fingerprint",
    kind: "batch",
    command: { schemaVersion: 2, commands: [{ kind: "add" }] },
    sourceSessionId: "crash-root",
    sourceTurnId: "crash-root-turn",
    sourceRunId: "crash-root-run",
    sourceToolCallId: "crash-root-tool",
  });
  ensureProvision("provision-window", "session-provision", { kind: "shared" });
  const claimProvision = ensureProvision("claim-provision", "session-runtime", { kind: "shared" });
  graphStore.transitionOperatorProvision({
    provisionId: claimProvision.provisionId,
    expectedVersion: 1,
    from: "requested",
    to: "provisioned",
  });
  graphStore.claimActivation({
    claimId: "claim-window",
    graphId: "crash-graph",
    intentId: "intent-window",
    operatorId: "operator-claim-provision",
    operatorGeneration: 1,
    expectedGraphRevision: 1,
    intentFingerprint: "intent-fingerprint",
    readinessFingerprint: "readiness-fingerprint",
    targetSessionId: "session-runtime",
    targetTurnId: "runtime-turn",
    targetRunId: "runtime-run",
    targetInvocationId: "runtime-invocation",
    runStartedEventId: "runtime-started",
  });
  ensureProvision("workspace-provision", "session-workspace", {
    kind: "isolated-worktree",
    baseRef: "HEAD",
  });
  graphStore.registerYieldInterest({
    permitId: "yield-window",
    graphId: "crash-graph",
    rootSessionId: "crash-root",
    rootTurnId: "yield-turn",
    rootRunId: "yield-run",
    toolCallId: "yield-tool",
  });
  graphStore.enqueueSupervisorWake({
    wakeId: "wake-window",
    graphId: "crash-graph",
    dedupeKey: "crash-window",
    wakeFingerprint: "wake-fingerprint",
    cause: "startup_recovery",
    payload: { graphId: "crash-graph" },
  });
  graphStore.claimSupervisorWake({
    wakeId: "wake-window",
    expectedWakeVersion: 1,
    attemptId: "wake-attempt-window",
    rootSessionId: "crash-root",
    targetTurnId: "wake-target-turn",
    targetRunId: "wake-target-run",
  });
}

async function seedRuntimeFacts(): Promise<void> {
  await runtimeStore.initializeSession({ sessionId: "session-runtime", workDir: config.repoRoot });
  const fence = await runtimeStore.advanceOwnerFence("session-runtime", 0);
  const base = {
    schemaVersion: 2 as const,
    sessionId: "session-runtime",
    invocationId: "runtime-invocation",
    runId: "runtime-run",
    turnId: "runtime-turn",
    at: "2026-08-27T00:00:00.000Z",
    partial: false as const,
    visibility: "internal" as const,
  };
  await runtimeStore.append(
    {
      ...base,
      eventId: "runtime-started",
      kind: "run.started",
      data: { workDir: config.repoRoot },
    },
    { ownerFence: fence },
  );
  await runtimeStore.append(
    {
      ...base,
      eventId: "provider-dispatched",
      kind: "model.call.started",
      data: { providerCallId: "provider-call-window", purpose: "main" },
    } as RuntimeEvent,
    { ownerFence: fence },
  );
  const activation = {
    kind: "graph_operator_activation" as const,
    graphId: "crash-graph",
    operatorId: "operator-claim-provision",
    operatorGeneration: 1,
    activationId: "claim-window",
    sessionId: "session-runtime",
    turnId: "runtime-turn",
    runId: "runtime-run",
  };
  const idempotencyKey = agentOutputIdempotencyKey(activation);
  const output = "durable output before RecordRef projection";
  const ledger = new SqliteAgentGraphOutputLedger({
    store: runtimeStore,
    ownerFencePort: { assertAgentOutputWriteAllowed: async () => fence },
  });
  await ledger.commitAgentOutputEvent({
    eventId: agentOutputRuntimeEventId(idempotencyKey),
    toolCallId: "output-tool-window",
    activation,
    payload: {
      schemaVersion: "pico.agent_output.v1",
      graphId: activation.graphId,
      operatorId: activation.operatorId,
      operatorGeneration: activation.operatorGeneration,
      activationId: activation.activationId,
      status: "success",
      output,
      outputBytes: Buffer.byteLength(output),
      evidenceRefs: [],
      artifactRefs: [],
      idempotencyKey,
      fingerprint: agentOutputFingerprint({
        status: "success",
        output,
        evidenceRefs: [],
        artifactRefs: [],
      }),
    },
  });
}

function ensureProvision(provisionId: string, childSessionId: string, workspaceBinding: unknown) {
  return graphStore.ensureOperatorProvision({
    provisionId,
    graphId: "crash-graph",
    operatorId: `operator-${provisionId}`,
    generation: 1,
    scheduleRevision: 1,
    provisionFingerprint: `fingerprint-${provisionId}`,
    childSessionId,
    profileSnapshot: profileSnapshot(),
    workspaceBinding,
  }).record;
}

function domainProvision(provisionId: string) {
  const record = graphStore
    .listOperatorProvisions("crash-graph")
    .find((item) => item.provisionId === provisionId)!;
  return {
    provisionId: record.provisionId,
    graphId: record.graphId,
    operatorId: record.operatorId,
    operatorGeneration: record.generation,
    childSessionId: record.childSessionId,
    state: record.state,
    version: record.version,
    profileSnapshot: record.profileSnapshot as AgentGraphProfileSnapshot,
    workspaceBinding: record.workspaceBinding as { kind: "isolated-worktree"; baseRef: string },
    createdAt: record.createdAt,
  };
}

async function readSnapshot() {
  const runtimeEvents = await runtimeStore.readRun("session-runtime", "runtime-run");
  const resources = graphStore.listWorkspaceResources();
  return {
    revisions: graphStore.listScheduleRevisions("crash-graph").length,
    provisions: graphStore
      .listOperatorProvisions("crash-graph")
      .map(({ provisionId, state }) => ({ provisionId, state })),
    claims: graphStore
      .listActivationClaims("crash-graph")
      .map(({ claimId, targetRunId }) => ({ claimId, targetRunId })),
    runtimeKinds: runtimeEvents.map(({ kind }) => kind),
    records: graphStore.listRecordRefs("crash-graph").length,
    wakes: graphStore
      .listSupervisorWakes("crash-graph")
      .map(({ wakeId, status, attemptCount }) => ({ wakeId, status, attemptCount })),
    attempts: graphStore
      .listSupervisorWakeAttempts("wake-window")
      .map(({ attemptId, status }) => ({ attemptId, status })),
    workspace: resources.map(({ resourceId, state, worktreePath, branch }) => ({
      resourceId,
      state,
      worktreePath,
      branch,
    })),
  };
}

function profileSnapshot(): AgentGraphProfileSnapshot {
  return {
    schemaVersion: 1,
    profileId: "implement",
    profileRevision: "test",
    profileFingerprint: "sha256:test",
    modelRouteId: "test-model",
    tools: ["bash"],
    permissionPolicy: { mode: "default", allowSessionGrants: false },
    systemPrompt: { version: "test", content: "test" },
    extensionPolicy: "none",
  };
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function send(message: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!process.send) return reject(new Error("IPC is unavailable"));
    process.send(message, (error) => (error ? reject(error) : resolve()));
  });
}
