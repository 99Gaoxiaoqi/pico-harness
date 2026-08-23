import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isTerminalRunStatus, parseStrictRuntimeParams } from "@pico/protocol";
import { LocalRuntimeClient } from "../../src/daemon/index.js";
import { UserConfigStore } from "../../src/input/user-config-store.js";
import { ClientSessionRuntime } from "../../src/tui/client-session-runtime.js";
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import { TestRuntimeHostCandidateTracker } from "./helpers/test-runtime-daemon.js";

/**
 * 3-D BLOCKED 收口（/mcp 镜像）：真 daemon 上验证用户级 MCP 服务器配置面
 * 的 status/enable/disable 全链路——daemon 读取 picoHome/mcp.json →
 * mcp.effective.list → 客户端 /mcp 命令 → mcp.user.setEnabled（新协议方法，
 * 含 revision 冲突语义）。不需要真实模型（死端点即可，不启动 run）。
 */

const DEAD_ENDPOINT = "http://127.0.0.1:9";

test("protocol gate: mcp.user.setEnabled 严格参数（accept + 必填拒绝）", () => {
  const ok = parseStrictRuntimeParams("mcp.user.setEnabled", {
    serverName: "srv",
    enabled: false,
    expectedRevision: "rev-1",
    idempotencyKey: "id-1",
  });
  assert.equal(ok.enabled, false);
  assert.throws(
    () => parseStrictRuntimeParams("mcp.user.setEnabled", { serverName: "srv" }),
    /必填/,
  );
  assert.throws(
    () =>
      parseStrictRuntimeParams("mcp.user.setEnabled", {
        serverName: "srv",
        enabled: "yes",
        expectedRevision: "rev-1",
        idempotencyKey: "id-1",
      }),
    /布尔/,
  );
});

