import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  getBackupFileName,
  resolveBackupPath,
  createBackup,
  restoreBackup,
  createFileHistoryState,
  fileHistoryTrackEdit,
  fileHistoryMakeSnapshot,
  fileHistoryRewind,
  fileHistoryDiffStat,
  fileHistoryLoadState,
  type FileHistoryState,
} from "../../src/safety/file-history.js";

describe("FileHistory 1.5.1 数据结构与存储层", () => {
  let workDir: string;
  let baseDir: string;
  const sessionId = "test-session-001";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-src-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  describe("getBackupFileName", () => {
    it("返回格式为 sha256[:16]@v{version}", () => {
      const name = getBackupFileName("/abs/path/to/file.ts", 1);
      expect(name).toMatch(/^[0-9a-f]{16}@v1$/);
    });

    it("version 递增时后缀变化", () => {
      const v1 = getBackupFileName("/abs/path/to/file.ts", 1);
      const v2 = getBackupFileName("/abs/path/to/file.ts", 2);
      expect(v1).toMatch(/@v1$/);
      expect(v2).toMatch(/@v2$/);
      expect(v1.slice(0, 16)).toBe(v2.slice(0, 16));
    });

    it("不同路径产生不同哈希前缀", () => {
      const a = getBackupFileName("/abs/path/a.ts", 1);
      const b = getBackupFileName("/abs/path/b.ts", 1);
      expect(a.slice(0, 16)).not.toBe(b.slice(0, 16));
    });

    it("同一输入确定性输出", () => {
      const a = getBackupFileName("/abs/path/to/file.ts", 3);
      const b = getBackupFileName("/abs/path/to/file.ts", 3);
      expect(a).toBe(b);
    });
  });

  describe("resolveBackupPath", () => {
    it("路径含 backupFileName 且以 baseDir 开头,sessionId 段为 hash 目录名", () => {
      const name = "abc123def456ghi7@v1";
      const p = resolveBackupPath(sessionId, name, baseDir);
      expect(p).toContain(name);
      expect(p.startsWith(baseDir)).toBe(true);
      // sessionId 经 hash 落盘,原始 sessionId 不应出现在路径中(避免特殊字符问题)
      expect(p).not.toContain(sessionId);
      // 目录段为 32 位 hex(跨平台安全)
      const rel = p.slice(baseDir.length + 1).split(/[\\/]/)[0]!;
      expect(rel).toMatch(/^[0-9a-f]{32}$/);
    });

    it("默认 baseDir 为 ~/.pico/file-history", () => {
      const p = resolveBackupPath(sessionId, "x@v1");
      expect(p).toContain(".pico");
      expect(p).toContain("file-history");
    });
  });

  describe("createBackup", () => {
    it("创建备份文件,内容与源文件一致", async () => {
      const src = join(workDir, "hello.ts");
      writeFileSync(src, "export const x = 1;\n");

      const backupName = await createBackup(src, 1, sessionId, baseDir);
      expect(backupName).toMatch(/^[0-9a-f]{16}@v1$/);

      const backupPath = resolveBackupPath(sessionId, backupName, baseDir);
      expect(existsSync(backupPath)).toBe(true);
      expect(readFileSync(backupPath, "utf8")).toBe("export const x = 1;\n");
    });

    it("保留源文件权限", async () => {
      const src = join(workDir, "script.sh");
      writeFileSync(src, "echo hi\n", { mode: 0o755 });

      const backupName = await createBackup(src, 1, sessionId, baseDir);
      const backupPath = resolveBackupPath(sessionId, backupName, baseDir);

      const srcMode = statSync(src).mode & 0o777;
      const backupMode = statSync(backupPath).mode & 0o777;
      expect(srcMode).toBe(backupMode);
      expect(srcMode).toBe(0o755);
    });

    it("源文件不存在时 throw ENOENT", async () => {
      const missing = join(workDir, "no-such-file.ts");
      await expect(createBackup(missing, 1, sessionId, baseDir)).rejects.toThrow();
    });

    it("lazy mkdir: 备份目录不存在时自动创建", async () => {
      const src = join(workDir, "fresh.ts");
      writeFileSync(src, "fresh content\n");

      const backupName = await createBackup(src, 1, sessionId, baseDir);
      const backupPath = resolveBackupPath(sessionId, backupName, baseDir);
      expect(existsSync(backupPath)).toBe(true);
    });

    it("lazy mkdir: 目录已存在时不报错", async () => {
      mkdirSync(join(baseDir, sessionId), { recursive: true });

      const src = join(workDir, "existing.ts");
      writeFileSync(src, "content\n");

      const backupName = await createBackup(src, 1, sessionId, baseDir);
      const backupPath = resolveBackupPath(sessionId, backupName, baseDir);
      expect(existsSync(backupPath)).toBe(true);
    });
  });

  describe("restoreBackup", () => {
    it("从备份恢复文件,内容一致", async () => {
      const src = join(workDir, "data.txt");
      writeFileSync(src, "original\n");

      const backupName = await createBackup(src, 1, sessionId, baseDir);

      writeFileSync(src, "modified\n");
      expect(readFileSync(src, "utf8")).toBe("modified\n");

      await restoreBackup(src, backupName, sessionId, baseDir);
      expect(readFileSync(src, "utf8")).toBe("original\n");
    });

    it("恢复时保留备份文件的权限", async () => {
      const src = join(workDir, "run.sh");
      writeFileSync(src, "echo hi\n", { mode: 0o755 });

      const backupName = await createBackup(src, 1, sessionId, baseDir);

      writeFileSync(src, "echo bye\n", { mode: 0o644 });

      await restoreBackup(src, backupName, sessionId, baseDir);
      expect(statSync(src).mode & 0o777).toBe(0o755);
    });

    it("目标父目录不存在时自动创建", async () => {
      const src = join(workDir, "nested", "deep", "file.txt");
      mkdirSync(join(workDir, "nested", "deep"), { recursive: true });
      writeFileSync(src, "nested content\n");

      const backupName = await createBackup(src, 1, sessionId, baseDir);

      rmSync(join(workDir, "nested"), { recursive: true, force: true });
      expect(existsSync(src)).toBe(false);

      await restoreBackup(src, backupName, sessionId, baseDir);
      expect(existsSync(src)).toBe(true);
      expect(readFileSync(src, "utf8")).toBe("nested content\n");
    });
  });
});

