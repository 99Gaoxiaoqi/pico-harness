import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import {
  connectOrSpawnRuntimeHost,
  connectResolvedRuntimeHost,
  prepareStorageRootControlDirectory,
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
  RUNTIME_HOST_PROTOCOL_VERSION,
  tryAcquireInteractiveRootOwner,
  type InteractiveRootOwner,
  type RuntimeHostConnection,
} from "@pico/runtime-host";
import {
  LocalDaemonInstanceLock,
  resolveLocalDaemonEndpoint,
  resolveLocalDaemonLockPath,
  startPicoDaemonRuntimeHostCandidate,
} from "../../src/daemon/index.js";

/**
 * 3-B-3 daemon candidate 实盘验证：
 * 1. in-process winner：守卫锁→flock→kernel+production composition 全链路，关停后
 *    守卫锁释放（fence 链收口）；
 * 2. 旧 instance-lock 被占（模拟旧版 daemon 存活）→ legacy_daemon_running，绝不并存；
 * 3. flock 被占 → loser；
 * 4. connectOrSpawn spawn 真进程（pico main.ts 自定义 entrypoint + env 透传）。
 *
 * kernel 符号从 dist 导入（模块身份规则，与 composition/events 桥接测试一致）。
 */

interface CandidateHarness {
  picoHome: string;
  env: Record<string, string | undefined>;
  lockPath: string;
  cleanup: () => Promise<void>;
}

async function startCandidateHarness(t: {
  after(hook: () => unknown): void;
}): Promise<CandidateHarness> {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-candidate-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome, { recursive: true });
  const env = { PICO_HOME: picoHome };
  const lockPath = resolveLocalDaemonLockPath(resolveLocalDaemonEndpoint({ env }));
  t.after(async () => {
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  return { picoHome, env, lockPath, cleanup: async () => undefined };
}

test("daemon candidate: in-process winner serves the full chain and releases the guard lock on close", async (t) => {
  const harness = await startCandidateHarness(t);
  const result = await startPicoDaemonRuntimeHostCandidate({
    rootPath: harness.picoHome,
    env: harness.env,
  });
  assert.equal(result.kind, "winner", `期望 winner，实际 ${JSON.stringify(result)}`);
  if (result.kind !== "winner") return;

  // 守卫锁被 winner 持有（升级期防旧 daemon 并存）。
  assert.equal(await pathExists(harness.lockPath), true, "winner 应持有升级守卫锁");

  const connection = await connectToCandidate(harness.picoHome);
  t.after(async () => {
    await connection.close().catch(() => undefined);
  });
  const status = await connection.status(5000);
  assert.equal(status.state, "ready");

  // 通用桥接操作经 production services 实盘应答。
  const ping = await connection.requestRegistered<{ result: unknown }>(
    "runtime.request",
    { method: "runtime.ping", params: {} },
    10_000,
  );
  assert.ok(ping.result, "runtime.ping 应经 production service 成功应答");

  // 关停：composition.close → daemonHost.stop（fence 链）→ 守卫锁释放。
  await result.host.close();
  assert.equal(await pathExists(harness.lockPath), false, "关停后守卫锁应释放");
});

test("daemon candidate: a live legacy instance lock blocks startup (upgrade guard)", async (t) => {
  const harness = await startCandidateHarness(t);
  // 模拟旧版本 daemon：持有旧 instance-lock（本进程 pid 存活）。
  const legacyLock = await LocalDaemonInstanceLock.acquire({
    endpoint: resolveLocalDaemonEndpoint({ env: harness.env }),
  });
  t.after(async () => {
    await legacyLock.release().catch(() => undefined);
  });

  const result = await startPicoDaemonRuntimeHostCandidate({
    rootPath: harness.picoHome,
    env: harness.env,
  });
  assert.equal(result.kind, "legacy_daemon_running");
  if (result.kind === "legacy_daemon_running") {
    assert.match(result.message, /旧版本/);
  }
  // 守卫失败时不应创建 storage root 标记之外的状态：flock 未被抢、锁仍在旧持有者手里。
  assert.equal(await pathExists(harness.lockPath), true);
});

test("daemon candidate: losing the flock election exits as loser", async (t) => {
  const harness = await startCandidateHarness(t);
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const owner: InteractiveRootOwner | undefined = await tryAcquireInteractiveRootOwner(capability);
  assert.ok(owner, "测试应先抢到 flock");
  t.after(async () => {
    await owner.close().catch(() => undefined);
  });

  const result = await startPicoDaemonRuntimeHostCandidate({
    rootPath: harness.picoHome,
    env: harness.env,
  });
  assert.equal(result.kind, "loser");
  // loser 路径应放掉已抢到的守卫锁（不滞留）。
  assert.equal(await pathExists(harness.lockPath), false, "loser 应释放升级守卫锁");
});

test("daemon candidate: connectOrSpawn spawns the pico daemon entrypoint and reaches ready", async (t) => {
  const harness = await startCandidateHarness(t);
  const mainPath = fileURLToPath(new URL("../../src/daemon/main.ts", import.meta.url));

  const result = await connectOrSpawnRuntimeHost({
    rootPath: harness.picoHome,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "candidate-spawn-test-client",
    electionDeadlineMs: 45_000,
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
    candidateEntrypoint: pathToFileURL(mainPath).href,
    env: harness.env,
  });
  assert.equal(result.kind, "connected", `期望 connected，实际 ${JSON.stringify(result)}`);
  if (result.kind !== "connected") return;
  const connection = result.connection;

  const status = await connection.status(5_000);
  assert.equal(status.state, "ready");

  const ping = await connection.requestRegistered<{ result: unknown }>(
    "runtime.request",
    { method: "runtime.ping", params: {} },
    10_000,
  );
  assert.ok(ping.result, "spawn 出的 daemon 应答 runtime.ping");

  // 清理：daemon 是常驻进程（retainUntilProcessExit），测试结束后硬杀（Windows 无跨
  // 进程优雅信号）；registration/flock/守卫锁均有 pid-dead 恢复语义。
  await connection.close().catch(() => undefined);
  const registrationPath = await findRegistrationPath(harness.picoHome);
  if (registrationPath) {
    try {
      const registration = await readHostRegistration(
        JSON.parse(await readFile(registrationPath, "utf8")),
      );
      if (registration) process.kill(registration.pid);
    } catch {
      // 已退出或注册不可读：测试通过即达意。
    }
  }
});

async function connectToCandidate(picoHome: string): Promise<RuntimeHostConnection> {
  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  const { controlDirectory } = await prepareStorageRootControlDirectory(capability);
  const connectResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: `candidate-test-client-${performance.now()}`,
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
  });
  assert.equal(connectResult.kind, "connected");
  if (connectResult.kind !== "connected") throw new Error("unreachable");
  return connectResult.connection;
}

async function findRegistrationPath(picoHome: string): Promise<string | undefined> {
  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  const registrationPath = join(
    resolveRootControlNamespace(),
    capability.rootId,
    "registration.json",
  );
  return (await pathExists(registrationPath)) ? registrationPath : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
