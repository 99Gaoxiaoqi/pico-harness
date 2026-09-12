import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionRuntimeServices } from "../../../src/daemon/production-host.js";
import { createRuntimeRequest } from "../../../packages/protocol/src/index.js";
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

for (const stopViaBoard of [false, true])
  test(
    `production ${stopViaBoard ? "Graph board stop" : "Plan cancellation"} retires a yielded active Graph Plan and aborts both operators without waking root`,
    {
      timeout: 30_000,
    },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pico-production-plan-graph-cancel-"));
      const workspace = join(root, "workspace");
      const picoHome = join(root, "pico-home");
      await mkdir(workspace, { recursive: true });
      await mkdir(picoHome, { recursive: true });
      await writeDesktopModelRouting(picoHome);
      const workspacePath = await realpath(workspace);
      const sessionId = "production-plan-graph-cancel";
      const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
      const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
      await trustStore.trust(workspacePath);
      let graphHost: AgentGraphWorkspaceHost | undefined;
      const operatorGate = Promise.withResolvers<void>();
      const operatorsEntered = new Set<string>();
      const operatorsAborted = new Set<string>();
      let wakeStarts = 0;
      const fakeAgentRuntime = new (class extends AgentRuntime {
        override async execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
          if (options.prompt.startsWith("[Graph Supervisor wake]")) wakeStarts++;
          const binding = dependencies.agentGraph;
          let turn = 0;
          return super.execute(options, {
            ...dependencies,
            isolatedHeadless: true,
            provider: {
              modelName: "deterministic/plan-graph-cancel",
              generate: async () => {
                turn++;
                if (options.collaborationMode === "plan")
                  return toolCall("plan-submit", "submit_plan", {
                    title: "Investigate two independent branches",
                    steps: [
                      { id: "a", title: "Branch A", description: "Collect evidence A" },
                      { id: "b", title: "Branch B", description: "Collect evidence B" },
                    ],
                  });
                assert.ok(binding);
                if (binding.kind === "operator") {
                  const activation = binding.getActivationContext();
                  assert.ok(activation);
                  assert.ok(
                    dependencies.signal,
                    "production operator must receive a host cancellation signal",
                  );
                  operatorsEntered.add(activation.operatorId);
                  try {
                    await waitForGate(operatorGate.promise, dependencies.signal);
                  } catch (error) {
                    if (dependencies.signal.aborted) operatorsAborted.add(activation.operatorId);
                    throw error;
                  }
                  return { role: "assistant", content: "operator gate released during cleanup" };
                }
                if (turn === 1)
                  return toolCall("root-add", "update_agent_graph", {
                    operation: "add_work",
                    add_work: ["a", "b"].map((branch) => ({
                      profile_id: "explore",
                      workspace: { kind: "shared" },
                      instruction: `Collect branch ${branch} evidence. Wait for evidence.`,
                      input_ids: [],
                    })),
                  });
                assert.equal(turn, 2);
                return toolCall("root-yield", "yield_agent_graph", {});
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
      const readProjection = () =>
        fakeAgentRuntime.readPlanProjection({ sessionId, dir: workspacePath, picoHome });
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
            permissionMode: "ask",
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
          prompt: "Plan two independent investigations.",
          execution: { requestedModel: "test/coder" },
        })) as { runId: string };
        const planningRun = await runtime.waitForRun(planned.runId);
        assert.equal(planningRun.status, "succeeded", planningRun.error);
        const proposed = await readProjection();
        assert.ok(proposed.pendingProposal);
        const approved = (await services.desktopService.handle(
          createRuntimeRequest("plan.respond", {
            workspacePath,
            sessionId,
            planId: proposed.pendingProposal.planId,
            action: "execute",
            expectedRevision: proposed.pendingProposal.revision,
            expectedSessionSequence: proposed.sessionSequence,
            controlEpoch: proposed.controlEpoch!,
          }),
        )) as { accepted: boolean; run: { runId: string } };
        assert.equal(approved.accepted, true);
        const initial = await runtime.waitForRun(approved.run.runId);
        assert.equal(initial.status, "succeeded", initial.error);
        await waitUntil(() => operatorsEntered.size === 2);
        const active = await readProjection();
        assert.equal(active.execution?.status, "active");
        assert.ok(active.execution?.graph);
        const graphId = active.execution.graph.graphId;
        assert.equal(graphHost.store.listYieldInterests(graphId).length, 1);
        const claims = graphHost.store.listActivationClaims(graphId);
        assert.equal(claims.length, 2);
        assert.equal(wakeStarts, 0);

        if (stopViaBoard) {
          await assert.rejects(
            services.desktopService.handle(
              createRuntimeRequest("session.graph.stop", {
                workspacePath,
                sessionId,
                graphId: "unrelated-graph",
              }),
            ),
            /不属于当前任务/u,
          );
          assert.deepEqual(
            await services.desktopService.handle(
              createRuntimeRequest("session.graph.stop", {
                workspacePath,
                sessionId,
                graphId,
              }),
            ),
            { stopped: true },
          );
          assert.deepEqual(
            await services.desktopService.handle(
              createRuntimeRequest("session.graph.stop", {
                workspacePath,
                sessionId,
                graphId,
              }),
            ),
            { stopped: true },
          );
        } else {
          const cancellation = (await services.desktopService.handle(
            createRuntimeRequest("plan.respond", {
              workspacePath,
              sessionId,
              planId: active.execution.planId,
              action: "cancel_execution",
              expectedRevision: active.execution.revision,
              expectedSessionSequence: active.sessionSequence,
              controlEpoch: active.controlEpoch!,
            }),
          )) as { accepted: boolean };
          assert.equal(cancellation.accepted, true);
        }
        await waitUntil(() => operatorsAborted.size === 2);
        const terminals = await Promise.all(
          claims.map((claim) => runtime.waitForRun(claim.targetRunId)),
        );
        assert.ok(
          terminals.every((run) => run.status === "cancelled"),
          `both exact operator runs must be cancelled: ${terminals.map((run) => run.status).join(", ")}`,
        );
        assert.equal((await readProjection()).execution?.status, "cancelled");
        assert.equal(graphHost.store.getGraph(graphId)?.phase, "finished");
        assert.ok(
          runtime
            .listRuns()
            .every((run) => ["succeeded", "failed", "cancelled"].includes(run.status)),
        );
        const runIds = runtime
          .listRuns()
          .map((run) => run.runId)
          .sort();
        await Promise.all([
          graphHost.application.supervisor.notifyGraph(graphId),
          graphHost.application.supervisor.notifyGraph(graphId),
        ]);
        assert.equal(wakeStarts, 0, "operator cancellation must not wake a retired root");
        assert.deepEqual(
          runtime
            .listRuns()
            .map((run) => run.runId)
            .sort(),
          runIds,
        );
        assert.ok(
          graphHost.store
            .listSupervisorWakes(graphId)
            .every((wake) => graphHost!.store.listSupervisorWakeAttempts(wake.wakeId).length === 0),
        );
        const events = await session.runtimeEventStore.readSession(sessionId);
        assert.equal(events.filter((event) => event.kind === "plan.execution.started").length, 1);
        assert.equal(events.filter((event) => event.kind === "plan.execution.cancelled").length, 1);
        assert.equal(
          events.filter((event) => event.kind === "plan.execution.interrupted").length,
          0,
        );
        assert.equal(events.filter((event) => event.kind === "plan.execution.completed").length, 0);
        for (const claim of claims) {
          const operatorEvents = await session.runtimeEventStore.readRun(
            claim.targetSessionId,
            claim.targetRunId,
          );
          assert.equal(operatorEvents.filter((event) => event.kind === "run.terminal").length, 1);
          assert.equal(operatorEvents.filter((event) => event.kind === "agent.output").length, 0);
        }
      } finally {
        operatorGate.resolve();
        await services.desktopService.close();
        const session = globalSessionManager.delete(sessionId, workspacePath, { picoHome });
        await session?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

async function waitForGate(gate: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abort: (() => void) | undefined;
  try {
    await Promise.race([
      gate,
      new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason ?? new DOMException("cancelled", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline)
      throw new Error("Timed out waiting for Plan Graph cancellation state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}
