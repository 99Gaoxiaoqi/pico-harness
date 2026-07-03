// cmd 入口:pico 引擎启动序列。
// 第 09 讲:引擎 I/O 解耦,支持 CLI 与 HTTP Server 两种入口。
// 第 13 讲:新增 --plan 开关,开启 Plan Mode 引导长程任务读写 PLAN.md/TODO.md。
// 用法:
//   CLI 模式:tsx --env-file=.env src/cli/main.ts --provider openai "你的任务"
//   指定目录:tsx --env-file=.env src/cli/main.ts --dir ./workspace --prompt "探索并修复问题"
//   Trace 模式:tsx --env-file=.env src/cli/main.ts --trace "你的任务"
//   Plan 模式:tsx --env-file=.env src/cli/main.ts --plan "搭建一个极简 Web Server 项目"
//   HTTP 模式:tsx --env-file=.env src/cli/main.ts --serve --port 3000
//             然后:curl -X POST localhost:3000/ask -H 'Content-Type: application/json' -d '{"prompt":"..."}'

import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { join } from "node:path";
import { AgentEngine } from "../engine/loop.js";
import { globalSessionManager } from "../engine/session.js";
import { Compactor } from "../context/compactor.js";
import { ToolResultArtifactStore } from "../context/artifact-store.js";
import { createContextBudget, estimateTokenBudgetAsChars } from "../context/context-budget.js";
import { SilentReporter, TerminalReporter } from "../engine/reporter.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { resolveThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import {
  BashTool,
  EditFileTool,
  EchoTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "../tools/registry-impl.js";
import { createFeishuApprovalMiddleware, FeishuBot, loadFeishuConfig } from "../feishu/bot.js";
import { PromptComposer } from "../context/composer.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import {
  globalApprovalManager,
  globalApprovalPolicy,
  type ApprovalNotifier,
} from "../approval/manager.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import { DelegationManager, DelegateStatusTool } from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import { AgentProfileLoader, type AgentProfile } from "../tools/agent-profile.js";
import { DelegateTaskTool, SpawnSubagentTool } from "../tools/subagent.js";
import { createToolResultObservationProcessor } from "../tools/tool-result-observation.js";
import { CostTracker } from "../observability/tracker.js";
import { Tracer } from "../observability/trace.js";
import { runAgentFromCli } from "./run-agent.js";
import { primeTokenizer } from "../context/token-counter.js";
import { FTS5Store } from "../memory/fts5-store.js";

// 进程退出时统一释放共享的 FTS5 SQLite 连接池,避免句柄泄漏(尤其 Windows)。
;["SIGINT", "SIGTERM", "beforeExit", "exit"].forEach((evt) => {
  process.on(evt, () => FTS5Store.closeAll());
});

function buildRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry({ truncateResults: false });
  registry.register(new EchoTool());
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new BashTool(workDir));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  return registry;
}

/**
 * 构建子智能体专属的只读注册表(爆炸半径限制)。
 * 子智能体只能读文件/执行只读 bash 搜索,绝对不能 write/edit,防莽夫瞎改。
 */
function buildReadOnlyRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry({ truncateResults: false });
  registry.register(new ReadFileTool(workDir));
  registry.register(new BashTool(workDir));
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
  const protocol = kind === "claude" ? "claude" : "openai";
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

/**
 * 构建安全拦截中间件:高危命令审批 (Human-in-the-loop)。
 * 命中黑名单的命令挂起执行流,通过 notifier 发审批请求,等待人类 approve/reject。
 * 未命中则 YOLO 放行。
 *
 * @param notifier 通知通道:飞书发卡片 / 终端打印 / HTTP 推送
 */
function buildApprovalMiddleware(notifier: ApprovalNotifier): MiddlewareFunc {
  return async (call) => {
    return globalApprovalPolicy.decide("cli", call, () =>
      globalApprovalManager.waitForApproval(call.id, call.name, call.arguments, notifier),
    );
  };
}

/** 终端通知器:CLI/HTTP 模式回退,打印审批请求到控制台 */
const terminalNotifier: ApprovalNotifier = (notice) => {
  console.warn(`\n\x1b[31m[需要审批 TaskID: ${notice.taskId}]\x1b[0m ${notice.message}\n`);
};

