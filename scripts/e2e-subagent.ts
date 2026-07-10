// E2E: 用真实大模型验证子代理 artifact 回传 + summary 续写。
// 运行: node --env-file=.env --import tsx scripts/e2e-subagent.ts
//
// 验证点:
//   A. 子代理读大文件(>4000字)触发外部化后,回传主 agent 的文本含 artifact 路径
//   B. 主 agent 据此路径用 read_file 能回查到原文(跨上下文回查缺口已补)
//   C. summary 续写: 子代理若给出过短 summary 会触发扩写(<200字)

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentEngine } from "../src/engine/loop.js";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { createToolResultObservationProcessor } from "../src/tools/tool-result-observation.js";
import { ToolRegistry, ReadFileTool, BashTool, WriteFileTool } from "../src/tools/registry-impl.js";
import { createRawProvider } from "../src/provider/factory.js";
import { SilentReporter } from "../src/engine/reporter.js";
import { SpawnSubagentTool } from "../src/tools/subagent.js";

async function main() {
  console.log("=== E2E 子代理 artifact 回传 + summary 续写验证 ===\n");

  // 1. 隔离工作区
  const workDir = await mkdtemp(join(tmpdir(), "pico-e2e-sub-"));
  console.log(`[setup] workDir = ${workDir}`);

  // 2. 造一个大文件(>4000 字符,触发 observationProcessor 外部化)
  const bigContent = "这是第 X 行的测试数据,用于撑大文件体积触发外部化机制。\n".repeat(200);
  await writeFile(join(workDir, "big-log.txt"), bigContent, "utf8");
  console.log(`[setup] big-log.txt = ${bigContent.length} 字符 (应 >4000 触发外部化)\n`);

  // 3. 装配真实 provider + 引擎
  const provider = createRawProvider("openai");
  const observationProcessor = createToolResultObservationProcessor({
    store: new ToolResultArtifactStore({ baseDir: join(workDir, ".claw", "artifacts") }),
  });

  const mainRegistry = new ToolRegistry({ truncateResults: false });
  mainRegistry.register(new ReadFileTool(workDir));
  mainRegistry.register(new BashTool(workDir));
  mainRegistry.register(new WriteFileTool(workDir));

  const readOnlyReg = new ToolRegistry({ truncateResults: false });
  readOnlyReg.register(new ReadFileTool(workDir));
  readOnlyReg.register(new BashTool(workDir));

  const engine = new AgentEngine({
    provider,
    registry: mainRegistry,
    workDir,
    enableThinking: false,
    observationProcessor,
    reporter: new SilentReporter(),
  });

  // 注册 spawn_subagent,其 runner 就是 engine
  mainRegistry.register(new SpawnSubagentTool(engine, readOnlyReg));

  // 4. 直接调 runSub 模拟"子代理读大文件"(绕过主循环,聚焦验证 runSub 本身)
  console.log("[step 1] 直接调 runSub,让子代理读 big-log.txt...\n");
  const taskPrompt =
    "请用 read_file 读取当前工作区下的 big-log.txt 文件,了解其内容规模和结构," +
    "然后简要总结。不要读取其他文件。";

  const result = await engine.runSub(taskPrompt, readOnlyReg, undefined, {
    depth: 0,
    maxSpawnDepth: 2,
    role: "leaf",
  });

  console.log("========== runSub 返回结果 ==========");
  console.log("[summary 长度]", result.summary.length, "字");
  console.log(
    "[summary 内容]",
    result.summary.slice(0, 500),
    result.summary.length > 500 ? "..." : "",
  );
  console.log("[artifacts 数量]", result.artifacts.length);
  console.log("[artifacts 列表]", result.artifacts);

  // 5. 验证点 A: artifacts 非空(子代理读大文件应触发外部化并被收集)
  const passedA = result.artifacts.length > 0;
  console.log("\n========== 验证 ==========");
  console.log(
    `[验证 A] artifact 路径被收集回主 agent: ${passedA ? "✅ 通过" : "❌ 失败(未触发外部化或提取失败)"}`,
  );

  // 6. 验证点 B: 主 agent 用 read_file 能读到 artifact 路径指向的原文
  if (passedA) {
    const artifactPath = result.artifacts[0]!;
    // 用绝对路径或相对 workDir 都试;ReadFileTool 的 safeResolve 接受两者
    try {
      const readBack = await new ReadFileTool(workDir).execute(
        JSON.stringify({ path: artifactPath }),
      );
      // 外部化的内容应是原始工具输出(含 big-log 内容)
      const containsOriginal = readBack.includes("测试数据");
      console.log(
        `[验证 B] 主 agent read_file 回查 artifact 原文: ${containsOriginal ? "✅ 通过" : "❌ 读到但内容不符"}`,
      );
      console.log(`         回查内容前 80 字: ${readBack.slice(0, 80).replace(/\n/g, " ")}`);
    } catch (err) {
      console.log(
        `[验证 B] 主 agent read_file 回查 artifact 原文: ❌ 失败 - ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // 7. 验证点 C: summary 续写(若 summary < 200,续写应已扩写)
  const passedC = result.summary.length >= 200;
  console.log(
    `[验证 C] summary 续写(>=200字): ${passedC ? "✅ 通过" : "⚠️ 仍 <200 字(模型可能未遵从扩写指令)"}`,
  );

  console.log("\n=== E2E 完成 ===");
}

main().catch((err) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
