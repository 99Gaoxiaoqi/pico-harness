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
  DesktopRuntimeService,
  ensurePicoRuntimeHostOperationsRegistered,
  WorkspaceRuntimeService,
  type JsonValue,
  type RuntimeHostBridgeService,
} from "../../src/daemon/index.js";

ensurePicoRuntimeHostOperationsRegistered();

/**
 * 3-B-1 bridge composition dispatch/decode verification. A real production service
 * (WorkspaceRuntimeService + DesktopRuntimeService) is assembled exactly as the daemon
 * does for query methods, injected into the bridge composition factory, and driven over
 * the Runtime Host wire protocol: frame decode → spec.decodeInput → handler → service.handle
 * → spec.decodeOutput → response.
 *
 * Runtime host symbols are imported from the built @pico/runtime-host package (not the
 * src path used by the 3-A mechanism tests): the pico composition and its dynamic spec
 * registry resolve through the package, so kernel + specs must share that same module
 * instance for the registry to be visible.
 */

interface BridgeHarness {
  kernel: RuntimeHostKernel;
  connection: RuntimeHostConnection;
  workspacePath: string;
  cleanup: () => Promise<void>;
}

async function startBridgeHarness(
  t: {
    after(hook: () => unknown): void;
  },
  options: { service?: RuntimeHostBridgeService } = {},
): Promise<BridgeHarness> {
  const root = await mkdtemp(join(tmpdir(), "pico-runtime-host-bridge-"));
  const picoHome = join(root, "pico-home");
  const workspaceDir = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  const env = { PICO_HOME: picoHome };

  // Same assembly convention as the daemon / desktop integration tests: a query-only
  // workspace service needs no real executor. Tests may inject a fake service instead.
  const service =
    options.service ??
    (() => {
      const runtimeService = new WorkspaceRuntimeService({
        env,
        execute: async () => undefined,
      });
      return new DesktopRuntimeService({ runtimeService, env });
    })();

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功获取 interactive root owner");

  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: createRuntimeHostCompositionFactory({ service }),
  });

  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "bridge-test-client",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connectResult.kind, "connected", `期望 connected，实际 ${connectResult.kind}`);
  if (connectResult.kind !== "connected") throw new Error("unreachable");
  const connection = connectResult.connection;

  const workspacePath = await realpath(workspaceDir);

  const cleanup = async () => {
    await connection.close().catch(() => undefined);
    await kernel.close().catch(() => undefined);
    await owner.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  };
  t.after(cleanup);

  return { kernel, connection, workspacePath, cleanup };
}

test("runtime-host bridge: workspace.status dispatches through the daemon and decodes a strict result", async (t) => {
  const { connection, workspacePath } = await startBridgeHarness(t);

  const result = await connection.requestRegistered<{
    workspacePath: string;
    registered: boolean;
    schedulerStatus: "unknown";
    mode: "folder" | "git";
    branch: string;
    capabilities: {
      foregroundRuns: boolean;
      fileHistory: boolean;
      isolatedWorktrees: boolean;
      branchMerge: boolean;
    };
  }>("workspace.status", { workspacePath }, 10000);

  assert.equal(result.workspacePath, workspacePath);
  assert.equal(typeof result.registered, "boolean");
  assert.equal(result.schedulerStatus, "unknown");
  assert.equal(result.mode, "folder");
  assert.equal(typeof result.branch, "string");
  assert.equal(result.capabilities.foregroundRuns, true);
  assert.equal(result.capabilities.fileHistory, true);
  assert.equal(result.capabilities.isolatedWorktrees, false);
  assert.equal(result.capabilities.branchMerge, false);
});

test("runtime-host bridge: usage.get returns a decoded usage object", async (t) => {
  const { connection, workspacePath } = await startBridgeHarness(t);

  const result = await connection.requestRegistered<{ usage: Record<string, unknown> }>(
    "usage.get",
    { workspacePath },
    10000,
  );

  assert.ok(result.usage && typeof result.usage === "object", "usage.get 应返回 usage 对象");
  assert.equal(result.usage["workspacePath"], workspacePath);
});

test("runtime-host bridge: daemon INVALID_PARAMS maps to invalid_request without dropping the connection", async (t) => {
  const { connection, workspacePath } = await startBridgeHarness(t);

  // getUsage rejects from > to with RuntimeProtocolError(INVALID_PARAMS).
  await assert.rejects(
    connection.requestRegistered(
      "usage.get",
      { workspacePath, from: 200, to: 100 },
      10000,
    ),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostOperationError);
      assert.equal(error.operation, "usage.get");
      assert.equal(error.code, "invalid_request");
      return true;
    },
  );

  // An operation error must only reject that request, not fail the connection.
  assert.equal(connection.terminalError, undefined, "operation 错误不应 fail 连接");
  const healthy = await connection.requestRegistered<{ usage: Record<string, unknown> }>(
    "usage.get",
    { workspacePath },
    10000,
  );
  assert.ok(healthy.usage && typeof healthy.usage === "object");
});

test("runtime-host bridge: malformed input is rejected by spec.decodeInput", async (t) => {
  const { connection } = await startBridgeHarness(t);

  // Missing required workspacePath -> decodeInput throws before dispatch.
  await assert.rejects(
    connection.requestRegistered("workspace.status", {}, 10000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      return true;
    },
  );
  assert.equal(connection.terminalError, undefined, "输入解码失败不应 fail 连接");
});

test("runtime-host bridge: host.status reports no leaked active operations after bridged calls", async (t) => {
  const { connection, workspacePath } = await startBridgeHarness(t);

  await connection.requestRegistered("workspace.status", { workspacePath }, 10000);
  await connection.requestRegistered("usage.get", { workspacePath }, 10000);

  // host.status counts itself, so a quiescent host reads exactly 1 active operation.
  const status = await connection.request("host.status", {}, 5000);
  assert.equal(status.state, "ready");
  assert.equal(status.activeOperations, 1, "桥接操作完成后不应泄漏 activeOperations");
});

test("runtime-host bridge: malformed handler output is rejected by spec.decodeOutput as internal_failure", async (t) => {
  // A service returning a shape that fails workspace.status decodeOutput exercises the
  // strict output-decoding boundary: the dispatcher must surface internal_failure.
  const brokenService: RuntimeHostBridgeService = {
    handle: async () => ({}) as JsonValue,
  };
  const { connection } = await startBridgeHarness(t, { service: brokenService });

  await assert.rejects(
    connection.requestRegistered("workspace.status", { workspacePath: "/tmp/bridge-broken" }, 10000),
    (error: unknown) => {
      assert.ok(error instanceof RuntimeHostOperationError);
      assert.equal(error.operation, "workspace.status");
      assert.equal(error.code, "internal_failure");
      return true;
    },
  );

  assert.equal(connection.terminalError, undefined, "decodeOutput 失败不应 fail 连接");
});
