import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../../src/engine/session-runtime-event.js";
import { createRuntimeEventId } from "../../../src/storage/runtime-event-store-contracts.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { LoadToolsTool, renderGroupCatalog } from "../../../src/tools/load-tools.js";
import { SearchToolsTool } from "../../../src/tools/search-tools.js";
import {
  ToolDisclosure,
  TOOL_SEARCH_MAX_SCHEMA_CHARS,
} from "../../../src/tools/tool-disclosure.js";
import {
  AUTOMATION_TOOL_ALLOWLIST,
  filterAutomationAllowedTools,
  isAutomationToolAllowed,
} from "../../../src/safety/automation-tool-policy.js";
import {
  getAvailableDeferredGroups,
  getSupportedToolNames,
  findGroupForTool,
  isPlanModeTool,
  isToolSupportedForHost,
  PICO_TOOL_GROUPS,
} from "../../../src/tools/tool-surface.js";
import { searchTools } from "../../../src/tools/tool-search-index.js";
import type { ToolDefinition } from "../../../src/schema/message.js";

function def(name: string, description = `${name} fixture`): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

test("headless 宿主派生与白名单完全一致（read_evidence 已随 E3 退役）", () => {
  const expected = new Set([
    "bash",
    "edit_file",
    "fetch_url",
    "glob",
    "grep",
    "read_file",
    "task_list",
    "task_output",
    "task_stop",
    "todo",
    "web_search",
    "write_file",
  ]);
  const derived = getSupportedToolNames("headless");
  assert.equal(derived.size, 12);
  for (const name of expected) assert.ok(derived.has(name), `missing ${name}`);
  for (const name of derived) assert.ok(expected.has(name), `extra ${name}`);
  assert.equal(isToolSupportedForHost("read_evidence", "headless"), false);
});

test("background 宿主亲和性拒绝交互与 Agent 启动工具", () => {
  for (const name of ["ask_user", "schedule_task", "agent_spawn"]) {
    assert.equal(isToolSupportedForHost(name, "background"), false, name);
  }
  for (const name of ["read_file", "bash", "grep", "task_list"]) {
    assert.equal(isToolSupportedForHost(name, "background"), true, name);
  }
});

test("旧委派工具不再属于运行时工具目录", () => {
  for (const name of ["delegate_task", "delegate_status", "spawn_subagent"]) {
    assert.equal(findGroupForTool(name), undefined, name);
  }
  assert.equal(findGroupForTool("agent_spawn")?.id, "agents");
});

test("Automation 工具权限独立 fail-closed，新工具不会随 background surface 自动扩权", () => {
  for (const name of AUTOMATION_TOOL_ALLOWLIST) {
    assert.equal(isAutomationToolAllowed(name), true, name);
    assert.equal(isToolSupportedForHost(name, "background"), true, `${name} 必须仍满足后台硬边界`);
  }
  assert.equal(isToolSupportedForHost("hypothetical_new_tool", "background"), true);
  assert.equal(isAutomationToolAllowed("hypothetical_new_tool"), false);
  assert.deepEqual(
    filterAutomationAllowedTools(["hypothetical_new_tool", "read_file", "read_file"]),
    ["read_file"],
  );
});

test("组目录互斥：无工具重复声明", () => {
  const seen = new Set<string>();
  for (const group of PICO_TOOL_GROUPS) {
    for (const name of group.toolNames) {
      assert.equal(seen.has(name), false, `tool ${name} declared twice`);
      seen.add(name);
    }
  }
});

test("core 工具只由活跃 surface 目录声明", () => {
  const core = PICO_TOOL_GROUPS.find((group) => group.id === "core");
  assert.ok(core);
  assert.equal(core.economy, "always");
  assert.equal(core.toolNames.length, 10);
  assert.ok(core.toolNames.includes("read_file"));
  assert.ok(core.toolNames.includes("ask_user"));
  assert.ok(core.toolNames.includes("request_sandbox_boundary"));
});

