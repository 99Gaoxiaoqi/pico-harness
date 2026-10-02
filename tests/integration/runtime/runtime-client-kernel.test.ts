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
} from "@pico/pico-host/local-runtime-client";
import { resolvePicoPaths } from "@pico/pico-host";
import { sessionOwnerLeaseDirectory, withWorkspaceSqliteLease } from "@pico/storage";
import { TestRuntimeHostCandidateTracker } from "../helpers/test-runtime-daemon.js";
import { writeDesktopModelRouting } from "../../fixtures/desktop-model-routing.js";

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
  await writeDesktopModelRouting(harness.picoHome);
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
  // shutdown targets the connected Host epoch, not late candidates already launched
  // by the election. A successor may register after the old owner releases its flock;
  // the harness tracks every launched process and stops them all during teardown.
  const after = await readHostRegistration(controlDirectory);
  assert.notEqual(after?.hostEpoch, before.hostEpoch, "已关停的 Host epoch 不得仍注册");
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

test("kernel client: trusted terminal owners isolate control, cleanup and reconnect", async (t) => {
  const harness = await startKernelClientHarness(t);
  await writeDesktopModelRouting(harness.picoHome);
  const desktop = harness.createClient({ surface: "desktop", terminalOwnerId: "desktop:window-a" });
  const mobile = harness.createClient({ surface: "inspect", terminalOwnerId: "remote:device-a" });
  assert.deepEqual(await mobile.request("terminal.ownershipCapabilities", {}), {
    ownerIsolation: true,
    sessionCleanupIsolation: true,
  });
  t.after(() => desktop.close());
  t.after(() => mobile.close());
  const workspacePath = harness.workspacePath;
  const sessionId = (await desktop.request("session.create", { workspacePath })).session.sessionId;
  const scope = { workspacePath, sessionId };
  const legacy = harness.createClient({
    terminalOwnerId: "pico-client-old-desktop",
    surface: "tui",
  });
  t.after(() => legacy.close());
  const legacyTerminal = await legacy.request("terminal.create", scope);
  assert.equal(
    legacyTerminal.terminal.terminalOwnerId,
    undefined,
    "old hello receives old exact result shape",
  );
  const legacyTarget = {
    ...scope,
    terminalId: legacyTerminal.terminal.terminalId,
    resourceEpoch: legacyTerminal.resourceEpoch,
  };
  await assert.rejects(
    mobile.request("terminal.stop", legacyTarget),
    (error: unknown) => error instanceof RuntimeClientError && error.code === "FORBIDDEN",
  );
  await desktop.request("terminal.stop", legacyTarget);
  const desktopTerminal = await desktop.request("terminal.create", scope);
  const mobileTerminal = await mobile.request("terminal.create", scope);
  assert.equal(mobileTerminal.terminal.terminalOwnerId, "remote:device-a");
  assert.equal(mobileTerminal.terminal.controlAllowed, true);
  assert.equal(desktopTerminal.terminal.capability, process.platform === "win32" ? "pipe" : "pty");
  const target = {
    ...scope,
    terminalId: mobileTerminal.terminal.terminalId,
    resourceEpoch: mobileTerminal.resourceEpoch,
  };
  const foreignRead = await desktop.request("terminal.attach", {
    ...scope,
    terminalId: target.terminalId,
  });
  assert.equal(foreignRead.terminal.controlAllowed, false);
  await assert.rejects(
    desktop.request("terminal.input", { ...target, data: "exit\n" }),
    (error: unknown) => error instanceof RuntimeClientError && error.code === "FORBIDDEN",
  );
  await assert.rejects(
    desktop.request("terminal.stop", target),
    (error: unknown) => error instanceof RuntimeClientError && error.code === "FORBIDDEN",
  );
  // Spoofing ownership through JSON params is rejected before service dispatch.
  await assert.rejects(
    desktop.request("terminal.create", { ...scope, terminalOwnerId: "remote:device-a" } as never),
    (error: unknown) => error instanceof RuntimeClientError && error.code === "INVALID_PARAMS",
  );
  assert.equal((await desktop.request("terminal.stopOwned", {})).stopped, 1);
  const remaining = await mobile.request("terminal.list", scope);
  assert.equal(
    remaining.terminals.find((terminal) => terminal.terminalId === target.terminalId)?.status,
    "running",
  );
  await assert.rejects(
    desktop.request("terminal.create", scope),
    (error: unknown) => error instanceof RuntimeClientError && error.code === "CONFLICT",
  );
  await desktop.request("terminal.resume", {});
  const next = await desktop.request("terminal.create", scope);
  assert.equal(next.terminal.status, "running");
  mobile.close();
  const reconnected = harness.createClient({
    surface: "inspect",
    terminalOwnerId: "remote:device-a",
  });
  t.after(() => reconnected.close());
  const attached = await reconnected.request("terminal.attach", {
    ...scope,
    terminalId: target.terminalId,
  });
  assert.equal(
    attached.terminal.status,
    "running",
    "disconnect only detaches; it must not terminate PTY",
  );
  assert.equal(attached.terminal.controlAllowed, true);
  if (process.platform !== "win32") {
    // Mobile xterm sends individual keystrokes, including whitespace and Enter.
    for (const data of ["\t", "\x15", ..."printf 'mobile-owner-ready\\n'\r"]) {
      await reconnected.request("terminal.input", { ...target, data });
    }
    for (const data of ["", "x".repeat(64 * 1024 + 1)]) {
      await assert.rejects(
        reconnected.request("terminal.input", { ...target, data }),
        (error: unknown) => error instanceof RuntimeClientError && error.code === "INVALID_PARAMS",
      );
    }
    assert.equal(
      await waitForCondition(async () => {
        const output = await reconnected.request("terminal.attach", {
          ...scope,
          terminalId: target.terminalId,
        });
        return /(?:^|[\r\n])mobile-owner-ready[\r\n]/.test(output.snapshot);
      }, 5_000),
      true,
    );
    await reconnected.request("terminal.resize", { ...target, cols: 100, rows: 30 });
  }
  await reconnected.request("terminal.stop", target);
  await desktop.request("terminal.stopOwned", {});
});

