// Main Loop (ReAct 循环) 的单元测试。
// 用 Mock Provider + Mock Registry 验证:
// 1. 模型返回 toolCalls 时,Loop 会执行工具并把观察结果追加回上下文
// 2. 模型不再返回 toolCalls 时,Loop 正常退出
//
// 第 11 讲:引擎改为 Session 驱动,测试改为构造 Session 后调用 engine.run(session)。

import { describe, expect, it, vi } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import { IterationBudget } from "../src/engine/budget.js";
import { GoalManager } from "../src/engine/goal-manager.js";
import type { Reporter } from "../src/engine/reporter.js";
import { LLMStatusError } from "../src/provider/errors.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { BaseTool, Registry, ToolExecutionContext } from "../src/tools/registry.js";
import { ToolAccesses } from "../src/tools/tool-access.js";
import { resolve } from "node:path";

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
 * 工具感知 Mock:记录每次调用收到的 tools 数量,供测试断言不会再触发空 tools 规划请求。
 */
class ThinkingAwareProvider implements LLMProvider {
  readonly calls: { toolsCount: number }[] = [];
  private actionCount = 0;
  async generate(_msgs: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push({ toolsCount: availableTools.length });
    if (availableTools.length === 0) {
      // 旧两阶段实现会在空 tools 时返回规划文本;新实现不应触发这条路径。
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

class StreamingProvider implements LLMProvider {
  async generate(): Promise<Message> {
    return { role: "assistant", content: "non-stream" };
  }

  async generateStream(
    _msgs: Message[],
    _tools: ToolDefinition[],
    onDelta: (delta: string) => void,
  ): Promise<Message> {
    onDelta("runtime ");
    onDelta("delta");
    return { role: "assistant", content: "runtime delta" };
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

function reporter(onTextDelta?: (delta: string) => void): Reporter {
  return {
    onThinking() {},
    onToolCall() {},
    onToolResult() {},
    onMessage() {},
    onStart() {},
    onTurnStart() {},
    onFinish() {},
    ...(onTextDelta ? { onTextDelta } : {}),
  };
}

describe("AgentEngine Main Loop", () => {
  it("enforces an active goal turn budget and records grace-call usage", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "run once",
        toolCalls: [{ id: "goal-call", name: "bash", arguments: "{}" }],
        usage: { promptTokens: 20, completionTokens: 10 },
      },
      {
        role: "assistant",
        content: "grace summary",
        usage: { promptTokens: 5, completionTokens: 5 },
      },
    ]);
    const registry = new MockRegistry();
    const goalManager = new GoalManager();
    const goal = goalManager.create("bounded goal", "run one model turn", { maxTurns: 1 });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      goalManager,
    });

    const session = newSession("start bounded goal");
    await engine.run(session);

    expect(registry.executed).toHaveLength(1);
    expect(goalManager.get(goal.id)?.budgetUsage).toMatchObject({
      turns: 1,
      tokens: 40,
    });
    expect(session.getHistory().at(-1)?.content).toBe("grace summary");
  });

  it("run 将 signal 传给 provider 调用", async () => {
    let receivedSignal: AbortSignal | undefined;
    const provider: LLMProvider = {
      async generate(_messages, _tools, options?: { signal?: AbortSignal }): Promise<Message> {
        receivedSignal = options?.signal;
        return { role: "assistant", content: "done" };
      },
    };
    const engine = new AgentEngine({ provider, registry: new MockRegistry(), workDir: "/tmp" });
    const controller = new AbortController();

    await engine.run(newSession("hi"), undefined, undefined, controller.signal);

    expect(receivedSignal).toBe(controller.signal);
  });

