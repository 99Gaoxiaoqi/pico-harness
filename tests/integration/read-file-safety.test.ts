import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { truncateSync } from "node:fs";
import { open, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ReadFileTool } from "../../src/tools/registry-impl.js";

const READ_FILE_MAX_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

test("read_file sizes its initial allocation from the tiny file instead of the global limit", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-read-file-allocation-"));
  const filePath = join(root, "tiny.txt");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(filePath, "x\n");

  const allocations: number[] = [];
  const originalAllocUnsafe = Buffer.allocUnsafe;
  Buffer.allocUnsafe = (size: number) => {
    allocations.push(size);
    return originalAllocUnsafe(size);
  };

  try {
    const result = await new ReadFileTool(root).execute(JSON.stringify({ path: "tiny.txt" }));
    assert.match(result, /^1\tx\n共 1 行/u);
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }

  assert.equal(allocations[0], 3, "初始 Buffer 应为 stat size + 1");
  assert.ok(
    allocations.every((size) => size < 1024),
    "微小文件不应触发大块 Buffer 分配",
  );
});

test("read_file still rejects a file that grows beyond the limit after stat", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-read-file-growth-"));
  const filePath = join(root, "growing.txt");
  context.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(filePath, "x\n");

  let grewAfterStat = false;
  const originalAllocUnsafe = Buffer.allocUnsafe;
  Buffer.allocUnsafe = (size: number) => {
    const buffer = originalAllocUnsafe(size);
    if (!grewAfterStat) {
      truncateSync(filePath, READ_FILE_MAX_BYTES + 1);
      grewAfterStat = true;
    }
    return buffer;
  };

  try {
    await assert.rejects(
      new ReadFileTool(root).execute(JSON.stringify({ path: "growing.txt" })),
      /读取超过 read_file 上限/u,
    );
  } finally {
    Buffer.allocUnsafe = originalAllocUnsafe;
  }
  assert.equal(grewAfterStat, true, "测试必须在 stat 后扩大文件");
});

test("read_file rejects sparse oversized files without loading them", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-read-file-size-"));
  const filePath = join(root, "oversized.txt");
  await mkdir(root, { recursive: true });
  context.after(() => rm(root, { recursive: true, force: true }));
  const handle = await open(filePath, "w");
  await handle.truncate(READ_FILE_MAX_BYTES + 1);
  await handle.close();

  const tool = new ReadFileTool(root);
  await assert.rejects(
    tool.execute(JSON.stringify({ path: "oversized.txt" })),
    /超过 read_file 上限/u,
  );
});

test(
  "read_file rejects a FIFO without waiting for a writer",
  { skip: process.platform === "win32" },
  async (context) => {
    const root = await mkdtemp(join(tmpdir(), "pico-read-file-fifo-"));
    const fifoPath = join(root, "input.pipe");
    context.after(() => rm(root, { recursive: true, force: true }));
    await execFileAsync("mkfifo", [fifoPath]);

    const tool = new ReadFileTool(root);
    const reading = tool.execute(JSON.stringify({ path: "input.pipe" }));
    const outcome = await Promise.race([
      reading.then(
        () => "resolved" as const,
        () => "rejected" as const,
      ),
      new Promise<"blocked">((resolveBlocked) => setTimeout(resolveBlocked, 250, "blocked")),
    ]);

    if (outcome === "blocked") {
      const writer = await open(fifoPath, "w");
      await writer.close();
      await reading.catch(() => undefined);
    }
    assert.equal(outcome, "rejected", "FIFO 必须在没有 writer 时立即按非普通文件拒绝");
    await assert.rejects(reading, /路径不是普通文件/u);
  },
);
