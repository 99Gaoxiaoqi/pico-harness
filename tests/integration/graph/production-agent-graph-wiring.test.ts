import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { graphIdFor } from "../../../src/agent-graph/core/ids.js";
import { createRuntimeRequest } from "../../../packages/protocol/src/index.js";
import { createBuiltinAgentGraphOperatorProfileCatalog } from "../../../src/agent-graph/operator-profile-catalog.js";
import { createProductionRuntimeServices } from "../../../src/daemon/production-host.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import type { SessionManagerLease } from "../../../src/engine/session-manager.js";
import type { AgentRuntime, RunAgentCliOptions } from "../../../src/runtime/agent-runtime.js";
import type {
  AgentGraphWorkspaceHost,
  CreateAgentGraphWorkspaceHostOptions,
  ExecuteHostedAgentGraphRunInput,
} from "../../../src/runtime/agent-graph-host.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import type { RunAgentCliDependencies } from "../../../src/runtime/agent-runtime.js";
import { PluginRuntimeSnapshotRegistry } from "../../../src/plugins/plugin-runtime-snapshot-registry.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import {
  compileRuntimePermissionProfile,
  createBypassExecutionBoundary,
  createManagedExecutionBoundary,
} from "../../../src/safety/permission-profile.js";
import { createAskUserRequestId } from "../../../src/tools/ask-user.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

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
  const brokerPending = deferred<{
    readonly approvalId: string;
    readonly promptId: string;
  }>();
  let brokerApproval: { readonly allowed: boolean; readonly allowForSession?: boolean } | undefined;
  let networkBoundaryApproval: { readonly allowed: boolean; readonly reason: string } | undefined;
  let writeBoundaryApproval: { readonly allowed: boolean; readonly reason: string } | undefined;
  let fullAccessBoundaryApproval:
    | { readonly allowed: boolean; readonly reason: string }
    | undefined;
  let brokerAnswer: { readonly kind: string; readonly optionId?: string } | undefined;
  let reattachAttempts = 0;
  let rootEpochAdmitted = false;
  const fakeAgentRuntime = {
    execute: async (options: RunAgentCliOptions, host: RunAgentCliDependencies) => {
      if (options.prompt === "supervise graph") {
        assert.equal(
          rootEpochAdmitted,
          true,
          "Graph epoch must exist before AgentRuntime dispatch",
        );
      }
      calls.push({ options, host });
      if (options.prompt === "retry graph work" && ++reattachAttempts === 1) {
        throw new Error("attach failed before AgentRuntime completed");
      }
      if (options.prompt === "exercise broker boundaries") {
        assert.equal(options.collaborationMode, "agent");
        assert.equal(options.permissionMode, "ask");
        assert.ok(host.approvalManager);
        assert.ok(host.approvalNotifier);
        assert.ok(host.askUserHandler);
        const approvalId = "graph-approval-1";
        const promptId = createAskUserRequestId();
        const approval = host.approvalManager.waitForApproval(
          approvalId,
          "bash",
          '{"command":"sensitive"}',
          host.approvalNotifier,
          undefined,
          host.signal,
          {
            providerCallId: "provider-call-approval-1",
            sessionScope: { type: "bash-command", command: "sensitive", match: "exact" },
          },
        );
        const answer = host.askUserHandler.waitForAnswer(
          {
            requestId: promptId,
            question: "Choose a bounded action",
            options: [
              { optionId: "safe", label: "Safe" },
              { optionId: "stop", label: "Stop" },
            ],
          },
          host.signal,
        );
        brokerPending.resolve({ approvalId, promptId });
        [brokerApproval, brokerAnswer] = await Promise.all([approval, answer]);
      }
      if (options.prompt === "reject operator network approval") {
        networkBoundaryApproval = await host.approvalManager!.waitForApproval(
          "graph-network-approval",
          "web_search",
          '{"query":"must stay offline"}',
          host.approvalNotifier!,
          undefined,
          host.signal,
          {
            providerCallId: "provider-call-network-boundary",
            sessionScope: { type: "tool", toolName: "web_search" },
          },
        );
      }
      if (options.prompt === "reject operator write approval") {
        writeBoundaryApproval = await host.approvalManager!.waitForApproval(
          "graph-write-approval",
          "write_file",
          '{"path":"blocked.txt","content":"blocked"}',
          host.approvalNotifier!,
          undefined,
          host.signal,
          {
            providerCallId: "provider-call-write-boundary",
            sessionScope: { type: "all-edits" },
          },
        );
      }
      if (options.prompt === "inherit operator full access") {
        assert.equal(options.collaborationMode, "agent");
        assert.equal(options.permissionMode, "full-access");
        assert.equal(
          (host.agentGraph as { readonly executionPermissionMode?: string } | undefined)
            ?.executionPermissionMode,
          "full-access",
        );
        fullAccessBoundaryApproval = await host.approvalManager!.waitForApproval(
          "graph-full-access-approval",
          "write_file",
          '{"path":"full-access.txt","content":"allowed"}',
          host.approvalNotifier!,
          undefined,
          host.signal,
          {
            providerCallId: "provider-call-full-access-boundary",
            sessionScope: { type: "all-edits" },
          },
        );
      }
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
      graphSupervision: () => undefined,
      start: async () => {
        graphStartCount++;
      },
      close: async () => undefined,
    };
    return {
      application,
      store: {},
      openRootEpoch: (rootSessionId: string) => {
        rootEpochAdmitted = true;
        return {
          graphId: graphIdFor(rootSessionId, 1),
          rootSessionId,
          epoch: 1,
          admissionPhase: "open",
          headRevision: 0,
          selectedRecordIds: [],
          createdAt: 1,
        };
      },
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
      permissionMode: "ask",
      orchestrationMode: "graph",
      thinkingEffort: "medium",
      thinkingEffortExplicit: false,
      additionalDirectories: [],
    },
    boundary: compileRuntimePermissionProfile({
      collaborationMode: "agent",
      permissionMode: "ask",
    }),
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
  assert.deepEqual(calls[0]?.options.allowedTools, [
    "view_agent_graph",
    "update_agent_graph",
    "yield_agent_graph",
  ]);
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
  const operatorProfile = createBuiltinAgentGraphOperatorProfileCatalog().resolve({
    profileId: "implement",
    rootModelRouteId: "test/coder",
  });
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
      rootSessionId: rootLease.session.id,
      workspacePolicy: { kind: "shared" },
      executionPermissionMode: "ask",
      getActivationContext: () => undefined,
      outputPort: {} as never,
      profileSnapshot: operatorProfile,
    },
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
  assert.equal(calls[1]?.options.collaborationMode, "agent");
  assert.equal(calls[1]?.options.permissionMode, "ask");
  assert.equal(calls[1]?.options.orchestrationMode, "default");
  assert.deepEqual(calls[1]?.options.allowedTools, [...operatorProfile.tools, "agent_output"]);
  assert.equal(calls[1]?.host.agentGraph?.kind, "operator");
  assert.equal(calls[1]?.host.prestartedRun, exactInput.prestartedRun);
  assert.equal(calls[1]?.host.prestartedUserInput, exactInput.prestartedUserInput);
  assert.ok(calls[1]?.host.runtimeState);
  assert.equal(calls[1]?.host.isolatedHeadless, true);
  assert.equal(calls[1]?.host.pluginSnapshot, undefined);
  assert.equal(calls[1]?.host.mcpConfigSources, undefined);
  assert.equal(calls[1]?.host.browserAgent, undefined);
  assert.deepEqual(
    operatorLease.session.getRuntimeStateSnapshot().boundary,
    rootLease.session.getRuntimeStateSnapshot().boundary,
  );

  releaseOperator();
  assert.equal((await runtime.waitForRun(exactInput.prestartedRun.runId)).status, "succeeded");
  assert.equal(terminalCount, 1);

  const parentBoundary = rootLease.session.getRuntimeStateSnapshot().boundary;
  assert.ok(parentBoundary?.kind === "managed");
  const outsidePath = "/graph-boundary-outside-parent";
  let rejectedBoundaryIndex = 0;
  const assertRejectedBoundary = async (
    label: string,
    childBoundary: Parameters<typeof operatorLease.session.updateRuntimeState>[0]["boundary"],
    expected: RegExp,
  ) => {
    rejectedBoundaryIndex++;
    operatorLease.session.updateRuntimeState({ boundary: childBoundary! });
    await operatorLease.session.flushPersistence();
    const callsBefore = calls.length;
    const runId = `graph-exact-boundary-rejected-${rejectedBoundaryIndex}`;
    await graphFactoryOptions!.execute({
      ...exactInput,
      claimId: `claim-boundary-rejected-${rejectedBoundaryIndex}`,
      prompt: `reject ${label} boundary`,
      prestartedRun: {
        runId,
        turnId: `${runId}-turn`,
        invocationId: `${runId}-invocation`,
        runStartedEventId: `${runId}-start`,
        runStartedAt: new Date(10 + rejectedBoundaryIndex).toISOString(),
      },
      prestartedUserInput: { messageId: `${runId}-input` },
    });
    const failed = await runtime.waitForRun(runId);
    assert.equal(failed.status, "failed");
    assert.match(failed.error ?? "", expected);
    assert.equal(calls.length, callsBefore, `${label} boundary must fail before AgentRuntime`);
  };

  await assertRejectedBoundary(
    "network",
    createManagedExecutionBoundary(
      { ...parentBoundary.profile, network: { kind: "enabled" } },
      parentBoundary.revision + 1,
    ),
    /exceeds its parent boundary/u,
  );
  await assertRejectedBoundary(
    "additional path",
    createManagedExecutionBoundary(
      {
        ...parentBoundary.profile,
        name: "custom",
        fileSystem: {
          ...parentBoundary.profile.fileSystem,
          entries: [
            ...parentBoundary.profile.fileSystem.entries,
            { kind: "path", access: "write", path: outsidePath, match: "subtree" },
          ],
        },
      },
      parentBoundary.revision + 1,
    ),
    /exceeds its parent boundary/u,
  );
  await assertRejectedBoundary(
    "bypass",
    createBypassExecutionBoundary(parentBoundary.revision + 1),
    /cannot run with a bypass execution boundary/u,
  );

  const denyBoundary = createManagedExecutionBoundary(
    {
      ...parentBoundary.profile,
      name: "custom",
      fileSystem: {
        ...parentBoundary.profile.fileSystem,
        entries: [
          ...parentBoundary.profile.fileSystem.entries,
          { kind: "path", access: "deny", path: outsidePath, match: "subtree" },
        ],
      },
    },
    parentBoundary.revision + 1,
  );
  rootLease.session.updateRuntimeState({ boundary: denyBoundary });
  await rootLease.session.flushPersistence();
  await assertRejectedBoundary(
    "missing custom deny",
    parentBoundary,
    /exceeds its parent boundary/u,
  );
  rootLease.session.updateRuntimeState({ boundary: parentBoundary });
  operatorLease.session.updateRuntimeState({ boundary: parentBoundary });
  await Promise.all([
    rootLease.session.flushPersistence(),
    operatorLease.session.flushPersistence(),
  ]);

  const callsBeforeNetworkApproval = calls.length;
  const networkApprovalRunId = "graph-exact-network-approval";
  await graphFactoryOptions.execute({
    ...exactInput,
    claimId: "claim-network-approval",
    prompt: "reject operator network approval",
    prestartedRun: {
      runId: networkApprovalRunId,
      turnId: `${networkApprovalRunId}-turn`,
      invocationId: `${networkApprovalRunId}-invocation`,
      runStartedEventId: `${networkApprovalRunId}-start`,
      runStartedAt: new Date(20).toISOString(),
    },
    prestartedUserInput: { messageId: `${networkApprovalRunId}-input` },
  });
  assert.equal((await runtime.waitForRun(networkApprovalRunId)).status, "succeeded");
  assert.equal(calls.length, callsBeforeNetworkApproval + 1);
  assert.deepEqual(networkBoundaryApproval, {
    allowed: false,
    reason: "Graph Operator 请求超出父 Session execution boundary，已安全拒绝。",
  });

  const readOnlyBoundary = compileRuntimePermissionProfile({
    collaborationMode: "plan",
    permissionMode: "ask",
    revision: parentBoundary.revision + 1,
  });
  rootLease.session.updateRuntimeState({ boundary: readOnlyBoundary });
  operatorLease.session.updateRuntimeState({ boundary: readOnlyBoundary });
  await Promise.all([
    rootLease.session.flushPersistence(),
    operatorLease.session.flushPersistence(),
  ]);
  const writeApprovalRunId = "graph-exact-write-approval";
  await graphFactoryOptions.execute({
    ...exactInput,
    claimId: "claim-write-approval",
    prompt: "reject operator write approval",
    prestartedRun: {
      runId: writeApprovalRunId,
      turnId: `${writeApprovalRunId}-turn`,
      invocationId: `${writeApprovalRunId}-invocation`,
      runStartedEventId: `${writeApprovalRunId}-start`,
      runStartedAt: new Date(20).toISOString(),
    },
    prestartedUserInput: { messageId: `${writeApprovalRunId}-input` },
  });
  assert.equal((await runtime.waitForRun(writeApprovalRunId)).status, "succeeded");
  assert.deepEqual(writeBoundaryApproval, {
    allowed: false,
    reason: "Graph Operator 请求超出父 Session execution boundary，已安全拒绝。",
  });
  rootLease.session.updateRuntimeState({ boundary: parentBoundary });
  operatorLease.session.updateRuntimeState({ boundary: parentBoundary });
  await Promise.all([
    rootLease.session.flushPersistence(),
    operatorLease.session.flushPersistence(),
  ]);

  const isolatedWorkspace = join(root, "isolated-operator-workdir");
  await mkdir(isolatedWorkspace, { recursive: true });
  const isolatedLease = await globalSessionManager.getOrCreatePinned(
    "graph-isolated-operator-session",
    isolatedWorkspace,
    {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    },
  );
  sessionLeases.push(isolatedLease);
  const callsBeforeIsolated = calls.length;
  const isolatedRunId = "graph-exact-isolated-boundary";
  await graphFactoryOptions.execute({
    ...exactInput,
    claimId: "claim-isolated-boundary",
    session: isolatedLease.session,
    prompt: "reject different operator workDir",
    prestartedRun: {
      runId: isolatedRunId,
      turnId: `${isolatedRunId}-turn`,
      invocationId: `${isolatedRunId}-invocation`,
      runStartedEventId: `${isolatedRunId}-start`,
      runStartedAt: new Date(21).toISOString(),
    },
    prestartedUserInput: { messageId: `${isolatedRunId}-input` },
  });
  const isolatedFailure = await runtime.waitForRun(isolatedRunId);
  assert.equal(isolatedFailure.status, "failed");
  assert.match(isolatedFailure.error ?? "", /workDir differs.*cannot be proven/u);
  assert.equal(calls.length, callsBeforeIsolated);

  const bypassBoundary = createBypassExecutionBoundary(parentBoundary.revision + 1);
  rootLease.session.updateRuntimeState({ boundary: bypassBoundary });
  await rootLease.session.flushPersistence();
  const fullAccessRunId = "graph-exact-full-access-boundary";
  await graphFactoryOptions.execute({
    ...exactInput,
    claimId: "claim-full-access-boundary",
    prompt: "inherit operator full access",
    prestartedRun: {
      runId: fullAccessRunId,
      turnId: `${fullAccessRunId}-turn`,
      invocationId: `${fullAccessRunId}-invocation`,
      runStartedEventId: `${fullAccessRunId}-start`,
      runStartedAt: new Date(22).toISOString(),
    },
    prestartedUserInput: { messageId: `${fullAccessRunId}-input` },
  });
  assert.equal((await runtime.waitForRun(fullAccessRunId)).status, "succeeded");
  assert.equal(operatorLease.session.getRuntimeStateSnapshot().boundary?.kind, "bypass");
  assert.deepEqual(fullAccessBoundaryApproval, {
    allowed: true,
    reason: "Graph Operator inherited full-access from its parent Session.",
  });
  rootLease.session.updateRuntimeState({ boundary: parentBoundary });
  operatorLease.session.updateRuntimeState({ boundary: parentBoundary });
  await Promise.all([
    rootLease.session.flushPersistence(),
    operatorLease.session.flushPersistence(),
  ]);

  let retryTerminalCount = 0;
  const retryInput: ExecuteHostedAgentGraphRunInput = {
    ...exactInput,
    claimId: "claim-retry",
    prompt: "retry graph work",
    prestartedRun: {
      runId: "graph-exact-run-retry",
      turnId: "graph-exact-turn-retry",
      invocationId: "graph-exact-invocation-retry",
      runStartedEventId: "graph-exact-start-retry",
      runStartedAt: new Date(1).toISOString(),
    },
    prestartedUserInput: { messageId: "graph-exact-input-retry" },
    onTerminal: () => {
      retryTerminalCount++;
    },
  };
  await graphFactoryOptions.execute(retryInput);
  const failedRetry = await runtime.waitForRun(retryInput.prestartedRun.runId);
  assert.equal(failedRetry.status, "failed");
  assert.equal(reattachAttempts, 1);
  assert.equal(retryTerminalCount, 1);

  await graphFactoryOptions.execute(retryInput);
  const succeededRetry = await runtime.waitForRun(retryInput.prestartedRun.runId);
  assert.equal(succeededRetry.status, "succeeded");
  assert.equal(succeededRetry.version, failedRetry.version + 2);
  assert.equal(reattachAttempts, 2);
  assert.equal(retryTerminalCount, 2);

  let brokerTerminalCount = 0;
  const brokerInput: ExecuteHostedAgentGraphRunInput = {
    ...exactInput,
    claimId: "claim-broker",
    prompt: "exercise broker boundaries",
    prestartedRun: {
      runId: "graph-exact-run-broker",
      turnId: "graph-exact-turn-broker",
      invocationId: "graph-exact-invocation-broker",
      runStartedEventId: "graph-exact-start-broker",
      runStartedAt: new Date(2).toISOString(),
    },
    prestartedUserInput: { messageId: "graph-exact-input-broker" },
    onTerminal: () => {
      brokerTerminalCount++;
    },
  };
  const callsBeforeBroker = calls.length;
  await graphFactoryOptions.execute(brokerInput);
  const pending = await brokerPending.promise;
  await assert.rejects(
    services.desktopService.handle(
      createRuntimeRequest("approval.respond", {
        workspacePath: canonicalWorkspace,
        approvalId: pending.approvalId,
        runId: brokerInput.prestartedRun.runId,
        sessionId: "another-session",
        decision: "allow_session",
      }),
    ),
    /不存在或已过期/u,
  );
  await assert.rejects(
    services.desktopService.handle(
      createRuntimeRequest("prompt.respond", {
        workspacePath: canonicalWorkspace,
        promptId: pending.promptId,
        runId: "another-run",
        sessionId: operatorLease.session.id,
        answer: "safe",
      }),
    ),
    /不存在或已过期/u,
  );
  assert.deepEqual(
    await services.desktopService.handle(
      createRuntimeRequest("approval.respond", {
        workspacePath: canonicalWorkspace,
        approvalId: pending.approvalId,
        runId: brokerInput.prestartedRun.runId,
        sessionId: operatorLease.session.id,
        decision: "allow_once",
      }),
    ),
    { accepted: true, alreadyResolved: false },
  );
  assert.deepEqual(
    await services.desktopService.handle(
      createRuntimeRequest("prompt.respond", {
        workspacePath: canonicalWorkspace,
        promptId: pending.promptId,
        runId: brokerInput.prestartedRun.runId,
        sessionId: operatorLease.session.id,
        answer: "safe",
      }),
    ),
    { accepted: true, alreadyResolved: false },
  );
  assert.equal((await runtime.waitForRun(brokerInput.prestartedRun.runId)).status, "succeeded");
  assert.deepEqual(brokerApproval, { allowed: true, reason: "用户在桌面端批准了本次操作。" });
  assert.deepEqual(brokerAnswer, {
    kind: "selected",
    requestId: pending.promptId,
    optionId: "safe",
    label: "Safe",
  });
  assert.equal(brokerTerminalCount, 1);
  assert.equal(calls.length, callsBeforeBroker + 1);
  await graphFactoryOptions.execute(brokerInput);
  await Promise.resolve();
  assert.equal(calls.length, callsBeforeBroker + 1, "successful exact replay must not redispatch");
  assert.equal(
    brokerTerminalCount,
    2,
    "a host-success replay without a canonical Runtime terminal must clear its launch",
  );

  let modelFailureTerminalCount = 0;
  const modelFailureInput: ExecuteHostedAgentGraphRunInput = {
    ...exactInput,
    claimId: "root-wake:model-failure",
    session: rootLease.session,
    prompt: "model assembly must fail closed",
    prestartedRun: {
      runId: "graph-exact-run-model-failure",
      turnId: "graph-exact-turn-model-failure",
      invocationId: "graph-exact-invocation-model-failure",
      runStartedEventId: "graph-exact-start-model-failure",
      runStartedAt: new Date(3).toISOString(),
    },
    prestartedUserInput: { messageId: "graph-exact-input-model-failure" },
    binding: {
      kind: "root",
      getRootContext: () => undefined,
      toolPort: {},
    } as ExecuteHostedAgentGraphRunInput["binding"],
    orchestrationMode: "graph",
    requestedModel: "missing/model",
    allowedTools: undefined,
    onTerminal: () => {
      modelFailureTerminalCount++;
    },
  };
  const callsBeforeModelFailure = calls.length;
  await graphFactoryOptions.execute(modelFailureInput);
  const modelFailure = await runtime.waitForRun(modelFailureInput.prestartedRun.runId);
  assert.equal(modelFailure.status, "failed");
  assert.match(modelFailure.error ?? "", /missing\/model|model route|模型路由/u);
  assert.equal(modelFailureTerminalCount, 1);
  assert.equal(calls.length, callsBeforeModelFailure);
  await graphFactoryOptions.execute(modelFailureInput);
  const modelFailureReplay = await runtime.waitForRun(modelFailureInput.prestartedRun.runId);
  assert.equal(modelFailureReplay.status, "failed");
  assert.equal(modelFailureReplay.version, modelFailure.version + 2);
  assert.equal(modelFailureTerminalCount, 2);
  assert.equal(
    calls.length,
    callsBeforeModelFailure,
    "assembly failure must not dispatch AgentRuntime",
  );

  operatorLease.release();
  isolatedLease.release();
  rootLease.release();
  await services.desktopService.close();
  const isolatedSession = globalSessionManager.delete(isolatedLease.session.id, isolatedWorkspace, {
    picoHome,
  });
  await isolatedSession?.close();
  assert.equal(graphCloseCount, 1);
  for (const sessionId of ["graph-root-session", "graph-operator-session"]) {
    const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
    await session?.close();
  }
  await rm(root, { recursive: true, force: true });
});

