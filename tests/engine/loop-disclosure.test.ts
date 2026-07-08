// 工具渐进披露(ROADMAP 5.4):AgentEngine 接入层单测。
//
// 验证 loop.ts 的拦截点行为:
// 1. 未注入 toolDisclosure:全量工具喂给 provider(行为不变,向后兼容)。
// 2. 注入 toolDisclosure:provider 只收到核心组 + search_tools(不含扩展)。
// 3. disclosure.disclose 后:下一轮 provider 收到被激活的扩展工具。
// 4. 安全网:registry.execute 仍能路由未披露的扩展工具(模型误调也能执行)。
//
// 用 Mock Provider 拦截 generate,检查每次传入的 availableTools 参数。
// 用 Mock Registry 返回固定全量工具集(核心 + 扩展 + search_tools)。

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import { ToolDisclosure } from "../../src/tools/tool-disclosure.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import type { BaseTool, Registry } from "../../src/tools/registry.js";

/**
 * 工具集构造助手:核心组 + 扩展组 + search_tools 元工具。
 * 核心:read_file / bash / grep(来自 CORE_TOOLS)
 * 扩展:web_search / fetch_url(需经 search_tools 披露)
 * 元工具:search_tools(必须始终暴露给模型)
 */
function buildAllTools(): ToolDefinition[] {
  return [
    // 核心组
    { name: "read_file", description: "读文件", inputSchema: { type: "object" } },
    { name: "bash", description: "执行命令", inputSchema: { type: "object" } },
    { name: "grep", description: "搜索文本", inputSchema: { type: "object" } },
    // 扩展组
    { name: "web_search", description: "搜索网络", inputSchema: { type: "object" } },
    { name: "fetch_url", description: "抓取网页", inputSchema: { type: "object" } },
    // 元工具
    {
      name: "search_tools",
      description: "搜索并激活扩展工具",
      inputSchema: { type: "object" },
    },
  ];
}

/**
 * Mock Registry:返回固定全量工具集,记录 execute 调用。
 * 安全网语义:execute 能路由任何工具(含未披露扩展),与披露状态无关。
 */
class MockRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  constructor(private readonly tools: ToolDefinition[] = buildAllTools()) {}
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return this.tools;
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    this.executed.push(call);
    return { toolCallId: call.id, output: `result-of-${call.name}`, isError: false };
  }
  isReadOnlyTool(_name: string): boolean {
    return false;
  }
}

/** 构造带初始用户消息的 Session */
function newSession(prompt: string, workDir = "/tmp"): Session {
  const sess = new Session("test", workDir);
  sess.append({ role: "user", content: prompt });
  return sess;
}

