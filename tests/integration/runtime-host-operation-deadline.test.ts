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
  RuntimeHostKernel,
  RuntimeHostOperationError,
  RUNTIME_HOST_PROTOCOL_VERSION,
  tryAcquireInteractiveRootOwner,
  type AnyOperationSpec,
  type InteractiveRootOwner,
  type RuntimeHostComposition,
  type RuntimeHostCompositionFactory,
} from "../../packages/runtime-host/src/index.js";

const HANG_OPERATION = "test.runtime-host-deadline.hang";

/**
 * Test-only domain operation whose injected handler never settles — the 3-B
 * failure mode of a hung business handler (e.g. an LLM turn stuck on a dead
 * provider). Registered before kernel start so client/server frame codecs and
 * handler composition all recognize it; the static OperationKey surface stays
 * untouched.
 */
const hangOperationSpec: AnyOperationSpec = {
  mode: "query",
  availability: "ready",
  errors: ["operation_unavailable", "internal_failure"],
  decodeInput: (value) => value,
  decodeOutput: (value) => value,
};
registerHostOperationSpecsForTesting({ [HANG_OPERATION]: hangOperationSpec });

interface HangHooks {
  /** Called when the hung handler starts; receives the deadline AbortSignal. */
  handlerStarted(signal: AbortSignal | undefined): void;
}

function hungCompositionFactory(hooks: HangHooks): RuntimeHostCompositionFactory {
  return async (): Promise<RuntimeHostComposition> => ({
    handlers: {
      [HANG_OPERATION]: async (_input: unknown, context: { signal?: AbortSignal }) => {
        hooks.handlerStarted(context.signal);
        // 挂死：永不 settle，模拟 provider 挂死。
        await new Promise<never>(() => undefined);
      },
    } as unknown as RuntimeHostComposition["handlers"],
    beginDrain() {},
    async recover() {},
    async close() {},
  });
}

async function createDeadlineRoot(): Promise<{ root: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-deadline-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

async function startDeadlineKernel(
  owner: InteractiveRootOwner,
  operationDeadlineMs: number,
  hooks: HangHooks,
): Promise<RuntimeHostKernel> {
  return RuntimeHostKernel.start({
    owner,
    operationDeadlineMs,
    compositionFactory: hungCompositionFactory(hooks),
  });
}

async function connectClient(
  capability: Awaited<ReturnType<typeof resolveStorageRoot<"interactive">>>,
  clientInstanceId: string,
) {
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  return connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId,
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    // 显式钉住 retired TTL，避免受默认值变化影响；对本测试的 deadline 语义无影响。
    retiredSlotTtlMs: 30_000,
    retiredEntryTtlMs: 120_000,
    electionDeadline: performance.now() + 15000,
  });
}

test("runtime-host deadline: hung handler triggers server-side deadline, teardown, and counter release", async (t) => {
  const { root, cleanup } = await createDeadlineRoot();
  t.after(cleanup);

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功获取 interactive root owner");

  let observedSignal: AbortSignal | undefined;
  const hooks: HangHooks = {
    handlerStarted: (signal) => {
      observedSignal = signal;
    },
  };
  const kernel = await startDeadlineKernel(owner, 500, hooks);
  t.after(async () => {
    await kernel.close();
    await owner.close();
  });

  const connectResult = await connectClient(capability, "deadline-test-client");
  assert.equal(connectResult.kind, "connected", `期望 connected，实际 ${connectResult.kind}`);
  if (connectResult.kind !== "connected") return;
  const connection = connectResult.connection;

  // client 超时给足，确保观测到的是 host 侧 deadline（而非 client retire）。
  const requestPromise = connection.requestRegistered(HANG_OPERATION, {}, 10_000);
  const outcome = await requestPromise.then(
    () => "resolved" as const,
    (error: unknown) =>
      error instanceof RuntimeHostOperationError
        ? error.code === "internal_failure"
          ? ("deadline_error" as const)
          : (`other_error:${error.code}` as const)
        : ("transport_error" as const),
  );
  assert.notEqual(outcome, "resolved", "挂死 handler 不应成功返回");
  assert.ok(
    outcome === "deadline_error" || outcome === "transport_error",
    `期望 internal_failure 或连接断开，实际 ${outcome}`,
  );

  // deadline 到期时应已 abort 传给 handler 的 signal（支持 AbortSignal 的
  // handler 可借此优雅取消）。
  assert.ok(observedSignal, "handler 应收到 deadline AbortSignal");
  assert.equal(observedSignal?.aborted, true, "deadline 到期后 signal 应已 abort");

  // 连接应已被 host teardown。
  await assertSettlesWithin(connection.closed, 5_000, "连接应在 deadline 后被 teardown");

  // kernel 计数必须已释放：connectionCount 归零，且 close()（drain）能在
  // shutdownGraceMs 之内干净完成——若 #activeOperations 未递减，drain 会等
  // operationDrain 直至 shutdown deadline 升级为 process_termination_required。
  await waitFor(() => kernel.connectionCount === 0, 5_000);
  await assertSettlesWithin(kernel.close(), 5_000, "deadline teardown 后 host 应能正常 drain 退出");
});

test("runtime-host deadline: host keeps serving new connections after a deadline teardown", async (t) => {
  const { root, cleanup } = await createDeadlineRoot();
  t.after(cleanup);

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);

  const hooks: HangHooks = { handlerStarted: () => undefined };
  const kernel = await startDeadlineKernel(owner, 500, hooks);
  t.after(async () => {
    await kernel.close();
    await owner.close();
  });

  // 第一条连接：挂死操作触发 deadline teardown。
  const first = await connectClient(capability, "deadline-test-first");
  assert.equal(first.kind, "connected");
  if (first.kind !== "connected") return;
  await first.connection.requestRegistered(HANG_OPERATION, {}, 10_000).catch(() => undefined);
  await assertSettlesWithin(first.connection.closed, 5_000, "第一条连接应被 teardown");
  await waitFor(() => kernel.connectionCount === 0, 5_000);

  // 第二条连接：deadline teardown 没有把 host 卡死——handshake 仍被接受，
  // host.status（bootstrap 操作，内置 handler 秒回）正常响应且计数干净。
  const second = await connectClient(capability, "deadline-test-second");
  assert.equal(second.kind, "connected", `第二条连接期望 connected，实际 ${second.kind}`);
  if (second.kind !== "connected") return;
  const status = await second.connection.status(5_000);
  assert.equal(status.state, "ready");
  // status 调用本身占用 1 个 operation 计数；挂死操作若未被 deadline 释放，
  // 这里会是 2。等于 1 证明 teardown 时 #activeOperations 已正确递减。
  assert.equal(status.activeOperations, 1, "除本次 status 外不应有残留 operation 计数");
  assert.equal(status.activeResidencies, 0);
  await second.connection.close();
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

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
