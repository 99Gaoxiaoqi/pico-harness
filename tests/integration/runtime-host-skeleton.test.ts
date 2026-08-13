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
  RUNTIME_HOST_COMPATIBILITY_EPOCH,
  RUNTIME_HOST_PROTOCOL_VERSION,
  startRuntimeHostCandidate,
  tryAcquireInteractiveRootOwner,
  type RuntimeHostComposition,
  type RuntimeHostCompositionFactory,
} from "../../packages/runtime-host/src/index.js";

/** 3-A 骨架 echo composition：无领域 handler，只靠 kernel 内置 host.status/host.diagnostics.query。 */
function echoCompositionFactory(): RuntimeHostCompositionFactory {
  return async (): Promise<RuntimeHostComposition> => ({
    handlers: {},
    beginDrain() {},
    async recover() {},
    async close() {},
  });
}

async function createSkeletonRoot(): Promise<{ root: string; cleanup: () => void }> {
  const root = mkdtempSync(join(tmpdir(), "pico-runtime-host-skeleton-"));
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

test("runtime-host skeleton: kernel start → connect → host.status full round trip", async (t) => {
  const { root, cleanup } = await createSkeletonRoot();
  t.after(cleanup);

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "flock 选主应成功获取 interactive root owner");

  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: echoCompositionFactory(),
  });
  t.after(async () => {
    await kernel.close();
    await owner.close();
  });

  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "skeleton-test-client",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(connectResult.kind, "connected", `期望 connected，实际 ${connectResult.kind}`);
  if (connectResult.kind !== "connected") return;

  const connection = connectResult.connection;
  assert.equal(connection.hostEpoch, kernel.hostEpoch);

  const status = await connection.request("host.status", {}, 5000);
  assert.equal(status.state, "ready");
  assert.equal(status.hostEpoch, kernel.hostEpoch);
  assert.equal(status.connections, 1);

  const diagnostics = await connection.request("host.diagnostics.query", {}, 5000);
  assert.equal(diagnostics.state, "ready");
  assert.equal(diagnostics.compatibilityEpoch, RUNTIME_HOST_COMPATIBILITY_EPOCH);
  assert.equal(diagnostics.pid, process.pid);

  await connection.close();
});

test("runtime-host skeleton: flock election yields exactly one winner among concurrent candidates", async (t) => {
  const { root, cleanup } = await createSkeletonRoot();
  t.after(cleanup);

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const candidateOptions = {
    rootPath: root,
    expectedRootId: capability.rootId,
    idleGraceMs: 30000,
  };

  const [first, second] = await Promise.all([
    startRuntimeHostCandidate(candidateOptions),
    startRuntimeHostCandidate(candidateOptions),
  ]);

  const kinds = [first.kind, second.kind].sort();
  assert.deepEqual(kinds, ["loser", "winner"], "并发选主应恰有一个 winner 一个 loser");

  const winner = first.kind === "winner" ? first : second;
  if (winner.kind === "winner") {
    t.after(async () => {
      await winner.host.close();
    });
  }
});

test("runtime-host skeleton: incompatible compatibility epoch is rejected at handshake", async (t) => {
  const { root, cleanup } = await createSkeletonRoot();
  t.after(cleanup);

  const capability = await resolveStorageRoot({ path: root, kind: "interactive" });
  const owner = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner);
  const kernel = await RuntimeHostKernel.start({
    owner,
    compositionFactory: echoCompositionFactory(),
  });
  t.after(async () => {
    await kernel.close();
    await owner.close();
  });

  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  // 客户端声明一个 host 必然拒绝的 protocol 区间（epoch 不匹配的模拟路径）。
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: {
      min: RUNTIME_HOST_PROTOCOL_VERSION + 1,
      max: RUNTIME_HOST_PROTOCOL_VERSION + 1,
    },
    clientInstanceId: "skeleton-test-incompatible",
    connectTimeoutMs: 5000,
    handshakeTimeoutMs: 5000,
    electionDeadline: performance.now() + 15000,
  });
  assert.equal(
    connectResult.kind,
    "incompatible",
    "protocol 区间不重叠时应返回 incompatible",
  );
});
