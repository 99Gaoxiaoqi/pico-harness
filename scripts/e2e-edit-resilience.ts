// E2E: 真实大模型验证 edit 工具改造(模型视图 + 缩进重对齐 + 候选提示)。
// 运行: node --env-file=.env --import tsx scripts/e2e-edit-resilience.ts
//
// 验证点:
//   A. CRLF 文件:模型 read_file → edit_file → 写回后仍是 CRLF(格式不破坏)
//   B. 缩进不一致:文件 4 空格,模型可能用 2 空格编辑,验证写回缩进对齐文件风格
//   C. 基础链路:正常 LF 文件编辑不回归

import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgentFromCli } from "../src/cli/run-agent.js";

async function main(): Promise<void> {
  console.log("=== E2E edit 工具改造验证(真实模型)===\n");

  // 验证 A: CRLF 文件编辑后格式保持
  console.log("========== 验证 A: CRLF 文件格式保持 ==========");
  const workDirA = await mkdtemp(join(tmpdir(), "pico-e2e-edit-crlf-"));
  const crlfPath = join(workDirA, "crlf-code.ts");
  const crlfContent = "function greet(name) {\r\n  return 'hello ' + name;\r\n}\r\n";
  await writeFile(crlfPath, crlfContent, "utf8");
  const isCrlfBefore = crlfContent.includes("\r\n");
  console.log(`[setup] crlf-code.ts 写入 CRLF 内容,行尾含 \\r\\n: ${isCrlfBefore}`);

  const resultA = await runAgentFromCli(
    {
      prompt:
        "请先 read_file 读取 crlf-code.ts,然后用 edit_file 把 'hello' 改成 'hi'。" +
        "只改这一处,完成后告诉我改了什么。",
      dir: workDirA,
      session: `e2e-edit-crlf-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  const afterA = await readFile(crlfPath, "utf8");
  const isCrlfAfter = afterA.includes("\r\n");
  const hasHi = afterA.includes("hi");
  const passA = isCrlfAfter && hasHi;
  console.log(`[验证 A] CRLF 文件编辑后: ${passA ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  编辑前 CRLF: ${isCrlfBefore},编辑后 CRLF: ${isCrlfAfter},含 hi: ${hasHi}`);
  console.log(`  最终回复: ${resultA.finalMessage.slice(0, 80)}...\n`);

  // 验证 B: 缩进不一致(文件 4 空格,引导模型用 2 空格编辑)
  console.log("========== 验证 B: 缩进重对齐 ==========");
  const workDirB = await mkdtemp(join(tmpdir(), "pico-e2e-edit-indent-"));
  const indentPath = join(workDirB, "indent-code.py");
  // 文件用 4 空格缩进
  const indentContent = "def calculate_total(items):\n    total = 0\n    for item in items:\n        total += item\n    return total\n";
  await writeFile(indentPath, indentContent, "utf8");
  console.log(`[setup] indent-code.py 写入 4 空格缩进`);

  await runAgentFromCli(
    {
      prompt:
        "请先 read_file 读取 indent-code.py,然后用 edit_file 把 'total = 0' 改成 'total = 0  # 初始化'。" +
        "只改这一处,完成后告诉我改了什么。",
      dir: workDirB,
      session: `e2e-edit-indent-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  const afterB = await readFile(indentPath, "utf8");
  // 验证:改动的行保留了 4 空格缩进(行首 4 空格),不是 2 空格
  // 用行首精确匹配,避免 4 空格含 2 空格子串的误判
  const lines = afterB.split("\n");
  const editedLine = lines.find((l) => l.includes("# 初始化"));
  const has4SpaceAfter = editedLine !== undefined && editedLine.startsWith("    total = 0");
  const has2SpaceBad = editedLine !== undefined && editedLine.startsWith("  total = 0") && !editedLine.startsWith("    total");
  const passB = has4SpaceAfter && !has2SpaceBad;
  console.log(`[验证 B] 缩进重对齐: ${passB ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  改动行: "${editedLine ?? "(未找到)"}"`);
  console.log(`  4空格行首: ${has4SpaceAfter},2空格错写: ${has2SpaceBad}\n`);

  // 验证 C: 正常 LF 文件编辑不回归
  console.log("========== 验证 C: LF 文件正常编辑 ==========");
  const workDirC = await mkdtemp(join(tmpdir(), "pico-e2e-edit-lf-"));
  const lfPath = join(workDirC, "lf-code.ts");
  await writeFile(lfPath, "export const x = 1;\nexport const y = 2;\n", "utf8");

  const resultC = await runAgentFromCli(
    {
      prompt:
        "请先 read_file 读取 lf-code.ts,然后用 edit_file 把 'export const x = 1' 改成 'export const x = 100'。" +
        "完成后告诉我改了什么。",
      dir: workDirC,
      session: `e2e-edit-lf-${Date.now()}`,
      provider: "openai",
      enableThinking: false,
      planMode: false,
    },
    { write: () => undefined },
  );

  const afterC = await readFile(lfPath, "utf8");
  const passC = afterC.includes("export const x = 100") && !afterC.includes("\r\n");
  console.log(`[验证 C] LF 文件正常编辑: ${passC ? "✅ 通过" : "❌ 失败"}`);
  console.log(`  含 x=100: ${afterC.includes("export const x = 100")},无 CRLF: ${!afterC.includes("\r\n")}`);
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
  console.log("=== E2E 完成:edit 工具改造(视图+缩进重对齐)闭环验证通过 ===");
}

main().catch((err: unknown) => {
  console.error("\n[E2E 失败]", err);
  process.exit(1);
});
