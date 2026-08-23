import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import {
  readHostRegistration,
  resolveRootControlNamespace,
  resolveStorageRoot,
} from "@pico/runtime-host";
import { LocalRuntimeClient } from "../../src/daemon/index.js";
import { EMPTY_USER_CONFIG_REVISION, UserConfigStore } from "../../src/input/user-config-store.js";
import { resolvePicoHome } from "../../src/paths/pico-paths.js";
import { ClientSessionRuntime } from "../../src/tui/client-session-runtime.js";
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

/**
 * 3-D Phase 3 E2E：TUI 客户端 tracer 挂真实 daemon + 真实模型完整回合。
 *
 * 模型路由：把用户级 Provider 配置复制到专属临时 pico-home，确保隔离 daemon
 * 使用同一 defaults.modelRouteId，走一次真实的 session.send → Session 帧流式 →
 * run.finished → transcript 对账闭环，再验证 /rename /status 的 slash 真实
 * 链路与 interrupt。
 *
 * 隔离边界（2026-08-16 修订）：独立临时 pico-home + 专属 daemon，不再共用
 * 用户常驻 daemon——失败轮次的 unregister 清理同样失败会在真 home 注册表累积
 * 死条目（实测 118 条），把常驻 daemon 拖进 cron 忙循环并让 workspace.list 超
 * 操作 deadline（"间歇死锁"根因）。结束 session.delete + trust(false) +
 * unregister + 优雅关停专属 daemon。
 */

const TEST_TIMEOUT_MS = 10 * 60_000;
const DAEMON_CLEANUP_RPC_TIMEOUT_MS = 5_000;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
const DAEMON_EXIT_TIMEOUT_MS = 2_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

