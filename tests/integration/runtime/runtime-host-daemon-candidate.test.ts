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
  ensurePicoRuntimeHostOperationsRegistered,
  ensurePicoRuntimeHostShutdownOperationRegistered,
  startPicoDaemonRuntimeHostCandidate,
} from "../../../src/daemon/index.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { sessionOwnerLeaseDirectory } from "../../../src/storage/session-owner-lease.js";
import {
  stopTestChildProcess,
  TestRuntimeHostCandidateTracker,
} from "../helpers/test-runtime-daemon.js";

/**
 * 3-B-3 daemon candidate 实盘验证：
 * 1. in-process winner：严格 root identity→flock→kernel+production composition；
 * 2. flock 被占 → loser；
 * 3. connectOrSpawn spawn 真进程（pico main.ts 自定义 entrypoint + env 透传）；
 * 4. runtime.shutdown 响应刷出后完成完整 ownership drain。
 *
 * kernel 符号从 dist 导入（模块身份规则，与 composition/events 桥接测试一致）。
 */

interface CandidateHarness {
  picoHome: string;
  rootId: string;
  env: Record<string, string | undefined>;
  candidates: TestRuntimeHostCandidateTracker;
  cleanup: () => Promise<void>;
}

async function startCandidateHarness(t: {
  after(hook: () => unknown): void;
}): Promise<CandidateHarness> {
  const root = await mkdtemp(join(tmpdir(), "pico-daemon-candidate-"));
  const picoHome = join(root, "pico-home");
  await mkdir(picoHome, { recursive: true });
  const env = { PICO_HOME: picoHome };
  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  const candidates = new TestRuntimeHostCandidateTracker();
  t.after(async () => {
    await candidates.stopAll();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  return {
    picoHome,
    rootId: capability.rootId,
    env,
    candidates,
    cleanup: async () => undefined,
  };
}

test("daemon candidate: strict in-process winner serves the full chain", async (t) => {
  const harness = await startCandidateHarness(t);
  const result = await startPicoDaemonRuntimeHostCandidate({
    rootPath: harness.picoHome,
    expectedRootId: harness.rootId,
    env: harness.env,
  });
  t.after(async () => {
    if (result.kind === "winner") await result.host.close().catch(() => undefined);
  });
  assert.equal(result.kind, "winner", `期望 winner，实际 ${JSON.stringify(result)}`);
  if (result.kind !== "winner") return;

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

  // 关停：composition.close → daemonHost.stop（fence 链）。
  await result.host.close();
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
    expectedRootId: harness.rootId,
    env: harness.env,
  });
  assert.equal(result.kind, "loser");
});

test("daemon candidate: connectOrSpawn spawns the pico daemon entrypoint and reaches ready", async (t) => {
  const harness = await startCandidateHarness(t);
  const mainPath = fileURLToPath(new URL("../../../src/daemon/main.ts", import.meta.url));

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
    candidateLauncher: harness.candidates.launcher,
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

  // 清理必须等待注册到该隔离 root 的精确 PID 退出，再允许 harness 删除 root。
  const registration = await readHostRegistration(await findControlDirectory(harness.picoHome));
  assert.ok(registration);
  await connection.close().catch(() => undefined);
  await harness.candidates.stopAll();
  assert.equal(await processAlive(registration.pid), false, "teardown 返回前 daemon 必须退出");
});

test("daemon candidate: runtime.shutdown gracefully stops the resident daemon", async (t) => {
  const harness = await startCandidateHarness(t);
  const mainPath = fileURLToPath(new URL("../../../src/daemon/main.ts", import.meta.url));
  // client 侧也要能解码 runtime.shutdown（进程级动态注册表）。
  ensurePicoRuntimeHostShutdownOperationRegistered();

  // 手动 spawn 一个严格参数候选而非 connectOrSpawn spawn：connectOrSpawn 的选举
  // 在候选启动慢的环境下会连续 spawn 多个候选（候选池），shutdown 期间池中候选
  // 可能接手 registration。手动 spawn + 直连把被测对象限定为单个 daemon 的
  // 优雅关停路径。
  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsxLoader,
      mainPath,
      "--root",
      harness.picoHome,
      "--expected-root-id",
      capability.rootId,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...harness.env },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  t.after(async () => {
    await stopTestChildProcess(child);
  });

  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  // 等 registration 发布（候选启动完成）。
  for (let i = 0; i < 60; i++) {
    if (await readHostRegistration(controlDirectory)) break;
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
  const status = await waitForReadyStatus(connection, 15_000);
  assert.equal(status.state, "ready");

  const registration = await readHostRegistration(controlDirectory);
  assert.ok(registration, "daemon 应有 registration");
  const pid = registration!.pid;

  // 请求优雅关停：handler 触发 kernel requestDrain → 排空 → composition.close
  // → residency 归零 → 连接被 destroy → 进程退出。
  const shutdown = await connection.requestRegistered("runtime.shutdown", {}, 10_000);
  assert.deepEqual(shutdown, {}, "runtime.shutdown 应答空对象");

  // 连接被 kernel destroy（关停路径最后一步）。
  await assert.doesNotReject(Promise.race([connection.closed, delay(10_000)]));
  // 注册消失 + 进程退出（有界轮询）。
  const deadline = performance.now() + 15_000;
  let registrationGone = false;
  while (performance.now() < deadline) {
    registrationGone =
      (await readHostRegistration(await findControlDirectory(harness.picoHome))) === undefined;
    const processExited = !(await processAlive(pid));
    if (registrationGone && processExited) break;
    await delay(200);
  }
  assert.equal(await processAlive(pid), false, "优雅关停后 daemon 进程应退出");
  assert.equal(registrationGone, true, "优雅关停后 registration 应移除");
});

