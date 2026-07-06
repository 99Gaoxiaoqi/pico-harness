import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BackgroundManager } from "../../src/tools/background-manager.js";

function waitFor(
  check: () => boolean,
  timeoutMs = 2000,
  intervalMs = 20,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (check()) {
        resolve();
        return;
      }
      if (Date.now() >= deadline) {
        reject(new Error("等待条件超时"));
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

describe("BackgroundManager", () => {
  let workDir: string;
  let manager: BackgroundManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-bg-"));
    manager = new BackgroundManager({ maxOutputChars: 80 });
  });

  afterEach(async () => {
    for (const task of manager.list()) {
      if (task.status === "running") {
        await manager.stop(task.taskId);
      }
    }
    await rm(workDir, { recursive: true, force: true });
  });

  it("启动任务并记录输出和退出码", async () => {
    const started = manager.start("printf 'hello\\n'; printf 'oops\\n' >&2; exit 7", workDir);

    expect(started.taskId).toMatch(/^bg-/);
    expect(started.pid).toBeGreaterThan(0);
    expect(started.status).toBe("running");
    expect(started.command).toContain("printf");
    expect(started.cwd).toBe(workDir);

    await waitFor(() => manager.list()[0]?.status === "exited");

    const [done] = manager.list();
    expect(done?.status).toBe("exited");
    expect(done?.exitCode).toBe(7);
    expect(done?.signal).toBeNull();
    expect(done?.endedAt).toBeInstanceOf(Date);

    const output = manager.output(started.taskId);
    expect(output.stdout).toContain("hello");
    expect(output.stderr).toContain("oops");
  });

  it("停止运行中的任务并更新状态", async () => {
    const started = manager.start("node -e \"setInterval(() => {}, 1000)\"", workDir);

    const stopped = await manager.stop(started.taskId);

    expect(stopped.status).toBe("stopped");
    expect(stopped.signal).toBeTruthy();
    expect(stopped.endedAt).toBeInstanceOf(Date);
  });

  it("未知 taskId 会返回明确错误", async () => {
    expect(() => manager.output("missing")).toThrow(/未知后台任务/);
    await expect(manager.stop("missing")).rejects.toThrow(/未知后台任务/);
  });

  it("stdout 和 stderr 使用环形缓冲限制内存", async () => {
    const started = manager.start(
      "node -e \"process.stdout.write('x'.repeat(120)); process.stderr.write('y'.repeat(120))\"",
      workDir,
    );

    await waitFor(() => manager.list()[0]?.status === "exited");

    const output = manager.output(started.taskId);
    expect(output.stdout).toHaveLength(80);
    expect(output.stdout).toBe("x".repeat(80));
    expect(output.stderr).toHaveLength(80);
    expect(output.stderr).toBe("y".repeat(80));
  });

  it("output 支持按 tail 截取末尾输出", async () => {
    const started = manager.start("printf 'abcdef'", workDir);

    await waitFor(() => manager.list()[0]?.status === "exited");

    expect(manager.output(started.taskId, 3).stdout).toBe("def");
  });
});
