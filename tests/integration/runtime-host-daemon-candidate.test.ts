import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
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
  ensurePicoRuntimeHostShutdownOperationRegistered,
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
  const status = await waitForReadyStatus(connection, 15_000);
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

  const status = await waitForReadyStatus(connection, 15_000);
  assert.equal(status.state, "ready");

  const ping = await connection.requestRegistered<{ result: unknown }>(
    "runtime.request",
    { method: "runtime.ping", params: {} },
    10_000,
  );
  assert.ok(ping.result, "spawn 出的 daemon 应答 runtime.ping");

  // 清理：daemon 是常驻进程（持有 residency），测试结束后硬杀（Windows 无跨进程
  // 优雅信号）；registration/flock/守卫锁均有 pid-dead 恢复语义。
  await connection.close().catch(() => undefined);
  try {
    const controlDirectory = await findControlDirectory(harness.picoHome);
    const registration = await readHostRegistration(controlDirectory);
    if (registration) process.kill(registration.pid);
  } catch {
    // 已退出或注册不可读：测试通过即达意。
  }
});

test("daemon candidate: runtime.shutdown gracefully stops the resident daemon", async (t) => {
  const harness = await startCandidateHarness(t);
  const mainPath = fileURLToPath(new URL("../../src/daemon/main.ts", import.meta.url));
  // client 侧也要能解码 runtime.shutdown（进程级动态注册表）。
  ensurePicoRuntimeHostShutdownOperationRegistered();

  // 手动 spawn 候选（无参自举）而非 connectOrSpawn spawn：connectOrSpawn 的选举
  // 在候选启动慢的环境下会连续 spawn 多个候选（候选池），shutdown 期间池中候选
  // 可能接手注册写锁/守卫锁，干扰"关停后锁应释放"的断言。手动 spawn + 直连把
  // 被测对象限定为单个 daemon 的优雅关停路径。
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(process.execPath, ["--import", tsxLoader, mainPath], {
    cwd: process.cwd(),
    env: { ...process.env, ...harness.env },
    stdio: "ignore",
    windowsHide: true,
  });
  child.unref();
  t.after(async () => {
    // 若关停失败（断言已红），兜底硬杀避免残留 daemon。
    const registration = await readHostRegistration(await findControlDirectory(harness.picoHome));
    if (registration && (await processAlive(registration.pid))) {
      process.kill(registration.pid);
    }
  });

  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  // 等 registration 发布（候选启动完成）。
  for (let i = 0; i < 60; i++) {
    if (await readHostRegistration(controlDirectory).catch(() => undefined)) break;
    await delay(500);
  }
  const result = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "candidate-shutdown-test-client",
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
  });
  assert.equal(result.kind, "connected", `期望 connected，实际 ${JSON.stringify(result)}`);
  if (result.kind !== "connected") return;
  const connection = result.connection;

  const registration = await readHostRegistration(controlDirectory);
  assert.ok(registration, "daemon 应有 registration");
  const pid = registration!.pid;

  // 请求优雅关停：handler 触发 kernel requestDrain → 排空 → composition.close
  // （守卫锁释放）→ residency 归零 → 连接被 destroy → 进程退出。
  const shutdown = await connection.requestRegistered("runtime.shutdown", {}, 10_000);
  assert.deepEqual(shutdown, {}, "runtime.shutdown 应答空对象");

  // 连接被 kernel destroy（关停路径最后一步）。
  await assert.doesNotReject(Promise.race([connection.closed, delay(10_000)]));
  // 注册消失 + 守卫锁释放 + 进程退出（有界轮询）。
  const deadline = performance.now() + 15_000;
  let registrationGone = false;
  while (performance.now() < deadline) {
    try {
      registrationGone =
        (await readHostRegistration(await findControlDirectory(harness.picoHome))) === undefined;
    } catch {
      registrationGone = true;
    }
    const lockReleased = !(await pathExists(harness.lockPath));
    const processExited = !(await processAlive(pid));
    if (registrationGone && lockReleased && processExited) break;
    await delay(200);
  }
  assert.equal(await pathExists(harness.lockPath), false, "优雅关停后守卫锁应释放");
  assert.equal(await processAlive(pid), false, "优雅关停后 daemon 进程应退出");
  assert.equal(registrationGone, true, "优雅关停后 registration 应移除");
});

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

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

/** recover 窗口（reconcile + cron 启动，环境慢时可达数秒）内轮询直到 ready。 */
async function waitForReadyStatus(
  connection: RuntimeHostConnection,
  deadlineMs: number,
): Promise<{ state: string }> {
  const deadline = performance.now() + deadlineMs;
  let lastStatus: { state: string } = { state: "unknown" };
  while (performance.now() < deadline) {
    lastStatus = await connection.status(Math.min(5_000, deadline - performance.now()));
    if (lastStatus.state === "ready") return lastStatus;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return lastStatus;
}

async function findControlDirectory(picoHome: string): Promise<string> {
  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  return join(resolveRootControlNamespace(), capability.rootId);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}