describe("FileHistory 1.5.2 写前备份 trackEdit", () => {
  let workDir: string;
  let baseDir: string;
  const sessionId = "test-session-002";
  let state: FileHistoryState;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-src-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
    state = createFileHistoryState();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("文件存在时备份修改前内容", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "original\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);

    const backupName = getBackupFileName(src, 1);
    const backupPath = resolveBackupPath(sessionId, backupName, baseDir);
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe("original\n");
  });

  it("同文件同 messageId 第二次跳过", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "v1\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);

    writeFileSync(src, "v2\n");
    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);

    const v1 = resolveBackupPath(sessionId, getBackupFileName(src, 1), baseDir);
    const v2 = resolveBackupPath(sessionId, getBackupFileName(src, 2), baseDir);
    expect(existsSync(v1)).toBe(true);
    expect(existsSync(v2)).toBe(false);
  });

  it("不同 messageId 创建新版本", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "v1\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);

    writeFileSync(src, "v2\n");
    await fileHistoryTrackEdit(state, src, "m2", sessionId, baseDir);

    const v1 = resolveBackupPath(sessionId, getBackupFileName(src, 1), baseDir);
    const v2 = resolveBackupPath(sessionId, getBackupFileName(src, 2), baseDir);
    expect(existsSync(v1)).toBe(true);
    expect(readFileSync(v1, "utf8")).toBe("v1\n");
    expect(existsSync(v2)).toBe(true);
    expect(readFileSync(v2, "utf8")).toBe("v2\n");
  });

  it("文件不存在时不报错且加入 trackedFiles", async () => {
    const missing = join(workDir, "no-such-file.ts");

    await expect(fileHistoryTrackEdit(state, missing, "m1", sessionId, baseDir)).resolves.toBeUndefined();

    expect(state.trackedFiles.has(missing)).toBe(true);
  });

  it("加入 trackedFiles", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "content\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);

    expect(state.trackedFiles.has(src)).toBe(true);
  });
});

