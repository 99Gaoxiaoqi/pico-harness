import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { wakeIdFor } from "../../src/agent-graph/core/ids.js";
import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { globalSessionManager } from "../../src/engine/session.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../src/runtime/agent-runtime.js";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../fixtures/desktop-model-routing.js";

test("production exact root wake escapes a completed ancestor AgentEngine context", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-production-root-wake-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const canonicalWorkspace = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonicalWorkspace);

  let host: AgentGraphWorkspaceHost | undefined;
  let dispatchCount = 0;
  const fakeAgentRuntime = new (class extends AgentRuntime {
    override async execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
      const binding = dependencies.agentGraph;
      assert.ok(binding);
      let turn = 0;
      const rootWake = options.prompt.startsWith("[Graph Supervisor wake]");
      return super.execute(options, {
        ...dependencies,
        provider: {
          modelName: "deterministic/root-wake",
          generate: async () => {
            dispatchCount++;
            turn++;
            if (binding.kind === "operator") {
              return turn === 1
                ? toolCall("operator-output", "agent_output", {
                    status: "success",
                    output: "deterministic operator result",
                  })
                : assistant("operator complete");
            }
            if (!rootWake) {
              if (turn === 1) {
                return toolCall("root-update", "update_agent_graph", {
                  expected_revision: 0,
                  operation_id: "deterministic-add-operator",
                  commands: [
                    {
                      kind: "add",
                      operator: {
                        operator_id: "deterministic-operator",
                        generation: 1,
                        role: "fixture",
                        description: "commit one deterministic output",
                        profile: {
                          profile_id: "deterministic-profile",
                          model: "test/coder",
                          tools: [],
                          permission_policy: {},
                          system_prompt_version: "deterministic-v1",
                        },
                        workspace: { kind: "shared" },
                      },
                      intent: {
                        intent_id: "deterministic-intent",
                        instruction: "Call agent_output exactly once.",
                        input_record_ids: [],
                      },
                    },
                  ],
                });
              }
              return turn === 2
                ? toolCall("root-yield", "yield_agent_graph", {})
                : assistant("initial root complete");
            }
            if (turn === 1) return toolCall("root-view", "view_agent_graph", {});
            if (turn === 2) {
              const context = binding.getRootContext();
              assert.ok(context);
              const recordIds = host?.store
                .listRecordRefs(context.graphId)
                .map((record) => record.recordId);
              assert.equal(recordIds?.length, 1);
              return toolCall("root-finish", "update_agent_graph", {
                expected_revision: 1,
                operation_id: "deterministic-finish-graph",
                commands: [{ kind: "finish", selected_record_ids: recordIds }],
              });
            }
            return assistant("root wake complete");
          },
        },
        isolatedHeadless: true,
      });
    }
  })();
  const services = createProductionRuntimeServices({
    env,
    trustStore,
    agentRuntime: fakeAgentRuntime,
    agentGraphWorkspaceHostFactory: (options) => {
      host = createAgentGraphWorkspaceHost(options);
      return host;
    },
  });
  const rootSessionId = "production-root-wake-session";
  const graphId = `graph:${rootSessionId}`;
  try {
    const workspaceRuntime = await services.service.getWorkspaceRuntime(canonicalWorkspace);
    assert.ok(host);
    const rootLease = await globalSessionManager.getOrCreatePinned(
      rootSessionId,
      canonicalWorkspace,
      {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      },
    );
    rootLease.session.updateRuntimeState({
      settings: {
        provider: "openai",
        model: "coder",
        modelRouteId: "test/coder",
        collaborationMode: "agent",
        permissionMode: "default",
        orchestrationMode: "graph",
        thinkingEffort: "medium",
        thinkingEffortExplicit: false,
        additionalDirectories: [],
      },
    });
    rootLease.release();

    const initial = await services.service.startForegroundRun({
      workspacePath: canonicalWorkspace,
      sessionId: rootSessionId,
      prompt: "Create one deterministic operator and yield.",
      execution: {
        requestedModel: "test/coder",
        allowedTools: ["update_agent_graph", "yield_agent_graph"],
      },
    });
    const initialRunId = String((initial as Record<string, unknown>)["runId"]);
    assert.equal((await workspaceRuntime.waitForRun(initialRunId)).status, "succeeded");
    await waitUntil(() => (host?.store.listActivationClaims(graphId).length ?? 0) === 1);
    const claim = host.store.listActivationClaims(graphId)[0]!;
    assert.equal((await workspaceRuntime.waitForRun(claim.targetRunId)).status, "succeeded");
    const operatorEvents = await rootLease.session.runtimeEventStore!.readRun(
      claim.targetSessionId,
      claim.targetRunId,
    );
    const operatorTerminal = operatorEvents.find((event) => event.kind === "run.terminal");
    assert.ok(operatorTerminal);
    const wakeId = wakeIdFor(
      graphId,
      `runtime-terminal:${claim.targetRunId}:${operatorTerminal.eventId}`,
    );
    await waitUntil(() => host?.store.getSupervisorWake(wakeId) !== undefined);
    const wake = host.store.getSupervisorWake(wakeId)!;
    await waitUntil(() => host?.store.listSupervisorWakeAttempts(wake.wakeId).length === 1);
    const attempts = host.store.listSupervisorWakeAttempts(wake.wakeId);
    const run = await workspaceRuntime.waitForRun(attempts[0]!.targetRunId);
    const events = await rootLease.session.runtimeEventStore!.readRun(
      rootSessionId,
      attempts[0]!.targetRunId,
    );
    assert.equal(
      run?.status,
      "succeeded",
      `exact root wake failed before provider dispatch: ${run?.error ?? host.store.getSupervisorWake(wake.wakeId)?.lastError ?? "unknown"}`,
    );
    await waitUntil(() => host?.store.getSupervisorWake(wake.wakeId)?.status === "delivered");
    const delivered = host.store.getSupervisorWake(wake.wakeId)!;
    const completedAttempts = host.store.listSupervisorWakeAttempts(wake.wakeId);
    assert.equal(host.store.getGraph(graphId)?.phase, "finished");
    assert.equal(delivered.status, "delivered");
    assert.equal(delivered.attemptCount, 1, "a successful exact wake must not enter retry churn");
    assert.equal(delivered.lastError, undefined);
    assert.equal(completedAttempts.length, 1);
    assert.equal(completedAttempts[0]?.status, "completed");
    assert.equal(completedAttempts[0]?.rootSessionId, rootSessionId);
    assert.equal(completedAttempts[0]?.targetRunId, run.runId);
    assert.equal(run.sessionId, rootSessionId);
    assert.equal(dispatchCount, 8);
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 1);
  } finally {
    await services.desktopService.close();
    const session = globalSessionManager.delete(rootSessionId, canonicalWorkspace, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for root wake terminal state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assistant(content: string): { readonly role: "assistant"; readonly content: string } {
  return { role: "assistant", content };
}

function toolCall(
  id: string,
  name: string,
  args: Record<string, unknown>,
): {
  readonly role: "assistant";
  readonly content: string;
  readonly toolCalls: readonly [
    { readonly id: string; readonly name: string; readonly arguments: string },
  ];
} {
  return {
    role: "assistant",
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}
