import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  resolveStorageRoot,
  RuntimeHostKernel,
  tryAcquireInteractiveRootOwner,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "../../src/daemon/client.js";
import {
  createRuntimeHostComposition,
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostEventOperationsRegistered,
  ensurePicoRuntimeHostShutdownOperationRegistered,
  RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN,
} from "../../src/daemon/index.js";
import type { LocalRuntimeService, RuntimeNotificationCursor } from "../../src/daemon/service.js";
import {
  createRuntimeNotification,
  type JsonValue,
  type RuntimeNotification,
  type RuntimeNotificationPage,
  type RuntimeRequest,
} from "../../src/daemon/protocol.js";

// 注：runtime.shutdown 的 spec 与 composition handler 必须成对（动态注册表
// 进程级——客户端连接时也会注册；本测试的 composition 对齐 candidate 补 handler）。
ensurePicoRuntimeHostOperationsRegistered();
ensurePicoRuntimeHostEventOperationsRegistered();
ensurePicoRuntimeHostShutdownOperationRegistered();

/**
 * 客户端订阅环的 replay overflow 恢复栅栏（3-D Phase 5 迁移到 kernel 承载）：
 * in-process kernel + fake service（同 composition-bridge 测试装配），客户端走
 * 真实 LocalRuntimeClient（kernel 模式）。host 重启对应旧测试的 daemon
 * stop/start——连接断开后订阅环重连重订，overflow 页触发恢复栅栏，栅栏期间的
 * durable 事件不丢（栅栏解除后重放补齐）。
 */

class ReplayOverflowService implements LocalRuntimeService {
  readonly durable: RuntimeNotification[] = [];
  replayCalls = 0;
  injectOverflow = false;
  private overflowInjected = false;
  private readonly listeners = new Set<(notification: RuntimeNotification) => void>();

  async handle(_request: RuntimeRequest): Promise<JsonValue> {
    return {};
  }

  async replayEvents(cursor: RuntimeNotificationCursor): Promise<RuntimeNotificationPage> {
    this.replayCalls++;
    if (this.injectOverflow && !this.overflowInjected) {
      this.overflowInjected = true;
      this.emitDurable("overflow-0");
      this.emitDurable("overflow-1");
      return {
        events: [],
        hasMore: false,
        highWatermarkEventId: this.durable.at(-1)?.eventId,
      };
    }
    const start = cursor.afterEventId
      ? Math.max(0, this.durable.findIndex((event) => event.eventId === cursor.afterEventId) + 1)
      : 0;
    const events = this.durable.slice(start);
    return {
      events,
      hasMore: false,
      ...(events.at(-1) ? { nextAfterEventId: events.at(-1)!.eventId } : {}),
      ...(this.durable.at(-1) ? { highWatermarkEventId: this.durable.at(-1)!.eventId } : {}),
    };
  }

  subscribe(listener: (notification: RuntimeNotification) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emitDurable(eventId: string, title = eventId): void {
    const event = createRuntimeNotification({
      eventId,
      topic: "run.timeline",
      scope: { workspacePath: this.workspacePath, sessionId: "session-1", runId: "run-1" },
      resourceVersion: this.durable.length + 1,
      at: this.durable.length + 1,
      payload: { runId: "run-1", item: { kind: "status", title } },
    });
    this.durable.push(event);
    for (const listener of this.listeners) listener(event);
  }

  workspacePath = "";
}

test("Runtime client keeps a recovery fence after replay overflow", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-client-replay-"));
  const picoHome = join(root, "pico-home");
  const workspaceSeed = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceSeed, { recursive: true });
  const workspacePath = await realpath(workspaceSeed);

  const service = new ReplayOverflowService();
  service.workspacePath = workspacePath;

  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  let owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功（测试进程独占交互根）");
  // 客户端在本���程注册过 runtime.shutdown spec（进程级动态注册表），composition
  // 必须补对应 handler（对齐 candidate 的组装方式）。
  const compositionFactory = async () => {
    const bridge = createRuntimeHostComposition({ service, eventSource: service });
    return {
      ...bridge,
      handlers: {
        ...bridge.handlers,
        [RUNTIME_HOST_BRIDGE_RUNTIME_SHUTDOWN]: async () => ({ ok: true, result: {} }),
      },
    };
  };
  let kernel = await RuntimeHostKernel.start({ owner, compositionFactory });

  const client = new LocalRuntimeClient(undefined, {
    runtimeHostRootPath: picoHome,
    reconnectDelayMs: 50,
    maxReconnectDelayMs: 50,
    replayBufferOptions: { maxEvents: 1, maxBytes: 4096 },
  });
  const currentOwner = () => owner;
  context.after(async () => {
    client.close();
    await kernel.close().catch(() => undefined);
    const activeOwner = currentOwner();
    if (activeOwner) await activeOwner.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  });

  const delivered: string[] = [];
  await client.subscribe({ workspacePath }, (event) => delivered.push(event.eventId));

  // host 重启（= 旧测试的 daemon stop/start）：kernel.close 会消费 owner lease，
  // 重启需重新选主。连接断开 → 订阅环重连重订。
  service.injectOverflow = true;
  await kernel.close();
  await owner.close().catch(() => undefined);
  owner = (await tryAcquireInteractiveRootOwner(capability))!;
  assert.ok(owner, "重启后应能重新选主");  kernel = await RuntimeHostKernel.start({ owner, compositionFactory });
  await waitFor(() => service.replayCalls >= 2, 10_000);
  service.emitDurable("during-recovery-fence");
  await waitFor(
    () => delivered.length === 3,
    10_000,
    () => `replayCalls=${service.replayCalls}, delivered=${delivered.length}`,
  );

  assert.equal(new Set(delivered).size, 3);
  assert.equal(delivered[0], "overflow-0");
  assert.equal(delivered.at(-1), "during-recovery-fence");
});

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 5_000,
  diagnostic: () => string = () => "",
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error(`Timed out waiting for Runtime replay ${diagnostic()}`.trim());
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
