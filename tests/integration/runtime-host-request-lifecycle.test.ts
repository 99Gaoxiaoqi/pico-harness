import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  connectResolvedRuntimeHost,
  prepareStorageRootControlDirectory,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
  RuntimeHostOperationError,
  type RuntimeHostConnection,
  type StorageRootCapability,
} from "../../packages/runtime-host/src/index.js";
import {
  ensureTestOperationsRegistered,
  FakeRuntimeHost,
  TEST_DOMAIN_OPERATION,
  TEST_LATCH_OPERATION,
  waitForCondition,
} from "./runtime-host-request-lifecycle.helpers.js";

ensureTestOperationsRegistered();

// 快进 TTL：所有生命周期测试都注入短 slot/entry TTL 与短 liveness 间隔，
// 避免等待真实默认值（30s / 5min / 2s）。
const FAST_SLOT_TTL_MS = 120;
const FAST_ENTRY_TTL_MS = 400;
const FAST_LIVENESS_INTERVAL_MS = 40;

interface LifecycleHarness {
  capability: StorageRootCapability<"interactive">;
  controlDirectory: string;
  host: FakeRuntimeHost;
  cleanup: () => void;
}

async function startFakeHostHarness(t: {
  after(hook: () => unknown): void;
}): Promise<LifecycleHarness> {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-lifecycle-"));
  const cleanup = () => rmSync(root, { recursive: true, force: true });
  t.after(cleanup);

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const host = new FakeRuntimeHost();
  t.after(async () => {
    await host.close();
  });
  await host.start(capability, controlDirectory);
  return { capability, controlDirectory, host, cleanup };
}

interface ConnectOptions {
  retiredSlotTtlMs?: number;
  retiredEntryTtlMs?: number;
  livenessIntervalMs?: number;
  onLivenessProbe?: () => void;
}

async function connectToFakeHost(
  harness: LifecycleHarness,
  options: ConnectOptions = {},
): Promise<RuntimeHostConnection> {
  const result = await connectResolvedRuntimeHost({
    capability: harness.capability,
    controlDirectory: harness.controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "lifecycle-test-client",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    retiredSlotTtlMs: options.retiredSlotTtlMs,
    retiredEntryTtlMs: options.retiredEntryTtlMs,
    livenessIntervalMs: options.livenessIntervalMs,
    onLivenessProbe: options.onLivenessProbe,
  });
  assert.equal(result.kind, "connected", `期望 connected，实际 ${result.kind}`);
  if (result.kind !== "connected") throw new Error("unreachable");
  return result.connection;
}

test("request lifecycle: normal domain request allocates a slot and releases it on response", async (t) => {
  const harness = await startFakeHostHarness(t);
  const connection = await connectToFakeHost(harness);
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  assert.equal(connection.inFlightDomainRequestCount, 0);
  const pending = connection.requestRegistered(TEST_DOMAIN_OPERATION, {});
  // 请求发出后、响应到达前，domain 槽位被占用。
  const allocated = await waitForCondition(() => connection.inFlightDomainRequestCount === 1, 1000);
  assert.ok(allocated, "domain 请求发出后应占用一个 in-flight 槽位");

  const output = (await pending) as { echo: string };
  assert.equal(typeof output.echo, "string");
  // 响应到达后槽位释放。
  const released = await waitForCondition(() => connection.inFlightDomainRequestCount === 0, 1000);
  assert.ok(released, "domain 响应到达后应释放 in-flight 槽位");
  assert.equal(connection.retiredRequestCount, 0);
  assert.equal(connection.terminalError, undefined);
});

