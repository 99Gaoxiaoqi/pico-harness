import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseStrictRuntimeParams } from "@pico/protocol";
import { LocalRuntimeClient } from "../../src/daemon/index.js";
import { ClientSessionRuntime } from "../../src/tui/client-session-runtime.js";
import { createClientCommandRegistry, processClientInput } from "../../src/tui/client-commands.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

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
  process.env.LLM_BASE_URL = DEAD_ENDPOINT;
  process.env.LLM_API_KEY = "mcp-smoke-key";
  process.env.LLM_MODEL = "mcp-smoke-model";
  t.after(() => {
    delete process.env.PICO_HOME;
    delete process.env.LLM_BASE_URL;
    delete process.env.LLM_API_KEY;
    delete process.env.LLM_MODEL;
  });

  const client = new LocalRuntimeClient(undefined, { runtimeHostRootPath: picoHome });
  t.after(() => client.close());
  t.after(async () => {
    await client.shutdownDaemon().catch(() => undefined);
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
  runtime.dispose();
});
