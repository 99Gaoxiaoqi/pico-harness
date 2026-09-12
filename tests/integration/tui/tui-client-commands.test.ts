import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { render } from "ink";
import { LOCAL_RUNTIME_PROTOCOL_VERSION, type RuntimeNotification } from "@pico/protocol";
import { AUTOMATION_TOOL_ALLOWLIST } from "../../../src/safety/automation-tool-policy.js";
import { AutomationCredentialImportProposalStore } from "../../../src/tui/automation-credential-proposal.js";
import {
  createClientCommandRegistry,
  processClientInput,
} from "../../../src/tui/client-commands.js";
import {
  ClientSessionRuntime,
  type DaemonSessionClient,
} from "../../../src/tui/client-session-runtime.js";
import { TuiReporter } from "../../../src/tui/tui-reporter.js";
import { handleClientLocalCommand } from "../../../src/tui/client-command-host.js";

/**
 * 3-D Phase 3 tier1：客户端命令注册表全命令矩阵。fake client 记录全部 RPC，
 * 逐命令断言解析/结果类型/RPC 形状/availability 门/坏参数路径。
 */

interface Harness {
  readonly runtime: ClientSessionRuntime;
  readonly registry: ReturnType<typeof createClientCommandRegistry>;
  readonly requests: { method: string; params: Record<string, unknown> }[];
  emit(notification: RuntimeNotification): void;
  setSessions(sessions: unknown[]): void;
  setTranscriptItems(items: unknown[]): void;
  setProviderApiKeyEnv(name: string): void;
}

