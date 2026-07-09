// cmd 入口:pico 引擎启动序列。
// 第 09 讲:引擎 I/O 解耦,支持 CLI 与 HTTP Server 两种入口。
// 第 13 讲:新增 --plan 开关,开启 Plan Mode 引导长程任务读写 PLAN.md/TODO.md。
// 用法:
//   CLI 模式:tsx --env-file=.env src/cli/main.ts --provider openai "你的任务"
//   指定目录:tsx --env-file=.env src/cli/main.ts --dir ./workspace --prompt "探索并修复问题"
//   Trace 模式:tsx --env-file=.env src/cli/main.ts --trace "你的任务"
//   Plan 模式:tsx --env-file=.env src/cli/main.ts --plan "搭建一个极简 Web Server 项目"
//   MCP 模式:tsx --env-file=.env src/cli/main.ts --mcp-config .claw/mcp.json "用 GitHub 工具列出我的仓库"
//   HTTP 模式:tsx --env-file=.env src/cli/main.ts --serve --port 3000
//             然后:curl -X POST localhost:3000/ask -H 'Content-Type: application/json' -d '{"prompt":"..."}'

import { parseArgs } from "node:util";
import { mkdir, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager } from "../engine/session.js";
import { Compactor } from "../context/compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { SilentReporter } from "../engine/reporter.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
// 4.3:--serve 抽到 src/server/,REST 端点矩阵 + WebSocket 流式推送。
import { startHttpServer } from "../server/http.js";
import { startWebSocketServer } from "../server/ws.js";
import {
  BashTool,
  ReadFileTool,
  ToolRegistry,
} from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import { BackgroundManager } from "../tools/background-manager.js";
import { createFeishuApprovalMiddleware, FeishuBot, loadFeishuConfig } from "../feishu/bot.js";
import { PromptComposer } from "../context/composer.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { TodoStore } from "../context/todo-store.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import { DelegationManager, DelegateStatusTool } from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import { AgentProfileLoader, type AgentProfile } from "../tools/agent-profile.js";
import { DelegateTaskTool, SpawnSubagentTool } from "../tools/subagent.js";
import { createToolResultObservationProcessor } from "../tools/tool-result-observation.js";
import { CostTracker } from "../observability/tracker.js";
import { Tracer } from "../observability/trace.js";
import { runUserInputFromCli } from "./run-agent.js";
import { startTuiRepl } from "../tui/repl.js";
import { shouldStartTuiByDefault } from "./launch-mode.js";
import { globalApprovalPolicy, globalApprovalManager, type ApprovalNotifier } from "../approval/manager.js";
import { computeApprovalDiff } from "../approval/diff.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import {
  assertFileHistoryCliFlags,
  defaultCliSessionId,
  formatFileHistorySnapshots,
  listFileHistorySnapshotSummaries,
  parseRewindMode,
  rewindFileHistoryFromCli,
} from "./file-history.js";
import { primeTokenizer } from "../context/token-counter.js";
import { FTS5Store } from "../memory/fts5-store.js";
import { AcpStdioServer } from "../acp/stdio-server.js";
import {
  AcpServer,
  normalizeMode,
  type AcpEngineFactory,
} from "../acp/server.js";
import type { AcpMode } from "../acp/protocol.js";

// 进程退出时统一释放共享的 FTS5 SQLite 连接池,避免句柄泄漏(尤其 Windows)。
;["SIGINT", "SIGTERM", "beforeExit", "exit"].forEach((evt) => {
  process.on(evt, () => FTS5Store.closeAll());
});

const cliBackgroundManager = new BackgroundManager();

function buildRegistry(
  workDir: string,
  backgroundManager: BackgroundManager = cliBackgroundManager,
  goalManager?: GoalManager,
  todoStore?: TodoStore,
  toolDisclosure?: ToolDisclosure,
): ToolRegistry {
  return buildDefaultToolRegistry(workDir, {
    truncateResults: false,
    backgroundManager,
    ...(goalManager !== undefined ? { goalManager } : {}),
    ...(todoStore !== undefined ? { todoStore } : {}),
    ...(toolDisclosure !== undefined ? { toolDisclosure } : {}),
  });
}

