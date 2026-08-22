import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  connectResolvedRuntimeHost,
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  RuntimeHostKernel,
  RuntimeHostOperationError,
  RUNTIME_HOST_PROTOCOL_VERSION,
  tryAcquireInteractiveRootOwner,
  type RuntimeHostConnection,
} from "@pico/runtime-host";
import {
  createRuntimeHostCompositionFactory,
  createTypedRuntimeRequest,
  DesktopRuntimeService,
  ensurePicoRuntimeHostEventOperationsRegistered,
  ensurePicoRuntimeHostOperationsRegistered,
  WorkspaceRuntimeService,
  type RuntimeHostEventSource,
} from "../../src/daemon/index.js";

ensurePicoRuntimeHostOperationsRegistered();
ensurePicoRuntimeHostEventOperationsRegistered();

/**
 * 3-B-2 event bridge verification over the Runtime Host wire: a real
 * WorkspaceRuntimeService + DesktopRuntimeService pair is bridged with an event
 * source; events.subscribe / events.replay run through frame decode → spec
 * decodeInput → handler → service.replayEvents → packReplayPageForBridge →
 * decodeOutput, while live events flow service listener → bridge-safe trimming
 * → session pushEvent → client setEventListener.
 *
 * Kernel symbols import from the built @pico/runtime-host package (same
 * module-identity rule as the composition-bridge test): the dynamic spec
 * registry resolves through the package, so kernel + pico specs must share one
 * module instance.
 */

interface BridgeNotificationLike {
  eventId: string;
  topic: string;
  scope: { workspacePath: string };
}

interface EventsHarness {
  kernel: RuntimeHostKernel;
  connection: RuntimeHostConnection;
  desktopService: DesktopRuntimeService;
  workspacePath: string;
  /** Live listeners currently registered on the wrapped event source. */
  listenerCount(): number;
}

async function startEventsHarness(t: { after(hook: () => unknown): void }): Promise<EventsHarness> {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-host-events-"));
  const picoHome = join(root, "pico-home");
  const workspaceDir = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const env = { PICO_HOME: picoHome };

  const runtimeService = new WorkspaceRuntimeService({
    env,
    execute: async () => undefined,
  });
  const desktopService = new DesktopRuntimeService({ runtimeService, env });

  // Counting wrapper: forwards to the real service subscription and tracks the
  // live listeners, proving the composition disposes its listener when the
  // kernel releases the connection.
  const listeners = new Set<(notification: never) => void>();
  const eventSource: RuntimeHostEventSource = {
    subscribe(listener) {
      const dispose = desktopService.subscribe(listener);
      listeners.add(listener as never);
      return () => {
        listeners.delete(listener as never);
        dispose();
      };
    },
    replayEvents(cursor) {
      return desktopService.replayEvents(cursor);
    },
  };

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功获取 interactive root owner");

  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: createRuntimeHostCompositionFactory({
      service: desktopService,
      eventSource,
    }),
  });

  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "events-bridge-test-client",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connectResult.kind, "connected", `期望 connected，实际 ${connectResult.kind}`);
  if (connectResult.kind !== "connected") throw new Error("unreachable");
  const connection = connectResult.connection;

  const workspacePath = await realpath(workspaceDir);

  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
    await connection.close().catch(() => undefined);
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  });

  return { kernel, connection, desktopService, workspacePath, listenerCount: () => listeners.size };
}

async function registerWorkspace(harness: EventsHarness, workspacePath: string): Promise<void> {
  await harness.desktopService.handle(
    createTypedRuntimeRequest("workspace.register", { workspacePath }),
  );
}

async function unregisterWorkspace(harness: EventsHarness, workspacePath: string): Promise<void> {
  await harness.desktopService.handle(
    createTypedRuntimeRequest("workspace.unregister", { workspacePath }),
  );
}

function waitForEvents(
  received: BridgeNotificationLike[],
  count: number,
  timeoutMs = 5000,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  return (function poll(): Promise<boolean> {
    if (received.length >= count) return Promise.resolve(true);
    if (performance.now() > deadline) return Promise.resolve(false);
    return new Promise((resolve) => setTimeout(resolve, 20)).then(poll);
  })();
}

test("events bridge: subscribe returns the first page and live pushes reach the client listener", async (t) => {
  const harness = await startEventsHarness(t);
  const { connection, workspacePath } = harness;

  // 先产生一条 durable 事件，订阅首页应携带它（无 cursor = 从最旧回放）。
  await registerWorkspace(harness, workspacePath);

  const received: BridgeNotificationLike[] = [];
  connection.setEventListener((event) => {
    received.push(event as unknown as BridgeNotificationLike);
  });

  const page = await connection.requestRegistered<{
    subscribed: true;
    events: BridgeNotificationLike[];
    hasMore: boolean;
    highWatermarkEventId?: string;
  }>("events.subscribe", { workspacePath }, 10_000);
  assert.equal(page.subscribed, true);
  assert.equal(page.events.length, 1, "首页应包含已注册的 durable 事件");
  assert.equal(page.events[0]?.topic, "workspace.registered");
  assert.equal(typeof page.highWatermarkEventId, "string");

  // 触发第二条 durable 事件：live 推送应到达客户端监听器（经 kernel event 帧）。
  await unregisterWorkspace(harness, workspacePath);
  const delivered = await waitForEvents(received, 1);
  assert.ok(delivered, "live 事件应经推送帧到达客户端");
  assert.equal(received[0]?.topic, "workspace.unregistered");
  assert.notEqual(
    received[0]?.eventId,
    page.events[0]?.eventId,
    "live 推送的是新事件，与首页回放的事件不同",
  );
  assert.equal(connection.terminalError, undefined, "事件推送不应 fail 连接");
});

