import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import type { RuntimeNotification } from "@pico/protocol";
import {
  LocalRuntimeClient,
  RuntimeClientError,
  type LocalRuntimeClientOptions,
} from "../../../src/daemon/index.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import { sessionOwnerLeaseDirectory } from "../../../src/storage/session-owner-lease.js";
import { TestRuntimeHostCandidateTracker } from "../helpers/test-runtime-daemon.js";

/**
 * 3-B-3 kernel 承载客户端实盘验证：LocalRuntimeClient
 * 经 connectOrSpawn 拉起 daemon candidate，请求走 runtime.request 通用桥接、订阅走
 * events.* 类型化桥接；host 错误码反查回 daemon 码（INVALID_PARAMS cursor 自动重置）；
 * daemon 进程被杀后下一次请求触发重生。
 *
 * PICO_HOME 在 harness 内改写（测试进程独立），每个测试使用独立 storage root。
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
      new LocalRuntimeClient({
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

test("kernel client: current shutdown waits for response, ownership drain and process exit", async (t) => {
  const harness = await startKernelClientHarness(t);
  const client = harness.createClient();
  t.after(() => client.close());
  await client.connect();

  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const before = await readHostRegistration(controlDirectory);
  assert.ok(before);

  const created = await client.request("session.create", { workspacePath: harness.workspacePath });
  const sessionId = created.session.sessionId;
  await client.request("workspace.trust", {
    workspacePath: harness.workspacePath,
    trusted: true,
  });
  await client.request("goal.get", { workspacePath: harness.workspacePath, sessionId });
  const leaseDirectory = sessionOwnerLeaseDirectory(
    resolvePicoPaths(harness.workspacePath, { picoHome: harness.picoHome }).workspace,
    sessionId,
  );
  await assert.doesNotReject(access(leaseDirectory), "当前 daemon 应持有 Session lease");

  await client.shutdownDaemon();
  assert.equal(await processAlive(before.pid), false, "shutdown 返回前 daemon PID 必须退出");
  assert.equal(await readHostRegistration(controlDirectory), undefined);
  await assert.rejects(access(leaseDirectory), { code: "ENOENT" });
});

test("kernel client: shutdown EOF before a flushed response remains an error", async (t) => {
  const harness = await startKernelClientHarness(t);
  const fixture = fileURLToPath(
    new URL("../../fixtures/runtime-host-unflushed-shutdown-candidate.ts", import.meta.url),
  );
  const client = harness.createClient({ candidateEntrypoint: fixture });
  t.after(() => client.close());
  await client.connect();

  const capability = await resolveStorageRoot({ path: harness.picoHome, kind: "interactive" });
  const controlDirectory = join(resolveRootControlNamespace(), capability.rootId);
  const before = await readHostRegistration(controlDirectory);
  assert.ok(before);

  await assert.rejects(client.shutdownDaemon(), (error: unknown) => {
    assert.ok(error instanceof RuntimeClientError);
    assert.equal(error.code, "RUNTIME_DISCONNECTED");
    return true;
  });
  assert.equal(await processAlive(before.pid), true, "响应前 EOF 不得被误判为进程已关停");
  assert.equal((await readHostRegistration(controlDirectory))?.hostEpoch, before.hostEpoch);
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