/**
 * 构建子智能体专属的只读注册表(爆炸半径限制)。
 * 子智能体只能读文件/执行只读 bash 搜索,绝对不能 write/edit,防莽夫瞎改。
 */
function buildReadOnlyRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry({ truncateResults: false });
  registry.register(new ReadFileTool(workDir));
  registry.register(new BashTool(workDir, undefined, { allowBackground: false }));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  return registry;
}

/** 加载工作区的自定义子代理角色(.claw/agents.yaml)。失败静默返回空。 */
async function loadProfiles(workDir: string): Promise<AgentProfile[]> {
  try {
    return await new AgentProfileLoader(workDir).load();
  } catch {
    return [];
  }
}

function registerDelegationTools(
  registry: ToolRegistry,
  engine: AgentEngine,
  workDir: string,
  profiles: AgentProfile[],
): void {
  const manager = new DelegationManager();
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    runner: engine,
    manager,
    ...(profiles.length > 0 ? { profiles } : {}),
  });
  registry.register(
    new DelegateTaskTool(engine, registryFactory, manager, {
      ...(profiles.length > 0 ? { profiles } : {}),
    }),
  );
  registry.register(new DelegateStatusTool(manager));
  registry.register(new SpawnSubagentTool(engine, buildReadOnlyRegistry(workDir)));
}

/**
 * 构建上下文压缩器:防 OOM 的物理防线。
 * 水位线 20000 字符(约 5K token,留足模型输出空间),保护区最近 6 条消息。
 */
function buildCompactor(kind: ProviderKind, model: string): Compactor {
  const protocol = kind === "openai" ? "openai" : kind;
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return new Compactor({
    maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
    retainLastMsgs: 6,
  });
}

function buildObservationProcessor(workDir: string) {
  const store = new ToolResultArtifactStore({
    baseDir: join(workDir, ".claw", "artifacts"),
  });
  return createToolResultObservationProcessor({ store });
}

/** 终端审批通知器:打印审批请求到控制台(与 server/http.ts 的 terminalNotifier 等价)。 */
const terminalNotifier: ApprovalNotifier = (notice) => {
  console.warn(`\n\x1b[31m[需要审批 TaskID: ${notice.taskId}]\x1b[0m ${notice.message}\n`);
  if (notice.diff) {
    console.warn(`\x1b[33m${notice.diff}\x1b[0m\n`);
  }
};

/** 构建审批中间件:与 run-agent.ts / server/http.ts 的 buildApprovalMiddleware 等价。 */
function buildApprovalMiddleware(notifier: ApprovalNotifier, workDir: string): MiddlewareFunc {
  return async (call) => {
    return globalApprovalPolicy.decide("acp", call, async () => {
      const diff = await computeApprovalDiff(call.name, call.arguments, workDir);
      return globalApprovalManager.waitForApproval(
        call.id,
        call.name,
        call.arguments,
        notifier,
        diff,
      );
    });
  };
}

/**
 * HTTP Server 模式(4.3):启动 REST 端点矩阵 + WebSocket 流式推送。
 * 把原本内联的 serve() 抽到 src/server/,main.ts 只负责装配与启动。
 * REST 端点见 src/server/http.ts;WS cursor 多端同步见 src/server/ws.ts。
 */