function createHarness(options?: {
  readonly duplicateModelProvider?: boolean;
  readonly staleMemoryUndo?: boolean;
  readonly sessionId?: string;
  readonly permissionMode?: "ask" | "auto" | "full-access";
  readonly configuredPermissionMode?: "ask" | "auto" | "full-access";
  readonly configuredCollaborationMode?: "agent" | "plan";
  readonly echoAutomationCredentialError?: boolean;
  readonly credentialEnv?: Readonly<Record<string, string | undefined>>;
  readonly automationCredentialProposals?: AutomationCredentialImportProposalStore;
}): Harness {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let listener: ((notification: RuntimeNotification) => void) | undefined;
  let transcriptItems: unknown[] = [];
  let sessions: unknown[] = [];
  let providerApiKeyEnv = "K";
  const sessionRecord = (sessionId: string) => ({
    sessionId,
    workspacePath: "C:\\ws",
    title: `会话 ${sessionId}`,
    status: "active",
    pinned: false,
    createdAt: 1,
    updatedAt: 2,
  });
  const settings = {
    modelRouteId: "p1/m1",
    thinkingEffort: "medium",
    reasoningLevels: ["low", "medium", "high"],
    collaborationMode: "agent",
    permissionMode: options?.permissionMode ?? "ask",
    orchestrationMode: "default",
  };
  const client = {
    connect: async () => undefined,
    subscribeSessionFrames: () => ({ dispose: () => undefined }),
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      switch (method) {
        case "session.send":
          return {
            session: sessionRecord("s1"),
            run: { runId: "run_1", status: "running" },
            disposition: "started",
          };
        case "session.subscription.open":
          return {
            session: sessionRecord(String(params.sessionId ?? "s1")),
            hostEpoch: "host-test",
            subscriptionId: `subscription-${String(params.sessionId ?? "s1")}`,
            nextSequence: 1,
            watermark: {
              historyEpoch: "history-test",
              projectorVersion: 4,
              throughSequence: transcriptItems.length,
            },
            durableTail: transcriptItems.map((item, index) => ({
              itemId: (item as { id: string }).id,
              itemRevision: 1,
              positionSequence: index + 1,
              positionOrdinal: 0,
              item,
            })),
            activeOverlay: [],
            queuedInputs: [],
          };
        case "session.subscription.close":
          return { closed: true };
        case "session.get":
          if (params.sessionId === "missing") throw new Error("not found");
          return { session: sessionRecord(String(params.sessionId ?? "s1")) };
        case "session.settings.get":
          return { settings };
        case "session.context.get":
          return {
            context: {
              routeId: "p1/m1",
              estimatedInputTokens: 1_200,
              contextWindowTokens: 200_000,
              reservedOutputTokens: 4_096,
              safetyMarginTokens: 512,
              inputBudgetTokens: 195_392,
              remainingTokens: 194_192,
              usedPercent: 0.6,
              estimation: "estimated",
              contextLimitSource: "provider_default",
              outputLimitSource: "provider_default",
              capabilities: { vision: true, reasoning: true, toolCall: true, cache: false },
            },
          };
        case "session.directories.add":
          return { directories: ["C:\\ext", "C:\\more"], added: true };
        case "hooks.manage":
          if (params.action === "list") {
            return {
              result: {
                items: [
                  {
                    id: "hook_1",
                    event: "UserPromptSubmit",
                    type: "command",
                    source: { kind: "extension", path: "C:\\ws\\.pico\\hooks" },
                    status: "active",
                    order: 1,
                  },
                ],
              },
            };
          }
          if (params.action === "review") {
            return {
              result: {
                review: {
                  id: "hook_1",
                  event: "UserPromptSubmit",
                  handler: { command: "echo hi" },
                },
              },
            };
          }
          if (params.action === "reload") return { result: { reloaded: true } };
          return { result: { ok: true } };
        case "operations.manage":
          if (params.action === "list") {
            return {
              result: {
                operations: [
                  {
                    operationId: "op_1",
                    kind: "fork",
                    state: "needs_attention",
                    sessionId: "s1",
                    createdAt: "2026-08-16T00:00:00.000Z",
                    updatedAt: "2026-08-16T00:00:01.000Z",
                    error: { phase: "workspace_applied", message: "revision conflict" },
                  },
                ],
              },
            };
          }
          if (params.action === "show") {
            return {
              result: {
                operation: {
                  operationId: String(params.operationId ?? ""),
                  kind: "fork",
                  state: "needs_attention",
                  sessionId: "s1",
                  createdAt: "t",
                  updatedAt: "t",
                  error: { phase: "workspace_applied", message: "revision conflict" },
                },
              },
            };
          }
          return {
            result: {
              operation: {
                operationId: String(params.operationId ?? ""),
                kind: "fork",
                state: params.action === "retry" ? "prepared" : "aborted",
                sessionId: "s1",
                createdAt: "t",
                updatedAt: "t",
              },
            },
          };
        case "plugin.manage":
          if (params.action === "list") {
            return {
              result: {
                plugins: [
                  {
                    installed: {
                      id: "reviewer",
                      scope: "project",
                      enabled: true,
                    },
                    contributions: { compatibility: "compatible" },
                    trust: "active",
                    changedSinceInstall: false,
                    active: true,
                  },
                ],
              },
            };
          }
          if (params.action === "inspect") {
            return {
              result: {
                plugin: {
                  installed: { id: String(params.id ?? ""), scope: params.scope ?? "project" },
                  contributions: { compatibility: "compatible" },
                  trust: "pending",
                  changedSinceInstall: false,
                  active: false,
                },
              },
            };
          }
          if (params.action === "trust.prepare") {
            return {
              result: {
                proposal: {
                  id: "prop_1",
                  pluginId: String(params.id ?? ""),
                  scope: params.scope ?? "project",
                  workspaceId: "ws",
                  workspacePath: "C:\\ws",
                  pluginRoot: "C:\\plugins\\reviewer",
                  resourceDigest: "sha-123",
                },
              },
            };
          }
          if (params.action === "install") {
            return {
              result: {
                install: { success: true, message: "Installed reviewer", pluginId: "reviewer" },
              },
            };
          }
          return { result: { ok: true } };
        case "session.settings.update":
          return { settings: { ...settings, ...(params as Record<string, unknown>) } };
        case "session.rename":
          return { session: { ...sessionRecord("s1"), title: String(params.title ?? "") } };
        case "session.compact":
          return { compacted: true, beforeMessageCount: 12, afterMessageCount: 3 };
        case "session.list":
          return { sessions };
        case "session.fork":
          if (params.sessionId === "missing") throw new Error("not found");
          return { session: sessionRecord("s_forked"), sourceSessionId: String(params.sessionId) };
        case "session.create":
          return { session: sessionRecord("s_created") };
        case "goal.get":
          return {
            goal: {
              stateVersion: 1,
              sequence: 1,
              activeGoalId: "g1",
              goals: [
                { id: "g1", title: "目标一", description: "d", status: "active", createdAt: 1 },
              ],
            },
          };
        case "usage.get":
          return {
            usage: {
              workspacePath: "C:\\ws",
              providerCallCount: 2,
              total: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
            },
          };
        case "diagnostics.run":
          return { output: ["诊断行 1", "诊断行 2"] };
        case "diagnostics.resources":
          return { output: ["资源行 1"] };
        case "workspace.init":
          return {
            workspacePath: "C:\\ws",
            files: ["AGENTS.md", "PLAN.md"],
            message: "初始化完成",
          };
        case "catalog.agents":
          return { agents: [{ name: "explore" }, { name: "review" }] };
        case "skills.effective.list":
          return {
            skills: [{ name: "commit" }, { name: "review" }],
            revisions: { user: "1", project: "1" },
          };
        case "config.effective.get":
          // 真实 wire 形状：config 才是 RuntimeEffectiveConfig（嵌套，对抗评审 P0）。
          return {
            config: {
              defaultModelRouteId: "p1/m1",
              defaults: {
                collaborationMode: options?.configuredCollaborationMode ?? "agent",
                permissionMode: options?.configuredPermissionMode ?? "ask",
              },
              providers: [
                {
                  id: "p1",
                  protocol: "openai",
                  baseURL: "http://x",
                  apiKeyEnv: providerApiKeyEnv,
                  models: ["m1", "m2"],
                  discoverModels: false,
                  origin: "user",
                  fingerprint: "provider-fingerprint",
                  credentialStatus: "ready",
                  credentialSource: "keychain",
                  storedCredentialPresent: true,
                },
                ...(options?.duplicateModelProvider
                  ? [
                      {
                        id: "p2",
                        protocol: "openai",
                        baseURL: "http://y",
                        models: ["m1", "org/nested"],
                      },
                    ]
                  : []),
              ],
              sources: { "providers.p1": "user" },
              revisions: { user: "1", project: "1" },
            },
          };
        case "run.cancel":
          return { run: { runId: "run_1", status: "cancelling" } };
        case "rewind.list":
          return {
            checkpoints: [
              {
                checkpointId: "msg_1",
                label: "第一条 prompt",
                createdAt: 1_000,
                changedFileCount: 2,
                additions: 10,
                deletions: 4,
              },
              {
                checkpointId: "msg_2",
                label: "第二条 prompt",
                createdAt: 2_000,
                changedFileCount: 0,
                additions: 0,
                deletions: 0,
              },
            ],
          };
        case "rewind.preview":
          return {
            checkpointId: String(params.checkpointId ?? ""),
            changes: [
              { path: "src/a.ts", status: "added", additions: 10, deletions: 0 },
              { path: "src/b.ts", status: "modified", additions: 3, deletions: 4 },
            ],
            fingerprint: "fp-1",
          };
        case "rewind.apply":
          return {
            applied: true,
            sessionId: "s_forked",
            sourceSessionId: String(params.sessionId ?? "s1"),
          };
        case "provider.list":
          return {
            providers: [
              {
                id: "p1",
                protocol: "openai",
                origin: "user",
                baseURL: "http://x",
                apiKeyEnv: "K",
                models: ["m1"],
                discoverModels: false,
                fingerprint: "f1",
                credentialStatus: "present",
                credentialSource: "keychain",
                storedCredentialPresent: true,
              },
            ],
            revision: "rev-1",
          };
        case "provider.delete":
          return { deleted: true, revision: "rev-2" };
        case "provider.importEnvironment":
          return {
            provider: {
              id: String((params.provider as { id?: string } | undefined)?.id ?? ""),
              protocol: "openai",
              origin: "user",
              baseURL: "http://x",
              apiKeyEnv: "K",
              models: ["m1"],
              discoverModels: true,
              fingerprint: "f2",
              credentialStatus: "present",
              credentialSource: "keychain",
              storedCredentialPresent: true,
            },
            revision: "rev-3",
          };
        case "config.user.get":
          return {
            config: {
              version: 1,
              defaults: {},
              providers: [
                {
                  id: "p1",
                  protocol: "openai",
                  baseURL: "http://x",
                  apiKeyEnv: providerApiKeyEnv,
                  models: ["m1"],
                  discoverModels: false,
                },
              ],
            },
            revision: "cfg-1",
          };
        case "config.user.update":
          return {
            config: {
              version: 1,
              defaults: {
                modelRouteId: String(
                  (params.defaults as { modelRouteId?: string } | undefined)?.modelRouteId ?? "",
                ),
              },
              providers: [],
            },
            revision: "cfg-2",
          };
        case "jobs.list":
          return {
            jobs: [
              {
                jobId: "job_1",
                workspacePath: "C:\\ws",
                name: "每日构建",
                prompt: "p",
                schedule: "0 9 * * *",
                enabled: true,
                status: "idle",
                updatedAt: 1,
              },
              {
                jobId: "job_2",
                workspacePath: "C:\\ws",
                name: "报告",
                prompt: "p",
                schedule: "0 18 * * 1",
                enabled: false,
                status: "idle",
                updatedAt: 2,
              },
            ],
          };
        case "jobs.setEnabled":
          return {
            job: {
              jobId: String(params.jobId ?? ""),
              workspacePath: "C:\\ws",
              name: "n",
              prompt: "p",
              schedule: "0 9 * * *",
              enabled: params.enabled === true,
              status: "idle",
              updatedAt: 3,
            },
          };
        case "jobs.delete":
          return { deleted: true };
        case "jobs.history":
          return { runs: [{ runId: "run_9", status: "succeeded", startedAt: 1 } as never] };
        case "automation.credential.import":
          if (options?.echoAutomationCredentialError) {
            throw new Error(`secret=${String(params.secret ?? "")}`);
          }
          return { imported: true, credentialRef: String(params.expectedCredentialRef ?? "") };
        case "automation.create":
          return {
            job: {
              jobId: "job_created",
              workspacePath: "C:\\ws",
              name: "Automation",
              prompt: String(params.prompt ?? ""),
              schedule: String(params.schedule ?? ""),
              enabled: params.enabled === true,
              status: "idle",
              updatedAt: 4,
            },
          };
        case "memory.get":
          return {
            item: {
              itemId: String(params.itemId),
              version: options?.staleMemoryUndo ? 2 : 1,
              lifecycleState: "active",
            },
          };
        case "memory.create":
          return {
            item: {
              itemId: "manual-item:abc",
              version: 1,
              kind: "note",
              content: "c",
              lifecycleState: "active",
              createdAt: 1,
              updatedAt: 1,
            } as never,
          };
        case "memory.list":
          return {
            items: [
              { itemId: "manual-item:abc", lifecycleState: "active" },
              { itemId: "archived-item", lifecycleState: "archived" },
            ],
          };
        case "memory.settings.get":
          return {
            settings: {
              enabled: true,
              autoExtract: false,
              recallEnabled: true,
              version: 3,
            },
          };
        case "memory.settings.update":
          return {
            settings: {
              enabled: params.enabled === true,
              autoExtract: false,
              recallEnabled: params.recallEnabled === true,
              version: 4,
            },
          };
        case "memory.update":
          return {
            item: {
              itemId: String(params.itemId ?? ""),
              version: 2,
              lifecycleState: "archived",
            } as never,
          };
        case "mcp.effective.list":
          return {
            servers: [
              {
                name: "git-tools",
                transport: "stdio",
                commandLabel: "node",
                hasArguments: true,
                enabled: true,
                source: { scope: "user", sourceId: "user", sourceLabel: "用户级" },
              },
              {
                name: "docs",
                transport: "sse",
                url: "https://docs.example.com/sse",
                enabled: false,
                source: { scope: "project", sourceId: "project", sourceLabel: "项目级" },
              },
            ],
            revisions: { user: "1", project: "2" },
          };
        case "config.mcpServers":
          return {
            servers: [
              { name: "git-tools", status: "connected", toolCount: 3, toolNames: ["git_diff"] },
            ],
          };
        case "mcp.user.list":
          return {
            servers: [
              {
                name: "git-tools",
                transport: "stdio",
                commandLabel: "node",
                hasArguments: true,
                enabled: true,
                source: { scope: "user", sourceId: "user", sourceLabel: "用户级" },
              },
            ],
            revision: "mcp-rev-1",
          };
        case "mcp.user.setEnabled":
          return {
            server: {
              name: String(params.serverName ?? ""),
              transport: "stdio",
              commandLabel: "node",
              hasArguments: true,
              enabled: params.enabled === true,
              source: { scope: "user", sourceId: "user", sourceLabel: "用户级" },
            },
            revision: "mcp-rev-2",
          };
        default:
          return {};
      }
    },
    subscribe: async (
      _params: unknown,
      notificationListener: (notification: RuntimeNotification) => void,
    ) => {
      listener = notificationListener;
      return { replay: { subscribed: true, events: [], hasMore: false }, dispose: () => undefined };
    },
  };
  const runtime = new ClientSessionRuntime({
    client: client as unknown as DaemonSessionClient,
    workspacePath: "C:\\ws",
    ...(options?.sessionId ? { sessionId: options.sessionId } : {}),
    reporter: new TuiReporter(),
  });
  return {
    runtime,
    registry: createClientCommandRegistry({
      runtime,
      workspacePath: "C:\\ws",
      ...(options?.credentialEnv ? { credentialEnv: options.credentialEnv } : {}),
      ...(options?.automationCredentialProposals
        ? { automationCredentialProposals: options.automationCredentialProposals }
        : {}),
    }),
    requests,
    emit: (event) => listener?.(event),
    setSessions: (value) => {
      sessions = value;
    },
    setTranscriptItems: (items) => {
      transcriptItems = items;
    },
    setProviderApiKeyEnv: (name) => {
      providerApiKeyEnv = name;
    },
  };
}