test("Turn 激活单调累积、Step 冻结、Run 绑定上限与下一 Turn 重置", async () => {
  const disclosure = new ToolDisclosure();
  const allTools = [
    def("read_file"),
    def("search_tools"),
    def("fetch_url"),
    def("web_search"),
    def("mcp__db__query"),
  ];
  const turn = disclosure.beginTurn(allTools);
  const search = new SearchToolsTool(() => allTools, disclosure);
  const initial = turn.snapshotForStep();
  allTools[0]!.description = "mutated";
  allTools.push(def("late_tool", "database"));
  await disclosure.runInTurn(turn, async () => {
    assert.deepEqual(initial.toolNames, ["read_file", "search_tools"]);
    assert.notEqual(initial.tools[0]!.description, "mutated");
    assert.ok(Object.isFrozen(initial.tools[0]!.inputSchema));
    assert.throws(() => {
      initial.tools[0]!.description = "changed";
    }, TypeError);
    assert.deepEqual(JSON.parse(await search.execute('{"query":"select:late_tool"}')), {
      activated: [],
    });
    assert.deepEqual(JSON.parse(await search.execute('{"query":"select:web_search"}')), {
      activated: ["web_search"],
    });
    assert.deepEqual(initial.toolNames, ["read_file", "search_tools"], "本 Step 不因搜索而改变");
    const second = turn.snapshotForStep();
    assert.deepEqual(second.toolNames, ["read_file", "search_tools", "web_search"]);
    assert.deepEqual(JSON.parse(await search.execute('{"query":"select:mcp__db__query"}')), {
      activated: ["mcp__db__query"],
    });
    assert.deepEqual(turn.snapshotForStep().toolNames, [
      "mcp__db__query",
      "read_file",
      "search_tools",
      "web_search",
    ]);
    assert.deepEqual(JSON.parse(await search.execute('{"query":"select:web_search"}')), {
      activated: [],
    });
  });
  disclosure.endTurn(turn);
  assert.throws(() => turn.snapshotForStep(), /已结束/);
  const next = disclosure.beginTurn(allTools);
  assert.deepEqual(next.snapshotForStep().toolNames, ["read_file", "search_tools"]);
  assert.deepEqual(initial.toolNames, ["read_file", "search_tools"], "旧快照在 Turn 结束后仍不变");
  disclosure.endTurn(next);
});

test("共享发现连接器并发执行时由不同 Turn owner 隔离", async () => {
  const disclosure = new ToolDisclosure();
  const bound = [def("read_file"), def("fetch_url"), def("web_search")];
  const first = disclosure.beginTurn(bound);
  const second = disclosure.beginTurn(bound);
  const search = new SearchToolsTool(bound, disclosure);
  let release!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const pending = disclosure.runInTurn(first, async () => {
    await barrier;
    await search.execute('{"query":"select:fetch_url"}');
    assert.deepEqual(disclosure.getDisclosedTools(), ["fetch_url"]);
  });
  await disclosure.runInTurn(second, async () => {
    await search.execute('{"query":"select:web_search"}');
    release();
    await pending;
    assert.deepEqual(disclosure.getDisclosedTools(), ["web_search"]);
  });
  disclosure.endTurn(first);
  assert.deepEqual(second.snapshotForStep().toolNames, ["read_file", "web_search"]);
  disclosure.endTurn(second);
  await assert.rejects(() => search.execute('{"query":"web"}'), /Turn 作用域/);
});

test("search_tools 目录来自 Run 绑定且限制名称数量与字符，不包含工具 schema", () => {
  const disclosure = new ToolDisclosure();
  const search = new SearchToolsTool(() => {
    throw new Error("不得递归读取 registry");
  }, disclosure);
  const bound = [
    search.definition(),
    ...Array.from({ length: 150 }, (_, i) => def(`mcp_bound_${i}`, "SECRET_DESCRIPTION")),
  ];
  const turn = disclosure.beginTurn(bound);
  const description = turn.snapshotForStep().tools[0]!.description;
  assert.match(description, /当前 Run 可发现工具/);
  assert.match(description, /mcp_bound_/);
  assert.match(description, /另有 50 个工具未列出/);
  assert.doesNotMatch(description, /SECRET_DESCRIPTION|inputSchema/);
  assert.ok(description.length < 9000);
  bound.push(def("mcp_late"));
  assert.doesNotMatch(turn.snapshotForStep().tools[0]!.description, /mcp_late/);
});