async function serve(
  kind: ProviderKind,
  enableThinking: boolean,
  thinkingEffort: ThinkingEffort,
  planMode: boolean,
  traceEnabled: boolean,
  port: number,
): Promise<void> {
  const workDir = process.cwd();
  // 进程级共享单例:跨请求/WS 连接复用同一个 GoalManager / BackgroundManager。
  const goalManager = new GoalManager();
  const backgroundManager = new BackgroundManager();
  const httpServer = await startHttpServer({
    kind,
    enableThinking,
    thinkingEffort,
    planMode,
    traceEnabled,
    port,
    workDir,
    goalManager,
    backgroundManager,
  });
  // WebSocket 挂载到同一个 http.Server,共享端口(/?sessionId=...&lastSeq=...)
  startWebSocketServer(httpServer);
  console.log(`🚀 pico HTTP+WS 模式监听 http://localhost:${port}`);
  console.log(`   REST:  POST /sessions, GET /sessions/:id, POST /sessions/:id/messages,`);
  console.log(`          POST /approvals/:taskId, GET /tools`);
  console.log(`   WS:    ws://localhost:${port}/?sessionId=<id>&lastSeq=<n>&epoch=<e>`);
}

async function main() {
  // 预加载 BPE 词表,抹平首次 token 估算的加载延迟(精确计数 cl100k_base)。
  // 失败静默:token-counter 会自动降级为 chars/4 兜底,不阻断启动。
  await primeTokenizer();

  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
      // 思考强度:off/low/medium/high(模型原生 reasoning_effort);兼容老的 true/false 布尔
      thinking: { type: "string", default: "true" },
      plan: { type: "boolean", default: false },
      trace: { type: "boolean", default: false },
      dir: { type: "string" },
      session: { type: "string" },
      continue: { type: "boolean", short: "c", default: false },
      resume: { type: "string", short: "r" },
      "fork-session": { type: "string" },
      prompt: { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      "base-url": { type: "string" },
      serve: { type: "boolean", default: false },
      port: { type: "string", default: "3000" },
      feishu: { type: "boolean", default: false },
      "mcp-config": { type: "string" },
      "list-snapshots": { type: "boolean", default: false },
      rewind: { type: "boolean", default: false },
      "rewind-mode": { type: "string", default: "both" },
      steer: { type: "string" },
      // 5.5e 图片入口:--image <path> 读取图片转 base64 注入 user 消息(parseArgs 不支持数组,故仅单个)
      image: { type: "string" },
      // ACP 模式:启动 stdio JSON-RPC server,供 IDE(VSCode 插件等)驱动 Agent
      acp: { type: "boolean", default: false },
      // 运行模式:default | plan | auto | yolo(ACP 模式下使用)
      mode: { type: "string", default: "default" },
      // TUI 模式:启动 ink REPL 交互界面(顶栏 + 消息列表 + 输入框)
      tui: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const kind = values.provider as ProviderKind;
  // thinking 参数升级为统一枚举:off/low/medium/high(兼容老 true/false)
  const thinkingEffort = resolveThinkingEffort(values.thinking);
  // enableThinking(应用层两阶段)保持老逻辑向后兼容:仅 "false" 时关闭
  const enableThinking = values.thinking !== "false";
  const planMode = values.plan;
  const traceEnabled = values.trace;

  assertFileHistoryCliFlags({
    listSnapshots: values["list-snapshots"],
    rewind: values.rewind,
  });

  if (values["list-snapshots"] || values.rewind) {
    const workDir = await resolveCliWorkDir(values.dir);
    const sessionId = values.session ?? defaultCliSessionId(workDir);
    const session = await globalSessionManager.getOrCreate(sessionId, workDir);

    if (values["list-snapshots"]) {
      console.log(formatFileHistorySnapshots(session.id, listFileHistorySnapshotSummaries(session)));
      return;
    }

    const result = await rewindFileHistoryFromCli(
      session,
      positionals[0],
      parseRewindMode(values["rewind-mode"]),
    );
    console.log(result.output);
    return;
  }

  if (values.acp) {
    // ACP 模式:启动 stdio JSON-RPC server,不跑 CLI 交互。
    // IDE(VSCode 插件)通过 stdin/stdout 收发 ACP 消息驱动 Agent。
    // --mode 控制默认运行模式(default/plan/auto/yolo),prompt 可逐条覆盖。
    const acpMode = normalizeMode(values.mode) as AcpMode;
    console.log(
      `[ACP] 启动 stdio server | [Provider] ${kind} | [DefaultMode] ${acpMode} | [ThinkingEffort] ${thinkingEffort}`,
    );
    const workDir = process.cwd();
    const modelName = process.env.LLM_MODEL ?? (kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet");
    const goalManager = new GoalManager();
    const todoStore = new TodoStore(workDir);
    const backgroundManager = new BackgroundManager();
    // 工具渐进披露状态机(ROADMAP 5.4):registry(search_tools)与 engine(pickForLLM)共享同一实例。
    const toolDisclosure = new ToolDisclosure();
    // 非 plan 模式预组装 system prompt(plan 模式由 engine 每轮动态重组,故不预生成)
    const acpSystemPrompt = await new PromptComposer(workDir, false, { goalManager, todoStore }).build();

    // Engine 工厂:每个 prompt 装配一个独立 engine(按 mode 映射 planMode/approval)。
    // auto / yolo 模式开启 YOLO 放行(跳过审批);default / plan 走人工审批中间件。
    const engineFactory: AcpEngineFactory = ({ session, mode, reporter }) => {
      const provider = createProvider(kind, undefined, thinkingEffort);
      const trackedProvider = new CostTracker(provider, modelName, session);
      const registry = buildRegistry(workDir, backgroundManager, goalManager, todoStore, toolDisclosure);
      const usePlanMode = mode === "plan";
      if (mode === "auto" || mode === "yolo") {
        globalApprovalPolicy.setYoloMode(session.id, true);
      }
      registry.use(buildApprovalMiddleware(terminalNotifier, workDir));
      const engine = new AgentEngine({
        provider: trackedProvider,
        registry,
        workDir,
        enableThinking,
        thinkingEffort,
        planMode: usePlanMode,
        systemPrompt: usePlanMode ? undefined : acpSystemPrompt,
        goalManager,
        todoStore,
        toolDisclosure,
        compactor: buildCompactor(kind, modelName),
        observationProcessor: buildObservationProcessor(workDir),
        reporter,
        tracer: traceEnabled ? new Tracer() : undefined,
      });
      return engine;
    };

    const stdio = new AcpStdioServer();
    const acpServer = new AcpServer(engineFactory, stdio, { defaultMode: acpMode });
    void acpServer; // 已在构造时把 handler 注册进 stdio
    stdio.start();
    // stdio server 持续监听 stdin,进程常驻;由 stdin 关闭(SIGINT/客户端断开)退出
    return;
  }

  if (values.feishu) {
    // 飞书模式:启动 WSClient 长连接,群里 @机器人 触发 Agent,状态发回会话
    const workDir = process.cwd();
    // GoalManager 单例:飞书进程级共享,registry(3 工具)与 engine 用同一实例。
    const goalManager = new GoalManager();
    // TodoStore 单例:飞书进程级共享,registry(TodoTool)与 Composer 用同一实例。
    const todoStore = new TodoStore(workDir);
    // 工具渐进披露状态机(ROADMAP 5.4):registry(search_tools)与 engine(pickForLLM)共享同一实例。
    const toolDisclosure = new ToolDisclosure();
    const systemPrompt = planMode
      ? undefined
      : await new PromptComposer(workDir, false, { goalManager, todoStore }).build();
    const modelName = process.env.LLM_MODEL ?? defaultModelForKind(kind);
    // 预加载自定义角色:飞书 engineFactory 回调是同步的,await 必须提前到这里
    const feishuProfiles = await loadProfiles(workDir);
    const backgroundManager = new BackgroundManager();
    const bot = new FeishuBot(
      ({ session, reporter }) => {
        const provider = createProvider(kind, undefined, thinkingEffort);
        const trackedProvider = new CostTracker(provider, modelName, session);
        const registry = buildRegistry(workDir, backgroundManager, goalManager, todoStore, toolDisclosure);
        registry.use(createFeishuApprovalMiddleware(reporter, workDir));
        const engine = new AgentEngine({
          provider: trackedProvider,
          registry,
          workDir,
          enableThinking,
          thinkingEffort,
          planMode,
          systemPrompt,
          goalManager,
          todoStore,
          toolDisclosure,
          compactor: buildCompactor(kind, modelName),
          observationProcessor: buildObservationProcessor(workDir),
          reporter: new SilentReporter(), // 实际回写由运行时 FeishuReporter 负责
          tracer: traceEnabled ? new Tracer() : undefined,
        });
        // 注册 Hermes 风格委派工具,并保留 spawn_subagent 兼容入口。
        registerDelegationTools(registry, engine, workDir, feishuProfiles);
        return engine;
      },
      loadFeishuConfig(),
      workDir,
    );
    bot.start();
    return;
  }

  if (values.serve) {
    await serve(kind, enableThinking, thinkingEffort, planMode, traceEnabled, Number(values.port));
    return;
  }

  if (shouldStartTuiByDefault({
    tui: values.tui,
    prompt: values.prompt,
    positionals,
  })) {
    // TUI 模式:启动 ink REPL 交互界面(顶栏 + 消息列表 + 输入框),
    // 每轮用户输入复用 runAgentFromCli 装配 engine,与 feishu/acp/serve 平级。
    // 日志静默靠 preload-env.ts(--import 预加载,在 logger 初始化前设 LOG_LEVEL=warn)。
    const workDir = await resolveCliWorkDir(values.dir);
    const modelName = process.env.LLM_MODEL ?? (kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet");
    await startTuiRepl({
      workDir,
      provider: kind,
      model: modelName,
      enableThinking,
      thinkingEffort,
      ...(values["mcp-config"] ? { mcpConfigPath: values["mcp-config"] } : {}),
    });
    return;
  }

  // 默认 CLI 模式 banner(TUI/ACP/飞书/HTTP 模式已提前 return,不打 banner)
  console.log("🚀 欢迎来到 pico-harness 引擎启动序列");
  console.log(
    `[Provider] ${kind} 协议 | [ThinkingEffort] ${thinkingEffort} | [EnableThinking] ${enableThinking} | [PlanMode] ${planMode} | [Trace] ${traceEnabled}`,
  );

  const task =
    values.prompt ??
    positionals[0] ??
    "请用 read_file 工具读取 README.md,然后用一句话总结这个项目是做什么的。";
  await runUserInputFromCli({
    prompt: task,
    provider: kind,
    ...(values.dir ? { dir: values.dir } : {}),
    ...(values.session ? { session: values.session } : {}),
    ...(values["continue"] ? { continueSession: true } : {}),
    ...(values.resume ? { resumeSession: values.resume } : {}),
    ...(values["fork-session"] ? { forkSession: values["fork-session"] } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
    ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
    enableThinking,
    thinkingEffort,
    planMode,
    trace: traceEnabled,
    ...(values["mcp-config"] ? { mcpConfigPath: values["mcp-config"] } : {}),
    ...(values.steer ? { steer: values.steer } : {}),
    ...(values.image ? { imagePath: values.image } : {}),
  });
}

async function resolveCliWorkDir(dir: string | undefined): Promise<string> {
  const target = resolve(dir ?? process.cwd());
  await mkdir(target, { recursive: true });
  return realpath(target);
}

/** 各 provider 的默认模型名(未设 LLM_MODEL 时兜底)。 */
function defaultModelForKind(kind: ProviderKind): string {
  switch (kind) {
    case "openai":
      return "glm-5.2";
    case "claude":
      return "claude-3-5-sonnet";
    case "gemini":
      return "gemini-2.0-flash";
  }
}

main().catch((err) => {
  console.error("引擎启动失败:", err);
  process.exit(1);
});