describe("FileHistory 1.5.3 每轮快照 makeSnapshot", () => {
  let workDir: string;
  let baseDir: string;
  const sessionId = "test-session-003";
  let state: FileHistoryState;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-src-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
    state = createFileHistoryState();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("trackEdit 过的文件用 pendingTrackEdits 的修改前备份", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "original\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);

    writeFileSync(src, "modified\n");

    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    expect(state.snapshots).toHaveLength(1);
    const snap = state.snapshots[0]!;
    const backup = snap.trackedFileBackups.get(src);
    expect(backup).toBeDefined();
    expect(backup!.backupFileName).not.toBeNull();

    const backupPath = resolveBackupPath(sessionId, backup!.backupFileName!, baseDir);
    expect(readFileSync(backupPath, "utf8")).toBe("original\n");
  });

  it("未 trackEdit 但变化的文件创建新版本备份", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "v1\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    writeFileSync(src, "v2\n");
    await fileHistoryMakeSnapshot(state, "m2", sessionId, baseDir);

    const snap2 = state.snapshots[1]!;
    const backup = snap2.trackedFileBackups.get(src);
    expect(backup).toBeDefined();
    expect(backup!.version).toBe(2);

    const backupPath = resolveBackupPath(sessionId, backup!.backupFileName!, baseDir);
    expect(readFileSync(backupPath, "utf8")).toBe("v2\n");
  });

  it("未变文件复用旧备份不创建新 copyFile", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "stable\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    const v1Backup = state.snapshots[0]!.trackedFileBackups.get(src)!;

    await fileHistoryMakeSnapshot(state, "m2", sessionId, baseDir);

    const v2Backup = state.snapshots[1]!.trackedFileBackups.get(src)!;
    expect(v2Backup.backupFileName).toBe(v1Backup.backupFileName);
    expect(v2Backup.version).toBe(v1Backup.version);

    const v2Path = resolveBackupPath(sessionId, getBackupFileName(src, 2), baseDir);
    expect(existsSync(v2Path)).toBe(false);
  });

  it("文件被删时标记 backupFileName=null", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "content\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    rmSync(src, { force: true });
    await fileHistoryMakeSnapshot(state, "m2", sessionId, baseDir);

    const snap2 = state.snapshots[1]!;
    const backup = snap2.trackedFileBackups.get(src);
    expect(backup).toBeDefined();
    expect(backup!.backupFileName).toBeNull();
  });

  it("makeSnapshot 后 pendingTrackEdits 清空", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "content\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    expect(state.pendingTrackEdits.size).toBeGreaterThan(0);

    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    expect(state.pendingTrackEdits.size).toBe(0);
  });

  it("100 个快照上限:推 101 个后只剩 100", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "stable\n");

    await fileHistoryTrackEdit(state, src, "m0", sessionId, baseDir);

    for (let i = 0; i < 101; i++) {
      await fileHistoryMakeSnapshot(state, `m${i}`, sessionId, baseDir);
    }

    expect(state.snapshots.length).toBeLessThanOrEqual(100);
  });
});

