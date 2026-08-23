import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  connectResolvedRuntimeHost,
  prepareStorageRootControlDirectory,
  registerHostOperationSpecsForTesting,
  resolveStorageRoot,
  RUNTIME_HOST_MAX_FRAME_BYTES,
  RuntimeHostKernel,
  RUNTIME_HOST_PROTOCOL_VERSION,
  tryAcquireInteractiveRootOwner,
  type AnyOperationSpec,
  type InteractiveRootOwner,
  type RuntimeHostComposition,
  type RuntimeHostCompositionFactory,
  type RuntimeHostConnection,
  type StorageRootCapability,
} from "../../packages/runtime-host/src/index.js";

/**
 * 3-B-2 机制层验证：Host→Client event 推送帧。覆盖三条实盘路径——
 * 1. handler 内同步 push：事件按 wire 顺序先于 response 到达客户端监听器；
 * 2. 捕获的 pushEvent 闭包在请求结束后继续推送（桥接订阅的 live 事件形态）；
 * 3. 超限 payload 推送失败 → fence（teardown 连接，绝不静默丢帧）。
 */

const PUSH_OPERATION = "test.runtime-host-event.push";

const pushOperationSpec: AnyOperationSpec = {
  mode: "query",
  availability: "ready",
  errors: ["operation_unavailable", "internal_failure"],
  decodeInput: (value) => value,
  decodeOutput: (value) => value,
};
registerHostOperationSpecsForTesting({ [PUSH_OPERATION]: pushOperationSpec });

type PushSink = (event: Record<string, unknown>) => Promise<void>;

interface PushCompositionHooks {
  /** Captured per-request pushEvent sinks, appended as requests arrive. */
  readonly capturedSinks: PushSink[];
}

function pushCompositionFactory(hooks: PushCompositionHooks): RuntimeHostCompositionFactory {
  return async (): Promise<RuntimeHostComposition> => ({
    handlers: {
      [PUSH_OPERATION]: async (
        input: unknown,
        context: {
          pushEvent?: PushSink;
          afterResponseFlushed?(callback: () => void): void;
        },
      ): Promise<{ ok: true; result: { pushed: boolean } }> => {
        const pushEvent = context.pushEvent;
        if (!pushEvent) throw new Error("test handler expected a pushEvent capability");
        // 捕获闭包供测试在请求结束后继续推送（模拟桥接订阅的 live 推送）。
        hooks.capturedSinks.push(pushEvent);
        if ((input as { afterResponse?: unknown }).afterResponse === true) {
          if (!context.afterResponseFlushed) {
            throw new Error("test handler expected an afterResponseFlushed capability");
          }
          context.afterResponseFlushed(() => {
            void pushEvent({ seq: 1, activated: true });
          });
          return { ok: true, result: { pushed: true } };
        }
        // handler 内同步推送：两帧事件先入 writer 队列，response 最后。
        await pushEvent({ seq: 1 });
        await pushEvent({ seq: 2 });
        return { ok: true, result: { pushed: true } };
      },
    } as unknown as RuntimeHostComposition["handlers"],
    beginDrain() {},
    async recover() {},
    async close() {},
  });
}

interface PushHarness {
  capability: StorageRootCapability<"interactive">;
  owner: InteractiveRootOwner;
}

async function startPushHarness(t: { after(hook: () => unknown): void }): Promise<PushHarness> {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-event-push-"));
  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功获取 interactive root owner");
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { capability, owner };
}

async function connectPushClient(
  capability: StorageRootCapability<"interactive">,
  clientInstanceId: string,
): Promise<RuntimeHostConnection> {
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connectResult.kind, "connected", `期望 connected，实际 ${connectResult.kind}`);
  if (connectResult.kind !== "connected") throw new Error("unreachable");
  return connectResult.connection;
}

test("event push: handler-pushed events arrive in wire order before the response", async (t) => {
  const hooks: PushCompositionHooks = { capturedSinks: [] };
  const { capability, owner } = await startPushHarness(t);
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: pushCompositionFactory(hooks),
  });
  t.after(async () => {
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  });

  const connection = await connectPushClient(capability, "event-push-order-client");
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  // 观测序：监听器与 response 各自记录到达顺序。
  const observed: string[] = [];
  connection.setEventListener((event) => {
    observed.push(`event:${(event as { seq: number }).seq}`);
  });

  const result = await connection.requestRegistered<{ pushed: boolean }>(PUSH_OPERATION, {}, 5000);
  assert.equal(result.pushed, true);
  observed.push("response");

  // handler 内先 push 两帧再返回：客户端应先观测到 event:1、event:2，后 response。
  assert.deepEqual(observed, ["event:1", "event:2", "response"]);
  assert.equal(connection.terminalError, undefined, "推送不应 fail 连接");
  // 事件帧不占 operation 槽位：host.status 只计自身。
  const status = await connection.status(5000);
  assert.equal(status.activeOperations, 1);
});

