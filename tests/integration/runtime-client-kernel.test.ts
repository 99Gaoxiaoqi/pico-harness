import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { RUNTIME_ERROR_CODES } from "@pico/protocol";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import {
  LocalRuntimeClient,
  RuntimeClientError,
  type LocalRuntimeClientOptions,
  type RuntimeNotification,
} from "../../src/daemon/index.js";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { resolveOwnerLeaseTombstonePath } from "../../src/storage/owner-lease.js";
import { sessionOwnerLeaseDirectory } from "../../src/storage/session-owner-lease.js";
import { resumeDesktopTerminalGenerationWithUpgrade } from "../../apps/desktop/src/main/daemon-controller.js";
import {
  stopTestChildProcess,
  TestRuntimeHostCandidateTracker,
} from "./helpers/test-runtime-daemon.js";

/**
 * 3-B-3 kernel 承载客户端实盘验证：默认构造（不注入 endpoint）的 LocalRuntimeClient
 * 经 connectOrSpawn 拉起 daemon candidate，请求走 runtime.request 通用桥接、订阅走
 * events.* 类型化桥接；host 错误码反查回 daemon 码（INVALID_PARAMS cursor 自动重置）；
 * daemon 进程被杀后下一次请求触发重生。
 *
 * PICO_HOME 在 harness 内改写（测试进程独立）：spawn 出的 daemon 继承本进程 env，
 * 其升级守卫锁按 PICO_HOME 摘要派生，与其他测试文件隔离。
 */

interface KernelClientHarness {
  picoHome: string;
  workspacePath: string;
  candidates: TestRuntimeHostCandidateTracker;
  createClient(
    options?: Omit<LocalRuntimeClientOptions, "runtimeHostRootPath" | "candidateLauncher">,
  ): LocalRuntimeClient;
  cleanup: () => Promise<void>;
}

async function startKernelClientHarness(t: {
  after(hook: () => unknown): void;
}): Promise<KernelClientHarness> {
  const root = await mkdtemp(join(tmpdir(), "pico-client-kernel-"));
  const picoHome = join(root, "pico-home");
  const workspaceDir = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceDir, { recursive: true });
  process.env.PICO_HOME = picoHome;
  const candidates = new TestRuntimeHostCandidateTracker();
  t.after(async () => {
    await candidates.stopAll();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });
  return {
    picoHome,
    workspacePath: await realpath(workspaceDir),
    candidates,
    createClient: (options = {}) =>
      new LocalRuntimeClient(undefined, {
        ...options,
        runtimeHostRootPath: picoHome,
        candidateLauncher: candidates.launcher,
      }),
    cleanup: async () => undefined,
  };
}

test("kernel client: request + subscribe + live push over the spawned daemon", async (t) => {
  const harness = await startKernelClientHarness(t);
  const client = harness.createClient();
  t.after(() => client.close());

  // connect() 触发 connectOrSpawn：首次拉起 daemon candidate。
  await client.connect();
  const ping = await client.request("runtime.ping", {});
  assert.ok(ping, "runtime.ping 应经 runtime.request 桥接成功");

  // 订阅：首页回放 + live 推送（第二个客户端触发 durable 事件）。
  const received: RuntimeNotification[] = [];
  const { replay, dispose } = await client.subscribe(
    { workspacePath: harness.workspacePath },
    (event) => received.push(event),
  );
  assert.equal(replay.subscribed, true);

  const trigger = harness.createClient();
  t.after(() => trigger.close());
  await trigger.request("workspace.register", { workspacePath: harness.workspacePath });

  const delivered = await waitForCondition(() => received.length >= 1, 10_000);
  assert.ok(delivered, "live durable 事件应推送到订阅监听器");
  assert.equal(received[0]?.topic, "workspace.registered");
  dispose();
});

test("kernel client: expired cursor resets and resubscribes (INVALID_PARAMS reverse mapping)", async (t) => {
  const harness = await startKernelClientHarness(t);
  const client = harness.createClient();
  t.after(() => client.close());
  await client.connect();
  await client.request("workspace.register", { workspacePath: harness.workspacePath });

  // 不存在的 afterEventId：daemon 侧 INVALID_PARAMS → 桥接 invalid_request →
  // 客户端反查 INVALID_PARAMS → 订阅环自动清 cursor 全量重订。
  const received: RuntimeNotification[] = [];
  const { replay, dispose } = await client.subscribe(
    {
      workspacePath: harness.workspacePath,
      afterEventId: "event_00000000-0000-4000-8000-000000000000",
    },
    (event) => received.push(event),
  );
  assert.equal(replay.subscribed, true, "cursor 重置后订阅应成功");
  assert.ok(replay.events.length >= 1, "全量重订首页应包含已注册事件");
  dispose();
});