describe("AgentEngine 工具渐进披露接入(ROADMAP 5.4)", () => {
  it("未注入 toolDisclosure 时:全量工具喂给 provider(行为不变)", async () => {
    const allTools = buildAllTools();
    const seenToolCounts: number[] = [];
    const seenToolNames: string[][] = [];
    const provider = new (class implements LLMProvider {
      async generate(_msgs: Message[], tools: ToolDefinition[]): Promise<Message> {
        seenToolCounts.push(tools.length);
        seenToolNames.push(tools.map((t) => t.name));
        // 给最终答案即退出
        return { role: "assistant", content: "完成" };
      }
    })();
    const registry = new MockRegistry(allTools);
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });

    await engine.run(newSession("做点什么"));

    // 全量 6 个工具全部喂给 provider
    expect(seenToolCounts).toHaveLength(1);
    expect(seenToolCounts[0]).toBe(allTools.length);
    expect(seenToolNames[0]).toEqual(expect.arrayContaining(allTools.map((t) => t.name)));
  });

  it("注入 toolDisclosure 时:provider 只收到核心组 + search_tools(不含扩展)", async () => {
    const allTools = buildAllTools();
    const seenToolCounts: number[] = [];
    const seenToolNames: string[][] = [];
    const provider = new (class implements LLMProvider {
      async generate(_msgs: Message[], tools: ToolDefinition[]): Promise<Message> {
        seenToolCounts.push(tools.length);
        seenToolNames.push(tools.map((t) => t.name));
        return { role: "assistant", content: "完成" };
      }
    })();
    const disclosure = new ToolDisclosure();
    const registry = new MockRegistry(allTools);
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      toolDisclosure: disclosure,
    });

    await engine.run(newSession("搜索点东西"));

    expect(seenToolCounts).toHaveLength(1);
    const names = seenToolNames[0]!;
    // 核心组(read_file/bash/grep)始终在
    expect(names).toContain("read_file");
    expect(names).toContain("bash");
    expect(names).toContain("grep");
    // search_tools 元工具必须始终暴露(否则模型无法激活扩展)
    expect(names).toContain("search_tools");
    // 扩展工具未披露 → 不喂给 LLM
    expect(names).not.toContain("web_search");
    expect(names).not.toContain("fetch_url");
    // 3 核心 + 1 search_tools = 4
    expect(seenToolCounts[0]).toBe(4);
  });

  it("disclosure.disclose 后:下一轮 provider 收到被激活的扩展工具", async () => {
    const allTools = buildAllTools();
    const seenToolNames: string[][] = [];
    const disclosure = new ToolDisclosure();
    const provider = new (class implements LLMProvider {
      private turn = 0;
      async generate(_msgs: Message[], tools: ToolDefinition[]): Promise<Message> {
        seenToolNames.push(tools.map((t) => t.name));
        this.turn++;
        if (this.turn === 1) {
          // 第一轮:调工具(模拟 search_tools 命中并披露)
          return {
            role: "assistant",
            content: "先搜工具",
            toolCalls: [{ id: "c1", name: "search_tools", arguments: '{"query":"网络"}' }],
          };
        }
        // 第二轮:给最终答案退出
        return { role: "assistant", content: "完成" };
      }
    })();
    // registry.execute 命中 search_tools 时,模拟 SearchToolsTool 的 disclose 副作用。
    // 真实 SearchToolsTool.execute 会调 disclosure.disclose;此处用真实 ToolDisclosure +
    // 手动 disclose 还原语义(测试关注 loop 拦截点,非 SearchToolsTool 本身)。
    const disclosureRegistry = new (class extends MockRegistry {
      override async execute(call: ToolCall): Promise<ToolResult> {
        if (call.name === "search_tools") {
          disclosure.disclose(["web_search", "fetch_url"]);
          return {
            toolCallId: call.id,
            output: "已激活 2 个工具,下一轮可直接调用",
            isError: false,
          };
        }
        return super.execute(call);
      }
    })(allTools);
    const engine = new AgentEngine({
      provider,
      registry: disclosureRegistry,
      workDir: "/tmp",
      toolDisclosure: disclosure,
    });

    await engine.run(newSession("搜索网络"));

    expect(seenToolNames).toHaveLength(2);
    // 第一轮:核心 + search_tools(扩展未披露)
    const turn1Names = seenToolNames[0]!;
    expect(turn1Names).toContain("search_tools");
    expect(turn1Names).not.toContain("web_search");
    // 第二轮:web_search/fetch_url 已被披露 → 出现在喂给 LLM 的工具列表
    const turn2Names = seenToolNames[1]!;
    expect(turn2Names).toContain("web_search");
    expect(turn2Names).toContain("fetch_url");
    // 核心组仍在
    expect(turn2Names).toContain("read_file");
    expect(turn2Names).toContain("bash");
  });

  it("安全网:registry.execute 仍能路由未披露的扩展工具(模型误调也能执行)", async () => {
    const allTools = buildAllTools();
    const disclosure = new ToolDisclosure();
    const provider = new (class implements LLMProvider {
      private turn = 0;
      async generate(_msgs: Message[], _tools: ToolDefinition[]): Promise<Message> {
        this.turn++;
        if (this.turn === 1) {
          // 模型"误调"一个未披露的扩展工具(它本不在喂给 LLM 的列表里,
          // 但若模型 hallucinate 了 toolName,registry.execute 仍能路由)。
          return {
            role: "assistant",
            content: "直接搜网络",
            toolCalls: [{ id: "c1", name: "web_search", arguments: '{"q":"pico"}' }],
          };
        }
        return { role: "assistant", content: "完成" };
      }
    })();
    const registry = new MockRegistry(allTools);
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      toolDisclosure: disclosure,
    });

    await engine.run(newSession("搜网络"));

    // web_search 未披露,但 registry.execute 按全集路由 → 仍被成功执行
    expect(registry.executed).toHaveLength(1);
    expect(registry.executed[0]!.name).toBe("web_search");
    // 安全网:披露状态不受误调影响(web_search 仍未被披露,因为 disclose 只由 search_tools 触发)
    expect(disclosure.getDisclosed()).not.toContain("web_search");
  });
});
