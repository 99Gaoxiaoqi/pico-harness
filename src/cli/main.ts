// cmd 入口:tiny-claw 引擎启动序列。
// 第 09 讲:引擎 I/O 解耦,支持 CLI 与 HTTP Server 两种入口。
// 第 13 讲:新增 --plan 开关,开启 Plan Mode 引导长程任务读写 PLAN.md/TODO.md。
// 用法:
//   CLI 模式:tsx --env-file=.env src/cli/main.ts --provider openai "你的任务"
//   Trace 模式:tsx --env-file=.env src/cli/main.ts --trace "你的任务"
//   Plan 模式:tsx --env-file=.env src/cli/main.ts --plan "搭建一个极简 Web Server 项目"
//   HTTP 模式:tsx --env-file=.env src/cli/main.ts --serve --port 3000
//             然后:curl -X POST localhost:3000/ask -H 'Content-Type: application/json' -d '{"prompt":"..."}'

import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { AgentEngine } from "../engine/loop.js";
import { globalSessionManager } from "../engine/session.js";
import { Compactor } from "../context/compactor.js";
import { SilentReporter, TerminalReporter } from "../engine/reporter.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import {
  BashTool,
  EditFileTool,
  EchoTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "../tools/registry-impl.js";
import { FeishuBot, loadFeishuConfig } from "../feishu/bot.js";
import { PromptComposer } from "../context/composer.js";
import {
  globalApprovalManager,
  isDangerousCommand,
  type ApprovalNotifier,
} from "../approval/manager.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import { SubagentTool } from "../tools/subagent.js";
import { CostTracker } from "../observability/tracker.js";
import { Tracer } from "../observability/trace.js";

function buildRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new BashTool(workDir));
  return registry;
}

/**
 * 构建子智能体专属的只读注册表(爆炸半径限制)。
 * 子智能体只能读文件/执行只读 bash 搜索,绝对不能 write/edit,防莽夫瞎改。
 */
function buildReadOnlyRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool(workDir));
  registry.register(new BashTool(workDir));
  return registry;
}

/**
 * 构建上下文压缩器:防 OOM 的物理防线。
 * 水位线 20000 字符(约 5K token,留足模型输出空间),保护区最近 6 条消息。
 */
function buildCompactor(): Compactor {
  return new Compactor({ maxChars: 20000, retainLastMsgs: 6 });
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
    if (!isDangerousCommand(call.name, call.arguments)) {
      return { allowed: true, reason: "" }; // 未命中黑名单,YOLO 放行
    }
    // 命中高危特征 → 挂起执行流,等待人类审批
    const { allowed, reason } = await globalApprovalManager.waitForApproval(
      call.id,
      call.name,
      call.arguments,
      notifier,
    );
    return { allowed, reason };
  };
}

/** 终端通知器:CLI/HTTP 模式回退,打印审批请求到控制台 */
const terminalNotifier: ApprovalNotifier = (notice) => {
  console.warn(`\n\x1b[31m[需要审批 TaskID: ${notice.taskId}]\x1b[0m ${notice.message}\n`);
};

/** 控制台入口的 SessionId:以工作目录路径为标识,重启后可恢复 */
function consoleSessionId(workDir: string): string {
  return `console:${workDir}`;
}

async function runOnce(
  kind: ProviderKind,
  enableThinking: boolean,
  planMode: boolean,
  traceEnabled: boolean,
  task: string,
): Promise<void> {
  const workDir = process.cwd();
  // 先取/建会话,以便 CostTracker 持有 session 引用做累计统计
  const session = globalSessionManager.getOrCreate(consoleSessionId(workDir), workDir);

  const provider = createProvider(kind);
  // 第 18 讲:用 CostTracker 装饰 provider,追踪每轮 Token 成本与耗时(对引擎透明)
  const trackedProvider = new CostTracker(
    provider,
    kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet",
    session,
  );

  const registry = buildRegistry(workDir);
  registry.use(buildApprovalMiddleware(terminalNotifier));
  // Plan Mode 开启时由引擎每次 run 动态组装 System Prompt(反映最新工作区状态);
  // 关闭时预构建一次,避免每轮重复读盘。
  const systemPrompt = planMode ? undefined : await new PromptComposer(workDir).build();
  const engine = new AgentEngine({
    provider: trackedProvider,
    registry,
    workDir,
    enableThinking,
    planMode,
    systemPrompt,
    compactor: buildCompactor(),
    reporter: new TerminalReporter(),
    tracer: traceEnabled ? new Tracer() : undefined,
  });
  // 第 17 讲:注册子智能体工具,让主 Agent 能派出探路者干脏活(仅只读工具)
  registry.register(new SubagentTool(engine, buildReadOnlyRegistry(workDir)));
  session.append({ role: "user", content: task });
  console.log("开始执行任务...\n");
  await engine.run(session);

  // 第 18 讲:任务结束打印财务报表
  console.log("\n================ 财务报表 ================");
  console.log(`会话 ID: ${session.id}`);
  console.log(`总消耗 Input Tokens: ${session.totalPromptTokens}`);
  console.log(`总消耗 Output Tokens: ${session.totalCompletionTokens}`);
  console.log(`总计费用 (CNY): ¥${session.totalCostCNY.toFixed(6)}`);
  console.log("==========================================");
}

