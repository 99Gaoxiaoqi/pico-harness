// cmd 入口:tiny-claw 引擎启动序列。
// 第 09 讲:引擎 I/O 解耦,支持 CLI 与 HTTP Server 两种入口。
// 用法:
//   CLI 模式:tsx --env-file=.env src/cli/main.ts --provider openai "你的任务"
//   HTTP 模式:tsx --env-file=.env src/cli/main.ts --serve --port 3000
//             然后:curl -X POST localhost:3000/ask -H 'Content-Type: application/json' -d '{"prompt":"..."}'

import { parseArgs } from "node:util";
import { createServer } from "node:http";
import { AgentEngine } from "../engine/loop.js";
import { globalSessionManager } from "../engine/session.js";
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

function buildRegistry(workDir: string): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new BashTool(workDir));
  return registry;
}

/** 控制台入口的 SessionId:以工作目录路径为标识,重启后可恢复 */
function consoleSessionId(workDir: string): string {
  return `console:${workDir}`;
}

async function runOnce(kind: ProviderKind, enableThinking: boolean, task: string): Promise<void> {
  const provider = createProvider(kind);
  const workDir = process.cwd();
  const registry = buildRegistry(workDir);
  const systemPrompt = await new PromptComposer(workDir).build();
  const engine = new AgentEngine({
    provider,
    registry,
    workDir,
    enableThinking,
    systemPrompt,
    reporter: new TerminalReporter(),
  });
  // 从全局 SessionManager 取/建会话:CLI 模式以工作目录为 sessionId
  const session = globalSessionManager.getOrCreate(consoleSessionId(workDir), workDir);
  session.append({ role: "user", content: task });
  console.log("开始执行任务...\n");
  await engine.run(session);
}

/** HTTP Server 模式:接收外部事件流触发 Agent (等价于飞书 webhook 入口) */
async function serve(kind: ProviderKind, enableThinking: boolean, port: number): Promise<void> {
  const workDir = process.cwd();
  const systemPrompt = await new PromptComposer(workDir).build();
  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/ask") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "请 POST 到 /ask,body: {\"prompt\":\"...\"}" }));
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
      const engine = new AgentEngine({
        provider,
        registry,
        workDir,
        enableThinking,
        systemPrompt,
        reporter,
      });

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
    console.log(`试试: curl -X POST localhost:${port}/ask -H 'Content-Type: application/json' -d '{"prompt":"你好"}'`);
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
      serve: { type: "boolean", default: false },
      port: { type: "string", default: "3000" },
      feishu: { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const kind = values.provider as ProviderKind;
  const enableThinking = values.thinking !== "false";

  console.log("🚀 欢迎来到 tiny-claw-harness 引擎启动序列");
  console.log(`[Provider] ${kind} 协议 | [Thinking] ${enableThinking}`);

  if (values.feishu) {
    // 飞书模式:启动 WSClient 长连接,群里 @机器人 触发 Agent,状态发回会话
    const workDir = process.cwd();
    const provider = createProvider(kind);
    const registry = buildRegistry(workDir);
    const systemPrompt = await new PromptComposer(workDir).build();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      enableThinking,
      systemPrompt,
      reporter: new SilentReporter(), // 实际回写由运行时 FeishuReporter 负责
    });
    // 飞书每个 chatId 对应独立 Session,实现多群物理隔离
    const bot = new FeishuBot(engine, loadFeishuConfig(), workDir);
    bot.start();
    return;
  }

  if (values.serve) {
    await serve(kind, enableThinking, Number(values.port));
    return;
  }

  const task =
    positionals[0] ?? "请用 read_file 工具读取 README.md,然后用一句话总结这个项目是做什么的。";
  await runOnce(kind, enableThinking, task);
}

main().catch((err) => {
  console.error("引擎启动失败:", err);
  process.exit(1);
});