test("宿主 baseline 与 Turn 搜索激活分离，并受绑定上限约束", () => {
  const disclosure = new ToolDisclosure();
  disclosure.setBaselineTools(["web_search", "unbound"]);
  const first = disclosure.beginTurn([def("read_file"), def("web_search"), def("fetch_url")]);
  first.discloseTools(["fetch_url"]);
  disclosure.setBaselineTools(["fetch_url"]);
  assert.deepEqual(first.snapshotForStep().toolNames, ["fetch_url", "read_file", "web_search"]);
  disclosure.endTurn(first);
  const next = disclosure.beginTurn([def("read_file"), def("web_search"), def("fetch_url")]);
  assert.deepEqual(next.snapshotForStep().toolNames, ["fetch_url", "read_file"]);
});

test("历史 tool.group.loaded 仅作审计，不恢复新 Turn 激活", () => {
  const disclosure = new ToolDisclosure();
  disclosure.seedFromEvents([
    { kind: "tool.group.loaded", data: { groupId: "web", toolNames: ["fetch_url", "web_search"] } },
    { kind: "tool.group.loaded", data: { groupId: 42, toolNames: null } },
  ]);
  const turn = disclosure.beginTurn([def("read_file"), def("fetch_url"), def("web_search")]);
  assert.deepEqual(turn.getLoadedGroups(), []);
  assert.deepEqual(turn.snapshotForStep().toolNames, ["read_file"]);
});

test("LoadToolsTool 兼容组激活：受 Run 绑定限制并保留审计回调", async () => {
  const disclosure = new ToolDisclosure();
  const turn = disclosure.beginTurn([def("fetch_url"), def("web_search")]);
  const loaded: Array<[string, string[]]> = [];
  const tool = new LoadToolsTool(getAvailableDeferredGroups("desktop"), disclosure, undefined, {
    onGroupLoaded: (id, names) => loaded.push([id, [...names]]),
  });
  await disclosure.runInTurn(turn, async () => {
    assert.deepEqual(JSON.parse(await tool.execute('{"group":"web"}')), {
      activated: ["fetch_url", "web_search"],
    });
    assert.deepEqual(disclosure.getLoadedGroups(), ["web"]);
    assert.deepEqual(loaded, [["web", ["fetch_url", "web_search"]]]);
    await tool.execute('{"group":"web"}');
    assert.equal(loaded.length, 1, "重复调用不制造新的激活事件");
    await assert.rejects(() => tool.execute('{"group":"nope"}'), /未知工具组/);
    await assert.rejects(() => tool.execute("not json"), /参数解析失败/);
  });
  disclosure.endTurn(turn);
});

test("LoadToolsTool description 渲染组目录", () => {
  const groups = getAvailableDeferredGroups("desktop");
  const text = renderGroupCatalog(groups);
  assert.match(text, /可用组/);
  assert.match(text, /- web: /);
  assert.match(text, /- code-intelligence: /);
  // definition 的 enum 与组列表一致
  const tool = new LoadToolsTool(groups, new ToolDisclosure());
  const schema = tool.definition().inputSchema as { properties: { group: { enum: string[] } } };
  assert.deepEqual(
    schema.properties.group.enum,
    groups.map((g) => g.id),
  );
});

test("background 允许 memory 组，隔离 headless 仍不暴露", () => {
  const desktop = getAvailableDeferredGroups("desktop").map((g) => g.id);
  const background = getAvailableDeferredGroups("background").map((g) => g.id);
  assert.ok(desktop.includes("memory"));
  assert.ok(background.includes("memory"));
  assert.equal(
    getAvailableDeferredGroups("headless").some((group) => group.id === "memory"),
    false,
  );
  assert.ok(background.includes("web"));
});

test("search_tools 覆盖原有分组与动态工具，结果仅包含名称", async () => {
  const disclosure = new ToolDisclosure();
  const allTools = [
    def("read_file"),
    def("web_search"),
    def("mcp__db__query", "Query the postgres database with SQL"),
  ];
  const tool = new SearchToolsTool(() => allTools, disclosure);
  const turn = disclosure.beginTurn(allTools);
  await disclosure.runInTurn(turn, async () => {
    assert.deepEqual(JSON.parse(await tool.execute('{"query":"database"}')), {
      activated: ["mcp__db__query"],
    });
    assert.deepEqual(JSON.parse(await tool.execute('{"query":"select:web_search"}')), {
      activated: ["web_search"],
    });
    assert.deepEqual(JSON.parse(await tool.execute('{"query":"select:read_file"}')), {
      activated: [],
    });
    assert.deepEqual(JSON.parse(await tool.execute('{"query":"select:missing"}')), {
      activated: [],
    });
    for (const limit of [0, 21, 1.5, "2"]) {
      await assert.rejects(() => tool.execute(JSON.stringify({ query: "web", limit })), /limit/);
    }
  });
});

