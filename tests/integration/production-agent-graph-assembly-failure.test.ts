import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentOutputRecordIdFor, graphIdFor, wakeIdFor } from "../../src/agent-graph/core/ids.js";
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
import { writeDesktopModelRouting } from "../fixtures/desktop-model-routing.js";

const ROOT_WAKE_TOOLS = ["view_agent_graph", "update_agent_graph", "yield_agent_graph"] as const;

test("production root assembly failure settles one wake attempt into backoff without churn", async () => {
  const fixture = await createProductionFixture({
    rootModel: "missing/root-assembly-model",
    agentRuntime: new (class extends AgentRuntime {
      override async execute(): Promise<never> {
        throw new Error("AgentRuntime must not receive a root route assembly failure");
      }
    })(),
  });
  const graphId = `graph:${fixture.rootSessionId}`;
  const wakeId = "wake-root-assembly-failure";
  try {
    fixture.host.store.createGraph({ graphId, rootSessionId: fixture.rootSessionId, epoch: 1 });
    fixture.host.store.enqueueSupervisorWake({
      wakeId,
      graphId,
      dedupeKey: "fixture:root-assembly-failure",
      wakeFingerprint: "sha256:root-assembly-failure",
      cause: "runtime_terminal",
      payload: { fixture: true },
    });

    await fixture.host.application.supervisor.scanRecoverableWakes();
    await waitUntil(
      () => fixture.host.store.getSupervisorWake(wakeId)?.status === "retryable_failed",
    );
    const wake = fixture.host.store.getSupervisorWake(wakeId)!;
    const attempts = fixture.host.store.listSupervisorWakeAttempts(wakeId);
    assert.equal(wake.attemptCount, 1);
    assert.ok(wake.availableAt > wake.updatedAt, "failed root wake must enter delayed backoff");
    assert.equal(attempts.length, 1);
    assert.equal(attempts[0]?.status, "failed");

    const workspaceRun = await fixture.workspaceRuntime.waitForRun(attempts[0]!.targetRunId);
    assert.equal(workspaceRun.status, "failed");
    const events = await fixture.rootSession.runtimeEventStore!.readRun(
      fixture.rootSessionId,
      attempts[0]!.targetRunId,
    );
    assert.equal(events.filter((event) => event.kind === "run.started").length, 1);
    assert.equal(events.filter((event) => event.kind === "run.terminal").length, 1);
    assert.equal(
      events.some((event) => event.kind === "model.call.started"),
      false,
    );
    assert.equal(
      events.some((event) => event.kind === "tool.started"),
      false,
    );

    await delay(150);
    assert.equal(fixture.host.store.listSupervisorWakeAttempts(wakeId).length, 1);
    assert.equal(fixture.host.store.getSupervisorWake(wakeId)?.status, "retryable_failed");
  } finally {
    await fixture.close();
  }
});

test("foreground assembly failure seals only its empty epoch and allows linear mode", async () => {
  const fixture = await createProductionFixture({
    rootModel: "missing/foreground-assembly-model",
    agentRuntime: new (class extends AgentRuntime {
      override async execute(): Promise<never> {
        throw new Error("AgentRuntime must not receive a foreground route assembly failure");
      }
    })(),
  });
  const graphId = graphIdFor(fixture.rootSessionId, 1);
  try {
    const started = (await fixture.services.service.startForegroundRun({
      workspacePath: fixture.workspacePath,
      sessionId: fixture.rootSessionId,
      prompt: "fail during route assembly",
    })) as Record<string, unknown>;
    const failed = await fixture.workspaceRuntime.waitForRun(String(started["runId"]));
    assert.equal(failed.status, "failed");
    assert.equal(fixture.host.store.getGraph(graphId)?.phase, "finished");
    assert.equal(fixture.host.store.getGraph(graphId)?.headRevision, 1);

    await fixture.services.desktopService.handle(
      createRuntimeRequest("session.settings.update", {
        workspacePath: fixture.workspacePath,
        sessionId: fixture.rootSessionId,
        orchestrationMode: "default",
      }),
    );
  } finally {
    await fixture.close();
  }
});

