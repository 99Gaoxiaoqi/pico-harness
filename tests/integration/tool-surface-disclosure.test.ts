import assert from "node:assert/strict";
import { test } from "node:test";
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

test("headless 宿主派生与原 13 工具白名单完全一致", () => {
  const expected = new Set([
    "bash",
    "edit_file",
    "fetch_url",
    "glob",
    "grep",
    "read_evidence",
    "read_file",
    "task_list",
    "task_output",
    "task_stop",
    "todo",
    "web_search",
    "write_file",
  ]);
  const derived = getSupportedToolNames("headless");
  assert.equal(derived.size, 13);
  for (const name of expected) assert.ok(derived.has(name), `missing ${name}`);
  for (const name of derived) assert.ok(expected.has(name), `extra ${name}`);
});

test("background 宿主亲和性收编原 UNSAFE_BACKGROUND_TOOLS 语义", () => {
  for (const name of ["ask_user", "schedule_task", "delegate_task", "delegate_status", "spawn_subagent"]) {
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
  const tool = new LoadToolsTool(groups, disclosure, {
    onGroupLoaded: (id, names) => loaded.push([id, [...names]]),
  });
  const result = await tool.execute(JSON.stringify({ group: "web" }));
  assert.match(result, /已加载/);
  assert.match(result, /fetch_url/);
  assert.deepEqual(disclosure.getLoadedGroups(), ["web"]);
  assert.deepEqual(loaded, [["web", ["fetch_url", "web_search"]]]);

  // 未知组报错并列出可用组
  await assert.rejects(
    () => tool.execute(JSON.stringify({ group: "nope" })),
    /未知工具组 "nope"/,
  );
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