realModelTest(
  "tui client tracer e2e: full turn + slash chains over a real daemon and model",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-client-e2e-"));
    const picoHome = join(root, "pico-home");
    const workspaceSeed = join(root, "workspace");
    await mkdir(picoHome, { recursive: true });
    await mkdir(workspaceSeed, { recursive: true });
    const workspaceDir = await realpath(workspaceSeed);
    const userConfig = (await new UserConfigStore({ picoHome: resolvePicoHome() }).read()).config;
    await new UserConfigStore({ picoHome }).write(userConfig, {
      expectedRevision: EMPTY_USER_CONFIG_REVISION,
    });
    const previousPicoHome = process.env.PICO_HOME;
    process.env.PICO_HOME = picoHome;
    const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
    const reporter = new TuiReporter();
    const runningStates: boolean[] = [];
    const runtime = new ClientSessionRuntime({
      client,
      workspacePath: workspaceDir,
      reporter,
      onRunStateChanged: (running) => {
        runningStates.push(running);
      },
    });
    // node:test 按注册顺序执行同级 after hook；清理顺序固定为 RPC → daemon →
    // client → 环境/目录，避免先删 root 后无法定位并关停 daemon。
    t.after(async () => {
      const sessionId = runtime?.activeSessionId;
      if (sessionId) {
        await settleWithin(
          client.request("session.delete", { workspacePath: workspaceDir, sessionId }),
          DAEMON_CLEANUP_RPC_TIMEOUT_MS,
        );
      }
      await settleWithin(
        client.request("workspace.trust", { workspacePath: workspaceDir, trusted: false }),
        DAEMON_CLEANUP_RPC_TIMEOUT_MS,
      );
      await settleWithin(
        client.request("workspace.unregister", { workspacePath: workspaceDir }),
        DAEMON_CLEANUP_RPC_TIMEOUT_MS,
      );
      await stopScenarioDaemon(client, picoHome);
      client.close();
      if (previousPicoHome === undefined) delete process.env.PICO_HOME;
      else process.env.PICO_HOME = previousPicoHome;
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    });
    // 冷启动排水：专属 daemon 冷启动（慢环境 19-31s），ping 在幂等重试白名单内
    // （30s 时间预算自动重试）。
    await client.request("runtime.ping", {});
    await client.request("workspace.register", { workspacePath: workspaceDir });
    await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });
    const registry = createClientCommandRegistry({ runtime, workspacePath: workspaceDir });
    await runtime.start();

    // 完整回合：真实模型流式 + 终态 + 对账。resend 可能在 P1-2 窗口留下双回合
    // （首 send 已达 daemon、响应丢失、重发被排队为第二回合）——所有 idle-only
    // 断言前必须排水到 idle（对抗评审 P0：丢弃 waitForCondition 布尔曾让 141s
    // 首败不可见）。
    let accepted = await runtime.sendText("请只回复两个字符：ok");
    if (!accepted) accepted = await runtime.sendText("请只回复两个字符：ok");
    assert.ok(accepted, "session.send 应被接受（容忍一次残留 socket 竞态重试）");
    assert.ok(runtime.activeSessionId);

    const started = await waitForCondition(() => runningStates.includes(true), 120_000);
    assert.ok(started, "run.started 应驱动 running=true");
    const settled = await waitForCondition(() => runningStates.includes(false), 180_000);
    assert.ok(settled, "真实回合应终态");
    const answered = await waitForCondition(
      () =>
        reporter
          .getProjection()
          .entries.some(({ entry }) => entry.kind === "assistant" && entry.content.includes("ok")),
      120_000,
    );
    assert.ok(answered, "transcript 对账后投影应含真实模型回复（含 ok）");

    // slash 真实链路：/rename 持久化 + /status 往返。排水等待必须断言（resend
    // 排队的第二回合可能仍在跑，否则 /rename 被 availability 门拦下）。
    const idleBeforeSlash = await waitForCondition(() => !runtime.running, 180_000);
    assert.ok(idleBeforeSlash, "slash 前 run 应回到 idle（含 resend 双回合排水）");
    const rename = await processClientInput("/rename e2e-真实回合", registry, runtime);
    assert.match(String(rename.result?.message), /e2e-真实回合/);
    const renamed = await client.request("session.get", {
      workspacePath: workspaceDir,
      sessionId: runtime.activeSessionId ?? "",
    });
    assert.equal(renamed.session.title, "e2e-真实回合");

    const status = await processClientInput("/status", registry, runtime);
    assert.equal(status.kind, "local");
    assert.match(String(status.result?.message), /模型路由/);

    // interrupt 路径：发起第二回合，观察 running 后中断。断言消息方向（对抗评审
    // P0：kind==="local" 三种结局都满足，无法区分门拦/执行/失败）。
    const second = await runtime.sendText("请从 1 数到 50，每个数一行");
    assert.ok(second);
    const sawRunning = await waitForCondition(() => runtime.running, 60_000);
    const interrupt = await processClientInput("/interrupt", registry, runtime);
    assert.equal(interrupt.kind, "local");
    assert.match(
      String(interrupt.result?.message),
      sawRunning ? /已请求中断/ : /only available while running/,
      "interrupt 应真实执行（running 时）或被门拦（run 抢先结束），二者之一",
    );
    const backIdle = await waitForCondition(() => !runtime.running, 180_000);
    assert.ok(backIdle, "中断或自然完成后应回到 idle");

    runtime.dispose();
  },
);

async function waitForCondition(condition: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}

/** 优雅关停场景专属 daemon；无注册（从未拉起）时直接跳过，绝不反向拉起。 */
async function stopScenarioDaemon(client: LocalRuntimeClient, picoHome: string): Promise<void> {
  let pid: number | undefined;
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    const registration = await readHostRegistration(
      join(resolveRootControlNamespace(), capability.rootId),
    );
    pid = registration?.pid;
  } catch {
    // 控制目录不可读 = daemon 未运行。
  }
  if (pid === undefined) return;
  const shutdownAccepted = await settleWithin(client.shutdownDaemon(), DAEMON_SHUTDOWN_TIMEOUT_MS);
  if (shutdownAccepted && (await waitForProcessExit(pid, DAEMON_EXIT_TIMEOUT_MS))) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    return;
  }
  if (await waitForProcessExit(pid, DAEMON_EXIT_TIMEOUT_MS)) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // 已退出。
  }
}

async function settleWithin(task: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      task.then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), timeoutMs);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (isProcessAlive(pid)) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