test("production operator assembly failure becomes terminal and wakes the root without a live ghost", async () => {
  let operatorDispatches = 0;
  let rootWakeDispatches = 0;
  const fixture = await createProductionFixture({
    rootModel: "test/coder",
    agentRuntime: new (class extends AgentRuntime {
      override async execute(options: RunAgentCliOptions, dependencies: RunAgentCliDependencies) {
        const binding = dependencies.agentGraph;
        assert.ok(binding);
        if (binding.kind === "operator") {
          operatorDispatches++;
          throw new Error("operator route failure must happen before AgentRuntime dispatch");
        }
        rootWakeDispatches++;
        assert.deepEqual(options.allowedTools, ROOT_WAKE_TOOLS);
        let turn = 0;
        return super.execute(options, {
          ...dependencies,
          provider: {
            modelName: "deterministic/operator-failure-root-wake",
            generate: async () => {
              turn++;
              return turn === 1
                ? {
                    role: "assistant" as const,
                    content: "",
                    toolCalls: [
                      {
                        id: "finish-after-operator-failure",
                        name: "update_agent_graph",
                        arguments: JSON.stringify({
                          expected_revision: 1,
                          operation_id: "finish-after-operator-failure",
                          commands: [{ kind: "finish", selected_record_ids: [] }],
                        }),
                      },
                    ],
                  }
                : { role: "assistant" as const, content: "failure observed" };
            },
          },
          isolatedHeadless: true,
        });
      }
    })(),
  });
  const graphId = `graph:${fixture.rootSessionId}`;
  try {
    fixture.host.store.createGraph({ graphId, rootSessionId: fixture.rootSessionId, epoch: 1 });
    fixture.host.store.registerYieldInterest({
      permitId: "permit-operator-assembly-failure",
      graphId,
      rootSessionId: fixture.rootSessionId,
      rootTurnId: "root-turn-before-operator-failure",
      rootRunId: "root-run-before-operator-failure",
      toolCallId: "yield-before-operator-failure",
    });
    await fixture.host.application.toolPort.commitUpdate({
      graphId,
      epoch: 1,
      expectedRevision: 0,
      operationId: "add-operator-with-missing-route",
      rootModelRouteId: "missing/operator-assembly-model",
      source: {
        sessionId: fixture.rootSessionId,
        turnId: "root-turn-before-operator-failure",
        runId: "root-run-before-operator-failure",
        toolCallId: "update-before-operator-failure",
      },
      commands: [
        {
          kind: "add",
          operator: {
            graphId,
            operatorId: "broken-operator",
            generation: 1,
            role: "fixture",
            profileId: "explore",
            workspacePolicy: { kind: "shared" },
          },
          intent: {
            graphId,
            intentId: "intent-broken-operator",
            operatorId: "broken-operator",
            operatorGeneration: 1,
            instruction: "This must fail during production route assembly.",
            expectedOutputRecordId: agentOutputRecordIdFor(graphId, "intent-broken-operator"),
            inputRefs: [],
            createdAtRevision: 1,
            requestedBy: {
              sessionId: fixture.rootSessionId,
              turnId: "root-turn-before-operator-failure",
              runId: "root-run-before-operator-failure",
              toolCallId: "update-before-operator-failure",
            },
          },
        },
      ],
    });
    await fixture.host.application.supervisor.notifyGraph(graphId);
    await waitUntil(() => fixture.host.store.listActivationClaims(graphId).length === 1);
    const claim = fixture.host.store.listActivationClaims(graphId)[0]!;
    const workspaceRun = await fixture.workspaceRuntime.waitForRun(claim.targetRunId);
    assert.equal(workspaceRun.status, "failed");

    const events = await fixture.rootSession.runtimeEventStore!.readRun(
      claim.targetSessionId,
      claim.targetRunId,
    );
    const terminal = events.find((event) => event.kind === "run.terminal");
    assert.ok(terminal);
    const wakeId = wakeIdFor(graphId, `runtime-terminal:${claim.targetRunId}:${terminal.eventId}`);
    await waitUntil(() => fixture.host.store.getSupervisorWake(wakeId)?.status === "delivered");
    assert.equal(terminal.data.status, "failed");
    assert.equal(
      events.some((event) => event.kind === "model.call.started"),
      false,
    );
    assert.equal(
      events.some((event) => event.kind === "tool.started"),
      false,
    );
    const yieldSnapshot = await fixture.host.application.drivePort.readYieldSnapshot(graphId);
    assert.equal(yieldSnapshot.executing, 0, "terminal operator must not remain live/executing");
    assert.equal(operatorDispatches, 0);
    assert.equal(rootWakeDispatches, 1);

    const terminalVersion = workspaceRun.version;
    await delay(150);
    assert.equal(fixture.workspaceRuntime.getRun(claim.targetRunId)?.version, terminalVersion);
    assert.equal(operatorDispatches, 0, "terminal operator assembly failure must not redispatch");
  } finally {
    await fixture.close();
  }
});

async function createProductionFixture(input: {
  readonly rootModel: string;
  readonly agentRuntime: AgentRuntime;
}): Promise<{
  readonly host: AgentGraphWorkspaceHost;
  readonly workspaceRuntime: Awaited<
    ReturnType<ReturnType<typeof createProductionRuntimeServices>["service"]["getWorkspaceRuntime"]>
  >;
  readonly rootSessionId: string;
  readonly rootSession: Awaited<
    ReturnType<typeof globalSessionManager.getOrCreatePinned>
  >["session"];
  readonly workspacePath: string;
  readonly services: ReturnType<typeof createProductionRuntimeServices>;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "pico-production-graph-assembly-failure-"));
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
  const services = createProductionRuntimeServices({
    env,
    trustStore,
    agentRuntime: input.agentRuntime,
    agentGraphWorkspaceHostFactory: (options) => {
      host = createAgentGraphWorkspaceHost(options);
      return host;
    },
  });
  const workspaceRuntime = await services.service.getWorkspaceRuntime(canonicalWorkspace);
  assert.ok(host);
  const rootSessionId = `root-assembly-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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
      model: input.rootModel.split("/").at(-1)!,
      modelRouteId: input.rootModel,
      collaborationMode: "agent",
      permissionMode: "default",
      orchestrationMode: "graph",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    },
  });
  return {
    host,
    workspaceRuntime,
    rootSessionId,
    rootSession: rootLease.session,
    workspacePath: canonicalWorkspace,
    services,
    close: async () => {
      const sessionIds = new Set([
        rootSessionId,
        ...host!.store
          .listActivationClaims(`graph:${rootSessionId}`)
          .map((claim) => claim.targetSessionId),
      ]);
      rootLease.release();
      await services.desktopService.close();
      for (const sessionId of sessionIds) {
        const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
        await session?.close();
      }
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Graph assembly state");
    await delay(10);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
