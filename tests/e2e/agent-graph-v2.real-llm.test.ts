import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { wakeIdFor } from "../../src/agent-graph/core/ids.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { EMPTY_USER_CONFIG_REVISION, UserConfigStore } from "../../src/input/user-config-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { CredentialRef, CredentialVault } from "../../src/provider/credential-vault.js";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import type { AgentGraphRecord } from "../../src/storage/sqlite/agent-graph-store-types.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 9 * 60_000;
const STAGE_TIMEOUT_MS = {
  rootUpdate: 90_000,
  rootYield: 60_000,
  rootTerminal: 30_000,
  operatorClaim: 30_000,
  operatorRun: 30_000,
  operatorOutput: 90_000,
  wakeAttempt: 30_000,
  rootFinish: 90_000,
  exactTerminal: 30_000,
} as const;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;
const LEGACY_GRAPH_TOOLS = new Set(["add_work", "view_graph", "close_graph"]);

test("Graph v2 E2E diagnostic stages expose bounded, sanitized failures", async () => {
  const lines: string[] = [];
  const trace = new GraphE2EStageTrace({
    log: (line) => lines.push(line),
    summarize: async () => ({
      graph: { exists: true, phase: "open", headRevision: 1 },
      root: { runsStarted: 1, runTerminals: 0, modelCallsStarted: 1, modelCallsSettled: 0 },
      operator: { claims: 1, exactRuns: 0, outputs: 0, records: 0 },
      wake: { exists: false, attempts: 0, exactRootRuns: 0 },
    }),
    pollIntervalMs: 1,
  });
  let probes = 0;
  await trace.waitFor("root.update", 50, () => ++probes >= 2);
  await assert.rejects(
    trace.waitFor("operator.output", 5, () => false),
    (error: unknown) =>
      error instanceof GraphE2EStageTimeoutError &&
      error.stage === "operator.output" &&
      error.summary.operator.outputs === 0,
  );
  assert.ok(lines.some((line) => line.includes('"stage":"root.update"')));
  assert.ok(lines.some((line) => line.includes('"stage":"operator.output.timeout"')));
  assert.equal(
    lines.some((line) => /prompt|api.?key|credential/iu.test(line)),
    false,
  );
});

test("Graph v2 E2E binds to the epoch identity returned by Graph authority", () => {
  const authorityGraph: AgentGraphRecord = {
    graphId: "authority-issued-opaque-graph-id",
    rootSessionId: "root-session",
    epoch: 7,
    phase: "open",
    headRevision: 0,
    createdAt: 1,
  };
  const authority = {
    listGraphs: (rootSessionId?: string) =>
      rootSessionId === authorityGraph.rootSessionId ? [authorityGraph] : [],
  };

  assert.equal(openRootEpochFromAuthority(authority, authorityGraph.rootSessionId), authorityGraph);
});