test("工具发现限制数量与 schema 预算，load_tools 不能绕过预算", async () => {
  const disclosure = new ToolDisclosure();
  const many = Array.from({ length: 25 }, (_, i) => def("mcp_database_" + i, "database query"));
  const oversized = def("fetch_url", "x".repeat(TOOL_SEARCH_MAX_SCHEMA_CHARS));
  const half = def("web_search", "web " + "x".repeat(40_000));
  const other = def("mcp_large", "large " + "x".repeat(40_000));
  const bound = [...many, oversized, half, other];
  const turn = disclosure.beginTurn(bound);
  const search = new SearchToolsTool(bound, disclosure);
  await disclosure.runInTurn(turn, async () => {
    assert.equal(JSON.parse(await search.execute('{"query":"database"}')).activated.length, 8);
    assert.equal(
      JSON.parse(await search.execute('{"query":"database","limit":20}')).activated.length,
      17,
    );
    const oversizedResult = JSON.parse(await search.execute('{"query":"select:fetch_url"}'));
    assert.deepEqual(oversizedResult.activated, []);
    assert.equal(oversizedResult.blocked.reason, "schema_too_large");
    const combined = turn.discloseTools(["web_search", "mcp_large"]);
    assert.deepEqual(combined.activated, ["web_search"]);
    assert.equal(combined.blocked?.reason, "schema_budget_exhausted");
    const loader = new LoadToolsTool(getAvailableDeferredGroups("desktop"), disclosure);
    const loadResult = JSON.parse(await loader.execute('{"group":"web"}'));
    assert.deepEqual(loadResult.activated, []);
    assert.equal(loadResult.blocked.reason, "schema_too_large");
    assert.equal(turn.snapshotForStep().toolNames.includes("fetch_url"), false);
  });
});

test("TF-IDF 检索：select 前缀精确选择 + 关键词排名", () => {
  const candidates = [
    def("mcp__db__query", "Query the postgres database with SQL"),
    def("mcp__fs__list_dir", "List directory contents on the filesystem"),
    def("mcp__git__status", "Show git working tree status"),
  ];
  // select: 精确
  const exact = searchTools(candidates, "select:mcp__git__status");
  assert.equal(exact.length, 1);
  assert.equal(exact[0]!.tool.name, "mcp__git__status");
  assert.equal(exact[0]!.score, 1);
  // 关键词命中 db 工具
  const hits = searchTools(candidates, "database");
  assert.equal(hits[0]!.tool.name, "mcp__db__query");
});

test("Plan 模式工具面从 surface 单源导出", () => {
  assert.equal(isPlanModeTool("read_file"), true);
  assert.equal(isPlanModeTool("ask_user"), true);
  assert.equal(isPlanModeTool("submit_plan"), true);
  assert.equal(isPlanModeTool("write_file"), false);
  assert.equal(isPlanModeTool("bash"), false);
  assert.equal(isPlanModeTool("edit_file"), false);
});

// ============ 对抗性审查修复验证 ============