test("event push: response-flushed barrier activates pushes after the response", async (t) => {
  const hooks: PushCompositionHooks = { capturedSinks: [] };
  const { capability, owner } = await startPushHarness(t);
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: pushCompositionFactory(hooks),
  });
  t.after(async () => {
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  });

  const connection = await connectPushClient(capability, "event-push-barrier-client");
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  const observed: string[] = [];
  connection.setEventListener((event) => {
    observed.push(`event:${(event as { seq: number }).seq}`);
  });

  const result = await connection.requestRegistered<{ pushed: boolean }>(
    PUSH_OPERATION,
    { afterResponse: true },
    5000,
  );
  assert.equal(result.pushed, true);
  observed.push("response");
  assert.ok(await waitForCondition(() => observed.length === 2, 2000));
  assert.deepEqual(observed, ["response", "event:1"]);
});

test("event push: a captured sink keeps pushing after the request completed", async (t) => {
  const hooks: PushCompositionHooks = { capturedSinks: [] };
  const { capability, owner } = await startPushHarness(t);
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: pushCompositionFactory(hooks),
  });
  t.after(async () => {
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  });

  const connection = await connectPushClient(capability, "event-push-captured-client");
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  const received: Record<string, unknown>[] = [];
  connection.setEventListener((event) => {
    received.push(event);
  });

  // 第一次请求：handler 推 seq 1/2 并捕获 sink。
  const first = await connection.requestRegistered<{ pushed: boolean }>(PUSH_OPERATION, {}, 5000);
  assert.equal(first.pushed, true);
  assert.equal(hooks.capturedSinks.length, 1);
  await waitForCondition(() => received.length === 2, 2000);

  // 请求已结束，用捕获的 sink 继续推（模拟 live 订阅事件在空闲连接上到达）。
  const idleSink = hooks.capturedSinks[0];
  assert.ok(idleSink, "第一次请求应捕获到 pushEvent sink");
  await idleSink({ seq: 3, live: true });
  const delivered = await waitForCondition(() => received.length === 3, 2000);
  assert.ok(delivered, "请求结束后捕获 sink 推送的事件应到达客户端");
  assert.deepEqual(
    received.map((event) => (event as { seq: number }).seq),
    [1, 2, 3],
  );
  assert.equal(connection.terminalError, undefined, "空闲��推送不应 fail 连接");
});

test("event push: oversized payload fences the connection", async (t) => {
  const hooks: PushCompositionHooks = { capturedSinks: [] };
  const { capability, owner } = await startPushHarness(t);
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: pushCompositionFactory(hooks),
  });
  t.after(async () => {
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
  });

  const connection = await connectPushClient(capability, "event-push-fence-client");
  const received: Record<string, unknown>[] = [];
  connection.setEventListener((event) => {
    received.push(event);
  });

  const first = await connection.requestRegistered<{ pushed: boolean }>(PUSH_OPERATION, {}, 5000);
  assert.equal(first.pushed, true);
  await waitForCondition(() => received.length === 2, 2000);

  // 超过 96KB 单帧上限的 payload：encode 抛 frame_too_large → fence teardown。
  const oversized: Record<string, unknown> = {
    blob: "x".repeat(RUNTIME_HOST_MAX_FRAME_BYTES),
  };
  const fenceSink = hooks.capturedSinks[0];
  assert.ok(fenceSink, "第一次请求应捕获到 pushEvent sink");
  await assert.rejects(fenceSink(oversized), (error: unknown) => {
    assert.ok(error instanceof Error);
    return true;
  });

  // fence：连接被 teardown，后续请求失败；host 侧计数归零。
  await assertSettlesWithin(connection.closed, 5000, "超限推送应 teardown 连接");
  await assert.rejects(connection.status(2000));
  await waitForCondition(() => kernel.connectionCount === 0, 5000);
});

async function assertSettlesWithin(
  promise: Promise<unknown>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const settled = await Promise.race([
      promise.then(
        () => true,
        () => true,
      ),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
      }),
    ]);
    assert.ok(settled, message);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return true;
}
