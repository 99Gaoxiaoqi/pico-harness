// 工具渐进披露核心三件套单测(ROADMAP 5.4)。
// 验证 getTier 分层、ToolDisclosure 状态机、SearchToolsTool 检索激活。

import { describe, expect, it } from "vitest";
import { CORE_TOOLS, getTier } from "../../src/tools/tool-tiers.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";
import { SearchToolsTool } from "../../src/tools/search-tools.js";
import type { ToolDefinition } from "../../src/schema/message.js";

// 构造一个最小 ToolDefinition 的便捷函数
function def(name: string, description = ""): ToolDefinition {
  return { name, description, inputSchema: { type: "object", properties: {} } };
}

// 模拟一份工具清单:核心组 + 扩展组
const ALL_TOOLS: ToolDefinition[] = [
  def("read_file", "读取文件"),
  def("write_file", "写入文件"),
  def("edit_file", "编辑文件"),
  def("bash", "执行 shell 命令"),
  def("glob", "匹配文件路径"),
  def("grep", "搜索文件内容"),
  def("todo", "任务清单"),
  // 扩展组
  def("web_search", "搜索网络"),
  def("fetch_url", "抓取网页"),
  def("task_create", "后台任务"),
];

describe("getTier / tool-tiers", () => {
  it("核心工具返回 core", () => {
    for (const name of CORE_TOOLS) {
      expect(getTier(name)).toBe("core");
    }
  });

  it("扩展工具返回 extended", () => {
    expect(getTier("web_search")).toBe("extended");
    expect(getTier("fetch_url")).toBe("extended");
  });

  it("未知工具返回 extended(安全兜底)", () => {
    expect(getTier("not_a_tool")).toBe("extended");
    expect(getTier("")).toBe("extended");
  });
});

describe("ToolDisclosure.pickForLLM", () => {
  it("默认只返回核心组", () => {
    const d = new ToolDisclosure();
    const picked = d.pickForLLM(ALL_TOOLS);
    expect(picked.map((t) => t.name)).toEqual([
      "read_file",
      "write_file",
      "edit_file",
      "bash",
      "glob",
      "grep",
      "todo",
    ]);
  });

  it("disclose 扩展工具后,pickForLLM 结果包含它", () => {
    const d = new ToolDisclosure();
    d.disclose(["web_search"]);
    const picked = d.pickForLLM(ALL_TOOLS);
    expect(picked.map((t) => t.name)).toContain("web_search");
  });

  it("disclose 核心工具无效(核心本来就在)", () => {
    const d = new ToolDisclosure();
    d.disclose(["read_file"]);
    expect(d.getDisclosed()).toEqual([]);
    // 核心仍在,且 disclosed 集合为空
    const picked = d.pickForLLM(ALL_TOOLS);
    expect(picked.map((t) => t.name)).toContain("read_file");
  });

  it("disclose 未注册的工具名无副作用", () => {
    const d = new ToolDisclosure();
    d.disclose(["ghost_tool"]);
    expect(d.getDisclosed()).toEqual(["ghost_tool"]);
    // 但 pickForLLM 取全集过滤,ghost_tool 不在 ALL_TOOLS 里故不出现
    const picked = d.pickForLLM(ALL_TOOLS);
    expect(picked.map((t) => t.name)).not.toContain("ghost_tool");
  });

  it("pickForLLM 对空数组返回空", () => {
    const d = new ToolDisclosure();
    expect(d.pickForLLM([])).toEqual([]);
  });

  it("pickForLLM 保留核心+扩展的并集,不重复", () => {
    const d = new ToolDisclosure();
    d.disclose(["web_search", "todo"]); // todo 是核心,disclose 应被忽略
    const picked = d.pickForLLM(ALL_TOOLS);
    const names = picked.map((t) => t.name);
    // web_search 出现一次,todo 出现一次(来自全集,不重复)
    expect(names.filter((n) => n === "todo")).toHaveLength(1);
    expect(names.filter((n) => n === "web_search")).toHaveLength(1);
  });
});

describe("ToolDisclosure.disclosed 集合", () => {
  it("getDisclosed 返回已披露列表", () => {
    const d = new ToolDisclosure();
    d.disclose(["web_search", "fetch_url"]);
    expect(d.getDisclosed()).toEqual(["web_search", "fetch_url"]);
  });

  it("reset 清空 disclosed", () => {
    const d = new ToolDisclosure();
    d.disclose(["web_search"]);
    expect(d.getDisclosed().length).toBe(1);
    d.reset();
    expect(d.getDisclosed()).toEqual([]);
  });

  it("disclose 同名工具多次不重复", () => {
    const d = new ToolDisclosure();
    d.disclose(["web_search"]);
    d.disclose(["web_search"]);
    d.disclose(["web_search"]);
    expect(d.getDisclosed()).toEqual(["web_search"]);
  });

  it("多个扩展工具 disclose 后都出现", () => {
    const d = new ToolDisclosure();
    d.disclose(["web_search", "fetch_url", "task_create"]);
    expect(d.getDisclosed()).toEqual(["web_search", "fetch_url", "task_create"]);
  });
});

describe("SearchToolsTool", () => {
  // 扩展工具池(只含扩展组)
  const EXTENDED: ToolDefinition[] = [
    def("web_search", "搜索网络,查询实时信息"),
    def("fetch_url", "抓取网页内容"),
    def("task_create", "创建后台任务"),
  ];

  it("name 与 definition 正确", () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    expect(tool.name()).toBe("search_tools");
    const defn = tool.definition();
    expect(defn.name).toBe("search_tools");
    expect(defn.description).toContain("扩展工具");
    expect((defn.inputSchema as { required: string[] }).required).toEqual(["query"]);
  });

  it("只读且 accesses 声明 none", () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    expect(tool.readOnly).toBe(true);
    expect(tool.accesses("{}")).toEqual([]);
  });

  it("query 匹配 name 时 disclose 并返回激活说明", async () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    const out = await tool.execute(JSON.stringify({ query: "web_search" }));
    expect(out).toContain("已激活");
    expect(out).toContain("web_search");
    expect(d.getDisclosed()).toContain("web_search");
  });

  it("query 匹配 description 时 disclose", async () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    const out = await tool.execute(JSON.stringify({ query: "抓取网页" }));
    expect(out).toContain("fetch_url");
    expect(d.getDisclosed()).toContain("fetch_url");
  });

  it("query 多分词命中多个工具", async () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    const out = await tool.execute(JSON.stringify({ query: "网络 后台" }));
    expect(out).toContain("web_search");
    expect(out).toContain("task_create");
    expect(d.getDisclosed()).toEqual(expect.arrayContaining(["web_search", "task_create"]));
  });

  it("无命中时提示换关键词", async () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    const out = await tool.execute(JSON.stringify({ query: "完全不存在的词汇xyz" }));
    expect(out).toContain("未找到匹配工具");
    expect(d.getDisclosed()).toEqual([]);
  });

  it("非法 JSON 抛错", async () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    await expect(tool.execute("not json")).rejects.toThrow(/参数解析失败/);
  });

  it("空 query 抛错", async () => {
    const d = new ToolDisclosure();
    const tool = new SearchToolsTool(EXTENDED, d);
    await expect(tool.execute(JSON.stringify({ query: "  " }))).rejects.toThrow(/query/);
  });
});