function runEvent(
  topic: "run.started" | "run.finished",
  sessionId: string,
  runId: string,
  status: string,
): RuntimeNotification {
  return {
    eventId: `e-${Math.random()}`,
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    topic,
    scope: { workspacePath: "C:\\ws", sessionId, runId },
    resourceVersion: 1,
    at: 1,
    payload: { runId, run: { runId, status } },
  } as RuntimeNotification;
}

async function run(
  harness: Harness,
  input: string,
): Promise<{
  kind: string;
  result?: {
    action?: string;
    message?: string;
    ui?: { kind: string; selector?: string; panel?: string };
    data?: unknown;
  };
  message?: string;
}> {
  return processClientInput(input, harness.registry, harness.runtime);
}

function credentialProposalId(message: unknown): string {
  const proposalId = /proposalId: ([A-Za-z0-9_-]+)/u.exec(String(message))?.[1];
  assert.ok(proposalId, "credential preview 必须返回 proposalId");
  return proposalId;
}

test("TUI 模型选择：厂商分组、筛选后确认保留完整路由，同名命令不静默切换", async () => {
  const harness = createHarness({ sessionId: "s1", duplicateModelProvider: true });
  const ambiguous = await run(harness, "/model m1");
  assert.equal(ambiguous.result?.ui?.selector, "model");
  assert.match(ambiguous.result?.message ?? "", /多个厂商/);
  assert.ok(!harness.requests.some((request) => request.method === "session.settings.update"));

  const result = await processClientInput("/model", harness.registry, harness.runtime);
  assert.ok(result.result);
  const dispatched: Promise<unknown>[] = [];
  const closed: string[] = [];
  const effect = handleClientLocalCommand(result.result, {
    reporter: new TuiReporter(),
    registry: harness.registry,
    currentModelId: () => "p1/m1",
    closeDialog: (id) => {
      closed.push(id);
    },
    switchSession: () => undefined,
    dispatchInput: (input) => {
      dispatched.push(run(harness, input));
    },
  });
  assert.ok(effect.dialog);
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  Object.defineProperty(stdin, "isTTY", { value: true });
  Object.assign(stdin, {
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.defineProperty(stdout, "columns", { value: 100 });
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance = render(effect.dialog.content, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    debug: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  async function press(input: string): Promise<void> {
    output = "";
    stdin.write(input);
    await delay(30);
    await instance.waitUntilRenderFlush();
  }
  try {
    await delay(30);
    await instance.waitUntilRenderFlush();
    assert.match(output, /当前：p1\/m1/);
    assert.match(output, /m1 ✓ 当前/);
    assert.match(output, /p1[\s\S]*p2/);
    await press("no-match");
    assert.match(output, /没有匹配的模型/);
    await press("\r");
    assert.equal(dispatched.length, 0);
    assert.equal(closed.length, 0);
    await press("\u0015"); // Ctrl+U
    await press("P2");
    assert.match(output, /筛选：P2/);
    assert.match(output, /已选：p2\/m1/);
    await press("\u001b[B");
    assert.match(output, /已选：p2\/org\/nested/);
    await press("\r");
    await Promise.all(dispatched);
    assert.deepEqual(closed, ["local-ui:model-selector"]);
    const updates = harness.requests.filter(
      (request) => request.method === "session.settings.update",
    );
    assert.equal(updates.length, 1);
    assert.equal(updates[0]?.params.modelRouteId, "p2/org/nested");
  } finally {
    instance.unmount();
    await instance.waitUntilExit();
    stdin.destroy();
    stdout.destroy();
  }

  harness.requests.length = 0;
  await run(harness, "/model p2/m1");
  assert.equal(
    harness.requests.find((request) => request.method === "session.settings.update")?.params
      .modelRouteId,
    "p2/m1",
  );
});

test("client commands: settings-class commands map to session.settings.update", async () => {
  const harness = createHarness({ sessionId: "s1" });

  // /model 无参 → 选择器 + 路由数据。
  const modelPicker = await run(harness, "/model");
  assert.equal(modelPicker.kind, "local");
  assert.equal(modelPicker.result?.ui?.selector, "model");
  const routes = (modelPicker.result?.data as { modelRoutes: { id: string }[] }).modelRoutes;
  assert.deepEqual(routes.map((route) => route.id).sort(), ["p1/m1", "p1/m2"]);

  // /model 有效路由 → settings.update.modelRouteId。
  harness.requests.length = 0;
  const modelSet = await run(harness, "/model p1/m2");
  assert.equal(modelSet.kind, "local");
  const update = harness.requests.find((entry) => entry.method === "session.settings.update");
  assert.equal(update?.params.modelRouteId, "p1/m2");

  // /model 未知路由 → usage 提示且不发 settings.update（config.effective.get
  // 作为校验数据源合法发生）。
  harness.requests.length = 0;
  const modelBad = await run(harness, "/model nope");
  assert.match(String(modelBad.result?.message), /未知模型路由/);
  assert.ok(!harness.requests.some((entry) => entry.method === "session.settings.update"));

  // /thinking 状态 / 设置 / 非法值。
  harness.requests.length = 0;
  const thinkingStatus = await run(harness, "/thinking");
  assert.match(String(thinkingStatus.result?.message), /medium/);
  const thinkingSet = await run(harness, "/thinking high");
  void thinkingSet;
  assert.equal(
    harness.requests.find((entry) => entry.method === "session.settings.update")?.params
      .thinkingEffort,
    "high",
  );
  harness.requests.length = 0;
  const thinkingBad = await run(harness, "/thinking ultra");
  assert.match(String(thinkingBad.result?.message), /未知思考强度/);
  assert.ok(
    !harness.requests.some((entry) => entry.method === "session.settings.update"),
    "非法思考强度不应发 settings.update（settings.get 是校验数据源，合法）",
  );

  // /mode /permissions /graph /plan：合法值设置 + 非法 usage。
  const planMode = await run(harness, "/mode plan");
  assert.equal(
    harness.requests.find((entry) => entry.method === "session.settings.update")?.params
      .collaborationMode,
    "plan",
  );
  assert.match(String(planMode.result?.message), /协作模式已切换：plan/u);
  assert.equal(
    Object.hasOwn(
      harness.requests.find((entry) => entry.method === "session.settings.update")?.params ?? {},
      "mode",
    ),
    false,
  );
  await run(harness, "/mode agent");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .collaborationMode,
    "agent",
  );
  const autoMode = await run(harness, "/mode auto");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .permissionMode,
    "auto",
  );
  assert.match(String(autoMode.result?.message), /权限模式已设置：帮我批准/u);
  await run(harness, "/permissions full-access");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .permissionMode,
    "full-access",
  );
  const permissionUpdateCount = harness.requests.filter(
    (entry) => entry.method === "session.settings.update",
  ).length;
  const invalidPermission = await run(harness, "/permissions plan");
  assert.match(String(invalidPermission.result?.message), /Usage/u);
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").length,
    permissionUpdateCount,
  );
  await run(harness, "/graph on");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .orchestrationMode,
    "graph",
  );
  await run(harness, "/plan off");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .collaborationMode,
    "agent",
  );
  harness.requests.length = 0;
  for (const bad of ["/mode sideways", "/permissions wildcard", "/graph maybe", "/plan maybe"]) {
    const result = await run(harness, bad);
    assert.match(String(result.result?.message), /Usage:/, `${bad} 应给 usage`);
  }
  assert.equal(harness.requests.length, 0, "非法值不应发 RPC");
});

test("client commands: query-class commands issue the right RPCs", async () => {
  const harness = createHarness({ sessionId: "s1" });

  const status = await run(harness, "/status");
  assert.match(String(status.result?.message), /模型路由：p1\/m1/);
  assert.ok(harness.requests.some((entry) => entry.method === "session.get"));
  assert.ok(harness.requests.some((entry) => entry.method === "session.settings.get"));

  const goal = await run(harness, "/goal");
  assert.match(String(goal.result?.message), /目标一/);
  assert.ok(harness.requests.some((entry) => entry.method === "goal.get"));

  const usage = await run(harness, "/usage");
  assert.match(String(usage.result?.message), /inputTokens=100/);

  const doctor = await run(harness, "/doctor");
  assert.match(String(doctor.result?.message), /诊断行 1/);
  await run(harness, "/doctor resources");
  assert.ok(harness.requests.some((entry) => entry.method === "diagnostics.resources"));

  const init = await run(harness, "/init");
  assert.match(String(init.result?.message), /初始化完成/);
  assert.ok(harness.requests.some((entry) => entry.method === "workspace.init"));

  const rename = await run(harness, "/rename 新名字");
  assert.match(String(rename.result?.message), /新名字/);
  assert.equal(
    harness.requests.find((entry) => entry.method === "session.rename")?.params.title,
    "新名字",
  );

  const compact = await run(harness, "/compact");
  assert.match(String(compact.result?.message), /12 → 3/);
});

