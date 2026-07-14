// 响应式溢出压缩+重试的单测(借鉴 kimi-code handleOverflowError 闭环语义)。
//
// 验证四条核心契约:
// 1. 首次溢出、第二次成功 → provider.generate 被调 2 次,且第 2 次入参字符数 < 第 1 次
// 2. 连续 3 次降级(共 4 次调用)仍溢出 → 抛出 ContextOverflowError,不无限循环
// 3. 非 overflow 错误(如 LLMStatusError 400)不触发响应式压缩,直接抛
// 4. Session 全量历史未被污染:压缩只作用于临时 context,Session 里的原始大消息完好无损
//
// 用 mock provider(可编程抛错/成功) + 真实 Compactor(设小 maxChars 触发压缩) + 真实 Session。

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import { Compactor } from "../src/context/compactor.js";
import { ContextOverflowError, LLMStatusError } from "../src/provider/errors.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { BaseTool, Registry } from "../src/tools/registry.js";

/** 单次 generate 行为:抛指定错误,或返回成功消息 */
type Behavior =
  | { kind: "throw"; error: Error }
  | { kind: "ok"; content: string; toolCalls?: ToolCall[] };

/**
 * 可编程 Mock Provider:按预设的 Behavior 序列依次响应,并记录每次调用的入参。
 * 记录入参用于断言"第 2 次字符数 < 第 1 次"与"Session 历史未被压缩污染"。
 */
class OverflowMockProvider implements LLMProvider {
  readonly calls: { messages: Message[]; toolsCount: number }[] = [];
  private i = 0;
  constructor(private readonly behaviors: Behavior[]) {}
  /**
   * 声明所有错误均不可重试:让普通重试层(generateWithRetry)对本 mock 透明,
   * 使本测试专注验证"响应式溢出压缩"行为,不被普通重试(429/5xx)叠加干扰。
   * 普通重试由 tests/provider-retry.test.ts 独立覆盖。
   */
  isRetryableError(): boolean {
    return false;
  }
  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    // 深拷贝入参,避免后续 push 改动影响记录
    this.calls.push({
      messages: messages.map((m) => ({
        ...m,
        ...(m.toolCalls ? { toolCalls: [...m.toolCalls] } : {}),
      })),
      toolsCount: availableTools.length,
    });
    const beh = this.behaviors[this.i];
    if (!beh) throw new Error("OverflowMockProvider: behavior 序列耗尽");
    this.i++;
    if (beh.kind === "throw") throw beh.error;
    return {
      role: "assistant",
      content: beh.content,
      ...(beh.toolCalls ? { toolCalls: beh.toolCalls } : {}),
    };
  }
}

/** 空工具的 Registry mock:Action 阶段需要非空工具列表,但不实际执行工具 */
class EmptyRegistry implements Registry {
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "read",
        description: "read a file",
        inputSchema: { type: "object", properties: { path: { type: "string" } } },
      },
    ];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    return { toolCallId: call.id, output: "stub", isError: false };
  }
  isReadOnlyTool(_name: string): boolean {
    return true;
  }
}

/** 计算消息数组的总字符长度(对齐 loop.ts 内部的 estimateTraceLength) */
function totalChars(messages: Message[]): number {
  let len = 0;
  for (const m of messages) {
    len += m.content.length;
    if (m.toolCalls) {
      for (const tc of m.toolCalls) len += tc.name.length + tc.arguments.length;
    }
  }
  return len;
}

/** 构造一段指定长度的重复文本(用于撑大单条消息触发压缩) */
function bigText(n: number): string {
  return "A".repeat(n);
}

/** 构造带初始用户消息 + 小预算 Compactor 的引擎 */
function newEngine(provider: LLMProvider, maxChars: number): AgentEngine {
  const compactor = new Compactor({ maxChars, retainLastMsgs: 20 });
  return new AgentEngine({
    provider,
    registry: new EmptyRegistry(),
    workDir: "/tmp",
    compactor,
  });
}