test("kernel client: remote session cleanup cannot terminate any owner's terminal or hidden child", async (t) => {
  const harness = await startKernelClientHarness(t);
  await writeDesktopModelRouting(harness.picoHome);
  const desktop = harness.createClient({ surface: "desktop", terminalOwnerId: "desktop:cleanup" });
  const remote = harness.createClient({ surface: "inspect", terminalOwnerId: "remote:cleanup" });
  t.after(() => desktop.close());
  t.after(() => remote.close());
  const workspacePath = harness.workspacePath;
  await desktop.request("workspace.register", { workspacePath });
  await desktop.request("workspace.trust", { workspacePath, trusted: true });
  const parent = (await desktop.request("session.create", { workspacePath })).session.sessionId;
  const child = (await desktop.request("session.create", { workspacePath })).session.sessionId;
  const grandchild = (await desktop.request("session.create", { workspacePath })).session.sessionId;
  const own = (await remote.request("session.create", { workspacePath })).session.sessionId;
  const grandchildScope = { workspacePath, sessionId: grandchild };
  const grandchildTerminal = await desktop.request("terminal.create", grandchildScope);
  const childScope = { workspacePath, sessionId: child };
  const childTerminal = await desktop.request("terminal.create", childScope);
  const ownTerminal = await remote.request("terminal.create", { workspacePath, sessionId: own });
  // Persist a valid expired lease for two real daemon-created sessions. Production list/recovery
  // and cleanup read this exact workspace lease; no fake runtime or cleanup implementation is used.
  const storageRoot = resolvePicoPaths(workspacePath, { picoHome: harness.picoHome }).workspace
    .root;
  const expired = new Date(Date.now() - 600_000).toISOString();
  withWorkspaceSqliteLease(storageRoot, ({ database }) => {
    database.prepare("INSERT OR REPLACE INTO workspace_kv (key, value_json) VALUES (?, ?)").run(
      "desktop.side-chat.leases.v1",
      JSON.stringify([
        {
          panelId: "cleanup-panel",
          sourceSessionId: parent,
          targetSessionId: child,
          throughEventId: "event_cleanup_fixture",
          state: "live",
          createdAt: expired,
          updatedAt: expired,
        },
        {
          panelId: "nested-cleanup-panel",
          sourceSessionId: child,
          targetSessionId: grandchild,
          throughEventId: "event_nested_cleanup_fixture",
          state: "live",
          createdAt: expired,
          updatedAt: expired,
        },
      ]),
    );
  });
  const runsBefore = await remote.request("runs.list", { workspacePath });
  const listed = await remote.request("session.list", { workspacePath });
  assert.ok(listed.sessions.some((session) => session.sessionId === parent));
  assert.ok(
    !listed.sessions.some((session) => session.sessionId === child),
    "child stays hidden without remote-triggered expiry cleanup",
  );
  const denied = (error: unknown) =>
    error instanceof RuntimeClientError &&
    error.code === "FORBIDDEN" &&
    /terminal.stop/u.test(error.message);
  await assert.rejects(
    remote.request("session.delete", { workspacePath, sessionId: parent }),
    denied,
  );
  await assert.rejects(remote.request("sideChat.close", childScope), denied);
  await assert.rejects(remote.request("session.delete", { workspacePath, sessionId: own }), denied);
  assert.equal(
    (await remote.request("session.get", { workspacePath, sessionId: parent })).session.sessionId,
    parent,
  );
  assert.equal((await remote.request("session.get", childScope)).session.sessionId, child);
  assert.equal(
    (await remote.request("session.get", { workspacePath, sessionId: own })).session.sessionId,
    own,
  );
  assert.deepEqual(
    await remote.request("runs.list", { workspacePath }),
    runsBefore,
    "rejected cleanup does not cancel tasks",
  );
  assert.equal(
    (await desktop.request("terminal.list", childScope)).terminals[0]?.status,
    "running",
  );
  assert.equal(
    (await remote.request("terminal.list", { workspacePath, sessionId: own })).terminals[0]?.status,
    "running",
  );
  // Remote sideChat.create must not run global stale-lease recovery either.
  const reused = await remote.request("sideChat.create", {
    workspacePath,
    sourceSessionId: parent,
    panelId: "cleanup-panel",
    idempotencyKey: "reuse-cleanup-panel",
  });
  assert.equal(reused.session.sessionId, child);
  assert.equal(
    (await desktop.request("terminal.list", childScope)).terminals[0]?.status,
    "running",
  );
  await desktop.request("terminal.stop", {
    ...childScope,
    terminalId: childTerminal.terminal.terminalId,
    resourceEpoch: childTerminal.resourceEpoch,
  });
  // The direct child's Shell is stopped; the hidden grandchild must still block both paths.
  await assert.rejects(
    remote.request("session.delete", { workspacePath, sessionId: parent }),
    denied,
  );
  await assert.rejects(remote.request("sideChat.close", childScope), denied);
  assert.equal(
    (await remote.request("session.get", { workspacePath, sessionId: parent })).session.sessionId,
    parent,
  );
  assert.equal(
    (await desktop.request("terminal.list", grandchildScope)).terminals[0]?.status,
    "running",
  );
  await desktop.request("terminal.stop", {
    ...grandchildScope,
    terminalId: grandchildTerminal.terminal.terminalId,
    resourceEpoch: grandchildTerminal.resourceEpoch,
  });
  const deleted = await remote.request("session.delete", { workspacePath, sessionId: parent });
  assert.equal(deleted.deleted, true);
  assert.deepEqual(deleted.closedSessionIds, [grandchild, child]);
  await remote.request("terminal.stop", {
    workspacePath,
    sessionId: own,
    terminalId: ownTerminal.terminal.terminalId,
    resourceEpoch: ownTerminal.resourceEpoch,
  });
  assert.equal(
    (await remote.request("session.delete", { workspacePath, sessionId: own })).deleted,
    true,
  );
  // Preserve the existing explicit Desktop deletion behavior.
  const desktopSession = (await desktop.request("session.create", { workspacePath })).session
    .sessionId;
  await remote.request("terminal.create", { workspacePath, sessionId: desktopSession });
  assert.equal(
    (await desktop.request("session.delete", { workspacePath, sessionId: desktopSession })).deleted,
    true,
  );
  await desktop.shutdownDaemon();
});