test("client commands: session-class commands switch/create/list", async () => {
  const harness = createHarness({ sessionId: "s1" });
  harness.setTranscriptItems([{ id: "h1", kind: "userMessage", content: "历史" }]);

  // /sessions → 选择器 + 列表映射。
  harness.setSessions([
    {
      sessionId: "s1",
      workspacePath: "C:\\ws",
      title: "当前",
      status: "active",
      pinned: false,
      createdAt: 1,
      updatedAt: 2,
    },
    {
      sessionId: "s2",
      workspacePath: "C:\\ws",
      title: "另一个",
      status: "active",
      pinned: false,
      createdAt: 1,
      updatedAt: 3,
    },
  ]);
  const sessions = await run(harness, "/sessions");
  assert.equal(sessions.result?.ui?.selector, "session");
  const data = sessions.result?.data as { id: string; isCurrent?: boolean }[];
  assert.equal(data.length, 2);
  assert.equal(data[0]?.id, "s1");
  assert.equal(data[0]?.isCurrent, true);
  assert.equal(data[1]?.isCurrent, false);

  // /resume 存在 → 切换（session.get 校验 + 水化）。
  const resume = await run(harness, "/resume s2");
  assert.match(String(resume.result?.message), /已切换/);
  assert.equal(harness.runtime.activeSessionId, "s2");
  assert.ok(
    harness.requests.some(
      (entry) => entry.method === "session.subscription.open" && entry.params.sessionId === "s2",
    ),
    "切换应触发水化",
  );

  // /resume 不存在 → 提示不切换。
  const resumeMissing = await run(harness, "/resume missing");
  assert.match(String(resumeMissing.result?.message), /不存在/);
  assert.equal(harness.runtime.activeSessionId, "s2");

  // /fork → 新会话切换。
  const fork = await run(harness, "/fork s1");
  assert.match(String(fork.result?.message), /s_forked/);
  assert.equal(harness.runtime.activeSessionId, "s_forked");

  // /new → 清空 + 无会话态（下次 send 物化）；data 告知宿主新会话意图。
  const fresh = await run(harness, "/new");
  assert.deepEqual(fresh.result?.data, { mode: "new" });
  assert.equal(harness.runtime.activeSessionId, undefined);
});

test("client commands: running-class behaviors gate on availability and map session.send", async () => {
  const harness = createHarness({ sessionId: "s1" });
  await harness.runtime.start();

  // idle 态：running-only 命令被门拦截，不发 RPC。
  for (const blocked of ["/steer 换个方向", "/queue 下一条", "/replace 重来", "/interrupt"]) {
    const outcome = await run(harness, blocked);
    assert.equal(outcome.kind, "local");
    assert.match(
      String(outcome.result?.message),
      /only available while running|不可用/u,
      `${blocked} 应被 availability 门拦截`,
    );
  }
  assert.ok(!harness.requests.some((entry) => entry.method === "session.send"));

  // 进入 running 态（事件流）。
  harness.emit(runEvent("run.started", "s1", "run_1", "running"));
  assert.equal(harness.runtime.running, true);
  const beforeSwarm = harness.requests.length;
  const swarmStatus = await processClientInput("/swarm status", harness.registry, harness.runtime);
  assert.equal(swarmStatus.kind, "local");
  if (swarmStatus.kind === "local")
    assert.match(String(swarmStatus.result?.message), /Swarm Mode/u);
  for (const command of ["/swarm on", "/swarm off", "/swarm Do work"]) {
    const blocked = await processClientInput(command, harness.registry, harness.runtime);
    assert.equal(blocked.kind, "local");
    if (blocked.kind === "local")
      assert.match(String(blocked.result?.message), /only available while idle/u);
  }
  assert.ok(
    harness.requests
      .slice(beforeSwarm)
      .every(({ method }) => method !== "session.send" && method !== "session.settings.update"),
  );

  // idle-only 命令被拦（/model /new）。
  const modelBlocked = await run(harness, "/model p1/m2");
  assert.match(String(modelBlocked.result?.message), /only available while idle|不可用/u);

  // /steer /queue /replace → session.send behavior 映射。
  await run(harness, "/steer 先看测试");
  assert.equal(
    harness.requests.find((entry) => entry.method === "session.send")?.params.behavior,
    "steer",
  );
  await run(harness, "/queue 然后 lint");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.send").at(-1)?.params.behavior,
    "queue",
  );
  await run(harness, "/replace 重写一遍");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.send").at(-1)?.params.behavior,
    "replace",
  );

  // /interrupt → run.cancel。
  await run(harness, "/interrupt");
  assert.ok(harness.requests.some((entry) => entry.method === "run.cancel"));
});

test("client commands: skill/agent inputs use native session.send kinds", async () => {
  const harness = createHarness({ sessionId: "s1" });

  const skill = await run(harness, "/skill commit 提交当前改动");
  assert.match(String(skill.result?.message), /已提交/);
  const skillSend = harness.requests.find((entry) => entry.method === "session.send");
  assert.deepEqual(skillSend?.params.input, {
    kind: "skill",
    name: "commit",
    args: "提交当前改动",
  });

  const agent = await run(harness, "/agent explore 扫描引擎模块");
  void agent;
  const agentSend = harness.requests.filter((entry) => entry.method === "session.send").at(-1);
  assert.deepEqual(agentSend?.params.input, {
    kind: "agent",
    name: "explore",
    task: "扫描引擎模块",
  });

  // 缺参 usage。
  for (const bad of ["/skill", "/agent", "/agent only-name"]) {
    const outcome = await run(harness, bad);
    assert.match(String(outcome.result?.message), /Usage:/);
  }

  const skills = await run(harness, "/skills");
  assert.match(String(skills.result?.message), /commit、review/);
  const agents = await run(harness, "/agents");
  assert.match(String(agents.result?.message), /explore、review/);
});

test("client commands: /rewind and /changes map to rewind.* RPC with selector data", async () => {
  const harness = createHarness({ sessionId: "s1" });
  await harness.runtime.start();

  // /rewind → rewind.list + 选择器数据（snapshots 映射 FileHistorySnapshotSummary）。
  const rewind = await run(harness, "/rewind");
  assert.equal(rewind.kind, "local");
  assert.equal(rewind.result?.ui?.selector, "rewind");
  const listRequest = harness.requests.find((entry) => entry.method === "rewind.list");
  assert.equal(listRequest?.params.sessionId, "s1");
  const data = rewind.result?.data as {
    sessionId: string;
    snapshots: {
      messageId: string;
      userPrompt: string;
      changedFileCount?: number;
      incomplete?: boolean;
    }[];
    viewOnly?: boolean;
  };
  assert.equal(data.sessionId, "s1");
  assert.deepEqual(
    data.snapshots.map((snapshot) => [
      snapshot.messageId,
      snapshot.userPrompt,
      snapshot.changedFileCount,
    ]),
    [
      ["msg_1", "第一条 prompt", 2],
      ["msg_2", "第二条 prompt", 0],
    ],
  );
  assert.equal(data.viewOnly, undefined, "/rewind 非查看型");

  // /changes 无参 → changes 对话框（checkpointId = 最新 checkpoint）。
  harness.requests.length = 0;
  const changes = await run(harness, "/changes");
  assert.equal(changes.result?.ui?.selector, "changes");
  const changesData = changes.result?.data as {
    sessionId?: string;
    checkpointId?: string;
  };
  assert.equal(changesData.checkpointId, "msg_2", "无参默认最新 checkpoint");

  // /changes <id> → 指定 checkpoint；未知 id → 错误提示不发对话框。
  harness.requests.length = 0;
  const changesArg = await run(harness, "/changes msg_1");
  assert.equal((changesArg.result?.data as { checkpointId?: string }).checkpointId, "msg_1");
  const changesBad = await run(harness, "/changes nope");
  assert.match(String(changesBad.result?.message), /was not found/);
  assert.equal(changesBad.result?.ui, undefined);

  // /rewind <id> → 预选该 checkpoint（changes 面板 w 跳转目标）；未知 id 报错。
  harness.requests.length = 0;
  const rewindArg = await run(harness, "/rewind msg_1");
  assert.equal(
    (rewindArg.result?.data as { selectedMessageId?: string }).selectedMessageId,
    "msg_1",
  );
  const rewindBad = await run(harness, "/rewind nope");
  assert.match(String(rewindBad.result?.message), /was not found/);
  assert.equal(rewindBad.result?.ui, undefined);

  // 别名 /checkpoint 与 availability 门（idle-only）。
  const alias = await run(harness, "/checkpoint");
  assert.equal(alias.result?.ui?.selector, "rewind");
  harness.emit(runEvent("run.started", "s1", "run_1", "running"));
  const busy = await run(harness, "/rewind");
  assert.match(String(busy.result?.message ?? busy.message), /当前不可用|only available/i);
});