describe("主 Agent 溢出兜底 (generateWithOverflowRetry)", () => {
  it("低于水位时 Provider 收到超过 20 条的完整历史", async () => {
    const provider = new OverflowMockProvider([{ kind: "ok", content: "完成" }]);
    const engine = newEngine(provider, 100_000);
    const session = new Session("full-model-context", "/tmp");
    for (let index = 0; index < 25; index++) {
      session.append({
        role: index % 2 === 0 ? "user" : "assistant",
        content: `history-${index}`,
      });
    }

    await engine.run(session);

    expect(provider.calls[0]!.messages).toHaveLength(26);
    expect(provider.calls[0]!.messages.slice(1).map((message) => message.content)).toEqual(
      Array.from({ length: 25 }, (_, index) => `history-${index}`),
    );
  });

  it("单轮 50 个 tool calls 与 results 全部进入 Provider", async () => {
    const provider = new OverflowMockProvider([{ kind: "ok", content: "完成" }]);
    const engine = newEngine(provider, 1_000_000);
    const session = new Session("parallel-tool-context", "/tmp");
    const toolCalls = Array.from({ length: 50 }, (_, index) => ({
      id: `call-${index}`,
      name: "read",
      arguments: JSON.stringify({ index }),
    }));
    session.append({ role: "assistant", content: "", toolCalls });
    for (const call of toolCalls) {
      session.append({ role: "user", toolCallId: call.id, content: `result-${call.id}` });
    }

    await engine.run(session);

    const sent = provider.calls[0]!.messages;
    expect(sent).toHaveLength(52);
    expect(sent[1]!.toolCalls).toHaveLength(50);
    expect(sent.slice(2).map((message) => message.toolCallId)).toEqual(
      toolCalls.map((call) => call.id),
    );
  });

  it("无 FullCompactor 时硬重置只保留当前请求，不再按消息条数缩窗", async () => {
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new ContextOverflowError("context length exceeded") },
      { kind: "ok", content: "完成" },
    ]);
    const engine = newEngine(provider, 500);

    const session = new Session("overflow-retry-1", "/tmp");
    // 一条 2000 字符的用户消息,足以在 500 预算下触发压缩,且降级到 300 预算后更小
    session.append({ role: "user", content: bigText(2000) });

    const returned = await engine.run(session);

    // generate 被调 2 次(attempt 0 溢出 + attempt 1 成功)
    expect(provider.calls).toHaveLength(2);
    // 当前请求本身不可丢，硬重置后不会再按 14/10/6 条缩窗。
    const chars0 = totalChars(provider.calls[0]!.messages);
    const chars1 = totalChars(provider.calls[1]!.messages);
    expect(chars1).toBe(chars0);
    // 最终返回成功消息
    expect(returned[returned.length - 1]!.content).toBe("完成");
  });

  it("硬重置后仍溢出只有 2 次 provider 调用，不再进行 4 档降级", async () => {
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new ContextOverflowError("overflow #1") },
      { kind: "throw", error: new ContextOverflowError("overflow #2") },
      { kind: "throw", error: new ContextOverflowError("overflow #3") },
      { kind: "throw", error: new ContextOverflowError("overflow #4") },
    ]);
    // maxChars=800:确保最小降级预算 0.25*800=200 仍大于系统提示词(~150),
    // 避免 compactToBudget 抛 ContextCompactionError(系统提示词不可压缩)
    const engine = newEngine(provider, 800);

    const session = new Session("overflow-retry-2", "/tmp");
    session.append({ role: "user", content: bigText(2000) });

    await expect(engine.run(session)).rejects.toBeInstanceOf(ContextOverflowError);
    expect(provider.calls).toHaveLength(2);
  });

  it("非 overflow 错误(LLMStatusError 400)不触发响应式压缩,直接抛", async () => {
    // LLMStatusError 不是 ContextOverflowError 子类,应直接抛、不重试
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new LLMStatusError(400, "bad request: invalid model") },
    ]);
    const engine = newEngine(provider, 500);

    const session = new Session("overflow-retry-3", "/tmp");
    session.append({ role: "user", content: bigText(2000) });

    await expect(engine.run(session)).rejects.toBeInstanceOf(LLMStatusError);
    // 只调用 1 次,未触发任何降级重试
    expect(provider.calls).toHaveLength(1);
  });

  it("Session 全量历史未被污染:压缩只作用于临时 context,原始大消息完好无损", async () => {
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new ContextOverflowError("overflow first") },
      { kind: "ok", content: "完成" },
    ]);
    const engine = newEngine(provider, 500);

    const session = new Session("overflow-retry-4", "/tmp");
    const big = bigText(2000);
    session.append({ role: "user", content: big });

    await engine.run(session);

    // Session 历史应包含:原始 2000 字符用户消息 + 助手"完成"消息
    const history = session.getHistory();
    expect(history.length).toBe(2);
    // 用户消息在 Session 中必须是完整的 2000 字符(未被压缩截断)
    expect(history[0]!.role).toBe("user");
    expect(history[0]!.content.length).toBe(2000);
    expect(history[0]!.content).toBe(big);
    // 助手响应已追加
    expect(history[1]!.role).toBe("assistant");
    expect(history[1]!.content).toBe("完成");

    // 反证:发给 provider 的临时 context 中,用户消息已被压缩(< 2000 字符)
    // 这证明压缩只作用于临时 context,而非 Session
    const firstCallUserMsg = provider.calls[0]!.messages.find((m) => m.role === "user");
    expect(firstCallUserMsg).toBeDefined();
    expect(firstCallUserMsg!.content.length).toBeLessThan(2000);
  });
});