test("request lifecycle: hung handler timeout retires request, slot TTL force-releases, channel stays usable", async (t) => {
  const harness = await startFakeHostHarness(t);
  let probeCount = 0;
  const connection = await connectToFakeHost(harness, {
    retiredSlotTtlMs: FAST_SLOT_TTL_MS,
    retiredEntryTtlMs: FAST_ENTRY_TTL_MS,
    livenessIntervalMs: FAST_LIVENESS_INTERVAL_MS,
    onLivenessProbe: () => {
      probeCount += 1;
    },
  });
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  // latch 请求永不响应（fake host 只挂起不应答），client 短超时触发 retire。
  const hung = connection.requestRegistered(TEST_LATCH_OPERATION, { latchId: "wedge" }, 80);
  const slotPinned = await waitForCondition(
    () => connection.inFlightDomainRequestCount === 1,
    1000,
  );
  assert.ok(slotPinned, "挂死请求应占用槽位");

  await assert.rejects(hung, (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /Timed out/i);
    return true;
  });

  // retire 后条目仍在：槽位仍被占用（等待迟到响应），retired map 非空。
  assert.equal(connection.retiredRequestCount, 1);
  assert.equal(connection.inFlightDomainRequestCount, 1);

  // 槽位 TTL 到期 → 强制释放槽位（条目仍保留）。
  const slotReleased = await waitForCondition(
    () => connection.inFlightDomainRequestCount === 0,
    2000,
  );
  assert.ok(slotReleased, "槽位 TTL 到期后应强制释放 in-flight 槽位");
  assert.equal(connection.retiredRequestCount, 1, "槽位释放后 retired 条目仍应保留以等待迟到响应");

  // 通道未被钉死：新的 domain 请求仍可发出并完成。
  const echo = (await connection.requestRegistered(TEST_DOMAIN_OPERATION, {}, 2000)) as {
    echo: string;
  };
  assert.equal(typeof echo.echo, "string");
  assert.equal(connection.inFlightDomainRequestCount, 0);
  assert.ok(probeCount >= 1, "挂死期间 liveness 探针应实际触发过");
  assert.equal(connection.terminalError, undefined);
});

test("request lifecycle: late response before slot TTL reconciles without slot underflow", async (t) => {
  const harness = await startFakeHostHarness(t);
  const connection = await connectToFakeHost(harness, {
    retiredSlotTtlMs: 1500,
    retiredEntryTtlMs: 4000,
    livenessIntervalMs: FAST_LIVENESS_INTERVAL_MS,
  });
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  const late = connection.requestRegistered(TEST_LATCH_OPERATION, { latchId: "late-before" }, 80);
  await assert.rejects(late, /Timed out/i);
  assert.equal(connection.retiredRequestCount, 1);
  assert.equal(connection.inFlightDomainRequestCount, 1);

  // 槽位 TTL（1500ms）前送达迟到响应 → 对账成功：条目删除、槽位正常释放（非强制路径）。
  harness.host.releaseLatch("late-before");
  const reconciled = await waitForCondition(() => connection.retiredRequestCount === 0, 2000);
  assert.ok(reconciled, "槽位 TTL 前的迟到响应应对账并删除 retired 条目");
  assert.equal(connection.inFlightDomainRequestCount, 0, "对账应恰好释放一次槽位（不下溢）");
  assert.equal(connection.terminalError, undefined, "对账成功不应 fail 连接");

  // 对账后通道健康：再发一个请求验证。
  const echo = (await connection.requestRegistered(TEST_DOMAIN_OPERATION, {}, 2000)) as {
    echo: string;
  };
  assert.equal(typeof echo.echo, "string");
});

test("request lifecycle: late response after slot TTL but before entry TTL still reconciles", async (t) => {
  const harness = await startFakeHostHarness(t);
  const connection = await connectToFakeHost(harness, {
    retiredSlotTtlMs: FAST_SLOT_TTL_MS,
    retiredEntryTtlMs: 3000,
    livenessIntervalMs: FAST_LIVENESS_INTERVAL_MS,
  });
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  const late = connection.requestRegistered(
    TEST_LATCH_OPERATION,
    { latchId: "late-after-slot" },
    80,
  );
  await assert.rejects(late, /Timed out/i);

  // 等槽位 TTL 强制释放槽位，但条目仍在。
  const slotReleased = await waitForCondition(
    () => connection.inFlightDomainRequestCount === 0,
    2000,
  );
  assert.ok(slotReleased);
  assert.equal(connection.retiredRequestCount, 1);

  // 条目 TTL 前送达迟到响应 → 条目已 slotReleased，对账只删条目、不再释放槽位（不下溢）。
  harness.host.releaseLatch("late-after-slot");
  const reconciled = await waitForCondition(() => connection.retiredRequestCount === 0, 2000);
  assert.ok(reconciled, "槽位 TTL 后、条目 TTL 前的迟到响应仍应对账");
  assert.equal(
    connection.inFlightDomainRequestCount,
    0,
    "已强制释放的槽位不应被二次释放（不下溢）",
  );
  assert.equal(connection.terminalError, undefined);
});

