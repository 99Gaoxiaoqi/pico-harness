import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { open, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { ReadFileTool } from "../../src/tools/registry-impl.js";

const READ_FILE_MAX_BYTES = 16 * 1024 * 1024;
const execFileAsync = promisify(execFile);

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
