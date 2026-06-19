// Main Loop (ReAct 循环) 的单元测试。
// 用 Mock Provider + Mock Registry 验证:
// 1. 模型返回 toolCalls 时,Loop 会执行工具并把观察结果追加回上下文
// 2. 模型不再返回 toolCalls 时,Loop 正常退出

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { BaseTool, Registry } from "../src/tools/registry.js";

/** 可编程的 Mock Provider:按预设的响应序列依次返回 */
class ScriptedProvider implements LLMProvider {
  constructor(private readonly responses: Message[]) {}
  private i = 0;
  async generate(): Promise<Message> {
    const r = this.responses[this.i];
    if (!r) throw new Error("ScriptedProvider: 响应序列耗尽");
    this.i++;
    return r;
  }
}

/**
 * Thinking 感知 Mock:根据 availableTools 是否为空区分两阶段。
 * 记录每次调用收到的 tools 数量,供测试断言 Thinking 阶段确实传了空数组。
 */
class ThinkingAwareProvider implements LLMProvider {
  readonly calls: { toolsCount: number }[] = [];
  private actionCount = 0;
  async generate(_msgs: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push({ toolsCount: availableTools.length });
    if (availableTools.length === 0) {
      // Phase 1: 慢思考 —— 返回纯文本规划
      return { role: "assistant", content: "我计划先读文件再下结论。" };
    }
    // Phase 2: 行动 —— 第一次调工具,第二次给最终答案
    this.actionCount++;
    if (this.actionCount === 1) {
      return {
        role: "assistant",
        content: "读文件",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      };
    }
    return { role: "assistant", content: "完成" };
  }
}

class MockRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  register(_tool: BaseTool): void {
    // 测试用:直接实现 Registry,不走 BaseTool 注册
  }
  getAvailableTools(): ToolDefinition[] {
    // 必须返回非空,否则 Phase 2 会被误判为 Thinking 阶段
    return [
      {
        name: "bash",
        description: "run a bash command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    this.executed.push(call);
    return { toolCallId: call.id, output: `result-of-${call.name}`, isError: false };
  }
  isReadOnlyTool(_name: string): boolean {
    return false;
  }
}

describe("AgentEngine Main Loop", () => {
  it("执行一轮工具调用后收到最终答案即退出", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "我先读个文件",
        toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
      },
      { role: "assistant", content: "完成" },
    ]);
    const registry = new MockRegistry();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });

    const history = await engine.run("做点什么");

    // 末尾应是最终答案消息,且无 toolCalls
    const last = history[history.length - 1]!;
    expect(last.content).toBe("完成");
    expect(last.toolCalls ?? []).toHaveLength(0);
    // 工具被调用过一次
    expect(registry.executed).toHaveLength(1);
    expect(registry.executed[0]!.name).toBe("read");
  });

  it("上下文时间线包含 system / user / assistant / 观察结果", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "调工具",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
      { role: "assistant", content: "ok" },
    ]);
    const registry = new MockRegistry();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });

    const history = await engine.run("hi");

    expect(history[0]!.role).toBe("system");
    expect(history[1]!.role).toBe("user");
    // assistant (思考+工具调用)
    expect(history[2]!.role).toBe("assistant");
    expect(history[2]!.toolCalls).toHaveLength(1);
    // 观察结果:user 角色,带 toolCallId
    const observation = history[3]!;
    expect(observation.role).toBe("user");
    expect(observation.toolCallId).toBe("c1");
    expect(observation.content).toBe("result-of-bash");
  });

  it("开启 enableThinking 后,每轮行动前先发起空 tools 的慢思考", async () => {
    const provider = new ThinkingAwareProvider();
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: true,
    });

    const history = await engine.run("复杂任务");

    // 每一轮都应有一次 toolsCount===0 (Thinking) 紧跟一次 toolsCount>0 (Action)
    // 共两轮 → 4 次 generate 调用
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[0]!.toolsCount).toBe(0); // Turn1 Thinking
    expect(provider.calls[1]!.toolsCount).toBeGreaterThan(0); // Turn1 Action
    expect(provider.calls[2]!.toolsCount).toBe(0); // Turn2 Thinking
    expect(provider.calls[3]!.toolsCount).toBeGreaterThan(0); // Turn2 Action

    // Turn1 的思考 trace 应作为 assistant 消息出现在 history 中,
    // 且位置在 Turn1 的 Action 响应之前
    const thinkMsg = history.find(
      (m) => m.role === "assistant" && m.content === "我计划先读文件再下结论。",
    );
    expect(thinkMsg).toBeDefined();

    // 工具仍被调用一次
    expect(registry.executed).toHaveLength(1);
  });

  it("关闭 enableThinking 时,不发起 Thinking 请求", async () => {
    const provider = new ThinkingAwareProvider();
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: false,
    });

    await engine.run("简单任务");

    // 不应有 toolsCount===0 的调用
    expect(provider.calls.every((c) => c.toolsCount > 0)).toBe(true);
  });

  it("全只读批次并行执行,且观察结果按原始顺序保留", async () => {
    // 一次返回 3 个只读工具调用,然后给最终答案
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "并发读三个文件",
        toolCalls: [
          { id: "c1", name: "read", arguments: "{}" },
          { id: "c2", name: "read", arguments: "{}" },
          { id: "c3", name: "read", arguments: "{}" },
        ],
      },
      { role: "assistant", content: "完成" },
    ]);

    // 每个工具执行延迟 50ms;若并行总耗时约 50ms,若串行约 150ms
    const registry = new (class implements Registry {
      readonly executed: ToolCall[] = [];
      register(): void {}
      getAvailableTools(): ToolDefinition[] {
        return [{ name: "read", description: "", inputSchema: { type: "object" } }];
      }
      async execute(call: ToolCall): Promise<ToolResult> {
        this.executed.push(call);
        await new Promise((r) => setTimeout(r, 50));
        return { toolCallId: call.id, output: `out-${call.id}`, isError: false };
      }
      isReadOnlyTool(_name: string): boolean {
        return true;
      }
    })();

    const engine = new AgentEngine({ provider, registry, workDir: "/tmp", enableThinking: false });
    const start = Date.now();
    const history = await engine.run("并发读");
    const elapsed = Date.now() - start;

    // 三个工具都执行了
    expect(registry.executed).toHaveLength(3);
    // 并行:总耗时应明显小于 3*50=150ms (留余量取 120ms)
    expect(elapsed).toBeLessThan(120);
    // 观察结果按原始顺序 c1/c2/c3 保留
    const obs = history.filter((m) => m.toolCallId);
    expect(obs.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(obs.map((m) => m.content)).toEqual(["out-c1", "out-c2", "out-c3"]);
  });

  it("含写操作的批次退化为顺序执行", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "先写后读",
        toolCalls: [
          { id: "c1", name: "write", arguments: "{}" },
          { id: "c2", name: "read", arguments: "{}" },
        ],
      },
      { role: "assistant", content: "完成" },
    ]);

    // write 标记为非只读,read 为只读 → 批次含写操作,应串行
    const registry = new (class implements Registry {
      readonly executed: ToolCall[] = [];
      register(): void {}
      getAvailableTools(): ToolDefinition[] {
        return [
          { name: "write", description: "", inputSchema: { type: "object" } },
          { name: "read", description: "", inputSchema: { type: "object" } },
        ];
      }
      async execute(call: ToolCall): Promise<ToolResult> {
        this.executed.push(call);
        await new Promise((r) => setTimeout(r, 50));
        return { toolCallId: call.id, output: `out-${call.name}`, isError: false };
      }
      isReadOnlyTool(name: string): boolean {
        return name === "read";
      }
    })();

    const engine = new AgentEngine({ provider, registry, workDir: "/tmp", enableThinking: false });
    const start = Date.now();
    await engine.run("写读");
    const elapsed = Date.now() - start;

    // 串行:总耗时应接近 2*50=100ms (大于 90ms)
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(registry.executed).toHaveLength(2);
  });
});
