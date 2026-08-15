import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { LocalRuntimeClient } from "../../src/daemon/index.js";
import { ClientSessionRuntime } from "../../src/tui/client-session-runtime.js";
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

/**
 * 3-D Phase 3 E2E：TUI 客户端 tracer 挂真实 daemon + 真实模型完整回合。
 *
 * 与集成冒烟的区别：不覆盖 PICO_HOME——daemon（connectOrSpawn 拉起或连接既有
 * 常驻实例）按用户真实配置解析模型路由（defaults.modelRouteId），走一次真实的
 * session.send → run.live 流式 → run.finished → transcript 对账闭环，再验证
 * /rename /status 的 slash 真实链路与 interrupt。
 *
 * 隔离边界：临时工作区经 workspace.register/trust 注册（信任项落在用户信任库，
 * 指向临时目录，清理后为无害残留），结束时 unregister。不杀 daemon——常驻
 * daemon 属用户环境（pico --daemon-stop 归用户管理）。
 */

const TEST_TIMEOUT_MS = 10 * 60_000;
const RUN_REAL_MODEL = process.env.RUN_LLM_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

realModelTest(
  "tui client tracer e2e: full turn + slash chains over a real daemon and model",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-client-e2e-"));
    const workspaceSeed = join(root, "workspace");
    await mkdir(workspaceSeed, { recursive: true });
    const workspaceDir = await realpath(workspaceSeed);
    t.after(async () => {
      await rm(root, { recursive: true, force: true }).catch(() => undefined);
    });

    const client = new LocalRuntimeClient();
    t.after(() => client.close());
    await client.request("workspace.register", { workspacePath: workspaceDir });
    await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });
    // 清理（对抗评审二轮 P1）：删除测试会话 + 撤销信任 + 注销——不留残留
    // （unregister 不清信任，trust(false) 才清；session.delete 删真实模型回合）。
    t.after(async () => {
      const sessionId = runtime.activeSessionId;
      if (sessionId) {
        await client.request("session.delete", { workspacePath: workspaceDir, sessionId }).catch(() => undefined);
      }
      await client
        .request("workspace.trust", { workspacePath: workspaceDir, trusted: false })
        .catch(() => undefined);
      await client
        .request("workspace.unregister", { workspacePath: workspaceDir })
        .catch(() => undefined);
    });

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

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return true;
}
