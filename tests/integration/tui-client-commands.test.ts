import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { RuntimeNotification } from "@pico/protocol";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import {
  createClientCommandRegistry,
  processClientInput,
} from "../../src/tui/client-commands.js";
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
          return { session: sessionRecord(String(params.sessionId ?? "s1")), items: transcriptItems, queuedInputs: [], revision: "v1" };
        case "session.get":
          if (params.sessionId === "missing") throw new Error("not found");
          return { session: sessionRecord(String(params.sessionId ?? "s1")) };
        case "session.settings.get":
          return { settings };
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
          return { goal: { stateVersion: 1, sequence: 1, activeGoalId: "g1", goals: [{ id: "g1", title: "目标一", description: "d", status: "active", createdAt: 1 }] } };
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
          return { workspacePath: "C:\\ws", files: ["AGENTS.md", "PLAN.md"], message: "初始化完成" };
        case "catalog.agents":
          return { agents: [{ name: "explore" }, { name: "review" }] };
        case "skills.effective.list":
          return { skills: [{ name: "commit" }, { name: "review" }], revisions: { user: "1", project: "1" } };
        case "config.effective.get":
          // 真实 wire 形状：config 才是 RuntimeEffectiveConfig（嵌套，对抗评审 P0）。
          return {
            config: {
              defaultModelRouteId: "p1/m1",
              providers: [{ id: "p1", protocol: "openai", baseURL: "http://x", apiKeyEnv: "K", models: ["m1", "m2"], discoverModels: false }],
              sources: {},
              revisions: { user: "1", project: "1" },
            },
          };
        case "run.cancel":
          return { run: { runId: "run_1", status: "cancelling" } };
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

function runEvent(topic: "run.started" | "run.finished", sessionId: string, runId: string, status: string): RuntimeNotification {
  return {
    eventId: `e-${Math.random()}`,
    protocolVersion: 1,
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
): Promise<{ kind: string; result?: { action?: string; message?: string; ui?: { kind: string; selector?: string; panel?: string }; data?: unknown }; message?: string }> {
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
    harness.requests.find((entry) => entry.method === "session.settings.update")?.params.thinkingEffort,
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
    harness.requests
      .filter((entry) => entry.method === "session.settings.update")
      .at(-1)?.params.permissionMode,
    "yolo",
  );
  // plan 走 deprecated permissions 别名（permissionMode 枚举无 plan——对抗评审 P0）。
  await run(harness, "/permissions plan");
  assert.equal(
    harness.requests
      .filter((entry) => entry.method === "session.settings.update")
      .at(-1)?.params.permissions,
    "plan",
  );
  await run(harness, "/graph on");
  assert.equal(
    harness.requests
      .filter((entry) => entry.method === "session.settings.update")
      .at(-1)?.params.orchestrationMode,
    "graph",
  );
  await run(harness, "/plan off");
  assert.equal(
    harness.requests
      .filter((entry) => entry.method === "session.settings.update")
      .at(-1)?.params.collaborationMode,
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
    { sessionId: "s1", workspacePath: "C:\\ws", title: "当前", status: "active", pinned: false, createdAt: 1, updatedAt: 2 },
    { sessionId: "s2", workspacePath: "C:\\ws", title: "另一个", status: "active", pinned: false, createdAt: 1, updatedAt: 3 },
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
    harness.requests.some((entry) => entry.method === "session.transcript" && entry.params.sessionId === "s2"),
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
    assert.match(String(outcome.result?.message), /only available while running|不可用/u, `${blocked} 应被 availability 门拦截`);
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
  const agentSend = harness.requests
    .filter((entry) => entry.method === "session.send")
    .at(-1);
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
    if (!availabilityExemptions.has(name)) {
      assert.equal(
        mine.availability ?? "always",
        reference.availability ?? "always",
        `/${name} availability 应与 in-process 一致（分歧须进豁免表并给理由）`,
      );
    }
  }

  // 覆盖清单：in-process 核心命令（builtin 源）要么被镜像，要么在文档化延后
  // 清单里（用户技能/插件注入的命令不在此列——客户端经 /skills 列表另有入口）。
  const deferred = new Set(["provider", "cron", "memory", "mcp", "context", "operations", "rewind", "changes", "snapshots", "discovery", "add-dir", "model-usage", "plugin", "hooks", "resume-plan", "agents-usage"]);
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
  const plainInput = harness.requests.find(
    (entry) => entry.method === "session.send",
  )?.params.input as Record<string, unknown>;
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
