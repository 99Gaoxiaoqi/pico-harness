import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import type { JsonValue, RuntimeParams } from "@pico/protocol";
import {
  connectResolvedRuntimeHost,
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  RuntimeHostKernel,
  RUNTIME_HOST_PROTOCOL_VERSION,
  tryAcquireInteractiveRootOwner,
  WorkbarTerminalError,
} from "@pico/runtime-host";
import { DesktopWorkbarTerminalService } from "../../../packages/pico-host/src/desktop-workbar-terminal-service.js";
import { createRuntimeHostComposition } from "../../../packages/pico-host/src/runtime-host-composition.js";
import { ensurePicoRuntimeHostOperationsRegistered } from "../../../packages/pico-host/src/runtime-host-operations.js";
import { FileWorkbarTerminalStateStore } from "../../../packages/pico-host/src/workbar-terminal-state-store.js";

ensurePicoRuntimeHostOperationsRegistered();

test("Host deadline 关闭连接后，迟到终端创建保留进程但不能恢复失效显示 lease", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pico-terminal-deadline-"));
  const workspacePath = await realpath(directory);
  const service = new DesktopWorkbarTerminalService({ picoHome: directory });
  await service.list({ workspacePath, sessionId: "pending-session" });
  let started!: () => void, release!: () => void, released!: () => void;
  const saving = new Promise<void>((resolve) => {
    started = resolve;
  });
  const holdSave = new Promise<void>((resolve) => {
    release = resolve;
  });
  const connectionReleased = new Promise<void>((resolve) => {
    released = resolve;
  });
  const originalSave = FileWorkbarTerminalStateStore.prototype.save;
  let blocked = false;
  // 延迟真实持久化边界，模拟 fsync 超时；PTY 已创建且仍由 Host 拥有。
  FileWorkbarTerminalStateStore.prototype.save = async function (records) {
    if (
      !blocked &&
      records.some(
        (record) => record.workspacePath === workspacePath && record.status === "running",
      )
    ) {
      blocked = true;
      started();
      await holdSave;
    }
    await originalSave.call(this, records);
  };
  t.after(async () => {
    release();
    FileWorkbarTerminalStateStore.prototype.save = originalSave;
    await service.close();
    await rm(directory, { recursive: true, force: true });
  });
  let settled!: (value: { error?: unknown }) => void;
  const lateCreation = new Promise<{ error?: unknown }>((resolve) => {
    settled = resolve;
  });
  const capability = await resolveStorageRoot({ path: directory, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const kernel = await RuntimeHostKernel.start({
    owner,
    operationDeadlineMs: 500,
    compositionFactory: async () => {
      const composition = createRuntimeHostComposition({
        service: {
          async handle(request, context) {
            assert.equal(request.method, "terminal.create");
            try {
              const result = await service.create(
                request.params as RuntimeParams<"terminal.create">,
                context,
              );
              settled({});
              return result as JsonValue;
            } catch (error) {
              settled({ error });
              throw error;
            }
          },
          releaseTerminalAttachment: (id) => service.releaseAttachment(id),
          close() {},
        },
      });
      return {
        ...composition,
        releaseConnection(id) {
          composition.releaseConnection?.(id);
          released();
        },
      };
    },
  });
  t.after(async () => {
    await kernel.close();
    await owner.close();
  });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connected = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "pending-terminal-owner",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connected.kind, "connected");
  if (connected.kind !== "connected") throw new Error("Runtime Host connection failed");
  t.after(() => connected.connection.close());
  const rejected = assert.rejects(
    connected.connection.requestRegistered(
      "runtime.request",
      {
        method: "terminal.create",
        params: { workspacePath, sessionId: "pending-session", streamId: "closed-view" },
      },
      5000,
    ),
  );
  await saving;
  await rejected;
  await connectionReleased;
  release();
  const outcome = await lateCreation;
  assert.ok(outcome.error instanceof WorkbarTerminalError);
  assert.equal(outcome.error.code, "admission_closed");
  const listed = await service.list({ workspacePath, sessionId: "pending-session" });
  assert.equal(listed.terminals[0]?.status, "running", "显示关闭不停止 Host 拥有的进程");
});
