// edit-hint 单测 + EditFileTool 匹配失败错误增强集成测试。
// 覆盖:findClosestLines 相似段定位 / 完全不相似 / top N 限制;
// formatCandidateHint 格式化; EditFileTool catch 块附候选(含 gating:多处匹配不附)。

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findClosestLines, formatCandidateHint } from "../src/tools/edit-hint.js";
import type { CandidateHint } from "../src/tools/edit-hint.js";
import { EditFileTool } from "../src/tools/registry-impl.js";

describe("findClosestLines 相似段定位", () => {
  it("文件里有相似段时能找到,并带上下文与行号预览", () => {
    const content = [
      'import { foo } from "bar";',
      "",
      "function calculateTotal(items) {",
      "  let total = 0;",
      "  for (const item of items) {",
      "    total += item.price;",
      "  }",
      "  return total;",
      "}",
      "",
      "export { calculateTotal };",
    ].join("\n");
    // 模型记错版本:逐行 trim 后不同(calculateSum vs calculateTotal),但字符高度相似
    const oldText = [
      "function calculateSum(items) {",
      "  let sum = 0;",
      "  for (const item of items) {",
      "    sum += item.cost;",
      "  }",
      "  return sum;",
    ].join("\n");

    const hints = findClosestLines(content, oldText);

    expect(hints.length).toBeGreaterThanOrEqual(1);
    // 最高分候选应落在 calculateTotal 函数体附近
    const best = hints[0]!;
    expect(best.similarity).toBeGreaterThan(0.5);
    expect(best.preview).toContain("calculateTotal");
    // 预览带行号前缀
    expect(best.preview).toMatch(/\d+ \| /);
    // 行号区间合法
    expect(best.lineStart).toBeGreaterThanOrEqual(1);
    expect(best.lineEnd).toBeGreaterThan(best.lineStart);
  });

  it("完全不相似时返回空数组", () => {
    const content = "aaa\nbbb\nccc";
    const oldText = "zzzzz\nyyyyy";
    // 字符集无交集,Dice 系数全为 0,低于 0.3 阈值
    const hints = findClosestLines(content, oldText);
    expect(hints).toEqual([]);
  });

  it("限制最多返回 maxResults 个候选", () => {
    // 5 行相同文本,每个单行窗口都高度相似
    const content = "foo bar\nfoo bar\nfoo bar\nfoo bar\nfoo bar";
    const oldText = "foo baz"; // 仅末尾字符不同,Dice 高
    const hints = findClosestLines(content, oldText, 2, 2);
    expect(hints.length).toBeLessThanOrEqual(2);
    // 每个候选相似度都应高于阈值
    for (const h of hints) {
      expect(h.similarity).toBeGreaterThan(0.3);
    }
  });

  it("oldText 或 content 为空时返回空数组", () => {
    expect(findClosestLines("", "abc")).toEqual([]);
    expect(findClosestLines("abc", "")).toEqual([]);
    expect(findClosestLines("", "")).toEqual([]);
  });

  it("oldText 行数超过 content 行数时返回空", () => {
    const hints = findClosestLines("only one line", "first\nsecond\nthird");
    expect(hints).toEqual([]);
  });
});

describe("formatCandidateHint 格式化", () => {
  it("空列表返回空串", () => {
    expect(formatCandidateHint([])).toBe("");
  });

  it("单个候选含提示语、行号区间与预览(无分隔符)", () => {
    const hints: CandidateHint[] = [
      {
        lineStart: 3,
        lineEnd: 5,
        preview: "3 | a\n4 | b\n5 | c",
        similarity: 0.8,
      },
    ];
    const out = formatCandidateHint(hints);
    expect(out).toContain("你是否想编辑以下位置之一?");
    expect(out).toContain("第 3-5 行:");
    expect(out).toContain("3 | a");
    expect(out).toContain("4 | b");
    expect(out).toContain("5 | c");
    // 单个候选不应出现分隔符
    expect(out).not.toContain("---");
  });

  it("多个候选用分隔符连接", () => {
    const hints: CandidateHint[] = [
      { lineStart: 1, lineEnd: 2, preview: "1 | x\n2 | y", similarity: 0.7 },
      { lineStart: 5, lineEnd: 6, preview: "5 | p\n6 | q", similarity: 0.6 },
    ];
    const out = formatCandidateHint(hints);
    expect(out).toContain("第 1-2 行:");
    expect(out).toContain("第 5-6 行:");
    expect(out).toContain("---");
  });

  it("预览行缩进对齐(每行前补 4 空格)", () => {
    const hints: CandidateHint[] = [
      { lineStart: 1, lineEnd: 1, preview: "1 | hello", similarity: 0.9 },
    ];
    const out = formatCandidateHint(hints);
    // 预览行应缩进 4 空格
    expect(out).toContain("\n    1 | hello");
  });
});

describe("EditFileTool 匹配失败错误增强(集成)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-hint-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("匹配全失败且字符相似时,错误信息附候选提示", async () => {
    const fileContent = [
      'import { foo } from "bar";',
      "",
      "function calculateTotal(items) {",
      "  let total = 0;",
      "  for (const item of items) {",
      "    total += item.price;",
      "  }",
      "  return total;",
      "}",
      "",
      "export { calculateTotal };",
    ].join("\n");
    await writeFile(join(workDir, "calc.ts"), fileContent);

    const oldText = [
      "function calculateSum(items) {",
      "  let sum = 0;",
      "  for (const item of items) {",
      "    sum += item.cost;",
      "  }",
      "  return sum;",
    ].join("\n");

    const tool = new EditFileTool(workDir);
    // 原错误信息保留,且拼接了候选提示(含 calculateTotal 预览)
    await expect(
      tool.execute(JSON.stringify({ path: "calc.ts", old_text: oldText, new_text: "x" })),
    ).rejects.toThrow(/未找到 old_text[\s\S]*你是否想编辑以下位置之一[\s\S]*calculateTotal/);
  });

  it("完全不相似时不附候选(只保留原错误)", async () => {
    await writeFile(join(workDir, "f.txt"), "aaa\nbbb\nccc");
    const tool = new EditFileTool(workDir);
    const call = () =>
      tool.execute(JSON.stringify({ path: "f.txt", old_text: "zzzzz\nyyyyy", new_text: "x" }));
    await expect(call()).rejects.toThrow(/未找到 old_text/);
    await expect(call()).rejects.not.toThrow(/你是否想编辑以下位置之一/);
  });

  it("多处匹配错误不附候选(避免误导)", async () => {
    await writeFile(join(workDir, "d.txt"), "dup\ndup\nother");
    const tool = new EditFileTool(workDir);
    const call = () =>
      tool.execute(JSON.stringify({ path: "d.txt", old_text: "dup", new_text: "x" }));
    await expect(call()).rejects.toThrow(/匹配到了.*处/);
    await expect(call()).rejects.not.toThrow(/你是否想编辑以下位置之一/);
  });

  it("文件不存在等 IO 错误不被误增强", async () => {
    const tool = new EditFileTool(workDir);
    // readFile 失败抛 ENOENT,不含"未找到 old_text",不应附候选
    await expect(
      tool.execute(JSON.stringify({ path: "no-such.txt", old_text: "a", new_text: "b" })),
    ).rejects.toThrow();
  });
});
