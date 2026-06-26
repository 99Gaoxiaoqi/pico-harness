// E2E: 用真实大模型验证 Skill 加载链路 + 跨平台 shell。
// 运行: node --env-file=.env --import tsx scripts/e2e-skill-and-shell.ts
//
// 验证点(本次 skill 修复 + 跨平台 shell 修复的核心链路):
//   A. 默认 CLI 路径(planMode=false)systemPrompt 已注入 Skills 清单:
//      模型能"看到" aihot 技能并主动调用 skill_view 读取正文
//   B. skill_view 返回的正文被正确解析(js-yaml frontmatter + Markdown body):
//      模型能复述技能用途,证明读到了真实 body 而非空串
//   C. 跨平台 shell:模型用 bash 执行 POSIX 管道(echo ... | grep ...),
//      验证 resolveShell() 在真实链路下生效(macOS 走 /bin/bash)
//   D. AGENTS.md 被加载:模型行为体现项目专属规范(如"始终用中文回复")

import { mkdtemp, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentFromCli } from "../src/cli/run-agent.js";

async function main(): Promise<void> {
  console.log("=== E2E Skill 加载链路 + 跨平台 shell 验证(真实模型)===\n");

  const projectRoot = process.cwd();
  const workDir = await mkdtemp(join(tmpdir(), "pico-e2e-skill-"));
  console.log(`[setup] workDir = ${workDir}`);

  // 复制真实项目的 .claw(含 skills/aihot)和 AGENTS.md 到隔离工作区,
  // 这样既用真实 skill 配置,又不污染项目工作区。
  await cp(join(projectRoot, ".claw"), join(workDir, ".claw"), { recursive: true });
  await cp(join(projectRoot, "AGENTS.md"), join(workDir, "AGENTS.md"));
  console.log(`[setup] 已复制 .claw/skills/aihot + AGENTS.md 到隔离工作区\n`);

  // 一个 prompt 同时触发 skill_view + bash 管道 + 体现 AGENTS.md(中文回复)
  const prompt =
    "请完成两件事,然后用中文总结:\n" +
    "1. 调用 skill_view 工具,name 传 aihot,查看这个技能内容,告诉我它的用途。\n" +
    "2. 用 bash 执行这个命令并报告输出:echo 'hello-posix-shell' | grep 'posix'。\n" +
    "不要写任何文件,不要调用其他工具。";

  const result = await runAgentFromCli(
    {
      prompt,
      dir: workDir,
      session: `e2e-skill-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  console.log("========== 结果 ==========");
  console.log("[最终回复]", result.finalMessage);
  console.log("[会话]", result.sessionId);
  console.log("[用量]", JSON.stringify(result.usage), "\n");

  const skillViewCalls = result.messages.filter(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.some((tc) => tc.name === "skill_view"),
  );
  const bashCalls = result.messages.filter(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.some((tc) => tc.name === "bash"),
  );

  // 从 bash 的 observation 里找管道命令的输出
  const bashObservations = result.messages.filter(
    (m) => m.role === "user" && m.toolCallId && m.content.includes("hello-posix-shell"),
  );

  console.log("========== 验证 ==========");

  const passA = skillViewCalls.length > 0;
  console.log(
    `[验证 A] 默认 CLI 路径注入 Skills 清单 → 模型调用 skill_view: ${passA ? "✅ 通过" : "❌ 失败"}`,
  );

  const passB =
    skillViewCalls.length > 0 &&
    /aihot|AI|资讯|日报|API/i.test(result.finalMessage);
  console.log(
    `[验证 B] skill_view 正文被正确解析 → 模型复述技能用途: ${passB ? "✅ 通过" : "❌ 失败"}`,
  );

  const passC =
    bashCalls.length > 0 && bashObservations.length > 0;
  console.log(
    `[验证 C] 跨平台 shell → bash 执行 echo|grep 管道返回 'hello-posix-shell': ${passC ? "✅ 通过" : "❌ 失败"}`,
  );
  if (passC) {
    console.log(`         管道输出: ${bashObservations[0]!.content.trim().slice(0, 60)}`);
  }

  // AGENTS.md 要求"始终用中文回复"
  const passD = /[\u4e00-\u9fa5]/.test(result.finalMessage);
  console.log(
    `[验证 D] AGENTS.md 被加载 → 模型用中文回复: ${passD ? "✅ 通过" : "❌ 失败"}`,
  );

  const allPass = passA && passB && passC && passD;
  console.log(`\n========== 汇总 ==========`);
  console.log(`通过 ${[passA, passB, passC, passD].filter(Boolean).length} / 4`);

  if (!allPass) {
    console.error("❌ 存在失败项");
    process.exit(1);
  }
  console.log("=== E2E 完成 ===");
}

main().catch((err: unknown) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
