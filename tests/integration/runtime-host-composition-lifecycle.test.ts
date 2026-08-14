import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  type RuntimeHostComposition,
  type RuntimeHostCompositionFactory,
} from "../../packages/runtime-host/src/index.js";
import {
  ensureTestOperationsRegistered,
  TEST_BOOM_OPERATION,
  TEST_DOMAIN_OPERATION,
  TEST_LATCH_OPERATION,
  waitForCondition,
} from "./runtime-host-request-lifecycle.helpers.js";

ensureTestOperationsRegistered();

/** composeOperationHandlers 要求覆盖全部已知操作；未实现的 domain 操作用 unavailable 兜底。 */
const UNAVAILABLE_HANDLER = async () => ({
  ok: false,
  error: {
    code: "operation_unavailable" as const,
    message: "Runtime Host operation is unavailable in this composition",
  },
});

/**
 * Test-only composition：为动态注册的测试 domain 操作提供真实 handler，走完整
 * kernel 分发链路（beginOperation admission → dispatchOperation →
 * decodeOperationOutcome 动态 spec 校验 → 应答）。
 *
 * - test.domain.roundtrip：延迟后成功返回（正常 domain 请求走槽位分配/释放）。
 * - test.domain.boom：handler 抛错 → dispatcher catch → internal_failure 应答。
 * - test.domain.latch：本组合不实现，返回 operation_unavailable 兜底。
 */
function domainTestCompositionFactory(delayMs: number): RuntimeHostCompositionFactory {
  return async (): Promise<RuntimeHostComposition> => ({
    handlers: {
      [TEST_DOMAIN_OPERATION]: async () => {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        return { ok: true, result: { echo: "composition-slow" } };
      },
      [TEST_BOOM_OPERATION]: async () => {
        throw new Error("composition handler exploded");
      },
      [TEST_LATCH_OPERATION]: UNAVAILABLE_HANDLER,
    } as unknown as RuntimeHostComposition["handlers"],
    beginDrain() {},
    async recover() {},
    async close() {},
  });
}

async function startCompositionHarness(t: { after(hook: () => unknown): void }, delayMs: number) {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-composition-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功获取 interactive root owner");

  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: domainTestCompositionFactory(delayMs),
  });
  t.after(async () => {
    await kernel.close();
  });

  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "composition-test-client",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connectResult.kind, "connected", `期望 connected，实际 ${connectResult.kind}`);
  if (connectResult.kind !== "connected") throw new Error("unreachable");
  return { kernel, connection: connectResult.connection };
}

test("runtime-host composition: slow domain op goes through slot allocation and release", async (t) => {
  const { kernel, connection } = await startCompositionHarness(t, 150);
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  assert.equal(connection.inFlightDomainRequestCount, 0);
  const pending = connection.requestRegistered(TEST_DOMAIN_OPERATION, {}, 5000);
  const allocated = await waitForCondition(() => connection.inFlightDomainRequestCount === 1, 1000);
  assert.ok(allocated, "真实 kernel 上的 domain 请求应占用槽位");

  const output = (await pending) as { echo: string };
  assert.equal(output.echo, "composition-slow");
  assert.equal(connection.inFlightDomainRequestCount, 0, "响应后槽位应释放");
  assert.equal(connection.retiredRequestCount, 0);

  // host 侧视角：操作完成后无泄漏 operation。注意 host.status 探针自身计入
  // activeOperations，故无泄漏时读数应为 1（仅探针自己）；若 domain 操作泄漏则为 ≥2。
  const drained = await waitForCondition(async () => {
    const status = await connection.request("host.status", {}, 5000);
    return status.activeOperations === 1;
  }, 3000);
  assert.ok(drained, "domain 操作完成后 activeOperations 应只剩 host.status 探针自身");
  const status = await connection.request("host.status", {}, 5000);
  assert.equal(status.state, "ready");
  assert.equal(status.hostEpoch, kernel.hostEpoch);
});

test("runtime-host composition: throwing handler yields internal_failure and keeps the connection", async (t) => {
  const { connection } = await startCompositionHarness(t, 10);
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  // handler 抛错 → dispatcher catch → internal_failure 应答（真实分发路径）。
  await assert.rejects(
    connection.requestRegistered("test.domain.boom", {}, 5000),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostOperationError);
      assert.equal(error.code, "internal_failure");
      assert.equal(error.operation, "test.domain.boom");
      return true;
    },
  );

  // 操作错误只 reject 该请求：连接不断，后续 domain 请求仍正常。
  assert.ok(connection.terminalError === undefined, "handler 抛错不应 fail 连接");
  const echo = (await connection.requestRegistered(TEST_DOMAIN_OPERATION, {}, 5000)) as {
    echo: string;
  };
  assert.equal(echo.echo, "composition-slow");
});

test("runtime-host composition: unavailable fallback covers unhandled dynamic ops", async (t) => {
  // 无 composition（handlers 走 kernel 初始的 createUnavailableDomainOperationHandlers）。
  // 动态注册的测试操作也应被兜底为 operation_unavailable，而非缺失 handler 报错。
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-composition-unavail-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const kernel = await RuntimeHostKernel.start({ owner });
  t.after(async () => {
    await kernel.close();
  });

  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "composition-unavail-client",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connectResult.kind, "connected");
  if (connectResult.kind !== "connected") throw new Error("unreachable");
  const connection = connectResult.connection;
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });

  await assert.rejects(
    connection.requestRegistered(TEST_LATCH_OPERATION, { latchId: "x" }, 5000),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostOperationError);
      assert.equal(error.code, "operation_unavailable");
      return true;
    },
  );
  assert.ok(connection.terminalError === undefined);
});