test("client commands: dynamic argument completers ride RPCs with TTL cache", async () => {
  const harness = createHarness({ sessionId: "s1" });
  harness.setSessions([
    {
      sessionId: "s-alpha",
      workspacePath: "C:\\ws",
      title: "甲会话",
      status: "active",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    },
    {
      sessionId: "s-beta",
      workspacePath: "C:\\ws",
      title: "乙会话",
      status: "active",
      pinned: false,
      createdAt: 1,
      updatedAt: 2,
    },
  ]);
  const resume = harness.registry.resolve("resume");
  assert.ok(resume?.argumentCompleter, "/resume 应有动态补全（session-id 候选）");
  const narrowed = await resume.argumentCompleter!("s-al");
  assert.equal(narrowed.length, 1);
  assert.equal(narrowed[0]!.value, "s-alpha");
  // 包含式匹配也命中 label（旧 in-process 语义）。
  assert.equal((await resume.argumentCompleter!("乙")).length, 1);
  // TTL 内第二次调用走缓存——不再发 session.list。
  harness.requests.length = 0;
  await resume.argumentCompleter!("");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.list").length,
    0,
    "5s TTL 内应走缓存，不因每次按键打 RPC",
  );
  // /fork 与 /resume 共用会话候选源；/skill /agent 各自映射。
  const fork = harness.registry.resolve("fork");
  assert.equal((await fork?.argumentCompleter?.("beta"))?.[0]?.value, "s-beta");
  const skill = await harness.registry.resolve("skill")?.argumentCompleter?.("comm");
  assert.equal(skill?.[0]?.value, "commit");
  const agent = await harness.registry.resolve("agent")?.argumentCompleter?.("rev");
  assert.equal(agent?.[0]?.value, "review");
});