test("kernel client: killing the daemon makes the next request respawn it", async (t) => {
  const harness = await startKernelClientHarness(t);
  const client = harness.createClient();
  t.after(() => client.close());
  await client.connect();
  await client.request("runtime.ping", {});

  // 从 registration 读 pid，硬杀 daemon（模拟崩溃）。
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const registration = await readHostRegistration(controlDirectory);
  assert.ok(registration);
  await harness.candidates.terminateOwned(registration.pid);

  // 下一次请求：断连检测 → openKernel → connectOrSpawn 发现 host 死亡 → 重生。
  const ping = await client.request("runtime.ping", {});
  assert.ok(ping, "daemon 被杀后下一次请求应触发重生并成功");

  // 重生实例由 harness 持有其稳定进程能力并统一清理。
});

test("kernel client: Desktop 检出旧方法后优雅关闭常驻 daemon 并接管新版本", async (t) => {
  const harness = await startKernelClientHarness(t);
  const client = harness.createClient();
  t.after(() => client.close());
  await client.connect();
  await client.request("runtime.ping", {});

  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const before = await readHostRegistration(controlDirectory);
  assert.ok(before);
  let resumeAttempts = 0;
  await resumeDesktopTerminalGenerationWithUpgrade({
    resume: async () => {
      resumeAttempts++;
      if (resumeAttempts === 1) {
        throw new RuntimeClientError(
          RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
          "legacy daemon does not expose terminal.resume",
          false,
        );
      }
      await client.request("terminal.resume", {});
    },
    shutdownLegacyHost: () => client.shutdownDaemon(),
    reconnect: async () => {
      const deadline = performance.now() + 30_000;
      for (;;) {
        try {
          await client.request("runtime.ping", {});
          return;
        } catch (error) {
          if (!(error instanceof RuntimeClientError) || !error.retryable) throw error;
          if (performance.now() >= deadline) {
            throw new Error("new daemon did not become ready", { cause: error });
          }
          await delay(100);
        }
      }
    },
    isMethodNotFound: (error) =>
      error instanceof RuntimeClientError && error.code === RUNTIME_ERROR_CODES.METHOD_NOT_FOUND,
  });

  const after = await readHostRegistration(controlDirectory);
  assert.ok(after);
  assert.notEqual(after.pid, before.pid, "旧 daemon 必须优雅退出并由新 candidate 接管");
  assert.equal(resumeAttempts, 2);
});

test("kernel client: legacy shutdown EOF is accepted only after the old host fully exits", async (t) => {
  const harness = await startKernelClientHarness(t);
  const previousMode = process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"];
  process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"] = "eof-exit";
  t.after(() => restoreEnvironment("PICO_TEST_LEGACY_SHUTDOWN_MODE", previousMode));
  const fixture = fileURLToPath(
    new URL("../fixtures/runtime-host-legacy-shutdown-candidate.ts", import.meta.url),
  );
  await startLegacyShutdownFixture(t, harness.picoHome, fixture);
  const client = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => client.close());

  await client.connect();
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const before = await readHostRegistration(controlDirectory);
  assert.ok(before);

  await client.shutdownDaemon();
  assert.equal(await processAlive(before.pid), false, "旧 daemon 必须真正退出后才能接受 EOF");
  assert.equal(await readHostRegistration(controlDirectory), undefined);
});

test("kernel client: shutdown EOF remains an error while the old host is still alive", async (t) => {
  const harness = await startKernelClientHarness(t);
  const previousMode = process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"];
  process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"] = "eof-stay";
  t.after(() => restoreEnvironment("PICO_TEST_LEGACY_SHUTDOWN_MODE", previousMode));
  const fixture = fileURLToPath(
    new URL("../fixtures/runtime-host-legacy-shutdown-candidate.ts", import.meta.url),
  );
  await startLegacyShutdownFixture(t, harness.picoHome, fixture);
  const client = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => client.close());

  await client.connect();
  await assert.rejects(client.shutdownDaemon(), (error: unknown) => {
    assert.ok(error instanceof RuntimeClientError);
    assert.equal(error.code, "RUNTIME_SHUTDOWN_UNCONFIRMED");
    return true;
  });
});

