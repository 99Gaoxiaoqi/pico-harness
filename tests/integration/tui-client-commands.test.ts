import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LOCAL_RUNTIME_PROTOCOL_VERSION, type RuntimeNotification } from "@pico/protocol";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
import {
  ClientSessionRuntime,
  type DaemonSessionClient,
} from "../../src/tui/client-session-runtime.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

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
}

function createHarness(options?: { readonly sessionId?: string }): Harness {
  const requests: { method: string; params: Record<string, unknown> }[] = [];
  let listener: ((notification: RuntimeNotification) => void) | undefined;
  let transcriptItems: unknown[] = [];
  let sessions: unknown[] = [];
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
    permissionMode: "default",
    orchestrationMode: "default",
  };
  const client = {
    connect: async () => undefined,
    request: async (method: string, params: Record<string, unknown>) => {
      requests.push({ method, params });
      switch (method) {
        case "session.send":
          return {
            session: sessionRecord("s1"),
            run: { runId: "run_1", status: "running" },
            disposition: "started",
          };
        case "session.transcript":
          return {
            session: sessionRecord(String(params.sessionId ?? "s1")),
            items: transcriptItems,
            queuedInputs: [],
            revision: "v1",
          };
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
              providers: [
                {
                  id: "p1",
                  protocol: "openai",
                  baseURL: "http://x",
                  apiKeyEnv: "K",
                  models: ["m1", "m2"],
                  discoverModels: false,
                },
              ],
              sources: {},
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
          return { config: { version: 1, defaults: {}, providers: [] }, revision: "cfg-1" };
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
        case "memory.create":
          return {
            fact: {
              factId: "manual-fact:abc",
              version: 1,
              kind: "project_fact",
              title: "t",
              content: "c",
              confidence: 1,
              state: "active",
              createdAt: 1,
              updatedAt: 1,
              pinned: false,
            } as never,
          };
        case "memory.list":
          return { facts: [{ factId: "manual-fact:abc" }] };
        case "memory.review.list":
          return { proposals: [] };
        case "memory.settings.get":
          return {
            settings: {
              enabled: true,
              autoPropose: false,
              autoCommit: false,
              injectionEnabled: true,
              reviewMode: "balanced",
              version: 3,
              updatedAt: "t",
            },
            reviewBudget: {
              allowed: true,
              budget: { maxCalls: 10, maxInputTokens: 100, maxOutputTokens: 100, maxCostUsd: 1 },
              usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
            },
          };
        case "memory.settings.update":
          return {
            settings: {
              enabled: params.enabled === true,
              autoPropose: false,
              autoCommit: false,
              injectionEnabled: params.injectionEnabled === true,
              reviewMode: "balanced",
              version: 4,
              updatedAt: "t",
            },
            reviewBudget: {
              allowed: true,
              budget: { maxCalls: 10, maxInputTokens: 100, maxOutputTokens: 100, maxCostUsd: 1 },
              usage: { calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 },
            },
          };
        case "memory.update":
          return {
            fact: { factId: String(params.factId ?? ""), version: 2, state: "disabled" } as never,
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
    registry: createClientCommandRegistry({ runtime, workspacePath: "C:\\ws" }),
    requests,
    emit: (event) => listener?.(event),
    setSessions: (value) => {
      sessions = value;
    },
    setTranscriptItems: (items) => {
      transcriptItems = items;
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

  // /mode /permissions /graph /plan：合法值设置 + 非法 usage。/mode 走 SessionMode
  // 语义（deprecated mode param，对抗评审对齐）。
  await run(harness, "/mode plan");
  assert.equal(
    harness.requests.find((entry) => entry.method === "session.settings.update")?.params.mode,
    "plan",
  );
  await run(harness, "/permissions yolo");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .permissionMode,
    "yolo",
  );
  // plan 走 deprecated permissions 别名（permissionMode 枚举无 plan——对抗评审 P0）。
  await run(harness, "/permissions plan");
  assert.equal(
    harness.requests.filter((entry) => entry.method === "session.settings.update").at(-1)?.params
      .permissions,
    "plan",
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
      (entry) => entry.method === "session.transcript" && entry.params.sessionId === "s2",
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

test("client commands: tier2 mirrors map memory/provider/cron to RPCs", async () => {
  const harness = createHarness({ sessionId: "s1" });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, harness.registry, harness.runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // /memory remember → memory.create；undo token 回流 memory.update。
  harness.requests.length = 0;
  const remembered = await run("/memory remember 首选包管理器是 pnpm");
  assert.match(String(remembered.result?.message), /manual-fact:/);
  assert.equal(harness.requests.at(-1)?.method, "memory.create");
  const token = String(remembered.result?.message).split("/memory undo ")[1] ?? "";
  const undone = await run(`/memory undo ${token}`);
  assert.match(String(undone.result?.message), /disabled/);
  const undoRequest = harness.requests.at(-1);
  assert.equal(undoRequest?.method, "memory.update");
  assert.equal(undoRequest?.params.state, "disabled");

  // /memory status → settings.get + list + review.list 聚合。
  const status = await run("/memory status");
  assert.match(String(status.result?.message), /Memory: on/);
  assert.match(String(status.result?.message), /Active facts: 1/);

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

  // add/credential 明确降级提示（不发 automation RPC）。
  harness.requests.length = 0;
  const add = await run("/cron add 0 9 * * * 提示词");
  assert.match(String(add.result?.message), /暂未镜像/);
  assert.equal(harness.requests.length, 0, "降级提示不发 RPC");
});

test("client commands: /mcp status/enable/disable map to mcp.* RPCs with explicit downgrades", async () => {
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

  // reload 与活连接类子命令：明确降级提示（不发 RPC）。
  harness.requests.length = 0;
  const reload = await run("/mcp reload");
  assert.match(String(reload.result?.message), /无需 reload/);
  const resources = await run("/mcp resources git-tools");
  assert.match(String(resources.result?.message), /暂未镜像/);
  const read = await run("/mcp read git-tools uri://x");
  assert.match(String(read.result?.message), /暂未镜像/);
  assert.equal(harness.requests.length, 0, "降级路径不发 RPC");

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

test("client commands: registry metadata parity with in-process (drift gate)", async (t) => {
  // 对抗评审 P1：手镜像元数据已漂移（6 别名缺失/availability 分叉）。本测试把
  // 双注册表拉到同一断言下——镜像集的 name/aliases/availability/usage 必须与
  // in-process 一致，有意分歧按豁免表声明（含理由）。
  const root = await mkdtemp(join(tmpdir(), "pico-cmd-parity-"));
  const workspaceSeed = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspaceSeed, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  t.after(() => rm(root, { recursive: true, force: true }));

  const inProcess = await createPicoCommandRegistry({
    workDir: workspaceSeed,
    picoHome,
    provider: "openai",
    model: "test-model",
    tools: [],
  });
  const harness = createHarness({ sessionId: "s1" });
  const client = harness.registry;

  // 有意分歧豁免（availability）：/skill /agent 经 session.send 排队，运行中合法。
  const availabilityExemptions = new Set(["skill", "agent"]);
  const mirrored = [
    "status",
    "model",
    "thinking",
    "mode",
    "plan",
    "permissions",
    "graph",
    "goal",
    "rename",
    "compact",
    "rewind",
    "changes",
    "init",
    "doctor",
    "usage",
    "sessions",
    "resume",
    "fork",
    "new",
    "steer",
    "queue",
    "replace",
    "interrupt",
    "skill",
    "agent",
    "skills",
    "agents",
    "explore",
    "memory",
    "provider",
    "cron",
    "help",
    "clear",
    "exit",
  ];
  for (const name of mirrored) {
    const mine = client.resolve(name);
    const reference = inProcess.resolve(name);
    assert.ok(reference, `in-process 应有 /${name}（镜像集清单过期？）`);
    assert.ok(mine, `客户端应有 /${name}`);
    assert.deepEqual(
      [...(mine.aliases ?? [])].sort(),
      [...(reference.aliases ?? [])].sort(),
      `/${name} 别名应与 in-process 一致`,
    );
    assert.equal(mine.usage, reference.usage, `/${name} usage 应与 in-process 一致`);
    assert.equal(
      mine.argumentHint ?? undefined,
      reference.argumentHint ?? undefined,
      `/${name} argumentHint 应与 in-process 一致（对抗评审二轮：补齐后入漂移门）`,
    );
    assert.equal(
      mine.category ?? undefined,
      reference.category ?? undefined,
      `/${name} category 应与 in-process 一致`,
    );
    if (!availabilityExemptions.has(name)) {
      assert.equal(
        mine.availability ?? "always",
        reference.availability ?? "always",
        `/${name} availability 应与 in-process 一致（分歧须进豁免表并给理由）`,
      );
    }
  }

  // 覆盖清单：in-process 核心命令（builtin 源）要么被镜像，要么在延后清单里
  //（用户技能/插件注入的命令不在此列）。延后分两类（对抗评审二轮重划）：
  // BLOCKED=协议缺口（注释标缺失 RPC）；DEFERRED=优先级（RPC 已在，tier2 镜像）。
  const deferred = new Set<string>([]);
  // 注：/mcp 已镜像（2026-08-16 BLOCKED 收口——状态=effective.list+config.mcpServers
  // 拼合、enable/disable=mcp.user.setEnabled 新协议方法；reload/活连接类子命令
  // 明确降级提示，执行体边界而非命令缺失）。
  // 注：/context 已镜像（session.context.get 新协议方法，daemon 复用
  // createModelContextReport）；/snapshots 已镜像（rewind.* 等价能力，纯客户端）；
  // /add-dir 已镜像（session.directories.add 新协议方法，daemon 校验+持久化）；
  // /hooks 已镜像（hooks.manage 单方法六动作，daemon 每请求装配管理面）；
  // /operations 已镜像（operations.manage 单方法四动作，daemon 复用
  // SessionForkService——与 forkSession 同构装配）；
  // /plugin 已镜像（plugin.manage 单方法七动作，trust 两阶段无状态化——
  // confirm 以 fresh proposal 校验 confirmId+指纹，客户端不持有 pending）。
  // BLOCKED 豁免表已清空（2026-08-16 全部收口）。
  // 注：/memory /provider /cron 已镜像（2026-08-16 tier2 收口——memory.create
  // 新协议方法 + provider.*/config.user.* + jobs.*）。/cron 的 add/credential
  // 子命令（automation.create 凭据注入门）与 /provider default clear 明确降级
  // 为提示，属执行体边界而非命令缺失。model-usage/agents-usage 是过期豁免名
  // （in-process 从无此命令），已删除。
  // 注：/rewind /changes 已镜像（rewind.list/preview/apply + mode 参数）；
  // discovery 不在清单——协议方法已被 daemon 下线（METHOD_NOT_FOUND）且
  // in-process 无此命令，豁免注释过期已修正（3-D Phase 3 剩余收口）。
  const coreInProcess = inProcess
    .list({ includeHidden: false })
    .filter((command) => (command.source ?? "builtin") === "builtin")
    .map((command) => command.name)
    .filter((name) => !deferred.has(name));
  for (const name of coreInProcess) {
    assert.ok(
      client.resolve(name) !== undefined || deferred.has(name),
      `in-process 核心命令 /${name} 应被客户端镜像或列入延后清单`,
    );
  }

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
