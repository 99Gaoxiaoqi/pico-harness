import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../../src/engine/session-runtime-event.js";
import { createRuntimeEventId } from "../../src/storage/runtime-event-store-contracts.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { LoadToolsTool, renderGroupCatalog } from "../../src/tools/load-tools.js";
import { SearchToolsTool } from "../../src/tools/search-tools.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";
import {
  getAvailableDeferredGroups,
  getSupportedToolNames,
  isPlanModeTool,
  isToolSupportedForHost,
  PICO_TOOL_GROUPS,
} from "../../src/tools/tool-surface.js";
import { CORE_TOOLS, getTier } from "../../src/tools/tool-tiers.js";
import { searchTools } from "../../src/tools/tool-search-index.js";
import type { ToolDefinition } from "../../src/schema/message.js";

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

test("background 宿主亲和性收编原 UNSAFE_BACKGROUND_TOOLS 语义", () => {
  for (const name of [
    "ask_user",
    "schedule_task",
    "delegate_task",
    "delegate_status",
    "spawn_subagent",
  ]) {
    assert.equal(isToolSupportedForHost(name, "background"), false, name);
  }
  for (const name of ["read_file", "bash", "grep", "task_list"]) {
    assert.equal(isToolSupportedForHost(name, "background"), true, name);
  }
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

test("CORE_TOOLS 从 surface 派生且 getTier 兼容", () => {
  assert.equal(CORE_TOOLS.size, 10);
  assert.equal(getTier("read_file"), "core");
  assert.equal(getTier("ask_user"), "core");
  // MCP/未分组动态工具落 extended
  assert.equal(getTier("mcp__server__tool"), "extended");
  // deferred 组成员落 extended（激活前不可见）
  assert.equal(getTier("web_search"), "extended");
});

test("ToolDisclosure 组级激活：pickForLLM = always 组 ∪ loaded 组", () => {
  const disclosure = new ToolDisclosure();
  const allTools = [
    def("read_file"),
    def("write_file"),
    def("fetch_url"),
    def("web_search"),
    def("task_list"),
    def("mcp__db__query"),
  ];
  // 初始：只可见 core（always 组）
  assert.deepEqual(
    disclosure.pickForLLM(allTools).map((t) => t.name),
    ["read_file", "write_file"],
  );
  // 组级激活 web 组
  disclosure.discloseGroup("web", ["fetch_url", "web_search"]);
  assert.deepEqual(
    disclosure.pickForLLM(allTools).map((t) => t.name),
    ["read_file", "write_file", "fetch_url", "web_search"],
  );
  assert.deepEqual(disclosure.getLoadedGroups(), ["web"]);
  // 单工具兜底（MCP 动态工具）
  disclosure.discloseTools(["mcp__db__query"]);
  assert.deepEqual(
    disclosure.pickForLLM(allTools).map((t) => t.name),
    ["read_file", "write_file", "fetch_url", "web_search", "mcp__db__query"],
  );
});

test("ToolDisclosure durable 重播：seedFromEvents 恢复组加载状态", () => {
  const disclosure = new ToolDisclosure();
  disclosure.seedFromEvents([
    { kind: "run.started", data: {} },
    { kind: "tool.group.loaded", data: { groupId: "web", toolNames: ["fetch_url", "web_search"] } },
    {
      kind: "tool.group.loaded",
      data: { groupId: "background-task", toolNames: ["task_list", "task_output", "task_stop"] },
    },
    // 畸形事件（无效 data）不得崩溃
    { kind: "tool.group.loaded", data: { groupId: 42, toolNames: null } },
    { kind: "tool.group.loaded" },
  ]);
  assert.deepEqual(disclosure.getLoadedGroups(), ["web", "background-task"]);
  const allTools = [def("fetch_url"), def("web_search"), def("task_list"), def("read_file")];
  assert.deepEqual(
    disclosure.pickForLLM(allTools).map((t) => t.name),
    ["fetch_url", "web_search", "task_list", "read_file"],
  );
});

test("LoadToolsTool 枚举激活：命中即 discloseGroup + 回调", async () => {
  const disclosure = new ToolDisclosure();
  const groups = getAvailableDeferredGroups("desktop");
  const loaded: Array<[string, string[]]> = [];
  const tool = new LoadToolsTool(groups, disclosure, undefined, {
    onGroupLoaded: (id, names) => loaded.push([id, [...names]]),
  });
  const result = await tool.execute(JSON.stringify({ group: "web" }));
  assert.match(result, /已加载/);
  assert.match(result, /fetch_url/);
  assert.deepEqual(disclosure.getLoadedGroups(), ["web"]);
  assert.deepEqual(loaded, [["web", ["fetch_url", "web_search"]]]);

  // 未知组报错并列出可用组
  await assert.rejects(() => tool.execute(JSON.stringify({ group: "nope" })), /未知工具组 "nope"/);
  // 参数解析失败
  await assert.rejects(() => tool.execute("not json"), /参数解析失败/);
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

test("background 宿主的 deferred 组列表不含 memory", () => {
  const desktop = getAvailableDeferredGroups("desktop").map((g) => g.id);
  const background = getAvailableDeferredGroups("background").map((g) => g.id);
  assert.ok(desktop.includes("memory"));
  assert.equal(background.includes("memory"), false);
  assert.ok(background.includes("web"));
});

test("search_tools 只检索无预定义组的动态工具", async () => {
  const disclosure = new ToolDisclosure();
  const allTools = [
    def("read_file"),
    def("web_search"),
    def("mcp__db__query", "Query the postgres database with SQL"),
    def("mcp__fs__list_dir", "List directory contents on the filesystem"),
  ];
  const tool = new SearchToolsTool(() => allTools, disclosure);
  const result = await tool.execute(JSON.stringify({ query: "数据库 database" }));
  assert.match(result, /mcp__db__query/);
  assert.doesNotMatch(result, /web_search/);
  assert.doesNotMatch(result, /read_file/);
  assert.doesNotMatch(result, /mcp__fs__list_dir/);
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

test("durable 往返：store append tool.group.loaded → readSessionEntries → seedFromEvents 恢复", async () => {
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
    assert.deepEqual(disclosure.getLoadedGroups(), ["web"]);
    assert.deepEqual(
      disclosure
        .pickForLLM([def("fetch_url"), def("web_search"), def("read_file")])
        .map((t) => t.name),
      ["fetch_url", "web_search", "read_file"],
    );
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("幻影组防御：组成员未注册时 load_tools 拒绝假承诺（审查 C2）", async () => {
  const disclosure = new ToolDisclosure();
  const groups = getAvailableDeferredGroups("desktop");
  // registry 里只有 web 组成员，graph 组工具未注册（非 graph 模式会话的现实）
  const registered = () => ["fetch_url", "web_search", "read_file"];
  const tool = new LoadToolsTool(groups, disclosure, registered);
  await assert.rejects(() => tool.execute(JSON.stringify({ group: "graph" })), /在当前环境不可用/);
  assert.deepEqual(disclosure.getLoadedGroups(), [], "拒绝后不得留下任何加载状态");
  // 部分注册：只披露真实存在的成员
  const partial = new LoadToolsTool(groups, disclosure, () => ["fetch_url", "read_file"]);
  const result = await partial.execute(JSON.stringify({ group: "web" }));
  assert.match(result, /fetch_url/);
  assert.doesNotMatch(result, /web_search/);
});

test("重复 schema 防御：search_tools 候选排除连接器与协议工具（审查 H1）", async () => {
  const disclosure = new ToolDisclosure();
  const allTools = [
    def("read_file"),
    def("load_tools", "Load tool groups on demand"),
    def("search_tools", "Search and activate dynamic tools"),
    def("submit_plan"),
    def("mcp__db__query", "Query the database"),
  ];
  const tool = new SearchToolsTool(() => allTools, disclosure);
  // 搜 "load"/"tools"/"plan" 都不得把连接器或协议工具披露进集合
  for (const query of ["load", "tools 工具", "plan 计划", "select:load_tools"]) {
    await tool.execute(JSON.stringify({ query }));
  }
  const disclosed = disclosure.getDisclosedTools();
  assert.equal(disclosed.includes("load_tools"), false);
  assert.equal(disclosed.includes("search_tools"), false);
  assert.equal(disclosed.includes("submit_plan"), false);
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

test("seedFromEvents 的 stale groupId 防御：组被删除后旧事件不重播", () => {
  const disclosure = new ToolDisclosure();
  disclosure.seedFromEvents([
    { kind: "tool.group.loaded", data: { groupId: "web", toolNames: ["fetch_url"] } },
    // "legacy-group" 不在当前目录
    { kind: "tool.group.loaded", data: { groupId: "legacy-group", toolNames: ["old_tool"] } },
  ]);
  assert.deepEqual(disclosure.getLoadedGroups(), ["web"]);
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