test("审计往返：tool.group.loaded 落盘但不恢复工具激活", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-tool-surface-durable-"));
  try {
    const store = new SqliteRuntimeEventStore({ storageRoot: join(root, "state") });
    await store.initializeSession({ sessionId: "sess-durable", workDir: root });
    await store.append({
      schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
      eventId: createRuntimeEventId("tool-group"),
      sessionId: "sess-durable",
      invocationId: "inv-1",
      runId: "run-1",
      turnId: "turn-1",
      at: new Date().toISOString(),
      partial: false,
      visibility: "internal",
      kind: "tool.group.loaded",
      data: { groupId: "web", toolNames: ["fetch_url", "web_search"] },
    });
    const entries = await store.readSessionEntries("sess-durable");
    const loaded = entries.filter((entry) => entry.event.kind === "tool.group.loaded");
    assert.equal(loaded.length, 1, "事件必须真实落盘（审查 C1：曾被 assert 层硬拒）");
    const disclosure = new ToolDisclosure();
    disclosure.seedFromEvents(entries.map((entry) => entry.event as { kind: string }));
    assert.deepEqual(disclosure.getLoadedGroups(), []);
    assert.deepEqual(
      disclosure
        .pickForLLM([def("fetch_url"), def("web_search"), def("read_file")])
        .map((t) => t.name),
      ["read_file"],
    );
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("load_tools 拒绝未绑定组成员，实时注册不能扩大 Run 能力", async () => {
  const disclosure = new ToolDisclosure();
  const turn = disclosure.beginTurn([def("read_file"), def("fetch_url")]);
  const tool = new LoadToolsTool(getAvailableDeferredGroups("desktop"), disclosure, () => [
    "read_file",
    "fetch_url",
    "web_search",
  ]);
  await disclosure.runInTurn(turn, async () => {
    await assert.rejects(() => tool.execute('{"group":"graph"}'), /在当前环境不可用/);
    assert.deepEqual(turn.getLoadedGroups(), []);
    assert.deepEqual(JSON.parse(await tool.execute('{"group":"web"}')), {
      activated: ["fetch_url"],
    });
  });
});

test("search_tools 候选排除连接器与协议工具", async () => {
  const disclosure = new ToolDisclosure();
  const bound = [
    "read_file",
    "load_tools",
    "search_tools",
    "submit_plan",
    "update_plan",
    "cancel_plan",
  ].map((name) => def(name));
  const turn = disclosure.beginTurn(bound);
  const search = new SearchToolsTool(bound, disclosure);
  await disclosure.runInTurn(turn, async () => {
    for (const name of bound.map((tool) => tool.name)) {
      assert.deepEqual(
        JSON.parse(await search.execute(JSON.stringify({ query: "select:" + name }))),
        { activated: [] },
      );
    }
    assert.deepEqual(disclosure.getDisclosedTools(), []);
  });
});

test("headless fail-closed：新工具入组但未显式声明 headless supported 即被拒（审查 H1）", () => {
  // 模拟未来新工具加入 web 组但忘记声明 headless 亲和性
  assert.equal(isToolSupportedForHost("web_search", "headless"), true, "显式声明的仍可用");
  // 未在 affinity 表声明的工具（如假设的新工具）对 headless 一律拒绝
  assert.equal(isToolSupportedForHost("hypothetical_new_tool", "headless"), false);
  assert.equal(isToolSupportedForHost("code_definition", "headless"), false);
  // background 保持 fail-open 姿势：未声明 = supported
  assert.equal(isToolSupportedForHost("hypothetical_new_tool", "background"), true);
});

test("seedFromEvents 不影响正在执行的 Turn 激活", () => {
  const disclosure = new ToolDisclosure();
  const turn = disclosure.beginTurn([def("web_search"), def("fetch_url")]);
  disclosure.runInTurn(turn, () => {
    disclosure.discloseTools(["web_search"]);
    disclosure.seedFromEvents([
      { kind: "tool.group.loaded", data: { groupId: "web", toolNames: ["fetch_url"] } },
    ]);
    assert.deepEqual(disclosure.getDisclosedTools(), ["web_search"]);
  });
});

test("检索质量：标点 token 不污染 + 名称命中按内容排序（审查 M1/M3/M4）", () => {
  const candidates = [
    def("mcp__git__status", "Show git working tree status 状态"),
    def("mcp__git__diff", "Show git diff between commits"),
    def("mcp__db__query", "Query the postgres database"),
  ];
  // 中文标点残留（冒号/顿号）不产生噪音 token
  const hits = searchTools(candidates, "查看：状态");
  assert.equal(hits.length > 0 && hits[0]!.tool.name, "mcp__git__status");
  // 同前缀家族按 tf-idf tiebreaker 排序：查 "diff" 时 diff 工具排最前
  const diffHits = searchTools(candidates, "diff commits");
  assert.equal(diffHits[0]!.tool.name, "mcp__git__diff");
});
