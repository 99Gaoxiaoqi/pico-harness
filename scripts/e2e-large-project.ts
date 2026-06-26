// E2E: 真实大模型在中型项目上做"探索+理解+编辑+验证"完整任务。
// 运行: node --env-file=.env --import tsx scripts/e2e-large-project.ts
//
// 测试目标: pico-harness 项目本身(44 源文件/9000 行/11 模块)
// 任务: 给 ReadFileTool 加 offset/limit 可选参数(支持读部分文件)
//
// 验证点(覆盖 edit 工具改造在真实场景的表现):
//   A. 探索能力: 模型能找到 src/tools/registry-impl.ts 的 ReadFileTool
//   B. 理解能力: 模型能读懂现有 execute 实现(含视图归一化)
//   C. 编辑能力: edit_file 成功修改(考验 L1-L4 + 视图 + 缩进重对齐)
//   D. 自验证: 模型用 bash 跑 tsc --noEmit 确认编译通过
//   E. 不破坏: 改动后 typecheck 仍通过(不引入类型错误)

import { mkdtemp, cp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execSync } from "node:child_process";
import { runAgentFromCli } from "../src/cli/run-agent.js";

async function main(): Promise<void> {
  console.log("=== E2E 中型项目端到端验证(真实模型)===\n");

  const projectRoot = process.cwd();
  const workDir = await mkdtemp(join(tmpdir(), "pico-large-test-"));
  console.log(`[setup] 工作区副本 = ${workDir}`);

  // 复制整个项目(除 node_modules/.git/dist 等大目录)到临时副本
  // 这样模型在真实项目结构上工作,但不污染原项目
  await cp(join(projectRoot, "src"), join(workDir, "src"), { recursive: true });
  await cp(join(projectRoot, "tests"), join(workDir, "tests"), { recursive: true });
  await cp(join(projectRoot, "package.json"), join(workDir, "package.json"));
  await cp(join(projectRoot, "package-lock.json"), join(workDir, "package-lock.json"));
  await cp(join(projectRoot, "tsconfig.json"), join(workDir, "tsconfig.json"));
  await cp(join(projectRoot, "vitest.config.ts"), join(workDir, "vitest.config.ts"));
  await cp(join(projectRoot, "AGENTS.md"), join(workDir, "AGENTS.md"));
  await cp(join(projectRoot, ".claw"), join(workDir, ".claw"), { recursive: true });
  // node_modules 用软链接避免重复安装(类型检查需要)
  try {
    execSync(`ln -s "${join(projectRoot, "node_modules")}" "${join(workDir, "node_modules")}"`, { stdio: "ignore" });
  } catch {
    console.log("[setup] node_modules 软链接失败,跳过(可能影响 typecheck)");
  }
  console.log(`[setup] 已复制 src/tests/配置/AGENTS.md/.claw 到副本\n`);

  const targetFile = join(workDir, "src/tools/registry-impl.ts");
  const beforeContent = await readFile(targetFile, "utf8");
  console.log(`[setup] 目标文件 registry-impl.ts 大小: ${beforeContent.length} 字符`);

  const result = await runAgentFromCli(
    {
      prompt:
        "这是一个 TypeScript Agent Harness 项目。请完成以下任务:\n" +
        "1. 先用 bash 运行 ls src/tools/ 了解工具目录结构\n" +
        "2. 用 read_file 读取 src/tools/registry-impl.ts,找到 ReadFileTool 类\n" +
        "3. 给 ReadFileTool 的 definition 和 execute 加两个可选参数: offset(从第几行开始读,默认1) 和 limit(读几行,默认全部)。execute 里根据这两个参数截取行范围(在加行号前缀之前截取)\n" +
        "4. 用 edit_file 修改代码(可能需要多次 edit)\n" +
        "5. 用 bash 运行 npx tsc --noEmit 确认编译通过。如果有类型错误就修复\n" +
        "6. 完成后用中文告诉我:改了哪些地方、typecheck 结果",
      dir: workDir,
      session: `large-test-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  console.log("\n========== 结果 ==========");
  console.log("[最终回复]", result.finalMessage.slice(0, 300));
  console.log("[会话]", result.sessionId);
  console.log("[用量]", JSON.stringify(result.usage), "\n");

  // 验证 A: 模型是否探索了项目(bash ls 被调用)
  const bashCalls = result.messages.filter(
    (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.name === "bash"),
  );
  const passA = bashCalls.length > 0;
  console.log("========== 验证 ==========");
  console.log(`[验证 A] 探索能力(bash ls 被调用): ${passA ? "✅ 通过" : "❌ 失败"} (${bashCalls.length} 次 bash)`);

  // 验证 B: 模型是否读取了目标文件
  const readCalls = result.messages.filter(
    (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.name === "read_file"),
  );
  const passB = readCalls.length > 0;
  console.log(`[验证 B] 理解能力(read_file 被调用): ${passB ? "✅ 通过" : "❌ 失败"} (${readCalls.length} 次)`);

  // 验证 C: edit_file 是否成功(文件被修改)
  const editCalls = result.messages.filter(
    (m) => m.role === "assistant" && Array.isArray(m.toolCalls) && m.toolCalls.some((tc) => tc.name === "edit_file"),
  );
  const afterContent = await readFile(targetFile, "utf8");
  const fileChanged = beforeContent !== afterContent;
  // 检查是否真的加了 offset/limit 参数
  const hasOffset = /offset/.test(afterContent);
  const hasLimit = /limit/.test(afterContent);
  const passC = fileChanged && hasOffset && hasLimit;
  console.log(`[验证 C] 编辑能力(edit_file 成功 + 含 offset/limit): ${passC ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  edit 调用 ${editCalls.length} 次,文件已改: ${fileChanged},含 offset: ${hasOffset},含 limit: ${hasLimit}`);

  // 验证 D: 模型是否跑了 typecheck(检查 bash 工具调用的参数,而非 observation)
  const typecheckRun = result.messages.some(
    (m) =>
      m.role === "assistant" &&
      Array.isArray(m.toolCalls) &&
      m.toolCalls.some((tc) => tc.name === "bash" && /tsc|typecheck|--noEmit/i.test(tc.arguments)),
  );
  const passD = typecheckRun;
  console.log(`[验证 D] 自验证(模型跑了 tsc): ${passD ? "✅ 通过" : "❌ 失败"}`);

  // 验证 E: 真实 typecheck 是否通过(在副本里独立跑)
  let passE = false;
  try {
    execSync("npx tsc --noEmit", { cwd: workDir, stdio: "pipe", timeout: 60000 });
    passE = true;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? "";
    console.log(`  [typecheck stderr]: ${stderr.slice(0, 300)}`);
  }
  console.log(`[验证 E] 不破坏(typecheck 真实通过): ${passE ? "✅ 通过" : "❌ 失败"}`);

  // 汇总
  console.log("\n========== 汇总 ==========");
  const results = { A: passA, B: passB, C: passC, D: passD, E: passE };
  const passed = Object.values(results).filter(Boolean).length;
  console.log(`通过 ${passed} / 5`);

  if (passed < 5) {
    console.error("❌ 存在失败项");
    process.exit(1);
  }
  console.log("=== E2E 完成:中型项目探索+编辑+验证闭环通过 ===");
}

main().catch((err: unknown) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
