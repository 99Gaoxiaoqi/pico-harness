// cmd 入口:tiny-claw 引擎启动序列。
// 第 04 讲:接入真实 Provider (OpenAI / Claude 双协议),用 echo 工具端到端真跑。
// 用法:tsx --env-file=.env src/cli/main.ts --provider openai "你的任务"

import { parseArgs } from "node:util";
import { AgentEngine } from "../engine/loop.js";
import { createProvider, type ProviderKind } from "../provider/factory.js";
import { EchoTool, ReadFileTool, ToolRegistry } from "../tools/registry-impl.js";

async function main() {
  const { values, positionals } = parseArgs({
    options: {
      provider: { type: "string", default: "openai" },
      thinking: { type: "string", default: "true" },
    },
    allowPositionals: true,
  });

  const kind = values.provider as ProviderKind;
  const enableThinking = values.thinking !== "false";
  const task =
    positionals[0] ??
    "请用 read_file 工具读取 README.md,然后用一句话总结这个项目是做什么的。";

  console.log("🚀 欢迎来到 tiny-claw-harness 引擎启动序列");
  console.log(`[Provider] ${kind} 协议 | [Thinking] ${enableThinking}`);

  const provider = createProvider(kind);
  const registry = new ToolRegistry();
  registry.register(new EchoTool());
  registry.register(new ReadFileTool(process.cwd()));

  const engine = new AgentEngine({
    provider,
    registry,
    workDir: process.cwd(),
    enableThinking,
  });

  console.log("开始执行任务...\n");
  await engine.run(task);
}

main().catch((err) => {
  console.error("引擎启动失败:", err);
  process.exit(1);
});