test("events bridge: replay pages through the fixed high-watermark with recomputed hasMore", async (t) => {
  const harness = await startEventsHarness(t);
  const { connection, workspacePath } = harness;

  // 5 条 durable 事件：register/unregister 交替。
  await registerWorkspace(harness, workspacePath);
  await unregisterWorkspace(harness, workspacePath);
  await registerWorkspace(harness, workspacePath);
  await unregisterWorkspace(harness, workspacePath);
  await registerWorkspace(harness, workspacePath);

  const first = await connection.requestRegistered<{
    events: BridgeNotificationLike[];
    hasMore: boolean;
    nextAfterEventId?: string;
    highWatermarkEventId?: string;
  }>("events.replay", { workspacePath, limit: 2 }, 10_000);
  assert.equal(first.events.length, 2, "limit=2 的首页应有 2 条事件");
  assert.equal(first.hasMore, true, "cursor 未达 high-watermark 时应指示还有下一页");
  assert.ok(first.nextAfterEventId, "翻页 cursor 应存在");
  assert.ok(first.highWatermarkEventId, "首页应捕获 high-watermark");

  const second = await connection.requestRegistered<{
    events: BridgeNotificationLike[];
    hasMore: boolean;
    nextAfterEventId?: string;
    highWatermarkEventId?: string;
  }>(
    "events.replay",
    {
      workspacePath,
      afterEventId: first.nextAfterEventId,
      highWatermarkEventId: first.highWatermarkEventId,
      limit: 2,
    },
    10_000,
  );
  assert.equal(
    second.highWatermarkEventId,
    first.highWatermarkEventId,
    "翻页期间 high-watermark 应保持固定",
  );
  assert.equal(second.events.length, 2);

  const third = await connection.requestRegistered<{
    events: BridgeNotificationLike[];
    hasMore: boolean;
    nextAfterEventId?: string;
    highWatermarkEventId?: string;
  }>(
    "events.replay",
    {
      workspacePath,
      afterEventId: second.nextAfterEventId,
      highWatermarkEventId: first.highWatermarkEventId,
      limit: 2,
    },
    10_000,
  );
  assert.equal(third.events.length, 1, "最后一页应只剩 1 条事件");
  assert.equal(third.hasMore, false, "cursor 到达 high-watermark 后应无更多页");
  assert.equal(third.nextAfterEventId, third.highWatermarkEventId);

  // 全程 5 条事件不重不漏。
  const all = [...first.events, ...second.events, ...third.events];
  assert.equal(new Set(all.map((event) => event.eventId)).size, 5);
});

test("events bridge: expired cursor maps to invalid_request without dropping the connection", async (t) => {
  const harness = await startEventsHarness(t);
  const { connection, workspacePath } = harness;
  await registerWorkspace(harness, workspacePath);

  await assert.rejects(
    connection.requestRegistered(
      "events.replay",
      { workspacePath, afterEventId: "event_00000000-0000-4000-8000-000000000000" },
      10_000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostOperationError);
      assert.equal(error.operation, "events.replay");
      assert.equal(error.code, "invalid_request", "cursor 失效应映射为 invalid_request");
      return true;
    },
  );
  assert.equal(connection.terminalError, undefined, "cursor 失效不应 fail 连接");
  const status = await connection.status(5000);
  assert.equal(status.state, "ready");
});

test("events bridge: closing the connection disposes the live subscription", async (t) => {
  const harness = await startEventsHarness(t);
  const { connection, workspacePath } = harness;
  await registerWorkspace(harness, workspacePath);

  assert.equal(harness.listenerCount(), 0);
  await connection.requestRegistered("events.subscribe", { workspacePath }, 10_000);
  assert.equal(harness.listenerCount(), 1, "订阅后应注册一个 live 监听");

  await connection.close();
  // kernel 在连接结束时调 composition.releaseConnection → 桥接退订。
  const disposed = await new Promise<boolean>((resolve) => {
    const deadline = performance.now() + 5000;
    (function poll(): void {
      if (harness.listenerCount() === 0) return resolve(true);
      if (performance.now() > deadline) return resolve(false);
      setTimeout(poll, 20);
    })();
  });
  assert.ok(disposed, "连接关闭后 live 监听应被退订（无泄漏）");
});
