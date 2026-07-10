import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { computeApprovalDiff } from "../../src/approval/diff.js";

describe("computeApprovalDiff", () => {
  let workDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-approval-diff-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("edit_file 已存在文件 → diff 含 old_text/new_text", async () => {
    const filePath = join(workDir, "src.ts");
    writeFileSync(filePath, "line old\nline keep\n");

    const args = JSON.stringify({
      path: "src.ts",
      old_text: "line old",
      new_text: "line new",
    });

    const diff = await computeApprovalDiff("edit_file", args, workDir);

    expect(diff).toBeDefined();
    expect(diff!).toContain("line old");
    expect(diff!).toContain("line new");
    // diff 行以 `-`/`+` 前缀呈现变更
    expect(diff!).toMatch(/- line old/);
    expect(diff!).toMatch(/\+ line new/);
  });

  it("write_file 新建文件 → diff 全是 + 行(无删除)", async () => {
    const args = JSON.stringify({
      path: "new.txt",
      content: "hello\nworld\n",
    });

    const diff = await computeApprovalDiff("write_file", args, workDir);

    expect(diff).toBeDefined();
    expect(diff!).toContain("+ hello");
    expect(diff!).toContain("+ world");
    // 新建文件无旧行,不应出现 `-` 删除标记
    expect(diff).not.toContain("\n- ");
  });

  it("write_file 覆盖已存在文件 → diff 含 - 和 + 行", async () => {
    const filePath = join(workDir, "config.json");
    writeFileSync(filePath, "old content\n");

    const args = JSON.stringify({
      path: "config.json",
      content: "new content\n",
    });

    const diff = await computeApprovalDiff("write_file", args, workDir);

    expect(diff).toBeDefined();
    expect(diff!).toContain("- old content");
    expect(diff!).toContain("+ new content");
  });

  it("bash 重定向 `echo x > file.txt` → 识别目标文件,展示写入命令", async () => {
    const args = JSON.stringify({
      command: "echo hello > out.txt",
    });

    const diff = await computeApprovalDiff("bash", args, workDir);

    // 目标文件不存在 → old 为空;new 取重定向前命令文本(无法预执行,展示写入意图)
    expect(diff).toBeDefined();
    expect(diff!).toContain("+ echo hello");
  });

  it("bash 重定向到已存在文件 → 含旧内容删除与写入命令", async () => {
    const filePath = join(workDir, "out.txt");
    writeFileSync(filePath, "previous\n");

    const args = JSON.stringify({
      command: "echo fresh > out.txt",
    });

    const diff = await computeApprovalDiff("bash", args, workDir);

    expect(diff).toBeDefined();
    expect(diff!).toContain("- previous");
    expect(diff!).toContain("+ echo fresh");
  });

  it("bash 追加 `>>` 到新文件 → 不抛错,展示写入命令", async () => {
    const args = JSON.stringify({
      command: "echo appended >> log.txt",
    });

    const diff = await computeApprovalDiff("bash", args, workDir);

    expect(diff).toBeDefined();
    expect(diff!).toContain("+ echo appended");
  });

  it("bash 无重定向(如 rm) → 返回 undefined", async () => {
    const args = JSON.stringify({
      command: "rm -rf node_modules",
    });

    const diff = await computeApprovalDiff("bash", args, workDir);

    // rm 无写入目标,无法计算 diff
    expect(diff).toBeUndefined();
  });

  it("文件不存在场景 → 不抛错", async () => {
    const args = JSON.stringify({
      path: "nonexistent-deep/dir/missing.ts",
      old_text: "a",
      new_text: "b",
    });

    await expect(computeApprovalDiff("edit_file", args, workDir)).resolves.not.toThrow();
    const diff = await computeApprovalDiff("edit_file", args, workDir);
    // edit_file 用参数里的 old/new 直接算,文件读不到也不影响 diff
    expect(diff).toBeDefined();
  });

  it("参数非法 JSON → 返回 undefined 不抛错", async () => {
    await expect(
      computeApprovalDiff("edit_file", "{not valid json", workDir),
    ).resolves.toBeUndefined();
    await expect(computeApprovalDiff("write_file", "garbage", workDir)).resolves.toBeUndefined();
    await expect(computeApprovalDiff("bash", "", workDir)).resolves.toBeUndefined();
  });

  it("未知工具 → 返回 undefined", async () => {
    const args = JSON.stringify({ foo: "bar" });
    const diff = await computeApprovalDiff("read_file", args, workDir);
    expect(diff).toBeUndefined();
  });
});
