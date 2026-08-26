import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createProductionRuntimeServices } from "../../src/daemon/production-host.js";
import { globalSessionManager } from "../../src/engine/session.js";
import type { SessionManagerLease } from "../../src/engine/session-manager.js";
import type { AgentRuntime, RunAgentCliOptions } from "../../src/runtime/agent-runtime.js";
import type {
  AgentGraphWorkspaceHost,
  CreateAgentGraphWorkspaceHostOptions,
  ExecuteHostedAgentGraphRunInput,
} from "../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import type { RunAgentCliDependencies } from "../../src/runtime/agent-runtime.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { writeDesktopModelRouting } from "../fixtures/desktop-model-routing.js";

test("production host binds Graph root and installs detached exact execution", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-production-agent-graph-"));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  await writeDesktopModelRouting(picoHome);
  const canonicalWorkspace = await realpath(workspace);
  const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
  const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  await trustStore.trust(canonicalWorkspace);

  const calls: Array<{
    readonly options: RunAgentCliOptions;
    readonly host: RunAgentCliDependencies;
  }> = [];
  let releaseOperator!: () => void;
  const operatorGate = new Promise<void>((resolve) => {
    releaseOperator = resolve;
  });
  const fakeAgentRuntime = {
    execute: async (options: RunAgentCliOptions, host: RunAgentCliDependencies) => {
      calls.push({ options, host });
      if (host.agentGraph?.kind === "operator") await operatorGate;
      return {
        sessionId: options.session!,
        sessionSelection: { mode: "resume" as const, sessionId: options.session! },
        workDir: options.dir!,
        finalMessage: "done",
        usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
        messages: [],
      };
    },
  } as unknown as AgentRuntime;

  let graphFactoryOptions: CreateAgentGraphWorkspaceHostOptions | undefined;
  let graphStartCount = 0;
  let graphCloseCount = 0;
  const fakeGraphHostFactory = (
    options: CreateAgentGraphWorkspaceHostOptions,
  ): AgentGraphWorkspaceHost => {
    graphFactoryOptions = options;
    const application = {
      toolPort: {},
      drivePort: {},
      supervisor: {},
      start: async () => {
        graphStartCount++;
      },
      close: async () => undefined,
    };
    return {
      application,
      store: {},
      rootBinding: () => ({ kind: "root", getRootContext: () => undefined, toolPort: {} }),
      start: application.start,
      close: async () => {
        graphCloseCount++;
      },
    } as unknown as AgentGraphWorkspaceHost;
  };

  const services = createProductionRuntimeServices({
    env,
    trustStore,
    agentRuntime: fakeAgentRuntime,
    agentGraphWorkspaceHostFactory: fakeGraphHostFactory,
  });
  const sessionLeases: SessionManagerLease[] = [];
  context.after(async () => {
    releaseOperator();
    for (const lease of sessionLeases) lease.release();
    await services.desktopService.close();
    for (const sessionId of ["graph-root-session", "graph-operator-session"]) {
      const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
      await session?.close();
    }
    await rm(root, { recursive: true, force: true });
  });
  const runtime = await services.service.getWorkspaceRuntime(canonicalWorkspace);
  assert.equal(graphStartCount, 1);
  assert.ok(graphFactoryOptions);
  assert.equal(graphFactoryOptions.workDir, canonicalWorkspace);
  assert.equal(graphFactoryOptions.sessionManager, globalSessionManager);

  const rootLease = await globalSessionManager.getOrCreatePinned(
    "graph-root-session",
    canonicalWorkspace,
    {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    },
  );
  sessionLeases.push(rootLease);
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

  const foreground = asRecord(
    await services.service.startForegroundRun({
      workspacePath: canonicalWorkspace,
      sessionId: rootLease.session.id,
      prompt: "supervise graph",
    }),
  );
  const foregroundRunId = String(foreground["runId"]);
  assert.equal((await runtime.waitForRun(foregroundRunId)).status, "succeeded");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.options.orchestrationMode, "graph");
  assert.equal(calls[0]?.host.agentGraph?.kind, "root");

  const operatorLease = await globalSessionManager.getOrCreatePinned(
    "graph-operator-session",
    canonicalWorkspace,
    {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    },
  );
  sessionLeases.push(operatorLease);
  let terminalCount = 0;
  const exactInput: ExecuteHostedAgentGraphRunInput = {
    claimId: "claim-1",
    session: operatorLease.session,
    prompt: "perform graph work",
    prestartedRun: {
      runId: "graph-exact-run-1",
      turnId: "graph-exact-turn-1",
      invocationId: "graph-exact-invocation-1",
      runStartedEventId: "graph-exact-start-1",
      runStartedAt: new Date(0).toISOString(),
    },
    prestartedUserInput: { messageId: "graph-exact-input-1" },
    binding: {
      kind: "operator",
      getActivationContext: () => undefined,
      outputPort: {},
    } as ExecuteHostedAgentGraphRunInput["binding"],
    orchestrationMode: "default",
    requestedModel: "test/coder",
    allowedTools: ["read_file", "agent_output"],
    onTerminal: () => {
      terminalCount++;
    },
  };
  await graphFactoryOptions.execute(exactInput);
  await waitUntil(() => calls.length === 2);
  assert.equal(runtime.getRun(exactInput.prestartedRun.runId)?.status, "running");
  assert.equal(terminalCount, 0);
  assert.equal(calls[1]?.options.interactionMode, "default");
  assert.equal(calls[1]?.options.orchestrationMode, "default");
  assert.deepEqual(calls[1]?.options.allowedTools, ["read_file", "agent_output"]);
  assert.equal(calls[1]?.host.agentGraph?.kind, "operator");
  assert.equal(calls[1]?.host.prestartedRun, exactInput.prestartedRun);
  assert.equal(calls[1]?.host.prestartedUserInput, exactInput.prestartedUserInput);
  assert.ok(calls[1]?.host.runtimeState);
  assert.ok(calls[1]?.host.pluginSnapshot);
  assert.ok(calls[1]?.host.mcpConfigSources);

  releaseOperator();
  assert.equal((await runtime.waitForRun(exactInput.prestartedRun.runId)).status, "succeeded");
  assert.equal(terminalCount, 1);

  operatorLease.release();
  rootLease.release();
  await services.desktopService.close();
  assert.equal(graphCloseCount, 1);
  for (const sessionId of ["graph-root-session", "graph-operator-session"]) {
    const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
    await session?.close();
  }
  await rm(root, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for Graph execution");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}