describe("FileHistory 1.5.4 回滚 rewind", () => {
  let workDir: string;
  let baseDir: string;
  const sessionId = "test-session-004";
  let state: FileHistoryState;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-src-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
    state = createFileHistoryState();
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("改 3 个文件后 rewind 全部恢复", async () => {
    const files = ["a.ts", "b.ts", "c.ts"].map(f => join(workDir, f));
    for (const f of files) writeFileSync(f, "original\n");

    for (const f of files) {
      await fileHistoryTrackEdit(state, f, "m1", sessionId, baseDir);
    }
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    for (const f of files) writeFileSync(f, "modified\n");

    await fileHistoryRewind(state, "m1", sessionId, baseDir);

    for (const f of files) {
      expect(readFileSync(f, "utf8")).toBe("original\n");
    }
  });

  it("新建文件 rewind 后被 unlink", async () => {
    const existing = join(workDir, "existing.ts");
    const newFile = join(workDir, "new.ts");
    writeFileSync(existing, "v1\n");

    await fileHistoryTrackEdit(state, existing, "m1", sessionId, baseDir);
    await fileHistoryTrackEdit(state, newFile, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    writeFileSync(newFile, "created by agent\n");

    await fileHistoryRewind(state, "m1", sessionId, baseDir);

    expect(existsSync(newFile)).toBe(false);
    expect(readFileSync(existing, "utf8")).toBe("v1\n");
  });

  it("rewind 到不存在的 messageId 抛错", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "content\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    await expect(fileHistoryRewind(state, "no-such-msg", sessionId, baseDir)).rejects.toThrow();
  });

  it("rewind 后 snapshots 截断到 target", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "v1\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    writeFileSync(src, "v2\n");
    await fileHistoryMakeSnapshot(state, "m2", sessionId, baseDir);

    writeFileSync(src, "v3\n");
    await fileHistoryMakeSnapshot(state, "m3", sessionId, baseDir);

    await fileHistoryRewind(state, "m1", sessionId, baseDir);

    expect(state.snapshots).toHaveLength(1);
    expect(state.snapshots[0]!.messageId).toBe("m1");
  });

  it("rewind 后可继续 makeSnapshot", async () => {
    const src = join(workDir, "file.ts");
    writeFileSync(src, "v1\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    writeFileSync(src, "v2\n");
    await fileHistoryMakeSnapshot(state, "m2", sessionId, baseDir);

    await fileHistoryRewind(state, "m1", sessionId, baseDir);
    expect(readFileSync(src, "utf8")).toBe("v1\n");

    writeFileSync(src, "v3\n");
    await fileHistoryMakeSnapshot(state, "m3", sessionId, baseDir);

    expect(state.snapshots).toHaveLength(2);
    expect(state.snapshots[1]!.messageId).toBe("m3");
  });

  it("diff stat 只读统计目标快照到当前文件的 changed files 和 +/-", async () => {
    const src = join(workDir, "file.ts");
    const created = join(workDir, "created.ts");
    writeFileSync(src, "a\nb\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryTrackEdit(state, created, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);

    writeFileSync(src, "a\nb\nc\n");
    writeFileSync(created, "new\n");
    const beforeSnapshotCount = state.snapshots.length;

    const stat = await fileHistoryDiffStat(state, "m1", sessionId, baseDir);

    expect(stat.messageId).toBe("m1");
    expect(stat.changedFileCount).toBe(2);
    expect(stat.addedLines).toBe(2);
    expect(stat.removedLines).toBe(0);
    expect(stat.files.map((file) => file.filePath)).toEqual([created, src].sort());
    expect(stat.files.find((file) => file.filePath === src)).toMatchObject({
      status: "modified",
      addedLines: 1,
      removedLines: 0,
    });
    expect(stat.files.find((file) => file.filePath === created)).toMatchObject({
      status: "created",
      addedLines: 1,
      removedLines: 0,
    });
    expect(state.snapshots).toHaveLength(beforeSnapshotCount);
    expect(readFileSync(src, "utf8")).toBe("a\nb\nc\n");
  });

  it("diff stat 将当前已删除的文件统计为 removed lines", async () => {
    const src = join(workDir, "deleted.ts");
    writeFileSync(src, "a\nb\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);
    rmSync(src, { force: true });

    const stat = await fileHistoryDiffStat(state, "m1", sessionId, baseDir);

    expect(stat.changedFileCount).toBe(1);
    expect(stat.addedLines).toBe(0);
    expect(stat.removedLines).toBe(2);
    expect(stat.files[0]).toMatchObject({
      filePath: src,
      status: "deleted",
      addedLines: 0,
      removedLines: 2,
    });
    expect(existsSync(src)).toBe(false);
  });
});

describe("FileHistory sessionId 跨平台目录名(hash)", () => {
  let workDir: string;
  let baseDir: string;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-fh-src-"));
    baseDir = mkdtempSync(join(tmpdir(), "pico-fh-base-"));
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
    rmSync(baseDir, { recursive: true, force: true });
  });

  it("含冒号的 sessionId(CLI 默认 console:<path>)能正常创建备份不抛错", async () => {
    // Windows 不允许冒号出现在目录名,默认 session ID `console:D:\...` 会触发 ENOENT
    const sessionId = "console:D:\\work\\test";
    const src = join(workDir, "hello.ts");
    writeFileSync(src, "export const x = 1;\n");

    const backupName = await createBackup(src, 1, sessionId, baseDir);
    expect(backupName).toMatch(/^[0-9a-f]{16}@v1$/);

    const backupPath = resolveBackupPath(sessionId, backupName, baseDir);
    expect(existsSync(backupPath)).toBe(true);
    expect(readFileSync(backupPath, "utf8")).toBe("export const x = 1;\n");
  });

  it("含冒号的 sessionId 写入后 load 能读回 manifest(读写目录名一致)", async () => {
    const sessionId = "console:D:\\work\\pico-harness";
    const state = createFileHistoryState();
    const src = join(workDir, "file.ts");
    writeFileSync(src, "original\n");

    await fileHistoryTrackEdit(state, src, "m1", sessionId, baseDir);
    await fileHistoryMakeSnapshot(state, "m1", sessionId, baseDir);
    expect(state.snapshots).toHaveLength(1);

    // 新空 state,用同一 sessionId load,应该能读回之前写的 manifest
    const reloaded = createFileHistoryState();
    const loaded = await fileHistoryLoadState(reloaded, sessionId, baseDir);
    expect(loaded).toBe(true);
    expect(reloaded.snapshots).toHaveLength(1);
    expect(reloaded.snapshots[0]!.messageId).toBe("m1");
  });

  it("不同 sessionId 产生不同的备份目录前缀", () => {
    const a = resolveBackupPath("console:D:\\work\\a", "abc@v1", baseDir);
    const b = resolveBackupPath("console:D:\\work\\b", "abc@v1", baseDir);

    // 同 backupFileName,但 sessionId 不同 -> 目录段不同 -> 整体路径���同
    expect(a).not.toBe(b);
    // 二者都以 baseDir 开头
    expect(a.startsWith(baseDir)).toBe(true);
    expect(b.startsWith(baseDir)).toBe(true);
    // 目录名段(去 baseDir 前缀后)是 32 位 hex,不含冒号/反斜杠等非法字符
    const relA = a.slice(baseDir.length + 1).split(/[\\/]/)[0]!;
    expect(relA).toMatch(/^[0-9a-f]{32}$/);
  });

  it("同一 sessionId 多次解析路径一致(确定性 hash)", () => {
    const sessionId = "console:D:\\work\\test";
    const a = resolveBackupPath(sessionId, "name@v1", baseDir);
    const b = resolveBackupPath(sessionId, "name@v1", baseDir);
    expect(a).toBe(b);
  });
});