test("kernel client: a legacy shutdown response is accepted only after the old host fully exits", async (t) => {
  const harness = await startKernelClientHarness(t);
  const previousMode = process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"];
  process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"] = "response-exit";
  t.after(() => restoreEnvironment("PICO_TEST_LEGACY_SHUTDOWN_MODE", previousMode));
  const fixture = fileURLToPath(
    new URL("../fixtures/runtime-host-legacy-shutdown-candidate.ts", import.meta.url),
  );
  await startLegacyShutdownFixture(t, harness.picoHome, fixture);
  const client = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => client.close());

  await client.connect();
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const before = await readHostRegistration(controlDirectory);
  assert.ok(before);

  await client.shutdownDaemon();
  assert.equal(await processAlive(before.pid), false, "成功回包后仍必须等待旧 daemon 真正退出");
  assert.equal(await readHostRegistration(controlDirectory), undefined);
});

test("kernel client: a shutdown response remains an error while the old host is still alive", async (t) => {
  const harness = await startKernelClientHarness(t);
  const previousMode = process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"];
  process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"] = "response-stay";
  t.after(() => restoreEnvironment("PICO_TEST_LEGACY_SHUTDOWN_MODE", previousMode));
  const fixture = fileURLToPath(
    new URL("../fixtures/runtime-host-legacy-shutdown-candidate.ts", import.meta.url),
  );
  await startLegacyShutdownFixture(t, harness.picoHome, fixture);
  const client = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => client.close());

  await client.connect();
  await assert.rejects(client.shutdownDaemon(), (error: unknown) => {
    assert.ok(error instanceof RuntimeClientError);
    assert.equal(error.code, "RUNTIME_SHUTDOWN_UNCONFIRMED");
    return true;
  });
});

test("kernel client: confirmed legacy shutdown retires its fresh Session lease for immediate takeover", async (t) => {
  const harness = await startKernelClientHarness(t);
  const sessionId = "legacy-fresh-lease-takeover";
  const initial = new Session(sessionId, harness.workspacePath, {
    persistence: true,
    picoHome: harness.picoHome,
  });
  await initial.recover();
  await initial.close();

  const leaseDirectory = sessionOwnerLeaseDirectory(
    resolvePicoPaths(harness.workspacePath, { picoHome: harness.picoHome }).workspace,
    sessionId,
  );
  const previousMode = process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"];
  const previousLeaseDirectory = process.env["PICO_TEST_LEGACY_SESSION_LEASE_DIRECTORY"];
  process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"] = "response-exit";
  process.env["PICO_TEST_LEGACY_SESSION_LEASE_DIRECTORY"] = leaseDirectory;
  t.after(() => restoreEnvironment("PICO_TEST_LEGACY_SHUTDOWN_MODE", previousMode));
  t.after(() =>
    restoreEnvironment("PICO_TEST_LEGACY_SESSION_LEASE_DIRECTORY", previousLeaseDirectory),
  );
  const fixture = fileURLToPath(
    new URL("../fixtures/runtime-host-legacy-shutdown-candidate.ts", import.meta.url),
  );
  await startLegacyShutdownFixture(t, harness.picoHome, fixture);
  const legacy = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => legacy.close());
  await legacy.connect();
  const abandonedOwner = JSON.parse(await readFile(join(leaseDirectory, "owner.json"), "utf8")) as {
    leaseId: string;
  };

  await legacy.shutdownDaemon();
  await assert.doesNotReject(
    access(resolveOwnerLeaseTombstonePath(leaseDirectory, abandonedOwner.leaseId)),
    "旧 lease 必须通过 tombstone 迁移保留 ABA 栅栏",
  );
  await assert.rejects(access(leaseDirectory), { code: "ENOENT" });
  const successor = harness.createClient();
  t.after(() => successor.close());
  const takeoverStartedAt = performance.now();
  await successor.request("workspace.trust", {
    workspacePath: harness.workspacePath,
    trusted: true,
  });
  await successor.request("goal.get", { workspacePath: harness.workspacePath, sessionId });
  assert.ok(
    performance.now() - takeoverStartedAt < 10_000,
    "successor 应立即接管同一 Session，而不是等待 30s stale window",
  );
});