test("daemon candidate: current shutdown drains cached Session lease before successor takeover", async (t) => {
  const harness = await startCandidateHarness(t);
  const workspacePath = join(harness.picoHome, "shutdown-workspace");
  await mkdir(workspacePath, { recursive: true });
  const mainPath = fileURLToPath(new URL("../../../src/daemon/main.ts", import.meta.url));
  ensurePicoRuntimeHostOperationsRegistered();
  ensurePicoRuntimeHostShutdownOperationRegistered();

  const { spawn } = await import("node:child_process");
  const { createRequire } = await import("node:module");
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const currentChild = spawn(
    process.execPath,
    [
      "--import",
      tsxLoader,
      mainPath,
      "--root",
      harness.picoHome,
      "--expected-root-id",
      capability.rootId,
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, ...harness.env },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  t.after(async () => {
    await stopTestChildProcess(currentChild);
  });

  const currentRegistration = await waitForRegistration(controlDirectory, 30_000);
  assert.ok(currentRegistration, "当前 daemon 应发布 registration");
  const currentConnectionResult = await connectResolvedRuntimeHost({
    capability,
    controlDirectory,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "candidate-shutdown-current-client",
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
  });
  assert.equal(currentConnectionResult.kind, "connected");
  if (currentConnectionResult.kind !== "connected") return;
  const currentConnection = currentConnectionResult.connection;
  await waitForReadyStatus(currentConnection, 15_000);

  const created = await currentConnection.requestRegistered<{
    result: { session: { sessionId: string } };
  }>("runtime.request", { method: "session.create", params: { workspacePath } }, 10_000);
  const sessionId = created.result.session.sessionId;
  await currentConnection.requestRegistered(
    "runtime.request",
    { method: "workspace.trust", params: { workspacePath, trusted: true } },
    10_000,
  );
  await currentConnection.requestRegistered(
    "runtime.request",
    { method: "goal.get", params: { workspacePath, sessionId } },
    10_000,
  );
  const ownerPath = join(
    sessionOwnerLeaseDirectory(
      resolvePicoPaths(workspacePath, { picoHome: harness.picoHome }).workspace,
      sessionId,
    ),
    "owner.json",
  );
  assert.equal(await pathExists(ownerPath), true, "Session 应由当前 daemon 缓存并持 lease");

  await currentConnection.requestRegistered("runtime.shutdown", {}, 10_000);
  await waitForProcessExit(currentRegistration.pid, 15_000);
  assert.equal(await processAlive(currentRegistration.pid), false, "关停必须终止当前 PID");
  assert.equal(await pathExists(ownerPath), false, "当前 PID 退出前必须主动释放 Session lease");
  await currentConnection.close().catch(() => undefined);

  const successor = await connectOrSpawnRuntimeHost({
    rootPath: harness.picoHome,
    surface: "tui",
    protocol: { min: RUNTIME_HOST_PROTOCOL_VERSION, max: RUNTIME_HOST_PROTOCOL_VERSION },
    clientInstanceId: "candidate-shutdown-successor-client",
    electionDeadlineMs: 45_000,
    connectTimeoutMs: 5_000,
    handshakeTimeoutMs: 5_000,
    candidateEntrypoint: pathToFileURL(mainPath).href,
    env: harness.env,
    candidateLauncher: harness.candidates.launcher,
  });
  assert.equal(successor.kind, "connected", `新 daemon 接管失败：${JSON.stringify(successor)}`);
  if (successor.kind !== "connected") return;
  const successorStatus = await waitForReadyStatus(successor.connection, 15_000);
  assert.equal(successorStatus.state, "ready", "successor daemon 必须 ready 后再接管 Session");
  const successorRegistration = await readHostRegistration(controlDirectory);
  assert.ok(successorRegistration);
  assert.notEqual(successorRegistration.pid, currentRegistration.pid);
  await successor.connection.requestRegistered(
    "runtime.request",
    { method: "goal.get", params: { workspacePath, sessionId } },
    10_000,
  );
  assert.equal(await pathExists(ownerPath), true, "新 daemon 应无需等待 30s 即可接管 Session");
  await successor.connection.requestRegistered("runtime.shutdown", {}, 10_000);
  await waitForProcessExit(successorRegistration.pid, 15_000);
});

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForRegistration(
  controlDirectory: string,
  timeoutMs: number,
): Promise<Awaited<ReturnType<typeof readHostRegistration>>> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    const registration = await readHostRegistration(controlDirectory);
    if (registration) return registration;
    await delay(100);
  }
  return undefined;
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (!(await processAlive(pid))) return;
    await delay(100);
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
