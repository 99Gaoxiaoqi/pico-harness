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
import { createFeishuApprovalMiddleware, FeishuBot, loadFeishuConfig } from "../feishu/bot.js";
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
import { runAgentFromCli } from "./run-agent.js";

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
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
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
  const enableThinking = values.thinking !== "false";
  const planMode = values.plan;
  const traceEnabled = values.trace;

  console.log("🚀 欢迎来到 pico-harness 引擎启动序列");
  console.log(
    `[Provider] ${kind} 协议 | [Thinking] ${enableThinking} | [PlanMode] ${planMode} | [Trace] ${traceEnabled}`,
  );

  if (values.feishu) {
    // 飞书模式:启动 WSClient 长连接,群里 @机器人 触发 Agent,状态发回会话
    const workDir = process.cwd();
    const systemPrompt = planMode ? undefined : await new PromptComposer(workDir).build();
    const modelName =
      process.env.LLM_MODEL ?? (kind === "openai" ? "glm-5.2" : "claude-3-5-sonnet");
    const bot = new FeishuBot(
      ({ session, reporter }) => {
        const provider = createProvider(kind);
        const trackedProvider = new CostTracker(provider, modelName, session);
        const registry = buildRegistry(workDir);
        registry.use(createFeishuApprovalMiddleware(reporter));
        const engine = new AgentEngine({
          provider: trackedProvider,
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
        return engine;
      },
      loadFeishuConfig(),
      workDir,
    );
    bot.start();
    return;
  }

  if (values.serve) {
    await serve(kind, enableThinking, planMode, traceEnabled, Number(values.port));
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
    planMode,
    trace: traceEnabled,
  });
}

main().catch((err) => {
  console.error("引擎启动失败:", err);
  process.exit(1);
});