  it("中止本轮工具批次时拒绝排队工具", async () => {
    let releaseFirst!: () => void;
    let firstStarted!: () => void;
    let firstObservedAbort!: () => void;
    const firstStart = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstAbort = new Promise<void>((resolve) => {
      firstObservedAbort = resolve;
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "run tools",
        toolCalls: [
          { id: "c1", name: "bash", arguments: "{}" },
          { id: "c2", name: "bash", arguments: "{}" },
        ],
      },
      { role: "assistant", content: "done" },
    ]);
    const registry = new (class extends MockRegistry {
      override async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
        this.executed.push(call);
        if (call.id === "c1") {
          firstStarted();
          const signal = context?.signal;
          if (!signal) throw new Error("测试工具未收到 AbortSignal");
          if (signal.aborted) firstObservedAbort();
          else signal.addEventListener("abort", firstObservedAbort, { once: true });
          await firstRelease;
        }
        return { toolCallId: call.id, output: `out-${call.id}`, isError: false };
      }
    })();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });
    const controller = new AbortController();
    const reason = new DOMException("interrupted", "AbortError");
    const run = engine.run(newSession("hi"), undefined, undefined, controller.signal);
    let runSettled = false;
    void run.then(
      () => {
        runSettled = true;
      },
      () => {
        runSettled = true;
      },
    );

    await firstStart;
    controller.abort(reason);
    await firstAbort;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(runSettled).toBe(false);
    // settleOnAbort 会等底层物理执行收口，收口后 run 才拒绝。
    releaseFirst();
    await expect(run).rejects.toBe(reason);

    expect(runSettled).toBe(true);
    expect(registry.executed.map((call) => call.id)).toEqual(["c1"]);
  });

  it("工具批次中止后同一 Session 可继续且 tool calls/results 保持配对", async () => {
    let releaseTool!: () => void;
    let toolStarted!: () => void;
    let toolObservedAbort!: () => void;
    const started = new Promise<void>((resolve) => {
      toolStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseTool = resolve;
    });
    const aborted = new Promise<void>((resolve) => {
      toolObservedAbort = resolve;
    });
    const contexts: Message[][] = [];
    let providerCalls = 0;
    const provider: LLMProvider = {
      async generate(messages): Promise<Message> {
        contexts.push(messages.map((message) => ({ ...message })));
        providerCalls++;
        if (providerCalls === 1) {
          return {
            role: "assistant",
            content: "run tools",
            toolCalls: [
              { id: "abort-c1", name: "bash", arguments: "{}" },
              { id: "abort-c2", name: "bash", arguments: "{}" },
            ],
          };
        }
        return { role: "assistant", content: "continued safely" };
      },
    };
    const registry = new (class extends MockRegistry {
      override async execute(call: ToolCall, context?: ToolExecutionContext): Promise<ToolResult> {
        this.executed.push(call);
        if (call.id === "abort-c1") {
          toolStarted();
          const signal = context?.signal;
          if (!signal) throw new Error("测试工具未收到 AbortSignal");
          if (signal.aborted) toolObservedAbort();
          else signal.addEventListener("abort", toolObservedAbort, { once: true });
          await release;
        }
        return { toolCallId: call.id, output: `out-${call.id}`, isError: false };
      }
    })();
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });
    const session = newSession("first run");
    const controller = new AbortController();
    const firstRun = engine.run(session, undefined, undefined, controller.signal);
    let firstRunSettled = false;
    void firstRun.then(
      () => {
        firstRunSettled = true;
      },
      () => {
        firstRunSettled = true;
      },
    );

    await started;
    controller.abort(new DOMException("interrupted", "AbortError"));
    await aborted;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(firstRunSettled).toBe(false);
    expect(contexts).toHaveLength(1);
    expect(providerCalls).toBe(1);
    // 先模拟可中止工具的物理执行收口，再等待本轮 run 拒绝。
    releaseTool();
    await expect(firstRun).rejects.toMatchObject({ name: "AbortError" });
    expect(firstRunSettled).toBe(true);

    session.append({ role: "user", content: "continue after abort" });
    const secondRun = await engine.run(session);

    expect(secondRun.at(-1)?.content).toBe("continued safely");
    expect(providerCalls).toBe(2);
    expect(registry.executed.map((call) => call.id)).toEqual(["abort-c1"]);
    const secondContext = contexts[1] ?? [];
    const toolCallIds = secondContext.flatMap(
      (message) => message.toolCalls?.map((call) => call.id) ?? [],
    );
    const toolResultIds = secondContext.flatMap((message) =>
      message.toolCallId ? [message.toolCallId] : [],
    );
    expect(toolCallIds).toEqual(["abort-c1", "abort-c2"]);
    expect(toolResultIds).toEqual(["abort-c1", "abort-c2"]);
    expect(
      secondContext.some(
        (message) => message.role === "user" && message.content === "continue after abort",
      ),
    ).toBe(true);
  });

  it("run 传入的 runtimeReporter 接收本轮 stream delta", async () => {
    const constructorDelta = vi.fn();
    const runtimeDelta = vi.fn();
    const engine = new AgentEngine({
      provider: new StreamingProvider(),
      registry: new MockRegistry(),
      workDir: "/tmp",
      reporter: reporter(constructorDelta),
    });

    await engine.run(newSession("hi"), reporter(runtimeDelta));

    expect(runtimeDelta).toHaveBeenCalledTimes(2);
    expect(runtimeDelta.mock.calls.map((call) => call[0])).toEqual(["runtime ", "delta"]);
    expect(constructorDelta).not.toHaveBeenCalled();
  });

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

  it("Observation Processor 失败时回退为截断观察结果,不中断主循环", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "调工具",
        toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      },
      { role: "assistant", content: "ok" },
    ]);
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      observationProcessor: async () => {
        throw new Error("artifact disk failed");
      },
    });

    const session = newSession("hi");
    await engine.run(session);

    const observation = session.getHistory().find((msg) => msg.toolCallId === "c1");
    expect(observation?.content).toContain("工具输出处理失败");
    expect(session.getHistory().at(-1)?.content).toBe("ok");
  });

  it("不再执行应用层两阶段 thinking,每轮只发起一次带工具请求", async () => {
    const provider = new ThinkingAwareProvider();
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      enableThinking: true,
    } as ConstructorParameters<typeof AgentEngine>[0] & { enableThinking: boolean });

    const session = newSession("复杂任务");
    await engine.run(session);

    // 共两轮:一轮工具调用,一轮最终回答。没有额外的空 tools planning 请求。
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls.every((c) => c.toolsCount > 0)).toBe(true);
    expect(
      session
        .getHistory()
        .some((m) => m.role === "assistant" && m.content === "我计划先读文件再下结论。"),
    ).toBe(false);

    // 工具仍被调用一次
    expect(registry.executed).toHaveLength(1);
  });

  it("默认不发起空 tools 的 Thinking 请求", async () => {
    const provider = new ThinkingAwareProvider();
    const registry = new MockRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
    });

    await engine.run(newSession("简单任务"));

    // 不应有 toolsCount===0 的调用
    expect(provider.calls.every((c) => c.toolsCount > 0)).toBe(true);
  });

  it("资源不冲突的工具并行执行(如读不同文件),且结果按原始顺序保留", async () => {
    // 一次返回 3 个读不同文件路径的工具调用 —— 不冲突,应并行
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "并发读三个不同文件",
        toolCalls: [
          { id: "c1", name: "read", arguments: JSON.stringify({ path: "a.ts" }) },
          { id: "c2", name: "read", arguments: JSON.stringify({ path: "b.ts" }) },
          { id: "c3", name: "read", arguments: JSON.stringify({ path: "c.ts" }) },
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
      // 资源冲突图调度:read 不同路径 → 不冲突 → 并行
      getAccesses(call: ToolCall): ToolAccesses {
        const { path } = JSON.parse(call.arguments) as { path?: string };
        return ToolAccesses.readFile(resolve("/tmp", path ?? ""));
      }
    })();

    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });
    const start = Date.now();
    const session = newSession("并发读");
    await engine.run(session);
    const elapsed = Date.now() - start;

    // 三个工具都执行了
    expect(registry.executed).toHaveLength(3);
    // 并行:总耗时应明显小于 3*50=150ms (留余量取 120ms)
    expect(elapsed).toBeLessThan(120);
    // 观察结果按原始顺序 c1/c2/c3 保留(调度器保证 provider order)
    const obs = session.getHistory().filter((m) => m.toolCallId);
    expect(obs.map((m) => m.toolCallId)).toEqual(["c1", "c2", "c3"]);
    expect(obs.map((m) => m.content)).toEqual(["out-c1", "out-c2", "out-c3"]);
  });

  it("资源冲突的工具串行执行(如写与读同一文件)", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "写与读同一个文件",
        toolCalls: [
          { id: "c1", name: "write", arguments: JSON.stringify({ path: "same.ts" }) },
          { id: "c2", name: "read", arguments: JSON.stringify({ path: "same.ts" }) },
        ],
      },
      { role: "assistant", content: "完成" },
    ]);

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
      // 同一文件:write + read 冲突 → 串行
      getAccesses(call: ToolCall): ToolAccesses {
        const { path } = JSON.parse(call.arguments) as { path?: string };
        const op = call.name === "write" ? "write" : "read";
        const abs = resolve("/tmp", path ?? "");
        return op === "write" ? ToolAccesses.writeFile(abs) : ToolAccesses.readFile(abs);
      }
    })();

    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });
    const start = Date.now();
    await engine.run(newSession("写读同文件"));
    const elapsed = Date.now() - start;

    // 串行:总耗时应接近 2*50=100ms (大于 90ms)
    expect(elapsed).toBeGreaterThanOrEqual(90);
    expect(registry.executed).toHaveLength(2);
  });

  it("写不同文件可并行(旧二元模型做不到的并发度)", async () => {
    // 两个 write 不同路径 —— 旧模型会串行,冲突图调度应判定不冲突而并行
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "并发写两个不同文件",
        toolCalls: [
          { id: "c1", name: "write", arguments: JSON.stringify({ path: "a.ts" }) },
          { id: "c2", name: "write", arguments: JSON.stringify({ path: "b.ts" }) },
        ],
      },
      { role: "assistant", content: "完成" },
    ]);

    const registry = new (class implements Registry {
      readonly executed: ToolCall[] = [];
      register(): void {}
      use(): void {}
      getAvailableTools(): ToolDefinition[] {
        return [{ name: "write", description: "", inputSchema: { type: "object" } }];
      }
      async execute(call: ToolCall): Promise<ToolResult> {
        this.executed.push(call);
        await new Promise((r) => setTimeout(r, 50));
        return { toolCallId: call.id, output: `out-${call.id}`, isError: false };
      }
      getAccesses(call: ToolCall): ToolAccesses {
        const { path } = JSON.parse(call.arguments) as { path?: string };
        return ToolAccesses.writeFile(resolve("/tmp", path ?? ""));
      }
    })();

    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });
    const start = Date.now();
    await engine.run(newSession("并发写不同文件"));
    const elapsed = Date.now() - start;

    // 并行:两个写不同文件不冲突,耗时约 50ms (远小于串行的 100ms)
    expect(elapsed).toBeLessThan(120);
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
    const engine = new AgentEngine({ provider, registry, workDir: "/tmp" });

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

  it("达到 maxTurns 后触发无工具 Grace Call 收尾", async () => {
    const calls: { toolsCount: number; lastUser?: string }[] = [];
    const provider = new (class implements LLMProvider {
      private n = 0;
      async generate(msgs: Message[], tools: ToolDefinition[]): Promise<Message> {
        calls.push({
          toolsCount: tools.length,
          lastUser: [...msgs].reverse().find((m) => m.role === "user")?.content,
        });
        this.n++;
        if (this.n === 1) {
          return {
            role: "assistant",
            content: "继续调用",
            toolCalls: [{ id: "c1", name: "read", arguments: "{}" }],
          };
        }
        return { role: "assistant", content: "收尾总结" };
      }
    })();
    const engine = new AgentEngine({
      provider,
      registry: new MockRegistry(),
      workDir: "/tmp",
      maxTurns: 1,
    });

    const session = newSession("做一个长任务");
    await engine.run(session);

    expect(calls).toHaveLength(2);
    expect(calls[1]!.toolsCount).toBe(0);
    expect(calls[1]!.lastUser).toContain("已达执行预算");
    expect(session.getHistory().at(-1)?.content).toBe("收尾总结");
  });

  it("IterationBudget 同时支持轮次、Token、成本三闸", () => {
    const budget = new IterationBudget({
      maxTurns: 2,
      maxTokens: 100,
      maxCostCNY: 0.01,
    });

    expect(budget.canStartTurn(1).allowed).toBe(true);
    expect(budget.canStartTurn(3).allowed).toBe(false);

    budget.consumeUsage({
      promptTokens: 70,
      completionTokens: 20,
    });
    expect(budget.consumeUsage({ promptTokens: 20, completionTokens: 0 }).allowed).toBe(false);

    const costBudget = new IterationBudget({ maxCostCNY: 0.01 });
    expect(costBudget.consumeCost(0.02).allowed).toBe(false);
  });

  it("429 轮换 provider 后同一轮后续调用继续使用新 provider", async () => {
    const oldProviderCalls: number[] = [];
    const newProviderCalls: { toolsCount: number }[] = [];
    const oldProvider: LLMProvider = {
      modelName: "old-key",
      async generate(): Promise<Message> {
        oldProviderCalls.push(1);
        throw new LLMStatusError(429, "rate limited");
      },
    };
    const newProvider: LLMProvider = {
      modelName: "new-key",
      async generate(_messages, tools): Promise<Message> {
        newProviderCalls.push({ toolsCount: tools.length });
        return {
          role: "assistant",
          content: tools.length === 0 ? "思考完成" : "最终答案",
        };
      },
    };
    const engine = new AgentEngine({
      provider: oldProvider,
      registry: new MockRegistry(),
      workDir: "/tmp",
      rebuildProvider: () => newProvider,
    });

    const session = newSession("做点什么");
    await engine.run(session);

    expect(oldProviderCalls).toHaveLength(1);
    expect(newProviderCalls).toEqual([{ toolsCount: 1 }]);
    expect(session.getHistory().at(-1)?.content).toBe("最终答案");
  });

  it("Guardrail 会逐个分析并发批次里的每个工具结果", async () => {
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "并发读取",
        toolCalls: [
          { id: "c1", name: "read", arguments: '{"path":"a"}' },
          { id: "c2", name: "read", arguments: '{"path":"b"}' },
        ],
      },
      {
        role: "assistant",
        content: "继续并发读取",
        toolCalls: [
          { id: "c3", name: "read", arguments: '{"path":"a"}' },
          { id: "c4", name: "read", arguments: '{"path":"b"}' },
        ],
      },
      { role: "assistant", content: "完成" },
    ]);
    const registry = new (class extends MockRegistry {
      override isReadOnlyTool(): boolean {
        return true;
      }
      getAccesses(call: ToolCall): ToolAccesses {
        // read 不同路径 → 不冲突 → 并发,保持原测试意图
        const { path } = JSON.parse(call.arguments) as { path?: string };
        return ToolAccesses.readFile(resolve("/tmp", path ?? ""));
      }
      override async execute(call: ToolCall): Promise<ToolResult> {
        this.executed.push(call);
        return { toolCallId: call.id, output: `same-${call.arguments}`, isError: false };
      }
    })();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      guardrailOptions: { noProgressWarnAt: 2, noProgressBlockAt: 5 },
    });

    const session = newSession("读两份文件");
    await engine.run(session);

    const reminders = session.getHistory().filter((m) => m.content.includes("SYSTEM REMINDER"));
    expect(reminders).toHaveLength(2);
    expect(reminders.map((m) => m.content).join("\n")).toContain("无进展");
  });
});