realModelTest(
  "Graph v2 persists one operator output and wakes the exact root Run to finish",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-agent-graph-v2-real-llm-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(workDir, { recursive: true });
    await mkdir(picoHome, { recursive: true });
    const workspacePath = await realpath(workDir);
    const rootSessionId = `graph-v2-root-${randomUUID()}`;
    let graphId: string | undefined;
    const userConfigStore = new UserConfigStore({ picoHome });
    await userConfigStore.write(
      {
        version: 1,
        defaults: { modelRouteId: model.route.id },
        providers: {
          [model.route.providerId]: {
            protocol: model.provider,
            baseURL: model.config.baseURL,
            apiKeyEnv: model.route.apiKeyEnv,
            models: [model.route.model],
            discoverModels: false,
          },
        },
      },
      { expectedRevision: EMPTY_USER_CONFIG_REVISION },
    );
    const env = {
      ...process.env,
      PICO_HOME: picoHome,
      [model.route.apiKeyEnv]: model.config.apiKey,
    };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(workspacePath);
    let graphHost: AgentGraphWorkspaceHost | undefined;
    let workspaceRuntime: WorkspaceTaskRuntime | undefined;
    let initialRunId: string | undefined;
    const services = createProductionRuntimeServices({
      env,
      trustStore,
      userConfigStore,
      credentialVault: memoryCredentialVault(model.config.apiKey),
      agentGraphWorkspaceHostFactory: (options) => {
        graphHost = createAgentGraphWorkspaceHost(options);
        return graphHost;
      },
    });
    const sessionIds = new Set([rootSessionId]);
    const trace = new GraphE2EStageTrace({
      log: (line) => console.error(line),
      summarize: () =>
        collectGraphE2EDiagnosticSummary({
          graphHost,
          workspaceRuntime,
          workspacePath,
          picoHome,
          graphId,
          rootSessionId,
          initialRunId,
        }),
    });

    try {
      trace.mark("setup.ready", { modelRoute: model.route.id });
      const rootLease = await globalSessionManager.getOrCreatePinned(rootSessionId, workspacePath, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        rootLease.session.updateRuntimeState({
          settings: {
            provider: model.provider,
            model: model.route.model,
            modelRouteId: model.route.id,
            collaborationMode: "agent",
            permissionMode: "yolo",
            orchestrationMode: "graph",
            thinkingEffort: "off",
            thinkingEffortExplicit: false,
            additionalDirectories: [],
          },
        });
        await rootLease.session.flushPersistence();
      } finally {
        rootLease.release();
      }

      workspaceRuntime = await services.service.getWorkspaceRuntime(workspacePath);
      const initial = asRecord(
        await services.service.startForegroundRun({
          workspacePath,
          sessionId: rootSessionId,
          prompt: initialRootPrompt(),
          execution: {
            requestedModel: model.route.id,
            allowedTools: ["update_agent_graph", "yield_agent_graph"],
          },
        }),
      );
      initialRunId = requiredString(initial, "runId");
      const openedGraph = await trace.waitForValue(
        "graph.opened",
        STAGE_TIMEOUT_MS.rootUpdate,
        () => (graphHost ? openRootEpochFromAuthority(graphHost.store, rootSessionId) : undefined),
      );
      graphId = openedGraph.graphId;
      trace.mark("root.start", {
        graphId,
        epoch: openedGraph.epoch,
        workspaceRunStatus: workspaceRuntime.getRun(initialRunId)?.status,
      });

      await trace.waitFor(
        "root.update",
        STAGE_TIMEOUT_MS.rootUpdate,
        () => (graphHost?.store.getGraph(graphId!)?.headRevision ?? 0) >= 1,
      );
      await trace.waitFor(
        "root.yield",
        STAGE_TIMEOUT_MS.rootYield,
        () => (graphHost?.store.listYieldInterests(graphId!).length ?? 0) >= 1,
      );
      const initialTerminal = await trace.waitForValue(
        "root.initial-terminal",
        STAGE_TIMEOUT_MS.rootTerminal,
        () => {
          const run = workspaceRuntime?.getRun(initialRunId!);
          return run && isTerminalWorkspaceStatus(run.status) ? run : undefined;
        },
      );
      assert.equal(initialTerminal.status, "succeeded");

      const claim = await trace.waitForValue(
        "operator.claim",
        STAGE_TIMEOUT_MS.operatorClaim,
        () => graphHost?.store.listActivationClaims(graphId!)[0],
      );
      sessionIds.add(claim.targetSessionId);
      await trace.waitFor(
        "operator.run",
        STAGE_TIMEOUT_MS.operatorRun,
        () => workspaceRuntime?.getRun(claim.targetRunId) !== undefined,
      );
      await trace.waitFor("operator.output", STAGE_TIMEOUT_MS.operatorOutput, async () =>
        (await readRuntimeEvents(workspacePath, picoHome, claim.targetSessionId)).some(
          (event) => event.kind === "agent.output",
        ),
      );
      await trace.waitFor(
        "wake.attempt",
        STAGE_TIMEOUT_MS.wakeAttempt,
        () =>
          workspaceRuntime
            ?.listRuns()
            .some((run) => run.sessionId === rootSessionId && run.runId !== initialRunId) === true,
      );
      await trace.waitFor(
        "root.finish",
        STAGE_TIMEOUT_MS.rootFinish,
        () => graphHost?.store.getGraph(graphId!)?.phase === "finished",
      );
      await trace.waitFor(
        "exact.terminal",
        STAGE_TIMEOUT_MS.exactTerminal,
        () =>
          workspaceRuntime?.listRuns().every((run) => isTerminalWorkspaceStatus(run.status)) ===
          true,
      );

      assert.ok(
        workspaceRuntime.listRuns().every((run) => run.status === "succeeded"),
        "the foreground and exact Graph Runs must all succeed",
      );
      assert.ok(
        workspaceRuntime.listRuns().filter((run) => run.sessionId === rootSessionId).length >= 2,
        "Workspace runtime must own the initial and exact root wake Runs",
      );

      const host = graphHost;
      assert.ok(host, "production service must assemble the real Graph workspace host");
      assert.ok(graphId, "production Graph authority must expose the admitted epoch identity");
      const persistedGraph = host.store.getGraph(graphId);
      assert.ok(persistedGraph);
      assert.equal(persistedGraph.graphId, openedGraph.graphId);
      assert.equal(persistedGraph.epoch, openedGraph.epoch);
      assert.equal(persistedGraph.rootSessionId, rootSessionId);
      assert.equal(persistedGraph.phase, "finished");
      const graph = new SqliteAgentGraphControlStoreAdapter(host.store).getScheduleState(
        graphId,
      ).graph;

      const claims = host.store.listActivationClaims(graphId);
      assert.equal(claims.length, 1, "the one add command must create one Claim");
      assert.equal(claims[0]?.claimId, claim.claimId);
      assert.equal(workspaceRuntime.getRun(claim.targetRunId)?.sessionId, claim.targetSessionId);

      const records = host.store.listRecordRefs(graphId);
      assert.equal(records.length, 1, "one operator activation must project one RecordRef");
      const record = records[0];
      assert.ok(record);
      assert.deepEqual(graph.selectedRecordIds, [record.recordId]);
      assert.ok(graph.selectedRecordIds.every((recordId) => host.store.getRecordRef(recordId)));

      const rootEvents = await readRuntimeEvents(workspacePath, picoHome, rootSessionId);
      const operatorEvents = await readRuntimeEvents(
        workspacePath,
        picoHome,
        claim.targetSessionId,
      );
      const allEvents = [...rootEvents, ...operatorEvents];
      const rootRuns = rootEvents.filter((event) => event.kind === "run.started");
      const rootToolStarts = rootEvents.filter(
        (event): event is Extract<RuntimeEvent, { kind: "tool.started" }> =>
          event.kind === "tool.started",
      );
      const initialRootRuntimeRunId = rootToolStarts.find(
        (event) => event.data.toolName === "yield_agent_graph",
      )?.runId;
      assert.ok(initialRootRuntimeRunId, "the initial root RuntimeRun must yield exactly once");
      assert.ok(rootRuns.length >= 2, "root Session must contain the initial and exact wake Runs");
      assert.ok(rootRuns.some((event) => event.runId === initialRootRuntimeRunId));
      assert.equal(
        rootToolStarts.filter(
          (event) =>
            event.runId === initialRootRuntimeRunId &&
            event.data.toolName === "update_agent_graph",
        ).length,
        1,
        "the initial root RuntimeRun must update the admitted epoch exactly once",
      );
      assert.equal(
        rootToolStarts.filter(
          (event) =>
            event.runId === initialRootRuntimeRunId &&
            event.data.toolName === "yield_agent_graph",
        ).length,
        1,
        "the initial root RuntimeRun must yield exactly once",
      );
      assert.deepEqual(
        rootToolStarts
          .filter((event) => event.runId === initialRootRuntimeRunId)
          .map((event) => event.data.toolName),
        ["update_agent_graph", "yield_agent_graph"],
        "the initial root RuntimeRun must update before its single terminal yield",
      );

      const outputEvents = operatorEvents.filter((event) => event.kind === "agent.output");
      assert.equal(outputEvents.length, 1, "operator must commit exactly one agent.output fact");
      const outputEvent = outputEvents[0];
      assert.ok(outputEvent);
      const canary = outputEvent.data.payload.output;
      assert.ok(canary, "operator output must contain a canary unknown to the initial root prompt");
      assert.match(canary, /^GRAPH_V2_OPERATOR_CANARY_[A-F0-9]{32}$/u);
      assert.equal(outputEvent.data.payload.status, "success");
      assert.equal(outputEvent.data.payload.activationId, claim.claimId);
      assert.equal(outputEvent.runId, claim.targetRunId);
      assert.equal(
        operatorEvents.filter(
          (event) => event.kind === "tool.started" && event.data.toolName === "agent_output",
        ).length,
        1,
        "operator must invoke its formal output tool exactly once",
      );
      assert.equal(record.graphId, openedGraph.graphId);
      assert.equal(record.claimId, claim.claimId);
      assert.equal(record.operatorId, claim.operatorId);
      assert.equal(record.operatorGeneration, claim.operatorGeneration);
      assert.equal(record.sourceSessionId, claim.targetSessionId);
      assert.equal(record.sourceTurnId, outputEvent.turnId);
      assert.equal(record.sourceRunId, outputEvent.runId);
      assert.equal(record.sourceEventId, outputEvent.eventId);
      assert.ok(
        [...rootEvents, ...operatorEvents]
          .filter((event) => event.kind === "run.terminal")
          .every((event) => event.data.status === "completed"),
        "every RuntimeRun in the scenario must complete",
      );

      const wakes = host.store.listSupervisorWakes(graphId);
      assert.equal(wakes.length, 1, "the operator terminal must enqueue one exact root wake");
      const wake = wakes[0];
      assert.ok(wake);
      assert.equal(wake.graphId, openedGraph.graphId);
      assert.equal(wake.cause, "runtime_terminal");
      assert.equal(asRecord(wake.payload).claimId, claim.claimId);
      const wakeAttempts = host.store.listSupervisorWakeAttempts(wake.wakeId);
      assert.equal(wakeAttempts.length, 1, "the durable wake must have one exact attempt");
      const wakeAttempt = wakeAttempts[0];
      assert.ok(wakeAttempt);
      assert.equal(wakeAttempt.rootSessionId, rootSessionId);
      assert.equal(wakeAttempt.status, "completed");
      const exactWakeToolStarts = rootToolStarts.filter(
        (event) => event.runId === wakeAttempt.targetRunId,
      );
      assert.deepEqual(
        exactWakeToolStarts.map((event) => event.data.toolName),
        ["view_agent_graph", "update_agent_graph"],
        "the exact root wake must view the selected output before finishing",
      );
      assert.equal(
        exactWakeToolStarts.filter((event) => event.data.toolName === "view_agent_graph").length,
        1,
        "the exact root wake must inspect the durable projection exactly once",
      );
      assert.equal(
        exactWakeToolStarts.filter((event) => event.data.toolName === "update_agent_graph").length,
        1,
        "the exact root wake must finish the Graph exactly once",
      );
      const durableWakeView = rootEvents.find(
        (event): event is Extract<RuntimeEvent, { kind: "tool.result.recorded" }> =>
          event.kind === "tool.result.recorded" &&
          event.runId === wakeAttempt.targetRunId &&
          event.data.toolName === "view_agent_graph",
      );
      assert.ok(
        durableWakeView,
        "the exact root wake must durably record the view_agent_graph tool result",
      );
      assert.match(
        durableWakeView.data.projection.text,
        new RegExp(canary, "u"),
        "the durable view tool result must contain the operator output canary",
      );
      assert.match(
        durableWakeView.data.projection.text,
        /"status":"success"/u,
        "the durable view tool result must expose the explicit agent_output status",
      );

      assert.equal(
        allEvents.some((event) => event.kind.startsWith("graph.")),
        false,
        "Graph v2 must not append legacy graph.* RuntimeEvents",
      );
      assert.deepEqual(
        allEvents
          .filter(
            (event): event is Extract<RuntimeEvent, { kind: "tool.started" }> =>
              event.kind === "tool.started" && LEGACY_GRAPH_TOOLS.has(event.data.toolName),
          )
          .map((event) => event.data.toolName),
        [],
        "Graph v2 must not invoke legacy Graph tools",
      );
      trace.mark("assertions.complete", { selectedRecords: graph.selectedRecordIds.length });
    } catch (error) {
      if (!(error instanceof GraphE2EStageTimeoutError)) {
        await trace.reportFailure("unexpected", error);
      }
      for (const run of workspaceRuntime?.listRuns() ?? []) {
        if (!isTerminalWorkspaceStatus(run.status)) {
          workspaceRuntime?.cancel(run.runId, "Graph v2 E2E diagnostic boundary reached");
        }
      }
      throw error;
    } finally {
      try {
        for (const claim of graphId
          ? (graphHost?.store.listActivationClaims(graphId) ?? [])
          : []) {
          sessionIds.add(claim.targetSessionId);
        }
      } catch {
        // The host may already be closed by a startup failure.
      }
      try {
        await services.desktopService.close();
      } finally {
        for (const sessionId of sessionIds) {
          const session = globalSessionManager.delete(sessionId, workspacePath, { picoHome });
          await session?.close();
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

function initialRootPrompt(): string {
  return [
    "This is a deterministic Graph v2 end-to-end check. Follow these steps exactly.",
    "First call update_agent_graph exactly once with expected_revision 0 and operation_id e2e-add-operator.",
    "That call must contain exactly one add command with this exact structure:",
    JSON.stringify({
      kind: "add",
      operator: {
        operator_id: "canary-operator",
        generation: 1,
        role: "canary emitter",
        description: "emit the requested canary through agent_output",
        profile: {
          profile_id: "explore",
        },
        workspace: { kind: "shared" },
      },
      intent: {
        intent_id: "emit-canary",
        instruction:
          "Invent 32 random uppercase hexadecimal characters that are not present in this instruction. Call agent_output exactly once with status success and output equal to GRAPH_V2_OPERATOR_CANARY_ followed immediately by those 32 characters. Do not call any other tool and do not write files.",
        input_record_ids: [],
      },
    }),
    "After update_agent_graph succeeds, call yield_agent_graph exactly once.",
    "After yield_agent_graph succeeds, end this Run immediately. Do not call another tool and do not finish the Graph in this initial Run.",
  ].join("\n");
}

async function readRuntimeEvents(
  workDir: string,
  picoHome: string,
  sessionId: string,
): Promise<RuntimeEvent[]> {
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  try {
    return await store.readSession(sessionId);
  } finally {
    store.close();
  }
}

interface GraphE2EDiagnosticSummary {
  readonly graph: {
    readonly exists: boolean;
    readonly phase?: string;
    readonly headRevision?: number;
    readonly scheduleRevisions?: number;
    readonly yieldStates?: Readonly<Record<string, number>>;
  };
  readonly root: {
    readonly runsStarted: number;
    readonly runTerminals: number;
    readonly workspaceRunStatuses?: readonly string[];
    readonly workspaceFailureCategories?: Readonly<Record<string, number>>;
    readonly toolCalls?: Readonly<Record<string, number>>;
    readonly modelCallsStarted: number;
    readonly modelCallsSettled: number;
    readonly modelCallStatuses?: Readonly<Record<string, number>>;
  };
  readonly operator: {
    readonly claims: number;
    readonly claimStates?: Readonly<Record<string, number>>;
    readonly exactRuns: number;
    readonly runStatuses?: readonly string[];
    readonly runFailureCategories?: Readonly<Record<string, number>>;
    readonly outputs: number;
    readonly records: number;
    readonly modelCallsStarted?: number;
    readonly modelCallsSettled?: number;
    readonly toolCalls?: Readonly<Record<string, number>>;
  };
  readonly wake: {
    readonly exists: boolean;
    readonly status?: string;
    readonly attempts: number;
    readonly attemptStates?: Readonly<Record<string, number>>;
    readonly exactRootRuns: number;
  };
}

class GraphE2EStageTimeoutError extends Error {
  constructor(
    readonly stage: string,
    readonly timeoutMs: number,
    readonly summary: GraphE2EDiagnosticSummary,
  ) {
    super(
      `Graph v2 E2E stage ${stage} timed out after ${timeoutMs}ms; durableSummary=${JSON.stringify(summary)}`,
    );
    this.name = "GraphE2EStageTimeoutError";
  }
}

class GraphE2EStageTrace {
  private readonly startedAt = Date.now();
  private readonly log: (line: string) => void;
  private readonly summarize: () => Promise<GraphE2EDiagnosticSummary>;
  private readonly pollIntervalMs: number;

  constructor(options: {
    readonly log: (line: string) => void;
    readonly summarize: () => Promise<GraphE2EDiagnosticSummary>;
    readonly pollIntervalMs?: number;
  }) {
    this.log = options.log;
    this.summarize = options.summarize;
    this.pollIntervalMs = options.pollIntervalMs ?? 100;
  }

  mark(stage: string, details: Readonly<Record<string, unknown>> = {}): void {
    this.log(
      `[graph-v2-e2e-stage] ${JSON.stringify({
        stage,
        at: new Date().toISOString(),
        elapsedMs: Date.now() - this.startedAt,
        ...details,
      })}`,
    );
  }

  async waitFor(
    stage: string,
    timeoutMs: number,
    predicate: () => boolean | Promise<boolean>,
  ): Promise<void> {
    await this.waitForValue(stage, timeoutMs, async () => ((await predicate()) ? true : undefined));
  }

  async waitForValue<T>(
    stage: string,
    timeoutMs: number,
    probe: () => T | undefined | Promise<T | undefined>,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const value = await probe();
      if (value !== undefined) {
        this.mark(stage);
        return value;
      }
      if (Date.now() >= deadline) {
        const summary = await this.summarize();
        this.mark(`${stage}.timeout`, { timeoutMs, durableSummary: summary });
        throw new GraphE2EStageTimeoutError(stage, timeoutMs, summary);
      }
      await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
    }
  }

  async reportFailure(stage: string, error: unknown): Promise<void> {
    let summary: GraphE2EDiagnosticSummary | undefined;
    try {
      summary = await this.summarize();
    } catch {
      // Diagnostics must never replace the original failure.
    }
    this.mark(`${stage}.failure`, {
      errorKind: error instanceof Error ? error.name : typeof error,
      ...(summary ? { durableSummary: summary } : {}),
    });
  }
}

async function collectGraphE2EDiagnosticSummary(input: {
  readonly graphHost: AgentGraphWorkspaceHost | undefined;
  readonly workspaceRuntime: WorkspaceTaskRuntime | undefined;
  readonly workspacePath: string;
  readonly picoHome: string;
  readonly graphId: string | undefined;
  readonly rootSessionId: string;
  readonly initialRunId: string | undefined;
}): Promise<GraphE2EDiagnosticSummary> {
  const host = input.graphHost;
  const graphId =
    input.graphId ??
    (host ? openRootEpochFromAuthority(host.store, input.rootSessionId)?.graphId : undefined);
  const workspaceRuns = input.workspaceRuntime?.listRuns() ?? [];
  const rootEvents = await readRuntimeEvents(
    input.workspacePath,
    input.picoHome,
    input.rootSessionId,
  );
  const graph = graphId ? host?.store.getGraph(graphId) : undefined;
  const claims = graphId ? (host?.store.listActivationClaims(graphId) ?? []) : [];
  const records = graphId ? (host?.store.listRecordRefs(graphId) ?? []) : [];
  const yields = graphId ? (host?.store.listYieldInterests(graphId) ?? []) : [];
  const operatorEvents = (
    await Promise.all(
      [...new Set(claims.map((claim) => claim.targetSessionId))].map((sessionId) =>
        readRuntimeEvents(input.workspacePath, input.picoHome, sessionId),
      ),
    )
  ).flat();
  const terminal = operatorEvents.find(
    (event): event is Extract<RuntimeEvent, { kind: "run.terminal" }> =>
      event.kind === "run.terminal" && claims.some((claim) => claim.targetRunId === event.runId),
  );
  const terminalClaim = terminal
    ? claims.find((claim) => claim.targetRunId === terminal.runId)
    : undefined;
  const wake =
    host && graphId && terminal && terminalClaim
      ? host.store.getSupervisorWake(
          wakeIdFor(
            graphId,
            `runtime-terminal:${terminalClaim.targetRunId}:${terminal.eventId}`,
          ),
        )
      : undefined;
  const attempts = wake ? (host?.store.listSupervisorWakeAttempts(wake.wakeId) ?? []) : [];
  const rootWorkspaceRuns = workspaceRuns.filter((run) => run.sessionId === input.rootSessionId);
  const operatorWorkspaceRuns = workspaceRuns.filter((run) =>
    claims.some((claim) => claim.targetRunId === run.runId),
  );

  return {
    graph: {
      exists: graph !== undefined,
      ...(graph
        ? {
            phase: graph.phase,
            headRevision: graph.headRevision,
            scheduleRevisions: host?.store.listScheduleRevisions(graph.graphId).length ?? 0,
            yieldStates: countStrings(yields.map((interest) => interest.state)),
          }
        : {}),
    },
    root: {
      runsStarted: countEvents(rootEvents, "run.started"),
      runTerminals: countEvents(rootEvents, "run.terminal"),
      workspaceRunStatuses: rootWorkspaceRuns.map((run) =>
        run.runId === input.initialRunId ? `initial:${run.status}` : `wake:${run.status}`,
      ),
      workspaceFailureCategories: countStrings(
        rootWorkspaceRuns.flatMap((run) =>
          run.error === undefined ? [] : [classifyRunFailure(run.error)],
        ),
      ),
      toolCalls: countToolCalls(rootEvents),
      modelCallsStarted: countEvents(rootEvents, "model.call.started"),
      modelCallsSettled: countEvents(rootEvents, "model.call.settled"),
      modelCallStatuses: countStrings(
        rootEvents.flatMap((event) =>
          event.kind === "model.call.settled" ? [event.data.status] : [],
        ),
      ),
    },
    operator: {
      claims: claims.length,
      claimStates: countStrings(claims.map((claim) => claim.state)),
      exactRuns: operatorWorkspaceRuns.length,
      runStatuses: operatorWorkspaceRuns.map((run) => run.status),
      runFailureCategories: countStrings(
        operatorWorkspaceRuns.flatMap((run) =>
          run.error === undefined ? [] : [classifyRunFailure(run.error)],
        ),
      ),
      outputs: countEvents(operatorEvents, "agent.output"),
      records: records.length,
      modelCallsStarted: countEvents(operatorEvents, "model.call.started"),
      modelCallsSettled: countEvents(operatorEvents, "model.call.settled"),
      toolCalls: countToolCalls(operatorEvents),
    },
    wake: {
      exists: wake !== undefined,
      ...(wake ? { status: wake.status } : {}),
      attempts: attempts.length,
      attemptStates: countStrings(attempts.map((attempt) => attempt.status)),
      exactRootRuns: rootWorkspaceRuns.filter((run) => run.runId !== input.initialRunId).length,
    },
  };
}

function countEvents(events: readonly RuntimeEvent[], kind: RuntimeEvent["kind"]): number {
  return events.filter((event) => event.kind === kind).length;
}

function countToolCalls(events: readonly RuntimeEvent[]): Readonly<Record<string, number>> {
  return countStrings(
    events.flatMap((event) => (event.kind === "tool.started" ? [event.data.toolName] : [])),
  );
}

function countStrings(values: readonly string[]): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  return counts;
}

function isTerminalWorkspaceStatus(status: string): boolean {
  return status === "succeeded" || status === "failed" || status === "cancelled";
}

function classifyRunFailure(error: string): string {
  if (/prestarted|run.started|run id|turn id|invocation/iu.test(error)) return "runtime_identity";
  if (/session|owner|lease|fence/iu.test(error)) return "session_ownership";
  if (/graph root|root context|graph mode|tool/iu.test(error)) return "graph_tool_setup";
  if (/provider|model|route|network|429|rate limit/iu.test(error)) return "provider_setup";
  if (/permission|approval/iu.test(error)) return "permission";
  if (/abort|cancel/iu.test(error)) return "cancelled";
  return "other";
}

function memoryCredentialVault(secret: string): CredentialVault {
  return {
    capability: () => ({ available: true, backend: "macos-keychain", diagnostic: "E2E memory" }),
    put: async () => undefined,
    has: async () => true,
    resolve: async (_ref: CredentialRef) => secret,
    delete: async () => undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  if (typeof result !== "string" || !result) assert.fail(`${key} must be a non-empty string`);
  return result;
}

function openRootEpochFromAuthority(
  authority: {
    listGraphs(rootSessionId?: string): readonly AgentGraphRecord[];
  },
  rootSessionId: string,
): AgentGraphRecord | undefined {
  const opened = authority
    .listGraphs(rootSessionId)
    .filter((graph) => graph.rootSessionId === rootSessionId && graph.phase === "open");
  assert.ok(opened.length <= 1, `Graph authority returned multiple open epochs for ${rootSessionId}`);
  return opened[0];
}