for (const scenario of [
  { kind: "plugin", error: /plugin snapshot load failed/u },
  { kind: "mcp", error: /Unexpected token|JSON/u },
] as const) {
  test(`production Graph ${scenario.kind} assembly failure stays terminal and fail-closed`, async () => {
    const root = await mkdtemp(join(tmpdir(), `pico-production-graph-${scenario.kind}-failure-`));
    const workspace = join(root, "workspace");
    const picoHome = join(root, "pico-home");
    await mkdir(workspace, { recursive: true });
    await mkdir(picoHome, { recursive: true });
    await writeDesktopModelRouting(picoHome);
    if (scenario.kind === "mcp") {
      await mkdir(join(workspace, ".pico"), { recursive: true });
      await writeFile(join(workspace, ".pico", "mcp.json"), "{ invalid-json", "utf8");
    }
    const canonicalWorkspace = await realpath(workspace);
    const env = { PICO_HOME: picoHome, PICO_TEST_TOKEN: "test-token" };
    const trustStore = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trustStore.trust(canonicalWorkspace);
    const pluginRuntimeSnapshotRegistry =
      scenario.kind === "plugin"
        ? new PluginRuntimeSnapshotRegistry({
            loadSnapshot: async () => {
              throw new Error("plugin snapshot load failed");
            },
          })
        : undefined;
    let dispatchCount = 0;
    const fakeAgentRuntime = {
      execute: async () => {
        dispatchCount++;
        throw new Error("AgentRuntime must not receive a failed assembly");
      },
    } as unknown as AgentRuntime;
    let graphExecute: CreateAgentGraphWorkspaceHostOptions["execute"] | undefined;
    const services = createProductionRuntimeServices({
      env,
      trustStore,
      agentRuntime: fakeAgentRuntime,
      ...(pluginRuntimeSnapshotRegistry
        ? { pluginRuntimeSnapshotRegistry, ownsPluginRuntimeSnapshotRegistry: true }
        : {}),
      agentGraphWorkspaceHostFactory: (options) => {
        graphExecute = options.execute;
        const application = {
          toolPort: {},
          drivePort: {},
          supervisor: {},
          start: async () => undefined,
          close: async () => undefined,
        };
        return {
          application,
          store: {},
          openRootEpoch: (rootSessionId: string) => ({
            graphId: graphIdFor(rootSessionId, 1),
            rootSessionId,
            epoch: 1,
            admissionPhase: "open",
            headRevision: 0,
            selectedRecordIds: [],
            createdAt: 1,
          }),
          rootBinding: () => ({ kind: "root", getRootContext: () => undefined, toolPort: {} }),
          start: application.start,
          close: application.close,
        } as unknown as AgentGraphWorkspaceHost;
      },
    });
    const sessionId = `graph-${scenario.kind}-failure-session`;
    let lease: SessionManagerLease | undefined;
    try {
      const runtime = await services.service.getWorkspaceRuntime(canonicalWorkspace);
      assert.ok(graphExecute);
      lease = await globalSessionManager.getOrCreatePinned(sessionId, canonicalWorkspace, {
        persistence: true,
        picoHome,
        runtimePort: createEngineRuntimePort(),
      });
      let terminalCount = 0;
      const input: ExecuteHostedAgentGraphRunInput = {
        claimId: `root-wake:${scenario.kind}-failure`,
        session: lease.session,
        prompt: `${scenario.kind} assembly must fail closed`,
        prestartedRun: {
          runId: `graph-exact-${scenario.kind}-failure`,
          turnId: `graph-exact-${scenario.kind}-failure-turn`,
          invocationId: `graph-exact-${scenario.kind}-failure-invocation`,
          runStartedEventId: `graph-exact-${scenario.kind}-failure-start`,
          runStartedAt: new Date(0).toISOString(),
        },
        prestartedUserInput: { messageId: `graph-exact-${scenario.kind}-failure-input` },
        binding: {
          kind: "root",
          getRootContext: () => ({ privateIdentity: "must-not-be-dispatched" }),
          toolPort: {},
        } as unknown as ExecuteHostedAgentGraphRunInput["binding"],
        orchestrationMode: "graph",
        requestedModel: "test/coder",
        onTerminal: () => {
          terminalCount++;
        },
      };

      await graphExecute(input);
      const firstFailure = await runtime.waitForRun(input.prestartedRun.runId);
      assert.equal(firstFailure.status, "failed");
      assert.match(firstFailure.error ?? "", scenario.error);
      assert.equal(terminalCount, 1);
      assert.equal(dispatchCount, 0, "assembly failure must not expose the Graph binding");

      await graphExecute(input);
      const replayFailure = await runtime.waitForRun(input.prestartedRun.runId);
      assert.equal(replayFailure.status, "failed");
      assert.equal(replayFailure.version, firstFailure.version + 2);
      assert.equal(terminalCount, 2);
      assert.equal(dispatchCount, 0, "failed exact retry must not redispatch AgentRuntime");
    } finally {
      lease?.release();
      await services.desktopService.close();
      const session = globalSessionManager.delete(sessionId, canonicalWorkspace, { picoHome });
      await session?.close();
      await rm(root, { recursive: true, force: true });
    }
  });
}

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

function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((promiseResolve) => {
    resolve = promiseResolve;
  });
  return { promise, resolve };
}
