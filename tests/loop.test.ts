// Main Loop (ReAct 循环) 的单元测试。
// 用 Mock Provider + Mock Registry 验证:
// 1. 模型返回 toolCalls 时,Loop 会执行工具并把观察结果追加回上下文
// 2. 模型不再返回 toolCalls 时,Loop 正常退出
//
// 第 11 讲:引擎改为 Session 驱动,测试改为构造 Session 后调用 engine.run(session)。

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
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
  use(): void {
    // 测试用:不挂载中间件
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

/** 构造一个带初始用户消息的 Session */
function newSession(prompt: string, workDir = "/tmp"): Session {
  const sess = new Session("test", workDir);
  sess.append({ role: "user", content: prompt });
  return sess;
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

    const session = newSession("做点什么");
    const returned = await engine.run(session);

    // 末尾应是最终答案消息,且无 toolCalls
    const last = returned[returned.length - 1]!;
    expect(last.content).toBe("完成");
    expect(last.toolCalls ?? []).toHaveLength(0);
    // 工具被调用过一次
    expect(registry.executed).toHaveLength(1);
    expect(registry.executed[0]!.name).toBe("read");
  });

  it("Session 完整历史包含 user / assistant / 观察结果", async () => {
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

    const session = newSession("hi");
    await engine.run(session);
    const history = session.getHistory();

    // user 输入
    expect(history[0]!.role).toBe("user");
    expect(history[0]!.content).toBe("hi");
    // assistant (思考+工具调用)
    expect(history[1]!.role).toBe("assistant");
    expect(history[1]!.toolCalls).toHaveLength(1);
    // 观察结果:user 角色,带 toolCallId
    const observation = history[2]!;
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

    const session = newSession("复杂任务");
    await engine.run(session);

    // 每一轮都应有一次 toolsCount===0 (Thinking) 紧跟一次 toolsCount>0 (Action)
    // 共两轮 → 4 次 generate 调用
    expect(provider.calls).toHaveLength(4);
    expect(provider.calls[0]!.toolsCount).toBe(0); // Turn1 Thinking
    expect(provider.calls[1]!.toolsCount).toBeGreaterThan(0); // Turn1 Action
    expect(provider.calls[2]!.toolsCount).toBe(0); // Turn2 Thinking
    expect(provider.calls[3]!.toolsCount).toBeGreaterThan(0); // Turn2 Action

    // Turn1 的思考 trace 应作为 assistant 消息出现在 Session 历史中
    const thinkMsg = session
      .getHistory()
      .find((m) => m.role === "assistant" && m.content === "我计划先读文件再下结论。");
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

    await engine.run(newSession("简单任务"));

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
      use(): void {}
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
    const session = newSession("并发读");
    await engine.run(session);
    const elapsed = Date.now() - start;

    // 三个工具都执行了
    expect(registry.executed).toHaveLength(3);
    // 并行:总耗时应明显小于 3*50=150ms (留余量取 120ms)
    expect(elapsed).toBeLessThan(120);
    // 观察结果按原始顺序 c1/c2/c3 保留
    const obs = session.getHistory().filter((m) => m.toolCallId);
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
      use(): void {}
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
    await engine.run(newSession("写读"));
    const elapsed = Date.now() - start;

    // 串行:总耗时应接近 2*50=100ms (大于 90ms)
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(registry.executed).toHaveLength(2);
  });

  it("跨轮 Session 驱动:第二轮从 WorkingMemory 恢复上下文", async () => {
    // 验证 Session 驱动核心:第二次 run 不从零开始,而是带着历史继续。
    // 第一轮:调一次工具后给最终答案(无 toolCall,本轮结束)。
    // 第二轮:给最终答案,provider 收到的历史应包含第一轮全部交互。
    const seenHistories: Message[][] = [];
    const provider = new (class implements LLMProvider {
      private turn = 0;
      async generate(msgs: Message[], _tools: ToolDefinition[]): Promise<Message> {
        seenHistories.push(msgs.map((m) => ({ ...m })));
        this.turn++;
        if (this.turn === 1) {
          // 第一轮第一回合:发起工具调用
          return {
            role: "assistant",
            content: "调工具",
            toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
          };
        }
        if (this.turn === 2) {
          // 第一轮第二回合:工具结果回来后给最终答案,本轮结束
          return { role: "assistant", content: "第一轮完成" };
        }
        // 第二轮(以及之后):给最终答案
        return { role: "assistant", content: "第二轮看到了历史" };
      }
    })();
    const registry = new MockRegistry();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp", enableThinking: false });

    // 第一轮:一次 run 内完成工具调用 + 最终答案
    const session = newSession("第一轮任务");
    await engine.run(session);

    // 第二轮:复用同一 Session,append 新用户输入
    session.append({ role: "user", content: "第二轮任务" });
    await engine.run(session);

    // 第二轮 provider 收到的历史(第 3 次 generate 调用)应包含第一轮的全部交互
    const secondTurnHistory = seenHistories[2]!;
    const contents = secondTurnHistory.map((m) => m.content);
    expect(contents).toContain("第一轮任务");
    expect(contents).toContain("调工具");
    expect(contents).toContain("result-of-bash");
    expect(contents).toContain("第一轮完成");
    expect(contents).toContain("第二轮任务");
  });
});