test("client commands: tier2 mirrors map memory/provider/cron to RPCs", async (t) => {
  const harness = createHarness({ sessionId: "s1", permissionMode: "full-access" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // /memory remember → memory.create；undo token 回流 memory.update。
  harness.requests.length = 0;
  const remembered = await run("/memory remember 首选包管理器是 pnpm");
  assert.match(String(remembered.result?.message), /manual-item:/);
  assert.equal(harness.requests.at(-1)?.method, "memory.create");
  const token = String(remembered.result?.message).split("/memory undo ")[1] ?? "";
  const undone = await run(`/memory undo ${token}`);
  assert.match(String(undone.result?.message), /archived/);
  const undoRequest = harness.requests.at(-1);
  assert.equal(undoRequest?.method, "memory.update");
  assert.equal(undoRequest?.params.lifecycleState, "archived");

  // /memory status 聚合原子 Item 与当前设置。
  const status = await run("/memory status");
  assert.match(String(status.result?.message), /Memory: on/);
  assert.match(String(status.result?.message), /Active items: 1/);
  assert.match(String(status.result?.message), /Archived items: 1/);
  assert.match(String(status.result?.message), /Automatic extraction: off/);
  assert.doesNotMatch(String(status.result?.message), /Review mode|Pending proposals/);

  // /provider list → provider.list + config.effective.get；delete 带 revision。
  harness.requests.length = 0;
  const providers = await run("/provider list");
  assert.match(String(providers.result?.message), /p1 · openai · user/);
  assert.ok(harness.requests.some((entry) => entry.method === "provider.list"));
  harness.requests.length = 0;
  const deleted = await run("/provider delete p1");
  assert.match(String(deleted.result?.message), /deleted: p1|Provider deleted: p1/);
  const deleteRequest = harness.requests.at(-1);
  assert.equal(deleteRequest?.method, "provider.delete");
  assert.equal(
    deleteRequest?.params.expectedRevision,
    "rev-1",
    "delete 应携带 list 拿到的 revision",
  );

  // /cron list/enable/runs → jobs.*。
  harness.requests.length = 0;
  const jobs = await run("/cron list");
  assert.match(String(jobs.result?.message), /job_1 · enabled · 0 9 \* \* \*/);
  harness.requests.length = 0;
  const enabled = await run("/cron disable job_2");
  assert.match(String(enabled.result?.message), /已停用/);
  assert.equal(harness.requests.at(-1)?.method, "jobs.setEnabled");
  harness.requests.length = 0;
  const runs = await run("/cron runs job_1");
  assert.match(String(runs.result?.message), /run_9 · succeeded/);
  assert.equal(harness.requests.at(-1)?.method, "jobs.history");

  const credentialStatus = await run("/cron credential status p1/m1");
  assert.match(String(credentialStatus.result?.message), /Provider 凭据状态 ready/);
  assert.match(String(credentialStatus.result?.message), /daemon .*credentialRef.*复核/);

  // credential import 先预览后显式确认；secret 只进入 write-only RPC。
  const previousCredential = process.env.K;
  const secret = "pico-tui-credential-secret";
  process.env.K = secret;
  t.after(() => {
    if (previousCredential === undefined) delete process.env.K;
    else process.env.K = previousCredential;
  });
  harness.requests.length = 0;
  const preview = await run("/cron credential import p1/m1");
  assert.match(String(preview.result?.message), /--confirm/);
  assert.equal(String(preview.result?.message).includes(secret), false, "预览不回显 secret");
  const proposalId = credentialProposalId(preview.result?.message);
  assert.equal(
    harness.requests.some((entry) => entry.method === "automation.credential.import"),
    false,
    "未确认不写入凭据",
  );
  harness.requests.length = 0;
  const imported = await run(`/cron credential import p1/m1 --confirm ${proposalId}`);
  assert.match(String(imported.result?.message), /已导入/);
  assert.equal(String(imported.result?.message).includes(secret), false, "成功回执不回显 secret");
  const importRequest = harness.requests.at(-1);
  assert.equal(importRequest?.method, "automation.credential.import");
  assert.equal(importRequest?.params.modelRouteId, "p1/m1");
  assert.equal(importRequest?.params.secret, secret, "secret 仅送入 write-only RPC");
  assert.equal(typeof importRequest?.params.expectedCredentialRef, "string");

  // add 固化路由、后台工具与规范化网络 allowlist。
  harness.requests.length = 0;
  const add = await run(
    "/cron add --tool-network=allowlist:API.EXAMPLE.COM.,files.example.com 0 9 * * * 提示词",
  );
  assert.match(String(add.result?.message), /job_created/);
  assert.match(String(add.result?.message), /api\.example\.com, files\.example\.com/);
  const createRequest = harness.requests.at(-1);
  assert.equal(createRequest?.method, "automation.create");
  assert.equal(createRequest?.params.schedule, "0 9 * * *");
  assert.equal(createRequest?.params.prompt, "提示词");
  assert.equal(createRequest?.params.modelRouteId, "p1/m1");
  assert.equal(createRequest?.params.toolNetworkPolicy, "allowlist");
  assert.deepEqual(createRequest?.params.allowedToolNetworkHosts, [
    "api.example.com",
    "files.example.com",
  ]);
  assert.ok(Array.isArray(createRequest?.params.allowedTools));
  assert.deepEqual(createRequest?.params.allowedTools, AUTOMATION_TOOL_ALLOWLIST);
  assert.equal(
    (createRequest?.params.allowedTools as string[]).includes("ask_user"),
    false,
    "交互式工具不得进入后台快照",
  );

  harness.requests.length = 0;
  const invalidNetwork = await run(
    "/cron add --tool-network=allowlist:https://bad.example 0 9 * * * 提示词",
  );
  assert.match(String(invalidNetwork.result?.message), /非法 hostname/);
  assert.equal(
    harness.requests.some((entry) => entry.method === "automation.create"),
    false,
    "非法网络策略不得创建 Job",
  );

  const interactiveHarness = createHarness({ sessionId: "s1", permissionMode: "ask" });
  const interactive = await processClientInput(
    "/cron add 0 9 * * * 提示词",
    interactiveHarness.registry,
    interactiveHarness.runtime,
  );
  assert.match(String(interactive.result?.message), /require \/mode full-access/);
  assert.equal(
    interactiveHarness.requests.some((entry) => entry.method === "automation.create"),
    false,
    "交互模式不得创建无人值守 Job",
  );

  // daemon 错误即使携带原凭据，TUI 也必须精确脱敏。
  const failingHarness = createHarness({
    sessionId: "s1",
    permissionMode: "full-access",
    echoAutomationCredentialError: true,
  });
  const failingPreview = await processClientInput(
    "/cron credential import p1/m1",
    failingHarness.registry,
    failingHarness.runtime,
  );
  const failingProposalId = credentialProposalId(failingPreview.result?.message);
  const failed = await processClientInput(
    `/cron credential import p1/m1 --confirm ${failingProposalId}`,
    failingHarness.registry,
    failingHarness.runtime,
  );
  assert.equal(failed.kind, "local");
  assert.match(String(failed.result?.message), /<redacted>/);
  assert.equal(String(failed.result?.message).includes(secret), false, "错误回执不泄露 secret");
  const failedReplay = await processClientInput(
    `/cron credential import p1/m1 --confirm ${failingProposalId}`,
    failingHarness.registry,
    failingHarness.runtime,
  );
  assert.match(String(failedReplay.result?.message), /不存在、已使用/u);
  assert.equal(
    failingHarness.requests.filter((request) => request.method === "automation.credential.import")
      .length,
    1,
    "已派发但失败的 proposal 也必须消费，避免不确定结果重放",
  );
});

test("client cron credential proposals bind preview state, expire, and reject replay", async () => {
  let now = 1_000;
  let sequence = 0;
  const credentialEnv: Record<string, string | undefined> = {
    K: "credential-v1",
    K2: "credential-v1",
  };
  const proposals = new AutomationCredentialImportProposalStore({
    now: () => now,
    createProposalId: () => `proposal_${String(++sequence).padStart(4, "0")}`,
    ttlMs: 1_000,
    fingerprintKey: Buffer.alloc(32, 7),
  });
  const harness = createHarness({
    sessionId: "s1",
    permissionMode: "full-access",
    credentialEnv,
    automationCredentialProposals: proposals,
  });
  const runCredential = (command: string) =>
    processClientInput(command, harness.registry, harness.runtime);
  const credentialWrites = () =>
    harness.requests.filter((request) => request.method === "automation.credential.import");

  const naked = await runCredential("/cron credential import p1/m1 --confirm");
  assert.match(String(naked.result?.message), /禁止裸 --confirm/u);
  assert.equal(credentialWrites().length, 0, "裸确认不得写入凭据");
  const skippedPreview = await runCredential(
    "/cron credential import p1/m1 --confirm proposal_unknown",
  );
  assert.match(String(skippedPreview.result?.message), /不存在、已使用/u);
  assert.equal(credentialWrites().length, 0, "伪造 proposalId 不得跳过预览");

  const expiringPreview = await runCredential("/cron credential import p1/m1");
  const expiringId = credentialProposalId(expiringPreview.result?.message);
  now += 1_001;
  const expired = await runCredential(`/cron credential import p1/m1 --confirm ${expiringId}`);
  assert.match(String(expired.result?.message), /已过期并作废/u);
  assert.equal(credentialWrites().length, 0);

  const envPreview = await runCredential("/cron credential import p1/m1");
  const envProposalId = credentialProposalId(envPreview.result?.message);
  harness.setProviderApiKeyEnv("K2");
  const envChanged = await runCredential(
    `/cron credential import p1/m1 --confirm ${envProposalId}`,
  );
  assert.match(String(envChanged.result?.message), /Provider 配置或环境凭据已变化/u);
  assert.equal(credentialWrites().length, 0);

  const routePreview = await runCredential("/cron credential import p1/m1");
  const routeProposalId = credentialProposalId(routePreview.result?.message);
  const routeChanged = await runCredential(
    `/cron credential import p1/m2 --confirm ${routeProposalId}`,
  );
  assert.match(String(routeChanged.result?.message), /已变化/u);
  assert.equal(credentialWrites().length, 0);

  const secretPreview = await runCredential("/cron credential import p1/m1");
  const secretProposalId = credentialProposalId(secretPreview.result?.message);
  credentialEnv.K2 = "credential-v2";
  const secretChanged = await runCredential(
    `/cron credential import p1/m1 --confirm ${secretProposalId}`,
  );
  assert.match(String(secretChanged.result?.message), /已变化/u);
  assert.equal(String(secretChanged.result?.message).includes("credential-v2"), false);
  assert.equal(credentialWrites().length, 0);

  const validPreview = await runCredential("/cron credential import p1/m1");
  const validProposalId = credentialProposalId(validPreview.result?.message);
  const imported = await runCredential(
    `/cron credential import p1/m1 --confirm ${validProposalId}`,
  );
  assert.match(String(imported.result?.message), /已导入/u);
  assert.equal(credentialWrites().length, 1);
  const replayed = await runCredential(
    `/cron credential import p1/m1 --confirm ${validProposalId}`,
  );
  assert.match(String(replayed.result?.message), /不存在、已使用/u);
  assert.equal(credentialWrites().length, 1, "成功 proposal 不得重放");
});

test("client commands: /mcp only exposes status/enable/disable and accurate reload guidance", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // status：effective.list（配置面）+ config.mcpServers（探测面）拼合。
  harness.requests.length = 0;
  const status = await run("/mcp");
  const statusText = String(status.result?.message);
  assert.match(statusText, /MCP status/);
  assert.match(statusText, /git-tools \[stdio\] - 用户级 \[connected · 3 tools\]/);
  assert.match(statusText, /docs \[sse\] disabled - 项目级/);
  assert.ok(harness.requests.some((entry) => entry.method === "mcp.effective.list"));
  assert.ok(harness.requests.some((entry) => entry.method === "config.mcpServers"));

  // enable/disable：user.list 取 revision → mcp.user.setEnabled（幂等键新生成）。
  harness.requests.length = 0;
  const disabled = await run("/mcp disable git-tools");
  assert.match(String(disabled.result?.message), /已停用/);
  const disableRequest = harness.requests.at(-1);
  assert.equal(disableRequest?.method, "mcp.user.setEnabled");
  assert.equal(disableRequest?.params.enabled, false);
  assert.equal(
    disableRequest?.params.expectedRevision,
    "mcp-rev-1",
    "enable/disable 应携带 user.list 的 revision",
  );
  assert.equal(typeof disableRequest?.params.idempotencyKey, "string");
  const enabled = await run("/mcp enable git-tools");
  assert.match(String(enabled.result?.message), /已启用/);
  assert.equal(harness.requests.at(-1)?.params.enabled, true);

  // 非用户级 server：明确提示，不发 setEnabled（user.list 查询本身合法）。
  harness.requests.length = 0;
  const missing = await run("/mcp disable other-server");
  assert.match(String(missing.result?.message), /未在用户级配置中找到/);
  assert.equal(
    harness.requests.filter((entry) => entry.method === "mcp.user.setEnabled").length,
    0,
    "非用户级 server 不发 setEnabled",
  );

  // reload 只准确说明配置重读时机；未实现能力不再对外承诺。
  harness.requests.length = 0;
  const reload = await run("/mcp reload");
  assert.match(String(reload.result?.message), /无需 reload/);
  const resources = await run("/mcp resources git-tools");
  assert.equal(resources.result?.message, "Usage: /mcp [reload|enable <server>|disable <server>]");
  const reconnect = await run("/mcp reconnect git-tools");
  assert.equal(reconnect.result?.message, "Usage: /mcp [reload|enable <server>|disable <server>]");
  const malformedReload = await run("/mcp reload git-tools");
  assert.equal(malformedReload.result?.message, "Usage: /mcp reload");
  assert.equal(harness.requests.length, 0, "非能力面子命令不发 RPC");

  // 未知子命令 → usage。
  const usage = await run("/mcp bogus");
  assert.match(String(usage.result?.message), /Usage: \/mcp/);
});

test("client commands: /context and /snapshots map to session.context.get / rewind.list", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // /context：session.context.get（BLOCKED 收口——daemon 复用 createModelContextReport）。
  harness.requests.length = 0;
  const ctx = await run("/context");
  const ctxText = String(ctx.result?.message);
  assert.match(ctxText, /Context \(p1\/m1\)/);
  assert.match(ctxText, /used=0.6%/);
  assert.match(ctxText, /capabilities: vision,reasoning,tool-call/);
  const contextRequest = harness.requests.at(-1);
  assert.equal(contextRequest?.method, "session.context.get");
  assert.deepEqual(contextRequest?.params, { workspacePath: "C:\\ws", sessionId: "s1" });
  const argRejected = await run("/context extra");
  assert.match(String(argRejected.result?.message), /Usage: \/context/);

  // /snapshots：rewind.* 等价能力纯镜像（含 alias）。
  harness.requests.length = 0;
  const snaps = await run("/snapshots");
  assert.match(String(snaps.result?.message), /Rewind/);
  assert.match(String(snaps.result?.message), /第一条 prompt/);
  assert.equal(harness.requests.at(-1)?.method, "rewind.list");
  assert.equal((snaps.result?.data as unknown[])?.length, 2);
  await run("/snapshot");
  assert.equal(harness.requests.at(-1)?.method, "rewind.list", "alias /snapshot 同链路");
});

test("client commands: /add-dir maps to session.directories.add / settings list", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // 无参：settings.get 的 additionalDirectories 列表（fake 未配置 → 空提示）。
  harness.requests.length = 0;
  const empty = await run("/add-dir");
  assert.match(String(empty.result?.message), /No workspace roots/);
  assert.equal(harness.requests.at(-1)?.method, "session.settings.get");

  // 有参：session.directories.add（BLOCKED 收口——daemon 校验+持久化）。
  harness.requests.length = 0;
  const added = await run("/add-dir C:\\ext");
  assert.match(String(added.result?.message), /Workspace directory added: C:\\ext/);
  const addRequest = harness.requests.at(-1);
  assert.equal(addRequest?.method, "session.directories.add");
  assert.deepEqual(addRequest?.params, {
    workspacePath: "C:\\ws",
    sessionId: "s1",
    path: "C:\\ext",
  });
});

