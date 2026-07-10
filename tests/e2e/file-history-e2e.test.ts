import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir, homedir } from "node:os";
import type { LLMProvider } from "../../src/provider/interface.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import {
  ToolRegistry,
  WriteFileTool,
  EditFileTool,
  BashTool,
} from "../../src/tools/registry-impl.js";
import {
  createFileHistoryState,
  fileHistoryTrackEdit,
  fileHistoryMakeSnapshot,
  resolveBackupPath,
} from "../../src/safety/file-history.js";

describe("FileHistory 1.5.5 集成到工具系统", () => {
  let workDir: string;
  let baseDir: string;
  let sessionId: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-e2e-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
    sessionId = `test-session-005-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
    rmSync(join(homedir(), ".pico", "file-history", sessionId), { recursive: true, force: true });
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

    it("bash 重定向通过 loop preWriteHook 备份所有目标", async () => {
      const firstPath = join(workDir, "first.txt");
      const secondPath = join(workDir, "second.txt");
      writeFileSync(firstPath, "original first");
      writeFileSync(secondPath, "original second");

      const registry = new ToolRegistry();
      registry.register(new BashTool(workDir));
      let calls = 0;
      const provider: LLMProvider = {
        async generate() {
          calls++;
          if (calls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "bash-1",
                  name: "bash",
                  arguments: JSON.stringify({
                    command: "printf replaced > first.txt; printf appended >> second.txt",
                  }),
                },
              ],
            };
          }
          return { role: "assistant", content: "done" };
        },
      };
      const session = new Session(sessionId, workDir, { persistence: false });
      session.append({ role: "user", content: "run bash redirects" });
      const engine = new AgentEngine({ provider, registry, workDir, maxTurns: 3 });

      await engine.run(session);

      expect(session.fileHistory.trackedFiles.has(firstPath)).toBe(true);
      expect(session.fileHistory.trackedFiles.has(secondPath)).toBe(true);
      const firstSnapshot = session.fileHistory.snapshots.find((snapshot) =>
        snapshot.trackedFileBackups.has(firstPath),
      );
      expect(firstSnapshot).toBeDefined();
      const firstBackup = firstSnapshot!.trackedFileBackups.get(firstPath);
      const secondBackup = firstSnapshot!.trackedFileBackups.get(secondPath);
      expect(firstBackup?.backupFileName).toBeDefined();
      expect(secondBackup?.backupFileName).toBeDefined();
      expect(readFileSync(resolveBackupPath(sessionId, firstBackup!.backupFileName!), "utf8")).toBe(
        "original first",
      );
      expect(
        readFileSync(resolveBackupPath(sessionId, secondBackup!.backupFileName!), "utf8"),
      ).toBe("original second");
      expect(readFileSync(firstPath, "utf8")).toBe("replaced");
      expect(readFileSync(secondPath, "utf8")).toBe("original secondappended");
    });

    it("write_file 路径越界被拒绝后不会跟踪或回滚工作区外文件", async () => {
      const outsidePath = join(workDir, "..", "outside-write.txt");
      writeFileSync(outsidePath, "outside original");

      const registry = new ToolRegistry();
      registry.register(new WriteFileTool(workDir));
      let calls = 0;
      const provider: LLMProvider = {
        async generate() {
          calls++;
          if (calls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "write-outside",
                  name: "write_file",
                  arguments: JSON.stringify({
                    path: "../outside-write.txt",
                    content: "should not write",
                  }),
                },
              ],
            };
          }
          return { role: "assistant", content: "done" };
        },
      };
      const session = new Session(`${sessionId}-outside-write`, workDir, { persistence: false });
      session.append({ role: "user", content: "try outside write" });
      const engine = new AgentEngine({ provider, registry, workDir, maxTurns: 3 });

      await engine.run(session);
      writeFileSync(outsidePath, "outside changed after denied tool");
      const firstSnapshotId = session.fileHistory.snapshots[0]?.messageId;
      if (firstSnapshotId) {
        await session.rewindCode(firstSnapshotId);
      }

      expect(session.fileHistory.trackedFiles.has(outsidePath)).toBe(false);
      expect(readFileSync(outsidePath, "utf8")).toBe("outside changed after denied tool");
      rmSync(outsidePath, { force: true });
    });

    it("edit_file 路径越界被拒绝后不会跟踪或回滚工作区外文件", async () => {
      const outsidePath = join(workDir, "..", "outside-edit.txt");
      writeFileSync(outsidePath, "outside original");

      const registry = new ToolRegistry();
      registry.register(new EditFileTool(workDir));
      let calls = 0;
      const provider: LLMProvider = {
        async generate() {
          calls++;
          if (calls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "edit-outside",
                  name: "edit_file",
                  arguments: JSON.stringify({
                    path: "../outside-edit.txt",
                    old_text: "outside",
                    new_text: "inside",
                  }),
                },
              ],
            };
          }
          return { role: "assistant", content: "done" };
        },
      };
      const session = new Session(`${sessionId}-outside-edit`, workDir, { persistence: false });
      session.append({ role: "user", content: "try outside edit" });
      const engine = new AgentEngine({ provider, registry, workDir, maxTurns: 3 });

      await engine.run(session);
      writeFileSync(outsidePath, "outside changed after denied edit");
      const firstSnapshotId = session.fileHistory.snapshots[0]?.messageId;
      if (firstSnapshotId) {
        await session.rewindCode(firstSnapshotId);
      }

      expect(session.fileHistory.trackedFiles.has(outsidePath)).toBe(false);
      expect(readFileSync(outsidePath, "utf8")).toBe("outside changed after denied edit");
      rmSync(outsidePath, { force: true });
    });

    it("同一 session 多次 engine.run 生成唯一快照 id", async () => {
      const registry = new ToolRegistry();
      registry.register(new WriteFileTool(workDir));
      let calls = 0;
      const provider: LLMProvider = {
        async generate() {
          calls++;
          if (calls === 1) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "write-a",
                  name: "write_file",
                  arguments: JSON.stringify({ path: "a.txt", content: "a" }),
                },
              ],
            };
          }
          if (calls === 3) {
            return {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "write-b",
                  name: "write_file",
                  arguments: JSON.stringify({ path: "b.txt", content: "b" }),
                },
              ],
            };
          }
          return { role: "assistant", content: "done" };
        },
      };
      const session = new Session(`${sessionId}-unique`, workDir, { persistence: false });
      const engine = new AgentEngine({ provider, registry, workDir, maxTurns: 3 });

      session.append({ role: "user", content: "first run" });
      await engine.run(session);
      session.append({ role: "user", content: "second run" });
      await engine.run(session);

      const ids = session.fileHistory.snapshots.map((snapshot) => snapshot.messageId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toEqual(["turn-1", "turn-2", "turn-3", "turn-4"]);
    });
  });
});