test("real daemon: /mcp status + enable/disable round trip over user mcp.json", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-client-mcp-"));
  const picoHome = join(root, "pico-home");
  const workspaceSeed = join(root, "workspace");
  await mkdir(picoHome, { recursive: true });
  await mkdir(workspaceSeed, { recursive: true });
  const workspaceDir = await realpath(workspaceSeed);
  // 用户级 MCP fixture：先于 daemon 启动写入（daemon 读 picoHome/mcp.json）。
  await writeFile(
    join(picoHome, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        "fake-tools": {
          transport: "stdio",
          command: "node",
          args: ["never-spawned.mjs"],
          enabled: true,
        },
      },
    }),
    "utf8",
  );
  process.env.PICO_HOME = picoHome;
  await configureDeadEndpointModel(picoHome);
  const candidates = new TestRuntimeHostCandidateTracker();
  t.after(() => {
    delete process.env.PICO_HOME;
  });

  const client = new LocalRuntimeClient(undefined, {
    runtimeHostRootPath: picoHome,
    candidateLauncher: candidates.launcher,
  });
  t.after(() => client.close());
  t.after(async () => {
    // t.after LIFO：精确 PID 退出后才删除 root，SIGTERM 超时仅兜底同一 PID。
    await candidates.stopAll();
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  });

  await client.request("runtime.ping", {});
  await client.request("workspace.register", { workspacePath: workspaceDir });
  await client.request("workspace.trust", { workspacePath: workspaceDir, trusted: true });

  const runtime = new ClientSessionRuntime({
    client,
    workspacePath: workspaceDir,
    reporter: new TuiReporter(),
  });
  await runtime.start();
  const registry = createClientCommandRegistry({ runtime, workspacePath: workspaceDir });
  const run = async (text: string) => {
    const outcome = await processClientInput(text, registry, runtime);
    assert.equal(outcome.kind, "local", `${text} 应本地执行`);
    return outcome;
  };

  // status：effective 配置面显示用户级服务器（无项目探测面——config.mcpServers
  // 只探 project+plugin 源，用户级不 spawn）。
  const status = await run("/mcp");
  const statusText = String(status.result?.message);
  assert.match(statusText, /MCP status/);
  assert.match(statusText, /fake-tools \[stdio\] - 用户级/, "用户级服务器应入状态");
  const effective = await client.request("mcp.effective.list", { workspacePath: workspaceDir });
  assert.equal(effective.servers[0]?.enabled, true);

  // disable → mcp.user.setEnabled（revision 来自 user.list）→ effective 反转。
  const disabled = await run("/mcp disable fake-tools");
  assert.match(String(disabled.result?.message), /已停用/);
  const afterDisable = await client.request("mcp.effective.list", {
    workspacePath: workspaceDir,
  });
  assert.equal(afterDisable.servers[0]?.enabled, false, "disable 应持久化到用户 mcp.json");

  // enable 回转。
  const enabled = await run("/mcp enable fake-tools");
  assert.match(String(enabled.result?.message), /已启用/);
  const afterEnable = await client.request("mcp.effective.list", {
    workspacePath: workspaceDir,
  });
  assert.equal(afterEnable.servers[0]?.enabled, true, "enable 应恢复启用");

  // 不存在的服务器：明确 NOT_FOUND 路径（客户端先查 user.list 提示）。
  const missing = await run("/mcp disable ghost-server");
  assert.match(String(missing.result?.message), /未在用户级配置中找到/);

  // /context 真 daemon：session.context.get 需要真实会话——死端点 send 建会话
  // （run 快速失败但会话与 settings 物化），再取上下文预算报告。
  const sent = await runtime.sendText("冒烟：请回复 ok");
  assert.ok(sent, "死端点 send 应被接受（会话物化）");
  const sessionId = runtime.activeSessionId;
  assert.ok(sessionId, "send 应带回 sessionId");
  // 死端点 run 快速失败——等终态再执行 idle 命令（/add-dir availability 门，
  // 竞态下会拒"仅 idle"命令，造成假阴性）。
  const settled = await waitForCondition(async () => {
    const { runs } = await client.request("runs.list", { workspacePath: workspaceDir, sessionId });
    return (
      runs.length > 0 && runs.every((run) => isTerminalRunStatus(run.status)) && !runtime.running
    );
  }, 60_000);
  assert.ok(settled, "死端点 run 应快速终态");

  const context = await client.request("session.context.get", {
    workspacePath: workspaceDir,
    sessionId,
  });
  const report = context.context as Record<string, unknown>;
  assert.ok(report["routeId"], "上下文报告应携带活跃路由");
  assert.equal(typeof report["estimatedInputTokens"], "number");
  assert.equal(typeof report["contextWindowTokens"], "number");
  assert.equal(typeof report["usedPercent"], "number");

  // /add-dir 真 daemon：真实目录校验 + 持久化到会话 settings。
  const extraDir = join(root, "extra");
  await mkdir(extraDir, { recursive: true });
  const added = await run(`/add-dir ${extraDir}`);
  assert.match(String(added.result?.message), /Workspace directory added/);
  const settings = await client.request("session.settings.get", {
    workspacePath: workspaceDir,
    sessionId,
  });
  const canonicalExtra = await realpath(extraDir);
  console.log(
    "[diag] settings after add:",
    JSON.stringify(settings.settings),
    "canonical:",
    canonicalExtra,
    "extraDir:",
    extraDir,
  );
  assert.ok(
    settings.settings.additionalDirectories?.includes(canonicalExtra),
    `附加目录应持久化到会话 settings（daemon 存 realpath 形式，${canonicalExtra}）`,
  );
  const missingAddDir = await run("/add-dir C:\\definitely\\missing-dir");
  assert.match(String(missingAddDir.result?.message), /Add directory failed|目录/);

  // /hooks 真 daemon：管理面装配（配置/信任加载）不报错，空工作区无 handler。
  const hooks = await run("/hooks");
  assert.match(String(hooks.result?.message), /No Hooks configured/);
  const reviewMissing = await run("/hooks review missing-handler");
  assert.match(String(reviewMissing.result?.message), /不存在|failed/i);

  // /operations 真 daemon：journal 空面 + NOT_FOUND 路径（与 forkSession 同构装配）。
  const operations = await run("/operations");
  assert.match(String(operations.result?.message), /No storage operations need attention/);
  const showMissing = await run("/operations show missing-op");
  assert.match(String(showMissing.result?.message), /not found|failed/i);

  // /plugin 真 daemon：管理面装配（scope 根解析/信任存储）不报错，空工作区无插件。
  const plugins = await run("/plugin");
  assert.match(String(plugins.result?.message), /No plugins installed/);
  const inspectMissing = await run("/plugin inspect ghost");
  assert.match(String(inspectMissing.result?.message), /not installed|failed/i);

  runtime.dispose();
});

async function configureDeadEndpointModel(picoHome: string): Promise<void> {
  const store = new UserConfigStore({ picoHome });
  const current = await store.read();
  await store.write(
    {
      version: 1,
      defaults: { modelRouteId: "mcp-smoke/mcp-smoke-model" },
      providers: {
        "mcp-smoke": {
          protocol: "openai",
          baseURL: DEAD_ENDPOINT,
          apiKeyEnv: "PICO_MCP_SMOKE_API_KEY",
          apiKey: "mcp-smoke-key",
          models: ["mcp-smoke-model"],
          discoverModels: false,
        },
      },
    },
    { expectedRevision: current.revision },
  );
}

async function waitForCondition(
  condition: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