test("client commands: /hooks maps to hooks.manage six actions", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // list（无参）→ hooks.manage list；review → 结构化输出。
  harness.requests.length = 0;
  const listed = await run("/hooks");
  assert.match(String(listed.result?.message), /hook_1\s+UserPromptSubmit\s+command\s+active/);
  const listRequest = harness.requests.at(-1);
  assert.equal(listRequest?.method, "hooks.manage");
  assert.deepEqual(listRequest?.params, { workspacePath: "C:\\ws", action: "list" });
  harness.requests.length = 0;
  const reviewed = await run("/hooks review hook_1");
  assert.match(String(reviewed.result?.message), /echo hi/);
  assert.equal(harness.requests.at(-1)?.params.handlerId, "hook_1");

  // trust/enable/disable → 同一方法不同 action；reload → reloaded 文案。
  for (const action of ["trust", "enable", "disable"]) {
    harness.requests.length = 0;
    const outcome = await run(`/hooks ${action} hook_1`);
    assert.match(
      String(outcome.result?.message),
      /Trusted|Enabled|Disabled Hook hook_1/,
      `${action} 应回显动作`,
    );
    assert.equal(harness.requests.at(-1)?.params.action, action);
    assert.equal(harness.requests.at(-1)?.params.handlerId, "hook_1");
  }
  harness.requests.length = 0;
  const reloaded = await run("/hooks reload");
  assert.match(String(reloaded.result?.message), /Hooks reloaded/);
  assert.equal(harness.requests.at(-1)?.params.action, "reload");

  // 未知动作 → usage（不发 RPC）。
  harness.requests.length = 0;
  const bogus = await run("/hooks bogus");
  assert.match(String(bogus.result?.message), /Usage: \/hooks/);
  assert.equal(harness.requests.length, 0, "未知动作不发 RPC");
});

test("client commands: /operations maps to operations.manage four actions", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // list（无参）→ operations.manage list；show → 结构化输出。
  harness.requests.length = 0;
  const listed = await run("/operations");
  assert.match(String(listed.result?.message), /op_1 · fork · needs_attention/);
  const listRequest = harness.requests.at(-1);
  assert.equal(listRequest?.method, "operations.manage");
  assert.deepEqual(listRequest?.params, { workspacePath: "C:\\ws", action: "list" });
  harness.requests.length = 0;
  const shown = await run("/operations show op_1");
  assert.match(String(shown.result?.message), /revision conflict/);
  assert.equal(harness.requests.at(-1)?.params.operationId, "op_1");
  const alias = await run("/ops");
  assert.match(String(alias.result?.message), /op_1/, "alias /ops 同链路");

  // retry/abort → expectedVersion + reason 形状。
  harness.requests.length = 0;
  const retried = await run("/operations retry op_1 2 手动重试");
  assert.match(String(retried.result?.message), /已重试/);
  const retryRequest = harness.requests.at(-1);
  assert.equal(retryRequest?.method, "operations.manage");
  assert.deepEqual(retryRequest?.params, {
    workspacePath: "C:\\ws",
    action: "retry",
    operationId: "op_1",
    expectedVersion: 2,
    reason: "手动重试",
  });
  harness.requests.length = 0;
  const aborted = await run("/operations abort op_1 2");
  assert.match(String(aborted.result?.message), /已中止/);
  assert.equal(harness.requests.at(-1)?.params.action, "abort");
  assert.equal(harness.requests.at(-1)?.params.reason, undefined, "无 reason 时不携带字段");

  // 非法参数 → usage（不发 RPC）。
  harness.requests.length = 0;
  const badVersion = await run("/operations retry op_1 abc");
  assert.match(String(badVersion.result?.message), /Usage: \/operations retry/);
  assert.equal(harness.requests.length, 0, "非法版本不发 RPC");
});

test("client commands: /plugin maps to plugin.manage incl. two-phase trust", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // list → plugin.manage list（scope 过滤默认 project）。
  harness.requests.length = 0;
  const listed = await run("/plugin");
  assert.match(String(listed.result?.message), /reviewer \[project\] · active/);
  assert.equal(harness.requests.at(-1)?.method, "plugin.manage");
  assert.deepEqual(harness.requests.at(-1)?.params, { workspacePath: "C:\\ws", action: "list" });

  // inspect → 结构化输出 + scope 透传。
  harness.requests.length = 0;
  const inspected = await run("/plugin inspect reviewer --scope project");
  assert.match(String(inspected.result?.message), /reviewer/);
  assert.deepEqual(harness.requests.at(-1)?.params, {
    workspacePath: "C:\\ws",
    action: "inspect",
    id: "reviewer",
    scope: "project",
  });

  // trust 两阶段：prepare 输出确认指引 → confirm 校验指纹回传。
  harness.requests.length = 0;
  const prepared = await run("/plugin trust reviewer");
  assert.match(String(prepared.result?.message), /Trust proposal for reviewer/);
  assert.match(String(prepared.result?.message), /--confirm=prop_1 --fingerprint=sha-123/);
  const prepareRequest = harness.requests.at(-1);
  assert.equal(prepareRequest?.params.action, "trust.prepare");
  harness.requests.length = 0;
  const confirmed = await run("/plugin trust reviewer --confirm=prop_1 --fingerprint=sha-123");
  assert.match(String(confirmed.result?.message), /trusted/);
  const confirmRequest = harness.requests.at(-1);
  assert.equal(confirmRequest?.params.action, "trust.confirm");
  assert.equal(confirmRequest?.params.confirmId, "prop_1");
  assert.equal(confirmRequest?.params.fingerprint, "sha-123");

  // enable/disable → 同一方法不同 action。
  harness.requests.length = 0;
  const enabled = await run("/plugin enable reviewer");
  assert.match(String(enabled.result?.message), /enabled/);
  assert.equal(harness.requests.at(-1)?.params.action, "enable");

  // 未知动作 → usage。
  const bogus = await run("/plugin bogus");
  assert.match(String(bogus.result?.message), /Unknown Plugin action/);
});

test("client memory undo rejects stale and malformed tokens before an update RPC", async () => {
  const harness = createHarness({ staleMemoryUndo: true });
  try {
    const remembered = await run(harness, "/memory remember Keep explanations concise.");
    const token = remembered.result?.message?.split("/memory undo ")[1];
    assert.ok(token);
    harness.requests.length = 0;
    const stale = await run(harness, `/memory undo ${token}`);
    assert.match(stale.result?.message ?? "", /item changed/);
    assert.deepEqual(
      harness.requests.map((request) => request.method),
      ["memory.get"],
    );
    harness.requests.length = 0;
    const invalid = await run(harness, "/memory undo malformed-token");
    assert.match(invalid.result?.message ?? "", /invalid memory undo token/);
    assert.deepEqual(harness.requests, []);
  } finally {
    await harness.runtime.dispose();
  }
});