test("kernel client: compatibility retirement preserves other PID, hostname, and malformed leases", async (t) => {
  const harness = await startKernelClientHarness(t);
  const previousMode = process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"];
  process.env["PICO_TEST_LEGACY_SHUTDOWN_MODE"] = "response-exit";
  t.after(() => restoreEnvironment("PICO_TEST_LEGACY_SHUTDOWN_MODE", previousMode));
  const fixture = fileURLToPath(
    new URL("../fixtures/runtime-host-legacy-shutdown-candidate.ts", import.meta.url),
  );
  const fixtureRegistration = await startLegacyShutdownFixture(t, harness.picoHome, fixture);
  const ownerRoot = join(
    resolvePicoPaths(harness.workspacePath, { picoHome: harness.picoHome }).workspace.root,
    "session-owners",
  );
  const now = new Date().toISOString();
  const records = [
    {
      directory: join(ownerRoot, "a".repeat(64)),
      contents: `${JSON.stringify({
        schemaVersion: 1,
        leaseId: "other-pid",
        ownerId: "negative-fixture",
        pid: process.pid,
        hostname: hostname(),
        processStartedAt: now,
        acquiredAt: now,
        heartbeatAt: now,
      })}\n`,
    },
    {
      directory: join(ownerRoot, "b".repeat(64)),
      contents: `${JSON.stringify({
        schemaVersion: 1,
        leaseId: "foreign-host",
        ownerId: "negative-fixture",
        pid: fixtureRegistration.pid,
        hostname: "remote.invalid",
        processStartedAt: now,
        acquiredAt: now,
        heartbeatAt: now,
      })}\n`,
    },
    {
      directory: join(ownerRoot, "c".repeat(64)),
      contents: "{ malformed owner record\n",
    },
  ];
  for (const record of records) {
    await mkdir(record.directory, { recursive: true });
    await writeFile(join(record.directory, "owner.json"), record.contents, "utf8");
  }
  const legacy = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => legacy.close());
  await legacy.connect();

  await legacy.shutdownDaemon();
  for (const record of records) {
    assert.equal(
      await readFile(join(record.directory, "owner.json"), "utf8"),
      record.contents,
      `兼容迁移不得改写 ${record.directory}`,
    );
  }
});

test("kernel client: non-idempotent write does not auto-retry after daemon death (P1-2)", async (t) => {
  const harness = await startKernelClientHarness(t);
  const client = harness.createClient();
  t.after(() => client.close());
  await client.connect();
  await client.request("workspace.register", { workspacePath: harness.workspacePath });

  // 杀前备好 registration 信息：kill 与发请求之间不允许有任何 await——
  // 断连传播是宏任务，中间让步会让 open() 走 connectOrSpawn 重生路径，
  // 就测不到"重试循环跳过非幂等方法"这条分支了。
  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const registration = await readHostRegistration(controlDirectory);
  assert.ok(registration);
  const killedPid = registration.pid;
  harness.candidates.signalOwned(killedPid);
  // 非幂等写（workspace.unregister）：传输级失败 + 连接 terminal 后必须立即上抛，
  // 不得丢弃死连接重生重发（双执行风险）。
  const attempt = client.request("workspace.unregister", {
    workspacePath: harness.workspacePath,
  });
  await assert.rejects(attempt, (error: unknown) => {
    assert.ok(error instanceof RuntimeClientError);
    assert.equal(error.code, "RUNTIME_DISCONNECTED");
    return true;
  });

  // 未重生：registration 仍指向被杀 pid（重生路径会拉起新 daemon 并改写它）。
  const after = await readHostRegistration(controlDirectory);
  if (after) {
    assert.equal(after.pid, killedPid, "非幂等失败不应触发 daemon 重生");
  }
  const pidDead = await waitForCondition(() => harness.candidates.ownedExited(killedPid), 2000);
  assert.ok(pidDead, "被杀 daemon 应仍处于死亡状态（无重生实例顶替）");
});

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!(await condition())) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return true;
}

async function processAlive(pid: number): Promise<boolean> {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function startLegacyShutdownFixture(
  t: { after(hook: () => unknown): void },
  picoHome: string,
  fixture: string,
): Promise<NonNullable<Awaited<ReturnType<typeof readHostRegistration>>>> {
  const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
  const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;
  const child = spawn(
    process.execPath,
    ["--import", tsxLoader, fixture, "--root", picoHome, "--expected-root-id", capability.rootId],
    {
      cwd: process.cwd(),
      env: { ...process.env, PICO_HOME: picoHome },
      stdio: "ignore",
      windowsHide: true,
    },
  );
  t.after(async () => {
    await stopTestChildProcess(child);
  });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const registered = await waitForCondition(
    () => readHostRegistration(controlDirectory).then((value) => value?.pid === child.pid),
    10_000,
  );
  assert.equal(registered, true, "旧行为 fixture 应发布 registration");
  const registration = await readHostRegistration(controlDirectory);
  assert.ok(registration);
  return registration;
}
