import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionRuntimeServices } from "../../../src/daemon/production-host.js";
import { createRuntimeRequest } from "../../../src/daemon/protocol.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import {
  AgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
} from "../../../src/runtime/agent-runtime.js";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "../../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

for (const recoverAfterFinish of [false, true]) {
  test(
    recoverAfterFinish
      ? "production resumes the same finished Graph after a crash before the last Plan update"
      : "production Plan Graph investigates, approves once, yields across two branches and completes after finish",
    {
      timeout: 30_000,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pico-production-plan-graph-"));
      const workspace = join(root, "workspace");
      const picoHome = join(root, "pico-home");
      await mkdir(workspace, { recursive: true });
      await mkdir(picoHome, { recursive: true });
      await writeFile(join(workspace, "TASK.txt"), "Investigate two independent branches.\n");
      await writeDesktopModelRouting(picoHome);
      const workspacePath = await realpath(workspace);
      const sessionId = "production-plan-graph";
      const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
      const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
      await trustStore.trust(workspacePath);
      let graphHost: AgentGraphWorkspaceHost | undefined;
      const gates = [Promise.withResolvers<void>(), Promise.withResolvers<void>()];
      let wakeCount = 0;
      const wakeRuns: string[] = [];
      const readProjection = () =>
        new AgentRuntime().readPlanProjection({
          sessionId,
          dir: workspacePath,
          picoHome,
        });
      const fakeAgentRuntime = new (class extends AgentRuntime {
        override async execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
          const binding = dependencies.agentGraph;
          const isPlanning = options.planMode === true;
          const wake = options.prompt.startsWith("[Graph Supervisor wake]") ? ++wakeCount : 0;
          if (wake) {
            assert.ok(dependencies.prestartedRun);
            wakeRuns.push(dependencies.prestartedRun.runId);
          }
          let turn = 0;
          return super.execute(options, {
            ...dependencies,
            isolatedHeadless: true,
            provider: {
              modelName: "deterministic/plan-graph",
              generate: async (messages, tools) => {
                turn++;
                const toolNames = tools?.map((tool) => tool.name) ?? [];
                if (isPlanning) {
                  assert.equal(
                    binding?.kind,
                    undefined,
                    "planning must not receive Graph root authority",
                  );
                  assert.equal(
                    graphHost?.store.listGraphs(sessionId).length,
                    0,
                    "planning must not admit a Graph epoch",
                  );
                  for (const name of ["read_file", "grep", "glob", "ask_user", "submit_plan"]) {
                    assert.ok(toolNames.includes(name), `planning must expose ${name}`);
                  }
                  for (const name of ["update_agent_graph", "yield_agent_graph", "write_file"]) {
                    assert.equal(
                      toolNames.includes(name),
                      false,
                      `planning must not expose ${name}`,
                    );
                  }
                  if (turn === 1) return toolCall("plan-read", "read_file", { path: "TASK.txt" });
                  assert.ok(messages.some((message) => message.toolCallId === "plan-read"));
                  return toolCall("plan-submit", "submit_plan", {
                    title: "Investigate two branches",
                    overview:
                      "Delegate both independent branches after approval and record their results.",
                    steps: [
                      { id: "step-a", title: "Branch A", description: "Collect branch A evidence" },
                      { id: "step-b", title: "Branch B", description: "Collect branch B evidence" },
                    ],
                  });
                }
                assert.ok(binding, "approved Graph execution must receive durable Graph authority");
                if (binding.kind === "operator") {
                  const activation = binding.getActivationContext();
                  assert.ok(activation);
                  const index = activation.operatorId === "operator-a" ? 0 : 1;
                  assert.equal(activation.operatorId, index === 0 ? "operator-a" : "operator-b");
                  await gates[index]!.promise;
                  return turn === 1
                    ? toolCall(`output-${index}`, "agent_output", {
                        status: "success",
                        output: `BRANCH_${index}_EVIDENCE`,
                      })
                    : assistant("operator complete");
                }
                for (const name of ["update_plan", "cancel_plan"]) {
                  assert.ok(toolNames.includes(name), `approved root and wake must expose ${name}`);
                }
                assert.equal(toolNames.includes("submit_plan"), false);
                if (options.approvedPlan?.transition === "resume") {
                  assert.equal(
                    graphHost?.store.listGraphs(sessionId).length,
                    1,
                    "resume must not create another epoch",
                  );
                  assert.equal(graphHost?.store.listGraphs(sessionId)[0]?.phase, "finished");
                  return turn === 1
                    ? toolCall("resume-step-b", "update_plan", {
                        stepId: "step-b",
                        status: "completed",
                      })
                    : assistant("resumed plan complete");
                }
                if (!wake) {
                  const approvalIndex = messages.findLastIndex(
                    (message) =>
                      message.role === "user" &&
                      message.content.includes("[APPROVED PLAN EXECUTION]"),
                  );
                  const submissionIndex = messages.findLastIndex(
                    (message) => message.toolCallId === "plan-submit",
                  );
                  assert.ok(
                    approvalIndex > submissionIndex && submissionIndex >= 0,
                    "approval instruction must reach the model after the pending handoff",
                  );
                  if (turn === 1)
                    return toolCall("root-add", "update_agent_graph", {
                      expected_revision: 0,
                      operation_id: "add-plan-branches",
                      commands: ["a", "b"].map((name) => ({
                        kind: "add",
                        operator: {
                          operator_id: `operator-${name}`,
                          generation: 1,
                          role: "fixture",
                          description: `Collect branch ${name} evidence`,
                          profile: { profile_id: "explore" },
                          workspace: { kind: "shared" },
                        },
                        intent: {
                          intent_id: `intent-${name}`,
                          instruction: "Return one agent_output.",
                          input_record_ids: [],
                        },
                      })),
                    });
                  assert.equal(turn, 2, "yield must end the initial approved Run");
                  return toolCall("root-yield", "yield_agent_graph", {});
                }
                assert.ok(wake <= 2, "each released branch needs at most one root wake");
                if (turn === 1) {
                  assert.equal(
                    (await readProjection()).execution?.status,
                    "active",
                    "a wake must attach the still-active approved Plan",
                  );
                  return toolCall(`view-${wake}`, "view_agent_graph", {});
                }
                const result = messages.findLast(
                  (message) => message.toolCallId === `view-${wake}`,
                );
                assert.ok(result);
                const view = JSON.parse(result.content) as {
                  results: { records: readonly { recordId: string; content: string }[] };
                  runtimeClaims: readonly { status: string }[];
                };
                assert.equal(view.results.records.length, wake);
                assert.equal(
                  view.runtimeClaims.filter((claim) => claim.status === "completed").length,
                  wake,
                );
                if (wake === 1) {
                  if (turn === 2)
                    return toolCall("complete-step-a", "update_plan", {
                      stepId: "step-a",
                      status: "completed",
                    });
                  assert.equal(turn, 3, "yield must end the first wake");
                  return toolCall("wake-yield", "yield_agent_graph", {});
                }
                if (turn === 2)
                  return toolCall("finish-graph", "update_agent_graph", {
                    expected_revision: 1,
                    operation_id: "finish-plan-graph",
                    commands: [
                      {
                        kind: "finish",
                        selected_record_ids: view.results.records.map((record) => record.recordId),
                      },
                    ],
                  });
                if (turn === 3) {
                  if (recoverAfterFinish) throw new Error("Simulated crash after Graph finish");
                  assert.equal(graphHost?.store.listGraphs(sessionId)[0]?.phase, "finished");
                  assert.equal(
                    (await readProjection()).execution?.status,
                    "active",
                    "Graph finish must leave the final Plan update available",
                  );
                  return toolCall("complete-step-b", "update_plan", {
                    stepId: "step-b",
                    status: "completed",
                  });
                }
                return assistant("approved plan complete");
              },
            },
          });
        }
      })();
      const services = createProductionRuntimeServices({
        env,
        trustStore,
        agentRuntime: fakeAgentRuntime,
        agentGraphWorkspaceHostFactory: (options) => {
          graphHost = createAgentGraphWorkspaceHost(options);
          return graphHost;
        },
      });
      try {
        const runtime = await services.service.getWorkspaceRuntime(workspacePath);
        assert.ok(graphHost);
        const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
          persistence: true,
          picoHome,
          runtimePort: createEngineRuntimePort(),
        });
        const session = lease.session;
        session.updateRuntimeState({
          settings: {
            provider: "openai",
            model: "coder",
            modelRouteId: "test/coder",
            collaborationMode: "plan",
            permissionMode: "default",
            orchestrationMode: "graph",
            thinkingEffort: "medium",
            thinkingEffortExplicit: false,
            additionalDirectories: [],
          },
        });
        await session.flushPersistence();
        lease.release();
        assert.ok(session.runtimeEventStore);
        const planned = (await services.service.startForegroundRun({
          workspacePath,
          sessionId,
          prompt: "Read TASK.txt and plan the two independent branches.",
          execution: { requestedModel: "test/coder" },
        })) as { runId: string };
        const planningRun = await runtime.waitForRun(planned.runId);
        assert.equal(planningRun.status, "succeeded", planningRun.error);
        const projection = await readProjection();
        assert.ok(projection.pendingProposal);
        assert.equal(graphHost.store.listGraphs(sessionId).length, 0);
        const approved = (await services.desktopService.handle(
          createRuntimeRequest("plan.respond", {
            workspacePath,
            sessionId,
            planId: projection.pendingProposal.planId,
            action: "execute",
            expectedRevision: projection.pendingProposal.revision,
            expectedSessionSequence: projection.sessionSequence,
            controlEpoch: projection.controlEpoch!,
          }),
        )) as { accepted: boolean; run: { runId: string } };
        assert.equal(approved.accepted, true);
        const approvedRun = await runtime.waitForRun(approved.run.runId);
        assert.equal(approvedRun.status, "succeeded", approvedRun.error);
        const graph = graphHost.store.listGraphs(sessionId)[0];
        assert.ok(graph);
        await waitUntil(() => graphHost!.store.listActivationClaims(graph.graphId).length === 2);
        assert.equal(graphHost.store.listYieldInterests(graph.graphId).length, 1);
        assert.equal(
          (await readProjection()).execution?.status,
          "active",
          "a successful Graph yield is not a Plan interruption",
        );
        const yielded = await readProjection();
        assert.deepEqual((yielded.execution as { graph?: unknown } | undefined)?.graph, {
          graphId: graph.graphId,
          epoch: graph.epoch,
        });

        gates[0]!.resolve();
        await waitUntil(() => wakeRuns.length === 1);
        const firstWake = await runtime.waitForRun(wakeRuns[0]!);
        assert.equal(firstWake.status, "succeeded", firstWake.error);
        const partial = await readProjection();
        assert.equal(partial.execution?.status, "active");
        assert.deepEqual(
          partial.execution?.steps.map((step) => step.status),
          ["completed", "pending"],
        );
        await Promise.all([
          graphHost.application.supervisor.notifyGraph(graph.graphId),
          graphHost.application.supervisor.notifyGraph(graph.graphId),
        ]);
        assert.equal(wakeCount, 1, "duplicate reconciliation must not consume another wake");

        gates[1]!.resolve();
        await waitUntil(() => wakeRuns.length === 2);
        const finalWake = await runtime.waitForRun(wakeRuns[1]!);
        if (recoverAfterFinish) {
          assert.equal(finalWake.status, "failed");
          const interrupted = await readProjection();
          assert.equal(interrupted.execution?.status, "interrupted");
          session.updateRuntimeState({
            settings: {
              ...session.getRuntimeStateSnapshot().settings!,
              orchestrationMode: "default",
            },
          });
          await session.flushPersistence();
          const resumed = (await services.desktopService.handle(
            createRuntimeRequest("plan.respond", {
              workspacePath,
              sessionId,
              planId: interrupted.execution!.planId,
              action: "resume_execution",
              expectedRevision: interrupted.execution!.revision,
              expectedSessionSequence: interrupted.sessionSequence,
              controlEpoch: interrupted.controlEpoch!,
            }),
          )) as { accepted: boolean; run: { runId: string } };
          assert.equal(resumed.accepted, true);
          const resumedRun = await runtime.waitForRun(resumed.run.runId);
          assert.equal(resumedRun.status, "succeeded", resumedRun.error);
          assert.equal(graphHost.store.listGraphs(sessionId).length, 1);
        } else {
          assert.equal(finalWake.status, "succeeded", finalWake.error);
        }
        await Promise.all([
          graphHost.application.supervisor.notifyGraph(graph.graphId),
          graphHost.application.supervisor.notifyGraph(graph.graphId),
        ]);
        const finished = await readProjection();
        assert.equal(graphHost.store.getGraph(graph.graphId)?.phase, "finished");
        assert.equal(finished.execution?.status, "completed");
        assert.deepEqual(
          finished.execution.steps.map((step) => step.status),
          ["completed", "completed"],
        );
        assert.equal(wakeCount, 2);
        const events = await session.runtimeEventStore.readSession(sessionId);
        assert.equal(events.filter((event) => event.kind === "plan.proposed").length, 1);
        assert.equal(events.filter((event) => event.kind === "plan.execution.started").length, 1);
        assert.equal(events.filter((event) => event.kind === "plan.execution.completed").length, 1);
        assert.equal(
          events.filter((event) => event.kind === "plan.execution.interrupted").length,
          recoverAfterFinish ? 1 : 0,
        );
        assert.equal(events.filter((event) => event.kind === "plan.step.updated").length, 2);
        assert.equal(
          events.filter(
            (event) => event.kind === "tool.started" && event.data.toolName === "submit_plan",
          ).length,
          1,
        );
        const finishIndex = events.findIndex(
          (event) =>
            event.kind === "tool.result.recorded" && event.refs.toolCallId === "finish-graph",
        );
        const completionIndex = events.findIndex(
          (event) => event.kind === "plan.execution.completed",
        );
        assert.ok(
          finishIndex >= 0 && completionIndex > finishIndex,
          "Plan completion must happen after the Graph finish result",
        );
        let redundantPlanUpdates = 0;
        const unsubscribe = services.service.subscribe((event) => {
          if (event.topic === "plan.updated") redundantPlanUpdates++;
        });
        try {
          for (let read = 0; read < 3; read++) {
            const metadata = await services.desktopService.readSessionContinuityMetadata(
              workspacePath,
              sessionId,
            );
            assert.equal(metadata.activeRun, undefined);
          }
          assert.equal(
            redundantPlanUpdates,
            0,
            "opening a completed Plan must not notify the renderer to reopen it again",
          );
          assert.equal(graphHost.store.listGraphs(sessionId).length, 1);
          assert.equal(wakeCount, 2);
        } finally {
          unsubscribe();
        }
      } finally {
        gates.forEach((gate) => gate.resolve());
        await services.desktopService.close();
        const session = globalSessionManager.delete(sessionId, workspacePath, { picoHome });
        await session?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Plan Graph state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function assistant(content: string) {
  return { role: "assistant" as const, content };
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}
