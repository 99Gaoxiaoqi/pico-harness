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
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
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

test("client commands over a real spawned daemon: slash chains (dead-endpoint model)", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-client-slash-"));
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
  await client.request("workspace.register", { workspacePath: workspaceDir });
  await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });

  const reporter = new TuiReporter();
  const runtime = new ClientSessionRuntime({ client, workspacePath: workspaceDir, reporter });
  const registry = createClientCommandRegistry({ runtime, workspacePath: workspaceDir });
  await runtime.start();

  // 物化会话；等 run 终态（死端点快速失败，但引擎重试有窗口）——投影越过本地
  // user 条目即 transcript 已对账，idle-only 命令可执行。
  let accepted = await runtime.sendText("slash 链路冒烟");
  if (!accepted) accepted = await runtime.sendText("slash 链路冒烟");
  assert.ok(accepted);
  assert.ok(runtime.activeSessionId);
  const runSettled = await waitForCondition(
    () => reporter.getProjection().entries.length > 1,
    90_000,
  );
  assert.ok(runSettled, "死端点 run 终态后 transcript 对账应使投影增长");
  const settledIdle = await waitForCondition(() => !runtime.running, 30_000);
  assert.ok(settledIdle, "run 应已终态（供 idle-only 命令执行）");

  // /status：真实往返（session.get + settings.get），消息含路由字段。
  const status = await processClientInput("/status", registry, runtime);
  assert.equal(status.kind, "local");
  assert.match(String(status.result?.message), /模型路由/);

  // /rename → daemon 持久化，session.get 验证。
  const rename = await processClientInput("/rename slash-链路-新标题", registry, runtime);
  assert.match(String(rename.result?.message), /slash-链路-新标题/);
  const renamed = await client.request("session.get", {
    workspacePath: workspaceDir,
    sessionId: runtime.activeSessionId ?? "",
  });
  assert.equal(renamed.session.title, "slash-链路-新标题");

  // /sessions：真实列表含当前会话且 isCurrent 标注。
  const sessions = await processClientInput("/sessions", registry, runtime);
  const data = sessions.result?.data as { id: string; isCurrent?: boolean }[];
  assert.ok(data.some((entry) => entry.id === runtime.activeSessionId && entry.isCurrent === true));

  // /new → 无会话态；再发消息物化新会话；/resume 切回并水化。
  const firstSessionId = runtime.activeSessionId;
  await processClientInput("/new", registry, runtime);
  assert.equal(runtime.activeSessionId, undefined);
  let second = await runtime.sendText("第二个会话");
  if (!second) second = await runtime.sendText("第二个会话");
  assert.ok(second);
  const secondSessionId = runtime.activeSessionId;
  assert.notEqual(secondSessionId, firstSessionId);
  // 第二个死端点 run 终态后再 /resume（idle-only）。
  await waitForCondition(() => !runtime.running, 90_000);
  const resume = await processClientInput(`/resume ${firstSessionId}`, registry, runtime);
  assert.match(String(resume.result?.message), /已切换/);
  assert.equal(runtime.activeSessionId, firstSessionId);
  assert.ok(
    reporter
      .getProjection()
      .entries.some(({ entry }) => entry.kind === "user" && entry.content === "slash 链路冒烟"),
    "切回应水化出第一会话历史",
  );

  // /interrupt：死端点 run 快速失败，竞态容忍——命令不抛错即可（run 可能已终态）。
  const third = await runtime.sendInput({ kind: "text", text: "中断目标" });
  assert.ok(third);
  await waitForCondition(() => runtime.running, 30_000).catch(() => undefined);
  const interrupt = await processClientInput("/interrupt", registry, runtime);
  assert.equal(interrupt.kind, "local");

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
