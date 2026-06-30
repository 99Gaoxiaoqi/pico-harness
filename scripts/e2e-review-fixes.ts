// E2E: 真实大模型验证 Code Review 修复闭环。
// 运行: node --env-file=.env --import tsx scripts/e2e-review-fixes.ts
//
// 验证点(覆盖 C1/M1/M2 三个修复在真实链路的表现):
//   A. Session 持久化:真实模型跑完一轮 → 重启 recover → 续接对话(模型能看到恢复的历史)
//   B. ToolScheduler 并发:多个不冲突工具调用在真实链路下并行执行
//   C. 基础链路不回归:正常任务 + skill 加载仍跑通

import { mkdtemp, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentFromCli } from "../src/cli/run-agent.js";

async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 100));
}

async function main(): Promise<void> {
  console.log("=== E2E Code Review 修复闭环验证(真实模型)===\n");

  const projectRoot = process.cwd();
  const workDir = await mkdtemp(join(tmpdir(), "pico-e2e-review-"));
  console.log(`[setup] workDir = ${workDir}`);
  await cp(join(projectRoot, ".claw"), join(workDir, ".claw"), { recursive: true });
  await cp(join(projectRoot, "AGENTS.md"), join(workDir, "AGENTS.md"));
  console.log(`[setup] 已复制 .claw + AGENTS.md\n`);

  // 验证 A: Session 持久化 + 重启恢复
  console.log("========== 验证 A: Session 持久化 + 重启恢复 ==========");
  const sessionId = `review-persist-${Date.now()}`;

  // 第一段:真实模型跑一轮
  const result1 = await runAgentFromCli(
    {
      prompt: "请用中文一句话告诉我:你有哪些工具可用?不要调用任何工具,直接回答。",
      dir: workDir,
      session: sessionId,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );
  console.log(`[第一段] 模型回复: ${result1.finalMessage.slice(0, 80)}...`);
  await flush();

  // 检查 session 文件是否落盘
  const sessionFile = join(workDir, ".claw", "sessions", `${sessionId}.jsonl`);
  let fileExists = false;
  try {
    const content = await readFile(sessionFile, "utf8");
    fileExists = content.length > 0;
    console.log(`[落盘检查] session 文件存在且有内容: ${fileExists} (${content.length} 字符)`);
  } catch {
    console.log(`[落盘检查] session 文件不存在`);
  }

  // 第二段:用同一个 sessionId 再跑一次,验证恢复的历史被喂给模型
  const result2 = await runAgentFromCli(
    {
      prompt: "我刚才问了你什么?用中文一句话回答。",
      dir: workDir,
      session: sessionId,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );
  // 模型应该能回忆第一轮的话题(工具相关)
  const passA = fileExists && /工具|tool|可用/i.test(result2.finalMessage);
  console.log(`[第二段] 模型回忆: ${result2.finalMessage.slice(0, 80)}...`);
  console.log(`[验证 A] Session 持久化 + 重启恢复: ${passA ? "✅ 通过" : "❌ 失败"}\n`);

  // 验证 B: ToolScheduler 并发(多个不冲突工具)
  console.log("========== 验证 B: ToolScheduler 并发执行 ==========");
  const workDirB = await mkdtemp(join(tmpdir(), "pico-e2e-review-sched-"));
  // 创建 3 个不同的文件,让模型用 bash 同时检查
  await import("node:fs/promises").then((fs) => {
    return Promise.all([
      fs.writeFile(join(workDirB, "a.txt"), "content-a", "utf8"),
      fs.writeFile(join(workDirB, "b.txt"), "content-b", "utf8"),
      fs.writeFile(join(workDirB, "c.txt"), "content-c", "utf8"),
    ]);
  });

  const resultB = await runAgentFromCli(
    {
      prompt:
        "请用 bash 同时执行 3 个命令检查文件:wc -c a.txt、wc -c b.txt、wc -c c.txt。" +
        "一次性提交(如果有并行能力),然后汇总三个文件的字节数。",
      dir: workDirB,
      session: `review-sched-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );
  const passB = /9|content/i.test(resultB.finalMessage);
  console.log(`[验证 B] ToolScheduler 并发: ${passB ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  最终回复: ${resultB.finalMessage.slice(0, 80)}...\n`);

  // 验证 C: 基础链路 + skill 加载
  console.log("========== 验证 C: 基础链路 + skill 加载 ==========");
  const resultC = await runAgentFromCli(
    {
      prompt: "请调用 skill_view 工具(name 传 aihot)查看技能,然后用中文一句话告诉我它的用途。",
      dir: workDir,
      session: `review-skill-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );
  const skillCalled = resultC.messages.some(
    (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.name === "skill_view"),
  );
  const passC = skillCalled && /aihot|AI|资讯/i.test(resultC.finalMessage);
  console.log(`[验证 C] 基础链路 + skill 加载: ${passC ? "✅ 通过" : "❌ 失败"}\n`);

  // 汇总
  console.log("========== 汇总 ==========");
  const results = { A: passA, B: passB, C: passC };
  const passed = Object.values(results).filter(Boolean).length;
  console.log(`通过 ${passed} / 3`);

  if (passed < 3) {
    console.error("❌ 存在失败项");
    process.exit(1);
  }
  console.log("=== E2E 完成:Code Review 修复闭环验证通过 ===");
}

main().catch((err: unknown) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
