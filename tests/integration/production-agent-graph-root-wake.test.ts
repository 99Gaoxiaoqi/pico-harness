import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { graphIdFor, wakeIdFor } from "../../src/agent-graph/core/ids.js";
import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { createRuntimeRequest } from "../../src/daemon/protocol.js";
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
import type { RuntimeEvent } from "../../src/storage/runtime-event.js";
import { isMessageHiddenFromTranscript } from "../../src/schema/message.js";
import { writeDesktopModelRouting } from "../fixtures/desktop-model-routing.js";

test("production exact root wake reads durable output before finish", () =>
  runProductionRootWakeScenario("output"));

test("production exact root wake finishes a terminal Claim without output instead of yielding", () =>
  runProductionRootWakeScenario("outputless"));

test("production recovers a scheduled root after provider failure before yield", () =>
  runProductionRootWakeScenario("root-failure"));

async function runProductionRootWakeScenario(
  scenario: "output" | "outputless" | "root-failure",
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), `pico-production-root-wake-${scenario}-`));
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
  const outputCanary = "DETERMINISTIC_GRAPH_OUTPUT_CANARY";
  const fakeAgentRuntime = new (class extends AgentRuntime {
    override async execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
      const binding = dependencies.agentGraph;
      assert.ok(binding);
      let turn = 0;
      const rootWake = options.prompt.startsWith("[Graph Supervisor wake]");
      if (rootWake) {
        assert.deepEqual(options.allowedTools, [
          "view_agent_graph",
          "update_agent_graph",
          "yield_agent_graph",
        ]);
      }
      return super.execute(options, {
        ...dependencies,
        provider: {
          modelName: "deterministic/root-wake",
          generate: async (messages) => {
            dispatchCount++;
            turn++;
            if (binding.kind === "operator") {
              if (scenario === "outputless") {
                return assistant("operator completed without agent_output");
              }
              return turn === 1
                ? toolCall("operator-output", "agent_output", {
                    status: "success",
                    output: outputCanary,
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
                          profile_id: "explore",
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
              if (scenario === "root-failure" && turn === 2) {
                throw new Error("provider failed after durable schedule commit");
              }
              return turn === 2
                ? toolCall("root-yield", "yield_agent_graph", {})
                : assistant("initial root complete");
            }
            if (turn === 1) return toolCall("root-view", "view_agent_graph", {});
            if (turn === 2) {
              const viewResult = messages.findLast(
                (message) => message.role === "user" && message.toolCallId === "root-view",
              );
              assert.ok(viewResult, "root must receive the view tool result before finish");
              const view = JSON.parse(viewResult.content) as {
                readonly results: {
                  readonly records: readonly {
                    readonly recordId: string;
                    readonly status: string;
                    readonly content: string;
                  }[];
                };
                readonly runtimeClaims: readonly {
                  readonly status: string;
                  readonly terminalEventId?: string;
                  readonly outputEventIds: readonly string[];
                }[];
              };
              if (scenario !== "outputless") {
                assert.deepEqual(
                  view.results.records.map(({ status, content }) => ({ status, content })),
                  [{ status: "success", content: outputCanary }],
                );
              } else {
                assert.deepEqual(view.results.records, []);
                assert.ok(view.runtimeClaims[0]?.terminalEventId);
                assert.deepEqual(view.runtimeClaims[0]?.outputEventIds, []);
              }
              assert.deepEqual(
                view.runtimeClaims.map(({ status }) => status),
                ["completed"],
              );
              const recordIds = view.results.records.map((record) => record.recordId);
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
  const rootSessionId = `production-root-wake-session-${scenario}`;
  const graphId = graphIdFor(rootSessionId, 1);
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
    assert.equal(
      (await workspaceRuntime.waitForRun(initialRunId)).status,
      scenario === "root-failure" ? "failed" : "succeeded",
    );
    await waitUntil(() => (host?.store.listActivationClaims(graphId).length ?? 0) === 1);
    const claim = host.store.listActivationClaims(graphId)[0]!;
    await waitUntil(() => workspaceRuntime.getRun(claim.targetRunId) !== undefined);
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
    await waitUntil(() => workspaceRuntime.getRun(attempts[0]!.targetRunId) !== undefined);
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
    const desktopGraph = (await services.desktopService.handle(
      createRuntimeRequest("session.graph.query", {
        workspacePath: canonicalWorkspace,
        sessionId: rootSessionId,
        action: "get",
        graphId,
      }),
    )) as {
      readonly runtimeClaims: readonly { readonly status: string }[];
      readonly outputs: readonly { readonly status: string }[];
    };
    assert.deepEqual(
      desktopGraph.runtimeClaims.map(({ status }) => status),
      ["completed"],
    );
    assert.deepEqual(
      desktopGraph.outputs.map(({ status }) => status),
      scenario === "outputless" ? [] : ["success"],
    );
    assert.equal(
      dispatchCount,
      6,
      "successful terminal Graph tools must not trigger an extra provider turn",
    );
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 1);
    assert.deepEqual(events.find((event) => event.kind === "run.started")?.data.presentation, {
      audience: "internal",
      source: "agent_graph_control",
    });
    const wakeInput = events.find(
      (event): event is Extract<RuntimeEvent, { kind: "message.committed" }> =>
        event.kind === "message.committed" && event.data.message.role === "user",
    );
    assert.ok(wakeInput);
    assert.equal(isMessageHiddenFromTranscript(wakeInput.data.message), true);
    assert.equal(
      events.some(
        (event) =>
          event.kind === "transcript.event.recorded" && event.data.event.type === "tool.started",
      ),
      false,
      "Graph supervisor tools must stay in the Runtime ledger without entering transcript facts",
    );
    assert.ok(
      events
        .filter(
          (event): event is Extract<RuntimeEvent, { kind: "message.committed" }> =>
            event.kind === "message.committed" && event.data.message.role === "assistant",
        )
        .filter((event) => (event.data.message.toolCalls?.length ?? 0) > 0)
        .every((event) => isMessageHiddenFromTranscript(event.data.message)),
    );
    const transcript = await rootLease.session.runtimeEventStore!.readTranscriptProjectionPage({
      sessionId: rootSessionId,
      maxBytes: 512 * 1024,
      limit: 100,
    });
    const visibleTranscript = JSON.stringify(transcript.items.map((item) => item.payload));
    assert.match(visibleTranscript, /Create one deterministic operator and yield\./u);
    assert.match(visibleTranscript, /root wake complete/u);
    assert.doesNotMatch(visibleTranscript, /Graph Supervisor wake/u);
    assert.doesNotMatch(
      visibleTranscript,
      /view_agent_graph|update_agent_graph|yield_agent_graph/u,
    );
    const durableViewResult = events.find(
      (event): event is Extract<RuntimeEvent, { kind: "tool.result.recorded" }> =>
        event.kind === "tool.result.recorded" && event.data.toolName === "view_agent_graph",
    );
    assert.ok(durableViewResult, "view_agent_graph result must be durable on the exact root Run");
    if (scenario !== "outputless") {
      assert.match(durableViewResult.data.projection.text, new RegExp(outputCanary, "u"));
      assert.match(durableViewResult.data.projection.text, /"status":"success"/u);
    } else {
      assert.match(durableViewResult.data.projection.text, /"status":"completed"/u);
      assert.match(durableViewResult.data.projection.text, /"outputEventIds":\[\]/u);
      assert.equal(
        events.some(
          (event) => event.kind === "tool.started" && event.data.toolName === "yield_agent_graph",
        ),
        false,
        "a root wake must not yield again for a terminal Claim without output",
      );
    }
  } finally {
    await services.desktopService.close();
    const session = globalSessionManager.delete(rootSessionId, canonicalWorkspace, { picoHome });
    await session?.close();
    await rm(root, { recursive: true, force: true });
  }
}

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
