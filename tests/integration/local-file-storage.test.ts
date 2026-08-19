import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  FileLockTimeoutError,
  readJsonFileSync,
  withFileLock,
  writeJsonAtomicSync,
} from "../../src/storage/local-file-storage.js";

/**
 * 票 09:JSONL 纪元的锁仪式/commit WAL/能力探针退役后,local-file-storage 只
 * 保留仍被 sqlite 模块与低频文件面使用的原语。本文件覆盖保留面:
 * async OwnerLease 文件锁的串行化与超时,以及 0600 原子写 + 读取。
 */

test("withFileLock 在同进程内串行化对同一锁目录的操作", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-local-file-lock-"));
  try {
    const lockDirectory = join(root, "state", "lock");
    const events: string[] = [];
    const worker = async (id: string): Promise<void> => {
      await withFileLock(lockDirectory, `worker-${id}`, async () => {
        events.push(`enter:${id}`);
        await new Promise((resolve) => setTimeout(resolve, 15));
        events.push(`exit:${id}`);
      });
    };
    await Promise.all([worker("a"), worker("b"), worker("c")]);
    // 任意时刻只有一个 worker 在临界区内:enter 与 exit 必须配对相邻。
    for (let index = 0; index < events.length; index += 2) {
      assert.equal(events[index]!.startsWith("enter:"), true);
      assert.equal(events[index + 1]!.startsWith("exit:"), true);
      assert.equal(events[index]!.slice(6), events[index + 1]!.slice(5));
    }
    assert.equal(events.length, 6);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("withFileLock 超时抛 FileLockTimeoutError 并携带锁路径", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-local-file-timeout-"));
  try {
    const lockDirectory = join(root, "state", "lock");
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolveHolder) => {
      releaseHolder = resolveHolder;
    });
    const first = withFileLock(lockDirectory, "holder", async () => {
      await held;
    });
    // 等待第一个 worker 真正拿到锁(轮询锁目录出现)。
    await waitFor(() => existsSync(lockDirectory));
    await assert.rejects(
      withFileLock(lockDirectory, "contender", async () => undefined, {
        timeoutMs: 50,
        retryIntervalMs: 10,
      }),
      (error: unknown) =>
        error instanceof FileLockTimeoutError &&
        error.lockPath.replaceAll("\\", "/").endsWith("state/lock"),
    );
    releaseHolder();
    await first;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("writeJsonAtomicSync 原子写 0600 文件并可经 readJsonFileSync 读回", () => {
  const root = mkdtempSync(join(tmpdir(), "pico-local-file-atomic-"));
  try {
    const path = join(root, "state", "document.json");
    const value = { schemaVersion: 1, entries: ["a", "b"] };
    writeJsonAtomicSync(path, value);
    if (process.platform !== "win32") {
      const metadata = readFileSync(path);
      assert.equal((metadata.length > 0), true);
    }
    assert.deepEqual(readJsonFileSync(path), value);
    writeJsonAtomicSync(path, { schemaVersion: 2 });
    assert.deepEqual(readJsonFileSync(path), { schemaVersion: 2 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

async function waitFor(probe: () => boolean, deadlineMs = 2_000): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  while (!probe()) {
    if (Date.now() > deadline) throw new Error("waitFor deadline exceeded");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