test("client commands preserve public metadata and registration order", () => {
  const harness = createHarness({ sessionId: "s1" });
  const metadata = harness.registry
    .list()
    .map(({ name, aliases, description, usage, argumentHint, category, availability }) => ({
      name,
      aliases,
      description,
      usage,
      argumentHint,
      category,
      availability,
    }));
  assert.deepEqual(JSON.parse(JSON.stringify(metadata)), [
    {
      name: "help",
      aliases: ["h", "?"],
      description: "Show available slash commands",
      usage: "/help [command]",
      category: "help",
      availability: "always",
    },
    {
      name: "clear",
      aliases: ["cls"],
      description: "Clear the local transcript view",
      usage: "/clear",
      category: "system",
      availability: "idle",
    },
    {
      name: "exit",
      aliases: ["quit", "q"],
      description: "Exit the interactive session",
      usage: "/exit",
      category: "system",
      availability: "idle",
    },
    {
      name: "model",
      aliases: ["models"],
      description: "查看或切换模型路由",
      usage: "/model [name]",
      argumentHint: "[name]",
      category: "model",
      availability: "idle",
    },
    {
      name: "thinking",
      aliases: ["effort"],
      description: "查看或设置思考强度",
      usage: "/thinking [level]",
      argumentHint: "[model level]",
      category: "model",
      availability: "idle",
    },
    {
      name: "mode",
      aliases: [],
      description: "查看或切换协作与权限模式",
      usage: "/mode <agent|plan|ask|auto|full-access>",
      argumentHint: "<agent|plan|ask|auto|full-access>",
      category: "session",
      availability: "idle",
    },
    {
      name: "plan",
      aliases: [],
      description: "进入或退出计划模式",
      usage: "/plan [on|off]",
      argumentHint: "[on|off]",
      category: "session",
      availability: "idle",
    },
    {
      name: "permissions",
      aliases: ["permission"],
      description: "查看或设置权限模式",
      usage: "/permissions [ask|auto|full-access]",
      argumentHint: "[ask|auto|full-access]",
      category: "permissions",
      availability: "idle",
    },
    {
      name: "graph",
      aliases: [],
      description: "查看或切换 Graph Mode",
      usage: "/graph [on|off]",
      argumentHint: "[on|off]",
      category: "session",
      availability: "idle",
    },
    {
      name: "swarm",
      aliases: [],
      description: "查看或切换 Swarm 编排，或用 Swarm 执行一次任务",
      usage: "/swarm [on|off|status|task]",
      argumentHint: "[on|off|status|task]",
      category: "session",
      availability: "idle",
    },
    {
      name: "status",
      aliases: ["st"],
      description: "查看会话与配置状态",
      usage: "/status",
      category: "session",
      availability: "always",
    },
    {
      name: "goal",
      aliases: [],
      description: "查看当前目标",
      usage: "/goal",
      category: "session",
      availability: "always",
    },
    {
      name: "rename",
      aliases: [],
      description: "重命名当前会话",
      usage: "/rename <title>",
      argumentHint: "<title>",
      category: "session",
      availability: "idle",
    },
    {
      name: "compact",
      aliases: [],
      description: "压缩当前会话上下文（daemon 侧执行）",
      usage: "/compact",
      category: "session",
      availability: "idle",
    },
    {
      name: "plugin",
      aliases: ["plugins"],
      description: "Install, inspect, trust, enable or disable local plugins",
      usage:
        "/plugin [list|install <path>|inspect <id>|trust <id>|enable <id>|disable <id>] [--scope user|project|local]",
      category: "system",
      availability: "idle",
    },
    {
      name: "operations",
      aliases: ["ops"],
      description: "Inspect and dispose storage operations needing attention",
      usage:
        "Usage:\n  /operations list\n  /operations show <operation-id>\n  /operations retry <operation-id> <expected-version> [reason]\n  /operations abort <operation-id> <expected-version> [reason]",
      argumentHint: "[list|show|retry|abort]",
      category: "system",
      availability: "idle",
    },
    {
      name: "hooks",
      aliases: [],
      description: "List, review, trust, enable, disable, or reload Hooks",
      usage: "/hooks [list|review|trust|enable|disable|reload] [handler-id]",
      category: "system",
      availability: "idle",
    },
    {
      name: "add-dir",
      aliases: [],
      description: "Add a directory to the current session workspace",
      usage: "/add-dir [directory]",
      argumentHint: "[directory]",
      category: "workspace",
      availability: "idle",
    },
    {
      name: "context",
      aliases: [],
      description: "Show the active route context budget and capabilities",
      usage: "/context",
      category: "model",
      availability: "always",
    },
    {
      name: "snapshots",
      aliases: ["snapshot"],
      description: "List current session rewind points",
      usage: "/snapshots",
      category: "session",
      availability: "idle",
    },
    {
      name: "rewind",
      aliases: ["checkpoint"],
      description: "Open the rewind menu for code and conversation checkpoints",
      usage: "/rewind",
      category: "session",
      availability: "idle",
    },
    {
      name: "changes",
      aliases: [],
      description: "Preview a message checkpoint and partially rewind one file",
      usage: "/changes [message-id]",
      argumentHint: "[message-id]",
      category: "session",
      availability: "idle",
    },
    {
      name: "init",
      aliases: [],
      description: "生成项目上下文文件（daemon 侧执行）",
      usage: "/init",
      availability: "idle",
    },
    {
      name: "doctor",
      aliases: [],
      description: "运行诊断",
      usage: "/doctor [resources]",
      argumentHint: "[resources]",
      availability: "idle",
    },
    {
      name: "usage",
      aliases: [],
      description: "查看用量",
      usage: "/usage",
      category: "model",
      availability: "always",
    },
    {
      name: "sessions",
      aliases: ["session-list"],
      description: "列出工作区会话",
      usage: "/sessions",
      category: "session",
      availability: "idle",
    },
    {
      name: "resume",
      aliases: [],
      description: "恢复指定会话",
      usage: "/resume <session-id>",
      argumentHint: "<session-id>",
      category: "session",
      availability: "idle",
    },
    {
      name: "fork",
      aliases: [],
      description: "分叉指定会话",
      usage: "/fork <session-id>",
      argumentHint: "<session-id>",
      category: "session",
      availability: "idle",
    },
    {
      name: "new",
      aliases: [],
      description: "开始新会话（下次发送时创建）",
      usage: "/new",
      category: "session",
      availability: "idle",
    },
    {
      name: "steer",
      aliases: [],
      description: "转向当前 run",
      usage: "/steer <guidance>",
      argumentHint: "<text>",
      category: "session",
      availability: "running",
    },
    {
      name: "queue",
      aliases: [],
      description: "排队下一条输入",
      usage: "/queue <prompt>",
      argumentHint: "<text>",
      category: "session",
      availability: "running",
    },
    {
      name: "replace",
      aliases: [],
      description: "替换当前 run",
      usage: "/replace <prompt>",
      argumentHint: "<text>",
      category: "session",
      availability: "running",
    },
    {
      name: "interrupt",
      aliases: [],
      description: "中断当前 run",
      usage: "/interrupt",
      category: "session",
      availability: "running",
    },
    {
      name: "skill",
      aliases: ["use-skill"],
      description: "请求 agent 使用指定技能（daemon 侧解析）",
      usage: "/skill <name> [arguments]",
      argumentHint: "<name> [arguments]",
      category: "skill",
      availability: "always",
    },
    {
      name: "agent",
      aliases: [],
      description: "派发命名 agent 任务（daemon 侧解析）",
      usage: "/agent <name> <task>",
      argumentHint: "<name> <task>",
      category: "agent",
      availability: "always",
    },
    {
      name: "skills",
      aliases: ["skill-list"],
      description: "列出可用技能",
      usage: "/skills",
      category: "skill",
      availability: "idle",
    },
    {
      name: "agents",
      aliases: [],
      description: "列出可用 agent",
      usage: "/agents",
      availability: "idle",
    },
    {
      name: "explore",
      aliases: [],
      description: "（已弃用）仓库探索已内建",
      usage: "/explore",
      category: "workspace",
      availability: "idle",
    },
    {
      name: "memory",
      aliases: [],
      description: "Remember a workspace item or control workspace memory",
      usage: "/memory remember <text>|status|off|on",
      argumentHint: "remember <text>|status|off|on",
      category: "workspace",
      availability: "idle",
    },
    {
      name: "provider",
      aliases: [],
      description: "Manage shared user providers without exposing credentials in command arguments",
      usage:
        "/provider [list | import-env <id> [--confirm] | default <provider/model|clear> | delete <id>]",
      argumentHint: "[list | import-env | default | delete]",
      category: "model",
      availability: "idle",
    },
    {
      name: "cron",
      aliases: [],
      description: "管理此工作区的持久后台 Cron 任务",
      usage:
        "/cron <status|list|credential|add|enable|disable|delete|runs> [--tool-network=allow|disabled|allowlist:host1,host2] [arguments]",
      argumentHint: "<status|list|credential|add|enable|disable|delete|runs>",
      category: "workspace",
      availability: "idle",
    },
    {
      name: "mcp",
      aliases: [],
      description: "Inspect and control MCP server connections",
      usage: "/mcp [reload|enable <server>|disable <server>]",
      category: "mcp",
      availability: "always",
    },
  ]);
  harness.runtime.dispose();
});

test("client commands: local/unknown/prompt routing", async () => {
  const harness = createHarness({ sessionId: "s1" });

  // 非 slash → prompt → sendText。
  const sent = await run(harness, "普通消息");
  assert.equal(sent.kind, "sent");
  const plainInput = harness.requests.find((entry) => entry.method === "session.send")?.params
    .input as Record<string, unknown>;
  assert.equal(plainInput.kind, "text");

  // 未知命令 → suggestions。
  const unknown = await run(harness, "/nosuch");
  assert.equal(unknown.kind, "unknown");
  assert.ok((unknown.message ?? "").length > 0);

  // 纯本地命令。
  const help = await run(harness, "/help");
  assert.equal(help.result?.ui?.panel, "help");
  const explore = await run(harness, "/explore");
  assert.match(String(explore.result?.message), /内建/);

  // 无会话态：需会话命令给指引。
  const bare = createHarness();
  const needSession = await run(bare, "/status");
  assert.match(String(needSession.result?.message), /没有活跃会话/);
});

test("fresh TUI can choose safe settings before the first atomic session.send", async () => {
  const harness = createHarness({
    configuredPermissionMode: "auto",
    configuredCollaborationMode: "agent",
  });
  await harness.runtime.start();

  assert.equal(harness.runtime.preSessionSettings.permissionMode, "auto");
  assert.equal(harness.runtime.preSessionSettings.collaborationMode, "agent");
  assert.match(String((await run(harness, "/permissions")).result?.message), /帮我批准/u);

  assert.match(
    String((await run(harness, "/permissions full-access")).result?.message),
    /首条消息/u,
  );
  assert.match(String((await run(harness, "/plan on")).result?.message), /计划模式/u);
  assert.equal(
    harness.requests.some((entry) => entry.method === "session.settings.update"),
    false,
  );

  await run(harness, "首条消息");
  const firstSend = harness.requests.find((entry) => entry.method === "session.send");
  assert.deepEqual(firstSend?.params.initialSettings, {
    collaborationMode: "plan",
    permissionMode: "full-access",
  });

  await harness.runtime.switchSession(undefined);
  assert.equal(harness.runtime.preSessionSettings.permissionMode, "auto");
  assert.equal(harness.runtime.preSessionSettings.collaborationMode, "agent");
  harness.runtime.dispose();
});
