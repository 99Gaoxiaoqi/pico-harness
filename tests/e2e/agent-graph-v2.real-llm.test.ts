import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { EMPTY_USER_CONFIG_REVISION, UserConfigStore } from "../../src/input/user-config-store.js";
import { SqliteAgentGraphControlStoreAdapter } from "../../src/agent-graph/sqlite-control-store-adapter.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { CredentialRef, CredentialVault } from "../../src/provider/credential-vault.js";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;
const LEGACY_GRAPH_TOOLS = new Set(["add_work", "view_graph", "close_graph"]);

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
    const graphId = `graph:${rootSessionId}`;
    const canary = `GRAPH_V2_${randomUUID().replaceAll("-", "").toUpperCase()}`;
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

    try {
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

      const workspaceRuntime = await services.service.getWorkspaceRuntime(workspacePath);
      const initial = asRecord(
        await services.service.startForegroundRun({
          workspacePath,
          sessionId: rootSessionId,
          prompt: initialRootPrompt({ canary, modelRouteId: model.route.id }),
          execution: {
            requestedModel: model.route.id,
            allowedTools: ["update_agent_graph", "yield_agent_graph"],
          },
        }),
      );
      const initialRunId = requiredString(initial, "runId");
      assert.equal((await workspaceRuntime.waitForRun(initialRunId)).status, "succeeded");

      await waitUntil(
        () => graphHost?.store.getGraph(graphId)?.phase === "finished",
        "Graph did not finish after the durable root wake",
      );
      await waitUntil(
        () =>
          workspaceRuntime
            .listRuns()
            .every((run) => ["succeeded", "failed", "cancelled"].includes(run.status)),
        "Graph exact Runs did not reach terminal state",
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
      const persistedGraph = host.store.getGraph(graphId);
      assert.ok(persistedGraph);
      assert.equal(persistedGraph.phase, "finished");
      const graph = new SqliteAgentGraphControlStoreAdapter(host.store).getScheduleState(
        graphId,
      ).graph;

      const claims = host.store.listActivationClaims(graphId);
      assert.equal(claims.length, 1, "the one add command must create one Claim");
      const claim = claims[0];
      assert.ok(claim);
      sessionIds.add(claim.targetSessionId);
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
      assert.ok(rootRuns.length >= 2, "root Session must contain the initial and exact wake Runs");
      assert.ok(rootRuns.some((event) => event.runId === initialRunId));

      const outputEvents = operatorEvents.filter((event) => event.kind === "agent.output");
      assert.equal(outputEvents.length, 1, "operator must commit exactly one agent.output fact");
      assert.equal(outputEvents[0]?.data.payload.output, canary);
      assert.equal(outputEvents[0]?.data.payload.status, "success");
      assert.equal(outputEvents[0]?.runId, claim.targetRunId);
      assert.ok(
        [...rootEvents, ...operatorEvents]
          .filter((event) => event.kind === "run.terminal")
          .every((event) => event.data.status === "completed"),
        "every RuntimeRun in the scenario must complete",
      );

      const rootToolStarts = rootEvents.filter(
        (event): event is Extract<RuntimeEvent, { kind: "tool.started" }> =>
          event.kind === "tool.started",
      );
      assert.ok(
        rootToolStarts.some(
          (event) => event.runId === initialRunId && event.data.toolName === "update_agent_graph",
        ),
      );
      assert.ok(
        rootToolStarts.some(
          (event) => event.runId === initialRunId && event.data.toolName === "yield_agent_graph",
        ),
      );
      assert.ok(
        rootToolStarts.some(
          (event) => event.runId !== initialRunId && event.data.toolName === "view_agent_graph",
        ),
        "the exact root wake must inspect the durable projection before finishing",
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
    } finally {
      try {
        for (const claim of graphHost?.store.listActivationClaims(graphId) ?? []) {
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

function initialRootPrompt(input: {
  readonly canary: string;
  readonly modelRouteId: string;
}): string {
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
          profile_id: "graph-v2-real-e2e",
          model: input.modelRouteId,
          tools: [],
          permission_policy: {},
          system_prompt_version: "graph-v2-real-e2e-v1",
        },
        workspace: { kind: "shared" },
      },
      intent: {
        intent_id: "emit-canary",
        instruction: `Call agent_output exactly once with status success and output exactly ${input.canary}. Do not call any other tool and do not write files.`,
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

async function waitUntil(
  predicate: () => boolean,
  message: string,
  timeoutMs = TEST_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
