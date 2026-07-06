import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ToolRegistry,
  ReadFileTool,
  WriteFileTool,
  EditFileTool,
  generateSimpleDiff,
} from "../../src/tools/registry-impl.js";

describe("Diff 预览", () => {
  let workDir: string;
  let registry: ToolRegistry;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-diff-"));
    registry = new ToolRegistry();
    registry.register(new ReadFileTool(workDir));
    registry.register(new WriteFileTool(workDir));
    registry.register(new EditFileTool(workDir));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("edit_file 返回结果包含 diff 预览", async () => {
    writeFileSync(join(workDir, "test.ts"), "function hello() {\n  return 1;\n}\n");

    const result = await registry.execute({
      id: "c1",
      name: "edit_file",
      arguments: JSON.stringify({
        path: "test.ts",
        old_text: "return 1;",
        new_text: "return 42;",
      }),
    });

    expect(result.output).toContain("修改前");
    expect(result.output).toContain("修改后");
    expect(result.output).toContain("- return 1;");
    expect(result.output).toContain("+ return 42;");
  });

  it("write_file 新建文件标记新建", async () => {
    const result = await registry.execute({
      id: "c2",
      name: "write_file",
      arguments: JSON.stringify({
        path: "new.ts",
        content: "export const x = 1;\n",
      }),
    });

    expect(result.output).toContain("新建");
    expect(result.output).toContain("new.ts");
  });

  it("write_file 覆盖已有文件标记覆盖", async () => {
    writeFileSync(join(workDir, "old.ts"), "old\n");

    const result = await registry.execute({
      id: "c3",
      name: "write_file",
      arguments: JSON.stringify({
        path: "old.ts",
        content: "new\n",
      }),
    });

    expect(result.output).toContain("覆盖");
    expect(result.output).toContain("old.ts");
  });

  it("generateSimpleDiff 单行替换", () => {
    const diff = generateSimpleDiff("a\nb\nc", "a\nB\nc");
    expect(diff).toContain("- b");
    expect(diff).toContain("+ B");
  });

  it("generateSimpleDiff 多行变更", () => {
    const diff = generateSimpleDiff("a\nb\nc\nd\ne", "a\nB\nC\nd\ne");
    expect(diff).toContain("- b");
    expect(diff).toContain("- c");
    expect(diff).toContain("+ B");
    expect(diff).toContain("+ C");
  });

  it("generateSimpleDiff 完全替换", () => {
    const diff = generateSimpleDiff("old", "new");
    expect(diff).toContain("- old");
    expect(diff).toContain("+ new");
  });

  it("generateSimpleDiff 截断过长 diff", () => {
    const oldText = Array.from({ length: 50 }, (_, i) => `old_${i}`).join("\n");
    const newText = Array.from({ length: 50 }, (_, i) => `new_${i}`).join("\n");
    const diff = generateSimpleDiff(oldText, newText);
    expect(diff).toContain("已截断");
  });
});
