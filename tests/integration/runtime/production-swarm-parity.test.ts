import { SqliteSessionContinuitySource } from "../../../src/daemon/sqlite-session-continuity-source.js";
import type { SessionSubscriptionRegistry } from "../../../src/daemon/session-subscription-owner.js";
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProductionRuntimeServices } from "../../../src/daemon/production-host.js";
import { createRuntimeRequest } from "../../../packages/protocol/src/index.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import {
  AgentRuntime,
  type RunAgentCliOptions,
  type RunAgentCliDependencies,
} from "../../../src/runtime/agent-runtime.js";
import {
  createAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost,
} from "../../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { compileRuntimePermissionProfile } from "../../../src/safety/permission-profile.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

for (const planning of [false, true]) {
  test(
    planning
      ? "single-turn Swarm survives plan review restart without changing session defaults"
      : "Swarm keeps ordinary tools and completes small tasks without delegation or explicit Graph finish",
    { timeout: 30_000 },
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pico-swarm-parity-"));
      const workspace = join(root, "workspace");
      const picoHome = join(root, "home");
      await mkdir(workspace);
      await mkdir(picoHome);
      await writeFile(join(workspace, "TASK.txt"), "SWARM_DIRECT_READ_OK\n");
      await writeDesktopModelRouting(picoHome);
      const workspacePath = await realpath(workspace);
      const sessionId = "swarm-parity";
      const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
      const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
      await trustStore.trust(workspacePath);
      const firstDelta = Promise.withResolvers<void>();
      const pendingDelta = Promise.withResolvers<void>();
      const externalFlush = Promise.withResolvers<void>();
      const degraded: unknown[] = [];
      let graphHost: AgentGraphWorkspaceHost | undefined;
      const runtimeAgent = new (class extends AgentRuntime {
        override execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
          let step = 0;
          return super.execute(options, {
            ...dependencies,
            isolatedHeadless: true,
            provider: {
              modelName: "test/swarm-parity",
              generate: async (messages, tools) => {
                const names = tools?.map((tool) => tool.name) ?? [];
                if (options.collaborationMode === "plan") {
                  assert.equal(dependencies.agentGraph, undefined);
                  assert.equal(names.includes("update_agent_graph"), false);
                  return toolCall("submit", "submit_plan", {
                    title: "Swarm direct read",
                    steps: [
                      {
                        id: "read",
                        title: "Read fixture",
                        description:
                          "Read TASK.txt directly; delegation would add unnecessary overhead.",
                      },
                    ],
                  });
                }
                assert.ok(names.includes("read_file"));
                if (options.orchestrationMode === "swarm") {
                  for (const name of [
                    "agent_list",
                    "agent_swarm_status",
                    "agent_output",
                    "update_agent_graph",
                    "yield_agent_graph",
                  ])
                    assert.ok(names.includes(name), `Missing ${name}`);
                  assert.equal(names.includes("agent_graph_results"), false);
                  assert.equal(names.includes("view_agent_graph"), false);
                  assert.equal(options.agentSwarmAuthorization, "turn_override");
                }
                step++;
                if (
                  !planning &&
                  options.agentSwarmAuthorization === "turn_override" &&
                  step === 1
                ) {
                  dependencies.reporter?.onTextDelta?.("prefix ");
                  await firstDelta.promise;
                  dependencies.reporter?.onTextDelta?.("suffix");
                  await externalFlush.promise;
                }
                if (step === 1) return toolCall("read", "read_file", { path: "TASK.txt" });
                assert.ok(
                  messages.some(
                    (message) =>
                      message.toolCallId === "read" &&
                      message.content.includes("SWARM_DIRECT_READ_OK"),
                  ),
                );
                if (planning && options.approvedPlan) {
                  if (step === 2)
                    return toolCall("finish", "update_agent_graph", {
                      operation: "finish",
                      finish: { result_ids: [], reason: "Small task completed directly" },
                    });
                  if (step === 3)
                    return toolCall("complete", "update_plan", {
                      stepId: "read",
                      status: "completed",
                    });
                }
                return { role: "assistant" as const, content: "SWARM_DIRECT_READ_OK" };
              },
            },
          });
        }
      })();
      const makeServices = () =>
        createProductionRuntimeServices({
          env,
          trustStore,
          agentRuntime: runtimeAgent,
          agentGraphWorkspaceHostFactory: (options) =>
            (graphHost = createAgentGraphWorkspaceHost(options)),
        });
      let services = makeServices();
      if (!planning)
        services.attachSessionSubscriptions({
          publishSessionDelta(delta: { text: string }) {
            if (delta.text === "prefix ") firstDelta.resolve();
            if (delta.text === "suffix") pendingDelta.resolve();
          },
          publishContinuityDegraded(...args: unknown[]) {
            degraded.push(args);
          },
          publishReporterEvent() {},
          publishTranscriptAdvanced() {},
        } as unknown as SessionSubscriptionRegistry);
      try {
        let runtime = await services.service.getWorkspaceRuntime(workspacePath);
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
            collaborationMode: planning ? "plan" : "agent",
            permissionMode: "ask",
            orchestrationMode: "default",
            thinkingEffort: "off",
            thinkingEffortExplicit: false,
            additionalDirectories: [],
          },
          boundary: compileRuntimePermissionProfile({
            collaborationMode: "agent",
            permissionMode: "ask",
          }),
        });
        await session.flushPersistence();
        lease.release();
        const request = (await services.service.startForegroundRun({
          workspacePath,
          sessionId,
          prompt: "Read TASK.txt directly; keep this small task on the main agent.",
          execution: { orchestrationMode: "swarm" },
        })) as { runId: string };
        if (!planning) {
          await pendingDelta.promise;
          try {
            // This call is outside the provider Run, exactly like subscription.open.
            await services.flushSessionOverlay(workspacePath, sessionId);
            assert.deepEqual(
              degraded,
              [],
              "subscription flush must retain the original Run authority",
            );
            const continuity = new SqliteSessionContinuitySource({
              picoHome,
              readMetadata: async () => ({
                session: {
                  sessionId,
                  workspacePath,
                  title: "Swarm",
                  status: "active",
                  pinned: false,
                  createdAt: 1,
                  updatedAt: 1,
                },
                activeRun: {
                  runId: request.runId,
                  sessionId,
                  workspacePath,
                  description: "Swarm",
                  status: "running",
                  startedAt: 1,
                  updatedAt: 1,
                  version: 1,
                },
                queuedInputs: [],
              }),
            });
            const snapshot = await continuity.readOpenSnapshot({ workspacePath, sessionId });
            assert.ok(snapshot.activeOverlay.some(({ text }) => text === "prefix suffix"));
          } finally {
            externalFlush.resolve();
          }
        }
        const result = await runtime.waitForRun(request.runId);
        assert.equal(result.status, "succeeded", result.error);
        if (planning) {
          await services.desktopService.close();
          services = makeServices();
          runtime = await services.service.getWorkspaceRuntime(workspacePath);
          const projection = await runtimeAgent.readPlanProjection({
            sessionId,
            dir: workspacePath,
            picoHome,
          });
          const plan = projection.pendingProposal!;
          assert.ok(plan);
          const approved = (await services.desktopService.handle(
            createRuntimeRequest("plan.respond", {
              workspacePath,
              sessionId,
              planId: plan.planId,
              action: "execute",
              expectedRevision: plan.revision,
              expectedSessionSequence: projection.sessionSequence,
              controlEpoch: projection.controlEpoch!,
            }),
          )) as { run: { runId: string } };
          const executed = await runtime.waitForRun(approved.run.runId);
          assert.equal(executed.status, "succeeded", executed.error);
          assert.equal(
            (await runtimeAgent.readPlanProjection({ sessionId, dir: workspacePath, picoHome }))
              .execution?.status,
            "completed",
          );
        }
        const hydrated = await session.readHydrationSnapshot();
        assert.equal(hydrated.runtime.settings?.orchestrationMode, "default");
        const allGraphs = graphHost!.store.listGraphs(sessionId);
        assert.equal(allGraphs.length, 1);
        assert.equal(allGraphs[0]!.phase, "finished");
        assert.equal(graphHost!.store.listActivationClaims(allGraphs[0]!.graphId).length, 0);
        const events = await session.runtimeEventStore!.readSession(sessionId);
        const starts = events.filter((event) => event.kind === "run.started");
        assert.ok(starts.length);
        assert.ok(starts.every((event) => event.data.agentSwarmAuthorization === "turn_override"));
        if (!planning) {
          const ordinary = (await services.service.startForegroundRun({
            workspacePath,
            sessionId,
            prompt: "Read TASK.txt once more.",
          })) as { runId: string };
          const after = await runtime.waitForRun(ordinary.runId);
          assert.equal(after.status, "succeeded", after.error);
          const ordinaryEvents = await session.runtimeEventStore!.readSession(sessionId);
          assert.equal(
            ordinaryEvents.filter((event) => event.kind === "run.started").at(-1)?.data
              .agentSwarmAuthorization,
            "none",
          );
        }
      } finally {
        await services.desktopService.close();
        await globalSessionManager.delete(sessionId, workspacePath, { picoHome })?.close();
        await rm(root, { recursive: true, force: true });
      }
    },
  );
}
function toolCall(id: string, name: string, args: Record<string, unknown>) {
  return {
    role: "assistant" as const,
    content: "",
    toolCalls: [{ id, name, arguments: JSON.stringify(args) }],
  };
}
