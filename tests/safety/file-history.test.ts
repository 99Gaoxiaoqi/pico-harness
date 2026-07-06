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
    it("路径含 sessionId 和 backupFileName 且以 baseDir 开头", () => {
      const name = "abc123def456ghi7@v1";
      const p = resolveBackupPath(sessionId, name, baseDir);
      expect(p).toContain(sessionId);
      expect(p).toContain(name);
      expect(p.startsWith(baseDir)).toBe(true);
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
