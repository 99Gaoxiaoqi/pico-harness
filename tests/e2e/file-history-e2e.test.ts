import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry, WriteFileTool, EditFileTool } from "../../src/tools/registry-impl.js";
import {
  createFileHistoryState,
  fileHistoryTrackEdit,
  fileHistoryMakeSnapshot,
  resolveBackupPath,
} from "../../src/safety/file-history.js";

describe("FileHistory 1.5.5 集成到工具系统", () => {
  let workDir: string;
  let baseDir: string;
  const sessionId = "test-session-005";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-e2e-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe("ToolRegistry preWriteHook", () => {
    it("preWriteHook 在 tool.execute 前调用", async () => {
      const registry = new ToolRegistry();
      registry.register(new WriteFileTool(workDir));

      let hookTool = "";
      let hookArgs = "";
      registry.setPreWriteHook(async (toolName, args) => {
        hookTool = toolName;
        hookArgs = args;
      });

      await registry.execute({
        id: "c1",
        name: "write_file",
        arguments: JSON.stringify({ path: "test.txt", content: "hello" }),
      });

      expect(hookTool).toBe("write_file");
      expect(hookArgs).toContain("test.txt");
    });

    it("preWriteHook 失败不阻止工具执行", async () => {
      const registry = new ToolRegistry();
      registry.register(new WriteFileTool(workDir));

      registry.setPreWriteHook(async () => {
        throw new Error("hook boom");
      });

      const result = await registry.execute({
        id: "c1",
        name: "write_file",
        arguments: JSON.stringify({ path: "test.txt", content: "hello" }),
      });

      expect(result.isError).toBe(false);
      expect(existsSync(join(workDir, "test.txt"))).toBe(true);
    });

    it("通过 preWriteHook 触发 trackEdit 备份", async () => {
      const registry = new ToolRegistry();
      const state = createFileHistoryState();
      registry.register(new WriteFileTool(workDir));

      registry.setPreWriteHook(async (toolName, args) => {
        if (toolName !== "write_file" && toolName !== "edit_file") return;
        const { path } = JSON.parse(args) as { path?: string };
        if (!path) return;
        const fullPath = join(workDir, path);
        await fileHistoryTrackEdit(state, fullPath, "m1", sessionId, baseDir);
      });

      writeFileSync(join(workDir, "existing.txt"), "original\n");

      await registry.execute({
        id: "c1",
        name: "write_file",
        arguments: JSON.stringify({ path: "existing.txt", content: "modified" }),
      });

      expect(state.trackedFiles.has(join(workDir, "existing.txt"))).toBe(true);

      await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);
      const snap = state.snapshots[0]!;
      const backup = snap.trackedFileBackups.get(join(workDir, "existing.txt"));
      expect(backup).toBeDefined();
      expect(backup!.backupFileName).not.toBeNull();

      const backupPath = resolveBackupPath(sessionId, backup!.backupFileName!, baseDir);
      expect(readFileSync(backupPath, "utf8")).toBe("original\n");
    });

    it("edit_file 通过 preWriteHook 触发 trackEdit", async () => {
      const registry = new ToolRegistry();
      const state = createFileHistoryState();
      registry.register(new EditFileTool(workDir));

      registry.setPreWriteHook(async (toolName, args) => {
        if (toolName !== "write_file" && toolName !== "edit_file") return;
        const { path } = JSON.parse(args) as { path?: string };
        if (!path) return;
        const fullPath = join(workDir, path);
        await fileHistoryTrackEdit(state, fullPath, "m1", sessionId, baseDir);
      });

      writeFileSync(join(workDir, "file.ts"), "line1\nline2\n");

      await registry.execute({
        id: "c1",
        name: "edit_file",
        arguments: JSON.stringify({
          path: "file.ts",
          old_text: "line1",
          new_text: "LINE1",
        }),
      });

      expect(state.trackedFiles.has(join(workDir, "file.ts"))).toBe(true);
      expect(readFileSync(join(workDir, "file.ts"), "utf8")).toContain("LINE1");
    });

    it("无 preWriteHook 时工具正常执行", async () => {
      const registry = new ToolRegistry();
      registry.register(new WriteFileTool(workDir));

      const result = await registry.execute({
        id: "c1",
        name: "write_file",
        arguments: JSON.stringify({ path: "test.txt", content: "hello" }),
      });

      expect(result.isError).toBe(false);
      expect(readFileSync(join(workDir, "test.txt"), "utf8")).toBe("hello");
    });
  });
});
