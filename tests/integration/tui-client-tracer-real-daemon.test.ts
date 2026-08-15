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
import { ClientSessionRuntime } from "../../src/tui/client-session-runtime.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

/**
 * 3-D Phase 2 真机冒烟：ClientSessionRuntime 挂真实 LocalRuntimeClient（kernel
 * 模式 connectOrSpawn 拉起常驻 daemon），无 Ink 驱动完整客户端环——
 * 信任工作区 → 订阅 → session.send（daemon 物化会话并启动 run）→ 事件流
 * （run.started/live/timeline/finished + transcriptUpdated reload 对账）→ 投影。
 *
 * 模型路由指向死端点（127.0.0.1:9）：session.send 被接受、run 正常启动、模型
 * 调用快速失败——生命周期事件与对账照常流动，无需真实模型/外部依赖。
 *
 * 已知竞态容忍：慢环境 connectOrSpawn 可能连到将死候选的残留 socket
 * （A6），非幂等 session.send 不自动重试（P1-2）——冒烟层对 retryable 断连
 * 做一次手动重试（新 idempotencyKey，daemon 未收到首发的场景安全）。
 */

const DEAD_ENDPOINT = "http://127.0.0.1:9";

test("client session runtime over a real spawned daemon: send + lifecycle + reconcile", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-client-smoke-"));
  const picoHome = join(root, "pico-home");
  const workspaceSeed = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceSeed, { recursive: true });
  const workspaceDir = await realpath(workspaceSeed);
  process.env.PICO_HOME = picoHome;
  process.env.LLM_BASE_URL = DEAD_ENDPOINT;
  process.env.LLM_API_KEY = "smoke-test-key";
  process.env.LLM_MODEL = "smoke-test-model";
  t.after(() => {
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
  });
  t.after(async () => {
    await killDaemonFor(picoHome);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
  t.after(() => client.close());

  // 注册 + 信任工作区（daemon 拒绝未信任工作区的前台 run；客户端信任门在
  // main.ts，测试直接走 RPC 等价路径）。
  await client.request("workspace.register", { workspacePath: workspaceDir });
  await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });

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

  await runtime.start();

  // 非幂等写 + A6 残留 socket 竞态：retryable 断连手动重试一次。
  let accepted = await runtime.sendText("冒烟：请回复 ok");
  if (!accepted) {
    accepted = await runtime.sendText("冒烟：请回复 ok");
  }
  assert.ok(accepted, "session.send 应被 daemon 接受（容忍一次残留 socket 竞态重试）");
  assert.ok(runtime.activeSessionId, "send 结果应带回 sessionId");

  // 等生命周期流动 + 对账：run 启动（running=true）→ 死端点模型调用失败 →
  // run 终态（running=false）→ transcript reload 对账使投影越过本地 user 条目。
  const started = await waitForCondition(() => runningStates.includes(true), 90_000);
  assert.ok(started, "run.started 应驱动 running=true（live 事件流经真实传输）");
  const settled = await waitForCondition(() => runningStates.includes(false), 90_000);
  assert.ok(settled, "run 终态（死端点快速失败）应驱动 running=false");
  const grew = await waitForCondition(
    () => reporter.getProjection().entries.length > 1,
    90_000,
  );
  assert.ok(grew, "transcript reload 对账应使投影增长（runBoundary/error 等条目入投影）");

  runtime.dispose();
});

async function killDaemonFor(picoHome: string): Promise<void> {
  try {
    const capability = await resolveStorageRoot({ path: picoHome, kind: "interactive" });
    const registration = await readHostRegistration(
      join(resolveRootControlNamespace(), capability.rootId),
    );
    if (registration) process.kill(registration.pid);
  } catch {
    // 无 daemon / 已退出：无需处理。
  }
}

async function waitForCondition(
  condition: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return true;
}
