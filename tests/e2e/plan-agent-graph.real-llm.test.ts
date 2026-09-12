import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { createRuntimeRequest } from "../../packages/protocol/src/index.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { EMPTY_USER_CONFIG_REVISION, UserConfigStore } from "../../src/input/user-config-store.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { CredentialVault } from "../../src/provider/credential-vault.js";
import { AgentRuntime } from "../../src/runtime/agent-runtime.js";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { WorkspaceTaskRuntime } from "../../src/runtime/workspace-runtime.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;

realModelTest(
  "Plan Graph uses the real user model to investigate, approve, delegate two branches and finish",
  { timeout: 9 * 60_000 },
  async () => {
    const model = await configuredUserDefaultRealModel();
    const root = await mkdtemp(join(tmpdir(), "pico-plan-graph-real-llm-"));
    const workDir = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(workDir, { recursive: true });
    await mkdir(picoHome, { recursive: true });
    const workspacePath = await realpath(workDir);
    const sessionId = `plan-graph-root-${randomUUID()}`;
    const evidence = ["a", "b"].map((branch) => `BRANCH_${branch}_${randomUUID()}`);
    await Promise.all([
      writeFile(join(workspacePath, "TASK.txt"), planningTask()),
      ...evidence.map((value, index) =>
        writeFile(join(workspacePath, `branch-${index === 0 ? "a" : "b"}.txt`), `${value}\n`),
      ),
    ]);
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
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(workspacePath);
    let graphHost: AgentGraphWorkspaceHost | undefined;
    let runtime: WorkspaceTaskRuntime | undefined;
    let graphId: string | undefined;
    const sessions = new Set([sessionId]);
    const services = createProductionRuntimeServices({
      env: {
        ...process.env,
        PICO_HOME: picoHome,
        [model.route.apiKeyEnv]: model.config.apiKey,
      },
      userConfigStore,
      trustStore,
      credentialVault: memoryCredentialVault(model.config.apiKey),
      agentGraphWorkspaceHostFactory: (options) => {
        graphHost = createAgentGraphWorkspaceHost(options);
        return graphHost;
      },
    });
    const readPlan = () =>
      new AgentRuntime().readPlanProjection({ sessionId, dir: workspacePath, picoHome });
    const deadline = Date.now() + 8 * 60_000;
    const summary = () => ({
      graphPhase: graphId ? graphHost?.store.getGraph(graphId)?.phase : "not-admitted",
      claims: graphId ? graphHost?.store.listActivationClaims(graphId).length : 0,
      records: graphId ? graphHost?.store.listRecordRefs(graphId).length : 0,
      runs: runtime
        ?.listRuns()
        .map((run) => ({ status: run.status, root: run.sessionId === sessionId })),
    });
    async function waitFor<T>(stage: string, timeoutMs: number, probe: () => T | Promise<T>) {
      console.error(`[Plan Graph E2E] ${stage}.started`);
      const stageDeadline = Math.min(deadline, Date.now() + timeoutMs);
      while (Date.now() < stageDeadline) {
        const value = await probe();
        if (value) {
          console.error(`[Plan Graph E2E] ${stage}.complete ${JSON.stringify(summary())}`);
          return value;
        }
        if (
          runtime?.listRuns().some((run) => run.status === "failed" || run.status === "cancelled")
        ) {
          assert.fail(`${stage}: a production Run failed; ${JSON.stringify(summary())}`);
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail(`${stage} timed out after at most ${timeoutMs}ms; ${JSON.stringify(summary())}`);
    }

    try {
      const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      try {
        lease.session.updateRuntimeState({
          settings: {
            provider: model.provider,
            model: model.route.model,
            modelRouteId: model.route.id,
            collaborationMode: "plan",
            permissionMode: "full-access",
            orchestrationMode: "graph",
            thinkingEffort: "off",
            thinkingEffortExplicit: false,
            additionalDirectories: [],
          },
        });
        await lease.session.flushPersistence();
      } finally {
        lease.release();
      }
      runtime = await services.service.getWorkspaceRuntime(workspacePath);
      const planned = asRecord(
        await services.service.startForegroundRun({
          workspacePath,
          sessionId,
          prompt:
            "Read TASK.txt with read_file, then call submit_plan with the exact proposal specified there. Do not investigate the branch files before approval. End after submit_plan; wait for user approval.",
          execution: { requestedModel: model.route.id },
        }),
      );
      const planningRunId = requiredString(planned, "runId");
      await waitFor(
        "planning.submit",
        120_000,
        () => runtime?.getRun(planningRunId)?.status === "succeeded",
      );
      const proposed = await readPlan();
      assert.ok(proposed.pendingProposal, "real model must submit a reviewable proposal");
      assert.ok(graphHost);
      assert.equal(
        graphHost.store.listGraphs(sessionId).length,
        0,
        "planning must not admit Graph authority",
      );
      assert.deepEqual(
        proposed.pendingProposal.steps.map((step) => step.id),
        ["step-a", "step-b"],
      );
      const planningEvents = await readEvents(workspacePath, picoHome, sessionId);
      const planningTools = planningEvents.filter((event) => event.kind === "tool.started");
      const planningToolNames = planningTools.map((event) => event.data.toolName);
      assert.ok(planningToolNames.includes("read_file"));
      assert.equal(planningToolNames.at(-1), "submit_plan");
      assert.ok(
        planningToolNames.every((name) =>
          ["read_file", "glob", "grep", "submit_plan"].includes(name),
        ),
      );
      assert.equal(proposed.execution, undefined);

      const approved = asRecord(
        await services.desktopService.handle(
          createRuntimeRequest("plan.respond", {
            workspacePath,
            sessionId,
            planId: proposed.pendingProposal.planId,
            action: "execute",
            expectedRevision: proposed.pendingProposal.revision,
            expectedSessionSequence: proposed.sessionSequence,
            controlEpoch: proposed.controlEpoch!,
          }),
        ),
      );
      assert.equal(approved.accepted, true);
      const approvedRunId = requiredString(asRecord(approved.run), "runId");
      const graph = await waitFor(
        "approved.graph",
        30_000,
        () => graphHost?.store.listGraphs(sessionId)[0],
      );
      graphId = graph.graphId;
      await waitFor(
        "approved.yield",
        120_000,
        () =>
          runtime?.getRun(approvedRunId)?.status === "succeeded" &&
          (graphHost?.store.listYieldInterests(graph.graphId).length ?? 0) > 0,
      );
      const yielded = await readPlan();
      assert.equal(
        yielded.execution?.status,
        "active",
        "yield must preserve approved Plan execution",
      );
      assert.deepEqual((yielded.execution as { graph?: unknown } | undefined)?.graph, {
        graphId: graph.graphId,
        epoch: graph.epoch,
      });
      await waitFor(
        "operators.outputs",
        150_000,
        () => graphHost?.store.listRecordRefs(graph.graphId).length === 2,
      );
      await waitFor(
        "wake.graph-finish",
        120_000,
        () => graphHost?.store.getGraph(graph.graphId)?.phase === "finished",
      );
      await waitFor(
        "wake.plan-complete",
        60_000,
        async () => (await readPlan()).execution?.status === "completed",
      );
      await waitFor("runs.terminal", 30_000, () =>
        runtime?.listRuns().every((run) => run.status === "succeeded"),
      );

      const finished = await readPlan();
      assert.deepEqual(
        finished.execution?.steps.map((step) => step.status),
        ["completed", "completed"],
      );
      const claims = graphHost.store.listActivationClaims(graph.graphId);
      assert.equal(claims.length, 2, "two independent explore operators must run once each");
      assert.equal(new Set(claims.map((claim) => claim.operatorId)).size, 2);
      const records = graphHost.store.listRecordRefs(graph.graphId);
      const schedule = new SqliteAgentGraphControlStoreAdapter(graphHost.store).getScheduleState(
        graph.graphId,
      );
      assert.deepEqual(
        [...schedule.graph.selectedRecordIds].sort(),
        records.map((record) => record.recordId).sort(),
      );
      assert.deepEqual(
        schedule.operators.map((operator) => operator.profileSnapshot.profileId),
        ["Explore", "Explore"],
      );
      assert.ok(
        schedule.intents.every((intent) => intent.inputRefs.length === 0),
        "both operators must be independently schedulable",
      );
      const observedBranches: number[] = [];
      for (const claim of claims) {
        const intent = schedule.intents.find((candidate) => candidate.intentId === claim.intentId);
        assert.ok(intent);
        const branch = /branch-([ab])\.txt/u.exec(intent.instruction)?.[1];
        assert.ok(branch, "each branch intent must identify its assigned evidence file");
        const branchIndex = branch === "a" ? 0 : 1;
        observedBranches.push(branchIndex);
        sessions.add(claim.targetSessionId);
        const operatorEvents = await readEvents(workspacePath, picoHome, claim.targetSessionId);
        const outputs = operatorEvents.filter((event) => event.kind === "agent.output");
        assert.equal(outputs.length, 1);
        assert.equal(outputs[0]?.data.payload.status, "success");
        assert.equal(outputs[0]?.data.payload.output, evidence[branchIndex]);
        assert.equal(outputs[0]?.runId, claim.targetRunId);
        assert.ok(
          operatorEvents.some(
            (event) => event.kind === "tool.started" && event.data.toolName === "read_file",
          ),
        );
        assert.ok(
          records.some(
            (record) =>
              record.claimId === claim.claimId && record.sourceEventId === outputs[0]?.eventId,
          ),
        );
      }
      assert.deepEqual(
        observedBranches.sort(),
        [0, 1],
        "each evidence branch must run exactly once",
      );
      const events = await readEvents(workspacePath, picoHome, sessionId);
      for (const kind of ["plan.proposed", "plan.execution.started", "plan.execution.completed"]) {
        assert.equal(
          events.filter((event) => event.kind === kind).length,
          1,
          `${kind} must happen exactly once`,
        );
      }
      assert.equal(events.filter((event) => event.kind === "plan.execution.interrupted").length, 0);
      const toolStarts = events.filter((event) => event.kind === "tool.started");
      assert.equal(toolStarts.filter((event) => event.data.toolName === "submit_plan").length, 1);
      assert.ok(toolStarts.some((event) => event.data.toolName === "yield_agent_graph"));
      assert.equal(
        toolStarts.filter((event) => event.data.toolName === "read_file").length,
        1,
        "only operators may read branch evidence",
      );
      const finishCall = toolStarts.findLast(
        (event) => event.data.toolName === "update_agent_graph",
      );
      assert.ok(finishCall);
      const finishToolCallId = finishCall.refs?.toolCallId;
      assert.ok(finishToolCallId);
      const finishIndex = events.findIndex(
        (event) =>
          event.kind === "tool.result.recorded" && event.refs.toolCallId === finishToolCallId,
      );
      const completionIndex = events.findIndex(
        (event) => event.kind === "plan.execution.completed",
      );
      assert.ok(
        finishIndex >= 0 && completionIndex > finishIndex,
        "final Plan update must follow Graph finish",
      );
      assert.ok(
        events
          .slice(finishIndex + 1, completionIndex)
          .some((event) => event.kind === "tool.started" && event.data.toolName === "update_plan"),
      );
      const wakeAttempts = graphHost.store
        .listSupervisorWakes(graph.graphId)
        .flatMap((wake) => graphHost!.store.listSupervisorWakeAttempts(wake.wakeId));
      assert.ok(wakeAttempts.length > 0, "operator completion must durably wake the root");
      assert.ok(
        wakeAttempts.some(
          (attempt) => attempt.targetRunId === finishCall.runId && attempt.status === "completed",
        ),
      );
      const finalWakeView = events.findLast(
        (event) =>
          event.kind === "tool.result.recorded" &&
          event.runId === finishCall.runId &&
          event.data.toolName === "view_agent_graph",
      );
      assert.ok(finalWakeView?.kind === "tool.result.recorded");
      for (const value of evidence)
        assert.ok(
          finalWakeView.data.projection.text.includes(value),
          "root must inspect both durable evidence outputs before finishing",
        );
    } catch (error) {
      const text = (value: string) =>
        value.replaceAll(model.config.apiKey, "[redacted]").slice(0, 900);
      for (const run of runtime?.listRuns() ?? []) if (run.sessionId) sessions.add(run.sessionId);
      for (const id of sessions) {
        const events = await readEvents(workspacePath, picoHome, id);
        const diagnostic = events.flatMap((event): Record<string, unknown>[] => {
          if (event.kind === "tool.result.recorded")
            return [
              {
                tool: event.data.toolName,
                status: event.data.status,
                ...(event.data.status !== "succeeded"
                  ? { error: text(event.data.projection.text) }
                  : {}),
              },
            ];
          if (event.kind === "tool.started") return [{ started: event.data.toolName }];
          if (event.kind === "run.terminal") return [{ terminal: event.data.status }];
          if (event.kind === "model.call.started" || event.kind === "model.call.settled")
            return [
              {
                kind: event.kind,
                ...(event.kind === "model.call.settled" ? { status: event.data.status } : {}),
              },
            ];
          if (event.kind === "message.committed" && event.data.message.role === "assistant")
            return [
              {
                tools: event.data.message.toolCalls?.map((call) => call.name) ?? [],
                text: text(event.data.message.content),
              },
            ];
          return [];
        });
        console.error(
          JSON.stringify({ sessionId: id, events: diagnostic.slice(-60) }).replaceAll(
            model.config.apiKey,
            "[redacted]",
          ),
        );
      }
      throw error;
    } finally {
      for (const run of runtime?.listRuns() ?? []) {
        if (!["succeeded", "failed", "cancelled"].includes(run.status))
          runtime?.cancel(run.runId, "Plan Graph E2E cleanup");
      }
      for (const claim of graphId ? (graphHost?.store.listActivationClaims(graphId) ?? []) : [])
        sessions.add(claim.targetSessionId);
      try {
        await services.desktopService.close();
      } finally {
        for (const id of sessions) {
          const session = globalSessionManager.delete(id, workspacePath, { picoHome });
          await session?.close();
        }
        await rm(root, { recursive: true, force: true });
      }
    }
  },
);

function planningTask(): string {
  const overview = [
    "After approval use exactly two independent explore Graph operators: one reads branch-a.txt; the other reads branch-b.txt. Root must not read branch files itself. Operator and intent IDs are allocated by the runtime; never invent them.",
    "Mark only step-a in_progress. For all Plan tools omit optional operationId so the runtime assigns a distinct identity. Call view_agent_graph, then add both branches in one update_agent_graph call with operation=add_work and add_work containing exactly two entries with profile_id=Explore (the case-sensitive catalog ID), instruction, input_ids=[] and workspace={kind:shared}. Omit target_kind, subagent_id, agent_id, operator_id and expected_revision. Instruct each to read_file its assigned branch file once and call agent_output once with status=success and output exactly the file line, without newline or commentary. Then yield_agent_graph immediately.",
    "On wake view_agent_graph first. Yield again if work remains; never add or reactivate operators. When both outputs are successful and claims terminal, finish Graph selecting both record IDs. Only then update_plan step-a and step-b completed. Never cancel or submit another plan.",
  ].join("\n");
  return [
    "This is an end-to-end Plan + Graph task. Do not ask questions. Submit exactly the following proposal, preserving the complete overview and both step IDs:",
    JSON.stringify(
      {
        title: "Investigate two independent branches",
        overview,
        steps: ["a", "b"].map((branch) => ({
          id: `step-${branch}`,
          title: `Investigate branch ${branch}`,
          description: `Delegate branch-${branch}.txt to one independent explore operator. Mark completed only after both branch outputs are collected and Graph is finished.`,
        })),
      },
      null,
      2,
    ),
  ].join("\n");
}

async function readEvents(
  workspacePath: string,
  picoHome: string,
  sessionId: string,
): Promise<RuntimeEvent[]> {
  const store = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workspacePath, { picoHome }).workspace.root,
  });
  try {
    return await store.readSession(sessionId);
  } finally {
    store.close();
  }
}

function memoryCredentialVault(secret: string): CredentialVault {
  return {
    capability: () => ({ available: true, backend: "macos-keychain", diagnostic: "E2E memory" }),
    put: async () => undefined,
    has: async () => true,
    resolve: async () => secret,
    delete: async () => undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function requiredString(value: Record<string, unknown>, key: string): string {
  const result = value[key];
  assert.ok(typeof result === "string" && result.length > 0, `${key} must be a non-empty string`);
  return result;
}