describe("runSub 简化版响应式溢出重试", () => {
  it("首次溢出、第二次成功 → 子代理 generate 被调 2 次,第 2 次入参字符数 < 第 1 次", async () => {
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new ContextOverflowError("sub overflow") },
      { kind: "ok", content: "探路者汇报:已找到关键文件,结论是 X。" + bigText(220) },
    ]);
    // maxChars=1200:子代理系统提示词约 233 字符,最小降级预算 0.25*1200=300 仍可容纳
    const compactor = new Compactor({ maxChars: 1200, retainLastMsgs: 20 });
    const engine = new AgentEngine({
      provider,
      registry: new EmptyRegistry(),
      workDir: "/tmp",
      compactor,
    });

    // 子代理任务 prompt 撑大,确保首次压缩后仍可能溢出(由 mock 模拟溢出)
    const bigTask = "请探索 " + bigText(600);
    const result = await engine.runSub(bigTask, new EmptyRegistry());

    expect(provider.calls).toHaveLength(2);
    const chars0 = totalChars(provider.calls[0]!.messages);
    const chars1 = totalChars(provider.calls[1]!.messages);
    expect(chars1).toBeLessThan(chars0);
    expect(result.summary.length).toBeGreaterThan(0);
  });

  it("连续 3 次降级仍溢出 → 抛出 ContextOverflowError", async () => {
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new ContextOverflowError("sub #1") },
      { kind: "throw", error: new ContextOverflowError("sub #2") },
      { kind: "throw", error: new ContextOverflowError("sub #3") },
      { kind: "throw", error: new ContextOverflowError("sub #4") },
    ]);
    // maxChars=1200:子代理系统提示词约 233 字符,最小降级预算 0.25*1200=300 仍可容纳
    const compactor = new Compactor({ maxChars: 1200, retainLastMsgs: 20 });
    const engine = new AgentEngine({
      provider,
      registry: new EmptyRegistry(),
      workDir: "/tmp",
      compactor,
    });

    await expect(engine.runSub("任务 " + bigText(600), new EmptyRegistry())).rejects.toBeInstanceOf(
      ContextOverflowError,
    );
    expect(provider.calls).toHaveLength(4);
  });

  it("非 overflow 错误直接抛,不触发降级", async () => {
    // LLMStatusError(400):不在可重试白名单 {429,500,502,503,504},
    // generateWithRetry 不重试;且非 ContextOverflowError,不触发响应式压缩 → 直接抛
    const provider = new OverflowMockProvider([
      { kind: "throw", error: new LLMStatusError(400, "bad request: invalid model") },
    ]);
    // maxChars=1200:子代理系统提示词约 233 字符,最小降级预算 0.25*1200=300 仍可容纳
    const compactor = new Compactor({ maxChars: 1200, retainLastMsgs: 20 });
    const engine = new AgentEngine({
      provider,
      registry: new EmptyRegistry(),
      workDir: "/tmp",
      compactor,
    });

    await expect(engine.runSub("任务", new EmptyRegistry())).rejects.toBeInstanceOf(LLMStatusError);
    expect(provider.calls).toHaveLength(1);
  });
});
