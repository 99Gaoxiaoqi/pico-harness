import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { CheckpointManager } from "../../src/safety/checkpoint-manager.js";

describe("CheckpointManager", () => {
  let workDir: string;
  let manager: CheckpointManager;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-cp-test-"));
    execSync("git init", { cwd: workDir });
    execSync('git config user.email "test@test.com"', { cwd: workDir });
    execSync('git config user.name "Test"', { cwd: workDir });

    writeFileSync(join(workDir, "hello.txt"), "initial content\n");
    execSync("git add -A", { cwd: workDir });
    execSync("git commit -m initial", { cwd: workDir });

    manager = new CheckpointManager(workDir);
  });

  afterEach(() => {
    rmSync(workDir, { recursive: true, force: true });
  });

  it("创建快照并回滚文件变更", async () => {
    // 修改文件
    writeFileSync(join(workDir, "hello.txt"), "modified content\n");

    // 创建快照
    const cpId = await manager.createCheckpoint("write_file: hello.txt");
    expect(cpId).not.toBeNull();

    // 再次修改(模拟 Agent 继续操作)
    writeFileSync(join(workDir, "hello.txt"), "more changes\n");
    expect(readFileSync(join(workDir, "hello.txt"), "utf8")).toBe("more changes\n");

    // 回滚
    const ok = await manager.rollback(cpId!);
    expect(ok).toBe(true);

    // 验证文件恢复到快照时的状态
    const content = readFileSync(join(workDir, "hello.txt"), "utf8");
    expect(content).toBe("modified content\n");
  });

  it("同一 turn 多次写操作只快照一次(dedup)", async () => {
    writeFileSync(join(workDir, "a.txt"), "a\n");
    const cp1 = await manager.createCheckpoint("write_file: a.txt");
    expect(cp1).not.toBeNull();

    writeFileSync(join(workDir, "b.txt"), "b\n");
    const cp2 = await manager.createCheckpoint("write_file: b.txt");
    // dedup: 返回同一个 checkpoint id
    expect(cp2).toBe(cp1);
  });

  it("newTurn 后可以再次创建快照", async () => {
    writeFileSync(join(workDir, "a.txt"), "a\n");
    const cp1 = await manager.createCheckpoint("write_file: a.txt");
    expect(cp1).not.toBeNull();

    manager.newTurn();

    writeFileSync(join(workDir, "b.txt"), "b\n");
    const cp2 = await manager.createCheckpoint("write_file: b.txt");
    expect(cp2).not.toBeNull();
    expect(cp2).not.toBe(cp1);
  });

  it("无变更时返回 null", async () => {
    const cpId = await manager.createCheckpoint("no-op");
    expect(cpId).toBeNull();
  });

  it("非 git 仓库时返回 null", async () => {
    const nonGitDir = mkdtempSync(join(tmpdir(), "pico-nongit-"));
    const nonGitManager = new CheckpointManager(nonGitDir);
    try {
      writeFileSync(join(nonGitDir, "a.txt"), "a\n");
      const cpId = await nonGitManager.createCheckpoint("write_file: a.txt");
      expect(cpId).toBeNull();
    } finally {
      rmSync(nonGitDir, { recursive: true, force: true });
    }
  });

  it("listCheckpoints 返回所有快照", async () => {
    writeFileSync(join(workDir, "a.txt"), "a\n");
    await manager.createCheckpoint("write_file: a.txt");

    manager.newTurn();

    writeFileSync(join(workDir, "b.txt"), "b\n");
    await manager.createCheckpoint("write_file: b.txt");

    const list = manager.listCheckpoints();
    expect(list.length).toBe(2);
    expect(list[0].description).toBe("write_file: a.txt");
    expect(list[1].description).toBe("write_file: b.txt");
  });

  it("getLatestCheckpoint 返回最近的快照", async () => {
    writeFileSync(join(workDir, "a.txt"), "a\n");
    await manager.createCheckpoint("write_file: a.txt");

    const latest = manager.getLatestCheckpoint();
    expect(latest).not.toBeNull();
    expect(latest!.description).toBe("write_file: a.txt");
  });

  it("rollback 不存在的快照返回 false", async () => {
    const ok = await manager.rollback("nonexistent_id");
    expect(ok).toBe(false);
  });
});
