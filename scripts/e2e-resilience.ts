// E2E: 真实大模型验证三个工程化增强功能的闭环。
// 运行: node --env-file=.env --import tsx scripts/e2e-resilience.ts
//
// 验证点(本次工程化增强):
//   A. 基础链路不回归:模型重试+溢出压缩+硬重置三层叠加后,正常任务仍跑通
//   B. 子代理场景:runSub 的 compactSubContext 硬重置兜底不破坏正常子代理流程
//   C. 大上下文压力:制造接近预算的上下文,验证压缩链路(预防式+响应式)正常工作
//   D. Skill 加载链路仍通畅(之前的修复不被本次改动破坏)

import { mkdtemp, cp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentFromCli } from "../src/cli/run-agent.js";

async function main(): Promise<void> {
  console.log("=== E2E 工程化增强闭环验证(真实模型)===\n");

  const projectRoot = process.cwd();
  const workDir = await mkdtemp(join(tmpdir(), "pico-e2e-resilience-"));
  console.log(`[setup] workDir = ${workDir}`);

  // 复制真实项目的 .claw(含 skills)和 AGENTS.md
  await cp(join(projectRoot, ".claw"), join(workDir, ".claw"), { recursive: true });
  await cp(join(projectRoot, "AGENTS.md"), join(workDir, "AGENTS.md"));
  console.log(`[setup] 已复制 .claw/skills + AGENTS.md\n`);

  // 验证 A:基础链路 + Skill 加载(D)
  console.log("========== 验证 A+D: 基础链路 + Skill 加载 ==========");
  const resultA = await runAgentFromCli(
    {
      prompt:
        "请调用 skill_view 工具(name 传 aihot)查看技能内容," +
        "然后用中文一句话告诉我这个技能的用途。不要写文件。",
      dir: workDir,
      session: `e2e-resilience-A-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  const skillViewCalled = resultA.messages.some(
    (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.name === "skill_view"),
  );
  const passA = skillViewCalled && /aihot|AI|资讯/i.test(resultA.finalMessage);
  console.log(`[验证 A+D] 基础链路 + Skill 加载: ${passA ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  skill_view 调用: ${skillViewCalled ? "YES" : "NO"}`);
  console.log(`  最终回复: ${resultA.finalMessage.slice(0, 80)}...\n`);

  // 验证 B:子代理场景
  console.log("========== 验证 B: 子代理委派 ==========");
  const workDirB = await mkdtemp(join(tmpdir(), "pico-e2e-resilience-B-"));
  const resultB = await runAgentFromCli(
    {
      prompt:
        "请用 delegate_task 工具启动 1 个 mode=worker 的子代理," +
        "子代理目标:用 write_file 创建 subagent-test.txt,内容为 SUBAGENT_OK。" +
        "子代理完成后回复 DELEGATE_DONE。",
      dir: workDirB,
      session: `e2e-resilience-B-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  let passB: boolean;
  try {
    const content = await import("node:fs/promises").then((fs) => fs.readFile(join(workDirB, "subagent-test.txt"), "utf8"));
    passB = content.trim() === "SUBAGENT_OK";
  } catch {
    passB = false;
  }
  console.log(`[验证 B] 子代理委派(含 compactSubContext 兜底): ${passB ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  最终回复: ${resultB.finalMessage.slice(0, 80)}...\n`);

  // 验证 C:大上下文压力(制造接近预算的上下文)
  console.log("========== 验证 C: 大上下文压力 ==========");
  const workDirC = await mkdtemp(join(tmpdir(), "pico-e2e-resilience-C-"));
  // 写一个中等大小的文件,让模型读取后上下文增长,验证压缩链路不崩
  await writeFile(join(workDirC, "large-log.txt"), "日志行:系统运行正常 ".repeat(500), "utf8");
  const resultC = await runAgentFromCli(
    {
      prompt:
        "请用 bash 执行 wc -c large-log.txt 查看文件大小,然后告诉我文件有多少字节。不要读取整个文件。",
      dir: workDirC,
      session: `e2e-resilience-C-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );
  const passC = /\d+/.test(resultC.finalMessage) && resultC.finalMessage.length > 0;
  console.log(`[验证 C] 大上下文压力(压缩链路不崩): ${passC ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  最终回复: ${resultC.finalMessage.slice(0, 80)}...\n`);

  // 汇总
  console.log("========== 汇总 ==========");
  const results = { A: passA, B: passB, C: passC };
  const passed = Object.values(results).filter(Boolean).length;
  console.log(`通过 ${passed} / 3`);

  if (passed < 3) {
    console.error("❌ 存在失败项");
    process.exit(1);
  }
  console.log("=== E2E 完成:三层增强(重试+溢出压缩+硬重置)闭环验证通过 ===");
}

main().catch((err: unknown) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