/** HTTP Server 模式:接收外部事件流触发 Agent (等价于飞书 webhook 入口) */
async function serve(
  kind: ProviderKind,
  enableThinking: boolean,
  planMode: boolean,
  traceEnabled: boolean,
  port: number,
): Promise<void> {
  const workDir = process.cwd();
  const systemPrompt = planMode ? undefined : await new PromptComposer(workDir).build();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/ask") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: '请 POST 到 /ask,body: {"prompt":"..."}' }));
      return;
    }

    try {
      const body = await readBody(req);
      const parsed = JSON.parse(body) as { prompt?: string; sessionId?: string };
      if (!parsed.prompt) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "缺少 prompt 字段" }));
        return;
      }

      // 每个请求独立引擎实例,收集最终消息回写
      const collected: string[] = [];
      const reporter = new (class extends TerminalReporter {
        override onMessage(content: string): void {
          collected.push(content);
        }
      })();

      const provider = createProvider(kind);
      const registry = buildRegistry(workDir);
      registry.use(buildApprovalMiddleware(terminalNotifier));
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        enableThinking,
        planMode,
        systemPrompt,
        compactor: buildCompactor(),
        reporter,
        tracer: traceEnabled ? new Tracer() : undefined,
      });
      registry.register(new SubagentTool(engine, buildReadOnlyRegistry(workDir)));

      // HTTP 入口:可选传入 sessionId 实现多会话隔离,缺省用单一控制台会话
      const sessionId = parsed.sessionId ?? `http:${workDir}`;
      const session = globalSessionManager.getOrCreate(sessionId, workDir);
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
    console.log(`🚀 tiny-claw HTTP 模式监听 http://localhost:${port}/ask`);
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
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
      thinking: { type: "string", default: "true" },
      plan: { type: "boolean", default: false },
      trace: { type: "boolean", default: false },
      serve: { type: "boolean", default: false },
      port: { type: "string", default: "3000" },
      feishu: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const kind = values.provider as ProviderKind;
  const enableThinking = values.thinking !== "false";
  const planMode = values.plan;
  const traceEnabled = values.trace;

  console.log("🚀 欢迎来到 tiny-claw-harness 引擎启动序列");
  console.log(
    `[Provider] ${kind} 协议 | [Thinking] ${enableThinking} | [PlanMode] ${planMode} | [Trace] ${traceEnabled}`,
  );

  if (values.feishu) {
    // 飞书模式:启动 WSClient 长连接,群里 @机器人 触发 Agent,状态发回会话
    const workDir = process.cwd();
    const provider = createProvider(kind);
    const registry = buildRegistry(workDir);
    const systemPrompt = planMode ? undefined : await new PromptComposer(workDir).build();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      enableThinking,
      planMode,
      systemPrompt,
      compactor: buildCompactor(),
      reporter: new SilentReporter(), // 实际回写由运行时 FeishuReporter 负责
      tracer: traceEnabled ? new Tracer() : undefined,
    });
    // 第 17 讲:注册子智能体工具(仅只读工具,爆炸半径限制)
    registry.register(new SubagentTool(engine, buildReadOnlyRegistry(workDir)));
    // 飞书每个 chatId 对应独立 Session,实现多群物理隔离
    const bot = new FeishuBot(engine, loadFeishuConfig(), workDir, registry);
    bot.start();
    return;
  }

  if (values.serve) {
    await serve(kind, enableThinking, planMode, traceEnabled, Number(values.port));
    return;
  }

  const task =
    positionals[0] ?? "请用 read_file 工具读取 README.md,然后用一句话总结这个项目是做什么的。";
  await runOnce(kind, enableThinking, planMode, traceEnabled, task);
}

main().catch((err) => {
  console.error("引擎启动失败:", err);
  process.exit(1);
});
