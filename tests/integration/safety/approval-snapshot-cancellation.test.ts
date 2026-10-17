import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, readFile, rm, truncate, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ApprovalManager } from "@pico/pico-host/global-approval-manager";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { buildPermissionMiddleware } from "@pico/pico-host/agent-runtime";
import {
  readApprovedWriteFileSnapshot,
  type ApprovedFileReadChunk,
} from "@pico/pico-host/atomic-workspace-file";
import { WriteFileTool } from "@pico/pico-host/write-file-tool";
import { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

test("approval snapshots read only the opened size and reject growth or truncation", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-approval-snapshot-range-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = join(root, "target.txt");
  const initial = "x".repeat(150_000);

  for (const change of ["append", "truncate"] as const) {
    await writeFile(targetPath, initial);
    let changed = false;
    let maximumRequestedEnd = 0;
    const readChunk: ApprovedFileReadChunk = async (handle, buffer, length, position) => {
      maximumRequestedEnd = Math.max(maximumRequestedEnd, position + length);
      const result = await handle.read(buffer, 0, length, position);
      if (!changed) {
        changed = true;
        if (change === "append") await appendFile(targetPath, "tail");
        else await truncate(targetPath, 70_000);
      }
      return result.bytesRead;
    };

    await assert.rejects(
      readApprovedWriteFileSnapshot(targetPath, { readChunk }),
      /文件内容发生变化|文件被截短/u,
    );
    assert.ok(maximumRequestedEnd <= Buffer.byteLength(initial));
    if (change === "append") {
      assert.equal(maximumRequestedEnd, Buffer.byteLength(initial));
      assert.equal(await readFile(targetPath, "utf8"), `${initial}tail`);
    }
  }
});

test("cancelling between snapshot chunks propagates and closes the file handle", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-approval-snapshot-cancel-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const targetPath = join(root, "target.txt");
  await writeFile(targetPath, "x".repeat(150_000));
  const controller = new AbortController();
  const reason = new DOMException("cancel approval snapshot", "AbortError");
  let readCalls = 0;
  let openedHandle: FileHandle | undefined;
  const readChunk: ApprovedFileReadChunk = async (handle, buffer, length, position) => {
    openedHandle = handle;
    readCalls++;
    const result = await handle.read(buffer, 0, length, position);
    if (readCalls === 1) controller.abort(reason);
    return result.bytesRead;
  };

  await assert.rejects(
    readApprovedWriteFileSnapshot(targetPath, { signal: controller.signal, readChunk }),
    (error) => error === reason,
  );
  assert.equal(readCalls, 1);
  assert.ok(openedHandle);
  await assert.rejects(openedHandle.stat(), { code: "EBADF" });
});

test("cancelling an approval preview creates no approval and does not write", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-approval-preview-cancel-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const targetPath = join(workspace, "target.txt");
  await writeFile(targetPath, "x".repeat(150_000));

  const roots = WorkspaceRoots.createSync(workspace);
  const manager = new ApprovalManager(60_000);
  const controller = new AbortController();
  const reason = new DOMException("cancel approval preview", "AbortError");
  let readCalls = 0;
  let notices = 0;
  let previewHandle: FileHandle | undefined;
  const readChunk: ApprovedFileReadChunk = async (handle, buffer, length, position) => {
    readCalls++;
    if (readCalls === 4) previewHandle = handle;
    const result = await handle.read(buffer, 0, length, position);
    if (readCalls === 4) controller.abort(reason);
    return result.bytesRead;
  };
  const registry = new ToolRegistry();
  registry.register(new WriteFileTool(roots));
  registry.usePermission(
    buildPermissionMiddleware(
      () => notices++,
      workspace,
      controller.signal,
      manager,
      { sessionId: "approval-preview-cancel", permissionMode: "ask", additionalDirectories: [] },
      roots,
      undefined,
      undefined,
      undefined,
      () => "ask",
      { readApprovalFileChunk: readChunk },
    ),
  );

  await assert.rejects(
    registry.execute({
      id: "cancelled-write",
      name: "write_file",
      arguments: JSON.stringify({ path: "target.txt", content: "replacement" }),
    }),
    (error) => error === reason,
  );
  assert.equal(readCalls, 4, "the preview read should stop after its first chunk");
  assert.equal(notices, 0, "cancellation must not create a later approval request");
  assert.equal(await readFile(targetPath, "utf8"), "x".repeat(150_000));
  assert.ok(previewHandle);
  await assert.rejects(previewHandle.stat(), { code: "EBADF" });
});

test("missing approval targets remain empty snapshots", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-approval-snapshot-missing-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const snapshot = await readApprovedWriteFileSnapshot(join(root, "missing.txt"));
  assert.deepEqual(snapshot.snapshot, { kind: "missing" });
  assert.deepEqual(snapshot.precondition, { kind: "missing" });
  assert.equal(snapshot.content, "");
});