test("request lifecycle: response after entry TTL removal fails the connection as unmatched", async (t) => {
  const harness = await startFakeHostHarness(t);
  const connection = await connectToFakeHost(harness, {
    retiredSlotTtlMs: 60,
    retiredEntryTtlMs: 200,
    livenessIntervalMs: FAST_LIVENESS_INTERVAL_MS,
  });
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  const veryLate = connection.requestRegistered(TEST_LATCH_OPERATION, { latchId: "very-late" }, 60);
  await assert.rejects(veryLate, /Timed out/i);
  assert.equal(connection.retiredRequestCount, 1);

  // 条目 TTL 到期删除：此后任何迟到响应都按 unmatched 处理。
  const removed = await waitForCondition(() => connection.retiredRequestCount === 0, 2000);
  assert.ok(removed, "条目 TTL 到期后 retired 条目应被删除");
  assert.equal(connection.inFlightDomainRequestCount, 0);
  // 快照到局部变量再断言：对 getter 表达式的断言会经别名条件收窄后续读取。
  const healthyAfterRemoval: Error | undefined = connection.terminalError;
  assert.ok(healthyAfterRemoval === undefined, "条目删除本身不应 fail 连接");

  // 条目已删，此时才送达响应 → unmatched，连接 fail。
  harness.host.releaseLatch("very-late");
  await connection.closed;
  const failure = connection.terminalError;
  assert.ok(failure, "条目删除后的迟到响应应以 unmatched fail 连接");
  assert.match(failure.message, /unmatched/i);
});

test("request lifecycle: entry TTL removal stops the perpetual liveness probes", async (t) => {
  const harness = await startFakeHostHarness(t);
  let probeCount = 0;
  const connection = await connectToFakeHost(harness, {
    retiredSlotTtlMs: 50,
    retiredEntryTtlMs: 180,
    livenessIntervalMs: 30,
    onLivenessProbe: () => {
      probeCount += 1;
    },
  });
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  const hung = connection.requestRegistered(TEST_LATCH_OPERATION, { latchId: "probe-stop" }, 50);
  await assert.rejects(hung, /Timed out/i);

  // retired 条目存在期间，liveness 探针持续触发。
  const probing = await waitForCondition(() => probeCount >= 2, 2000);
  assert.ok(probing, "retired 条目存在期间应持续触发 liveness 探针");

  // 条目 TTL 到期删除 → #hasOutstandingDomainRequest 转 false → 探针停止。
  const removed = await waitForCondition(() => connection.retiredRequestCount === 0, 2000);
  assert.ok(removed);
  const countAtRemoval = probeCount;
  await new Promise((resolve) => setTimeout(resolve, 250));
  assert.ok(
    probeCount <= countAtRemoval + 1,
    `条目删除后 liveness 探针应停止：删除时 ${countAtRemoval}，之后 ${probeCount}`,
  );
  assert.equal(connection.terminalError, undefined);
});

test("request lifecycle: error handler yields internal_failure without dropping the connection", async (t) => {
  const harness = await startFakeHostHarness(t);
  const connection = await connectToFakeHost(harness);
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  // 通过 latch 手动回一个 internal_failure 错误响应（模拟 dispatcher 把 handler 抛错
  // 转成 internal_failure 的 host 侧行为；实盘 dispatcher 路径由 composition 测试覆盖）。
  const failing = connection.requestRegistered(TEST_LATCH_OPERATION, { latchId: "error" }, 2000);
  const sentError = await waitForCondition(() => harness.host.hasLatchWaiters("error"), 2000);
  assert.ok(sentError, "请求应到达 fake host");
  harness.host.failLatch("error", "internal_failure", "test handler exploded");

  await assert.rejects(failing, (error: unknown) => {
    assert.ok(error instanceof RuntimeHostOperationError);
    assert.equal(error.code, "internal_failure");
    assert.match(error.message, /test handler exploded/);
    return true;
  });

  // 错误响应只 reject 该请求：槽位释放、连接不断，后续请求正常。
  assert.equal(connection.inFlightDomainRequestCount, 0);
  assert.equal(connection.retiredRequestCount, 0);
  assert.equal(connection.terminalError, undefined, "operation 错误不应 fail 连接");
  const echo = (await connection.requestRegistered(TEST_DOMAIN_OPERATION, {}, 2000)) as {
    echo: string;
  };
  assert.equal(typeof echo.echo, "string");
});