/** HTTP Server 模式:接收外部事件流触发 Agent (等价于飞书 webhook 入口) */
async function serve(
  kind: ProviderKind,
  enableThinking: boolean,
  thinkingEffort: ThinkingEffort,
  planMode: boolean,
  traceEnabled: boolean,
  port: number,
): Promise<void> {
  const workDir = process.cwd();
  const modelName = process.env.LLM_MODEL ?? (kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet");
  const systemPrompt = planMode ? undefined : await new PromptComposer(workDir).build();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/ask") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: '请 POST 到 /ask,body: {"prompt":"..."}' }));
      return;
    }

    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as {
        prompt?: string;
        sessionId?: string;
        thinkingEffort?: string;
      };
      if (!parsed.prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 prompt 字段" }));
        return;
      }
      // HTTP 请求可选覆盖进程级默认的 thinkingEffort(参考 Kimi createSession 的 options.thinking)
      const requestThinkingEffort = parsed.thinkingEffort
        ? resolveThinkingEffort(parsed.thinkingEffort)
        : thinkingEffort;

      // 每个请求独立引擎实例,收集最终消息回写
      const collected: string[] = [];
      const reporter = new (class extends TerminalReporter {
        override onMessage(content: string): void {
          collected.push(content);
        }
      })();

      const provider = createProvider(kind, undefined, requestThinkingEffort);
      const registry = buildRegistry(workDir);
      registry.use(buildApprovalMiddleware(terminalNotifier));
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        enableThinking,
        thinkingEffort: requestThinkingEffort,
        planMode,
        systemPrompt,
        compactor: buildCompactor(kind, modelName),
        observationProcessor: buildObservationProcessor(workDir),
        reporter,
        tracer: traceEnabled ? new Tracer() : undefined,
      });
      registerDelegationTools(registry, engine, workDir, await loadProfiles(workDir));

      // HTTP 入口:可选传入 sessionId 实现多会话隔离,缺省用单一控制台会话
      const sessionId = parsed.sessionId ?? `http:${workDir}`;
      const session = await globalSessionManager.getOrCreate(sessionId, workDir);
      session.append({ role: "user", content: parsed.prompt });
      await engine.run(session);

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ reply: collected.join("\n") }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: msg }));
    }
  });

  server.listen(port, () => {
    console.log(`🚀 pico HTTP 模式监听 http://localhost:${port}/ask`);
    console.log(
      `试试: curl -X POST localhost:${port}/ask -H 'Content-Type: application/json' -d '{"prompt":"你好"}'`,
    );
  });
}

function readBody(req: import("node:http").IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
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
      prompt: { type: "string" },
      model: { type: "string" },
      "api-key": { type: "string" },
      "base-url": { type: "string" },
      serve: { type: "boolean", default: false },
      port: { type: "string", default: "3000" },
      feishu: { type: "boolean", default: false },
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

  console.log("🚀 欢迎来到 pico-harness 引擎启动序列");
  console.log(
    `[Provider] ${kind} 协议 | [ThinkingEffort] ${thinkingEffort} | [EnableThinking] ${enableThinking} | [PlanMode] ${planMode} | [Trace] ${traceEnabled}`,
  );

  if (values.feishu) {
    // 飞书模式:启动 WSClient 长连接,群里 @机器人 触发 Agent,状态发回会话
    const workDir = process.cwd();
    const systemPrompt = planMode ? undefined : await new PromptComposer(workDir).build();
    const modelName =
      process.env.LLM_MODEL ?? (kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet");
    // 预加载自定义角色:飞书 engineFactory 回调是同步的,await 必须提前到这里
    const feishuProfiles = await loadProfiles(workDir);
    const bot = new FeishuBot(
      ({ session, reporter }) => {
        const provider = createProvider(kind, undefined, thinkingEffort);
        const trackedProvider = new CostTracker(provider, modelName, session);
        const registry = buildRegistry(workDir);
        registry.use(createFeishuApprovalMiddleware(reporter));
        const engine = new AgentEngine({
          provider: trackedProvider,
          registry,
          workDir,
          enableThinking,
          thinkingEffort,
          planMode,
          systemPrompt,
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

  const task =
    values.prompt ??
    positionals[0] ??
    "请用 read_file 工具读取 README.md,然后用一句话总结这个项目是做什么的。";
  await runAgentFromCli({
    prompt: task,
    provider: kind,
    ...(values.dir ? { dir: values.dir } : {}),
    ...(values.session ? { session: values.session } : {}),
    ...(values.model ? { model: values.model } : {}),
    ...(values["api-key"] ? { apiKey: values["api-key"] } : {}),
    ...(values["base-url"] ? { baseURL: values["base-url"] } : {}),
    enableThinking,
    thinkingEffort,
    planMode,
    trace: traceEnabled,
  });
}

main().catch((err) => {
  console.error("引擎启动失败:", err);
  process.exit(1);
});
