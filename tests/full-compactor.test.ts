// FullCompactor 模型摘要压缩器的单元测试(对标 kimi-code FullCompaction)。
//
// 验证五条核心契约:
// 1. mock provider 返回摘要 → session.history 被替换(前 N 条变成 1 条 summary)
// 2. retainLastN 保留的尾部消息不动
// 3. 摘要调用失败(provider 抛错/返回空)→ 返回 false,不崩
// 4. 迭代摘要:第二次压缩时 previousSummary 被传入摘要指令(增量更新)
// 5. 持久化顺序:applyCompaction 后重启 recover,history 与内存一致
//   (truncate → summary → retained tail 顺序落盘,复用 pendingWrites 机制)

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FullCompactor } from "../src/context/full-compactor.js";
import { AgentEngine } from "../src/engine/loop.js";
import { Compactor } from "../src/context/compactor.js";
import { ContextOverflowError } from "../src/provider/errors.js";
import type { BaseTool, Registry } from "../src/tools/registry.js";
import type { ToolCall, ToolResult } from "../src/schema/message.js";
import { Session, SessionManager } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolDefinition } from "../src/schema/message.js";

/**
 * 可编程 Mock Provider:可配置返回摘要内容,或抛错,或返回空。
 * 记录每次 generate 入参,用于断言"迭代摘要传入 previousSummary"。
 */
class SummaryMockProvider implements LLMProvider {
  readonly calls: { messages: Message[]; toolsCount: number }[] = [];
  private i = 0;
  constructor(
    private readonly behaviors: Array<
      { kind: "ok"; content: string } | { kind: "throw"; error: Error } | { kind: "empty" }
    >,
  ) {}
  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.calls.push({
      messages: messages.map((m) => ({ ...m })),
      toolsCount: availableTools.length,
    });
    const beh = this.behaviors[this.i];
    if (!beh) throw new Error("SummaryMockProvider: behavior 序列耗尽");
    this.i++;
    if (beh.kind === "throw") throw beh.error;
    if (beh.kind === "empty") return { role: "assistant", content: "" };
    return { role: "assistant", content: beh.content };
  }
}

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}
function toolResultMsg(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}
function assistantWithToolCall(id: string, name: string, args: string): Message {
  return { role: "assistant", content: "", toolCalls: [{ id, name, arguments: args }] };
}

describe("FullCompactor 模型摘要压缩", () => {
  it("mock provider 返回摘要 → session.history 前 N 条被替换为 1 条 summary", async () => {
    const provider = new SummaryMockProvider([{ kind: "ok", content: "## 历史任务快照\n完成重构" }]);
    const fc = new FullCompactor({ provider });
    const session = new Session("fc-1", "/tmp");
    // 5 条历史,保留尾部 2 条 → 压缩前 3 条
    session.append(userMsg("task1"), assistantMsg("step1"), userMsg("task2"), assistantMsg("step2"), userMsg("recent"));
    expect(session.length).toBe(5);

    const ok = await fc.compact(session, 2);
    expect(ok).toBe(true);
    // 压缩后:1 条 summary + 2 条尾部 = 3 条
    expect(session.length).toBe(3);
    const history = session.getHistory();
    // 第 1 条是 summary(role=assistant,含 REFERENCE-ONLY 标记 + 摘要正文)
    expect(history[0]!.role).toBe("assistant");
    expect(history[0]!.content).toContain("[上下文压缩 — 仅供参考]");
    expect(history[0]!.content).toContain("## 历史任务快照");
    expect(history[0]!.content).toContain("--- 历史摘要结束");
    expect(history[0]!.toolCalls).toBeUndefined();
    // 无 toolCallId(不是工具结果)
    expect(history[0]!.toolCallId).toBeUndefined();
  });

  it("retainLastN 保留的尾部消息不动(内容与顺序不变)", async () => {
    const provider = new SummaryMockProvider([{ kind: "ok", content: "摘要正文" }]);
    const fc = new FullCompactor({ provider });
    const session = new Session("fc-2", "/tmp");
    const tail1 = assistantMsg("step2");
    const tail2 = userMsg("recent");
    session.append(userMsg("task1"), assistantMsg("step1"), userMsg("task2"), tail1, tail2);

    await fc.compact(session, 2);
    const history = session.getHistory();
    // 尾部 2 条内容不变
    expect(history[1]!.content).toBe(tail1.content);
    expect(history[1]!.role).toBe("assistant");
    expect(history[2]!.content).toBe(tail2.content);
    expect(history[2]!.role).toBe("user");
  });

  it("摘要调用失败(provider 抛错)→ 返回 false,session.history 不变", async () => {
    const provider = new SummaryMockProvider([
      { kind: "throw", error: new Error("model unavailable") },
      { kind: "throw", error: new Error("model unavailable") },
      { kind: "throw", error: new Error("model unavailable") },
    ]);
    const fc = new FullCompactor({ provider, maxAttempts: 3 });
    const session = new Session("fc-3", "/tmp");
    session.append(userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d"), userMsg("e"));
    const beforeLen = session.length;

    const ok = await fc.compact(session, 2);
    expect(ok).toBe(false);
    // 失败时 history 不被修改
    expect(session.length).toBe(beforeLen);
    expect(session.getHistory()[0]!.content).toBe("a");
    // 重试 3 次
    expect(provider.calls).toHaveLength(3);
  });

  it("摘要返回空字符串 → 返回 false(视为失败)", async () => {
    const provider = new SummaryMockProvider([{ kind: "empty" }]);
    const fc = new FullCompactor({ provider, maxAttempts: 1 });
    const session = new Session("fc-4", "/tmp");
    session.append(userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d"), userMsg("e"));

    const ok = await fc.compact(session, 2);
    expect(ok).toBe(false);
    expect(session.length).toBe(5);
  });

  it("迭代摘要:第二次压缩时 previousSummary 被传入摘要指令", async () => {
    const provider = new SummaryMockProvider([
      { kind: "ok", content: "第一次摘要" },
      { kind: "ok", content: "第二次摘要(增量)" },
    ]);
    const fc = new FullCompactor({ provider });
    const session = new Session("fc-5", "/tmp");
    // 第一批历史
    session.append(userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d"), userMsg("e1"));

    // 第一次压缩
    const ok1 = await fc.compact(session, 2);
    expect(ok1).toBe(true);
    // 第一次指令不应包含 previousSummary 块
    const firstInstr = provider.calls[0]!.messages.find((m) => m.role === "user")!.content;
    expect(firstInstr).not.toContain("上一次的摘要");

    // 追加新历史后再压缩第二次
    session.append(assistantMsg("f"), userMsg("e2"), assistantMsg("g"));
    const ok2 = await fc.compact(session, 2);
    expect(ok2).toBe(true);
    // 第二次指令应包含 previousSummary(增量更新)
    const secondInstr = provider.calls[1]!.messages.find((m) => m.role === "user")!.content;
    expect(secondInstr).toContain("上一次的摘要");
    expect(secondInstr).toContain("第一次摘要");
  });

  it("历史不足以压缩(前缀为空)→ 返回 false", async () => {
    const provider = new SummaryMockProvider([{ kind: "ok", content: "x" }]);
    const fc = new FullCompactor({ provider });
    const session = new Session("fc-6", "/tmp");
    session.append(userMsg("a"), assistantMsg("b"));
    // retainLastN = 2,前缀 = 0
    const ok = await fc.compact(session, 2);
    expect(ok).toBe(false);
    // provider 不应被调用
    expect(provider.calls).toHaveLength(0);
  });

  it("边界矫正:保留区首条是孤儿 ToolResult 时,并入压缩前缀避免 API 400", async () => {
    const provider = new SummaryMockProvider([{ kind: "ok", content: "摘要" }]);
    const fc = new FullCompactor({ provider });
    const session = new Session("fc-7", "/tmp");
    // 历史含 ToolCall/ToolResult 对
    session.append(
      userMsg("task"),
      assistantWithToolCall("call-1", "read_file", '{"path":"a"}'),
      toolResultMsg("call-1", "content of a"),
      assistantMsg("done"),
    );
    // retainLastN=1: naive 前缀=3,保留尾部=[toolResultMsg("call-1")] —— 孤儿!
    // FullCompactor 应把孤儿 ToolResult 并入前缀(前缀=4),保留尾部=[assistantMsg("done")]
    const ok = await fc.compact(session, 1);
    expect(ok).toBe(true);
    const history = session.getHistory();
    // 压缩后:summary + assistantMsg("done") = 2 条
    expect(history).toHaveLength(2);
    expect(history[0]!.role).toBe("assistant"); // summary
    expect(history[1]!.content).toBe("done");
    // 不应出现孤儿 ToolResult(其 toolCallId 指向的 ToolCall 已被压缩)
    const orphan = history.find((m) => m.role === "user" && m.toolCallId !== undefined);
    expect(orphan).toBeUndefined();
  });
});

describe("FullCompactor 持久化(applyCompaction 落盘 + recover 重放)", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-fc-"));
  });

  afterEach(async () => {
    await safeRm(workDir);
  });

  /** 等待 fire-and-forget 落盘走完(appendFile 经 libuv 线程池) */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 60));
  }

  /** 跨平台安全删除:Windows 上 SQLite 句柄未释放时 rm 触发 EBUSY,退避重试兜底 */
  async function safeRm(path: string): Promise<void> {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(path, { recursive: true, force: true });
        return;
      } catch (err) {
        if (String(err).includes("EBUSY") || String(err).includes("EPERM") || String(err).includes("ENOTEMPTY")) {
          await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          continue;
        }
        throw err;
      }
    }
  }

  it("applyCompaction 后重启 recover,history 与内存一致(truncate→summary→retained 顺序)", async () => {
    const provider = new SummaryMockProvider([{ kind: "ok", content: "持久化摘要" }]);
    const fc = new FullCompactor({ provider });
    const ON = { persistence: true } as const;

    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("fc-persist", workDir, ON);
    s1.append(userMsg("m0"), assistantMsg("m1"), userMsg("m2"), assistantMsg("m3"), userMsg("m4"));
    await flush();
    expect(s1.length).toBe(5);

    // 压缩:保留尾部 2 条
    const ok = await fc.compact(s1, 2);
    expect(ok).toBe(true);
    await flush();
    // 内存:summary + m3 + m4
    expect(s1.length).toBe(3);
    const mem = s1.getHistory();
    expect(mem[0]!.role).toBe("assistant");
    expect(mem[0]!.content).toContain("持久化摘要");
    expect(mem[1]!.content).toBe("m3");
    expect(mem[2]!.content).toBe("m4");

    // 重启恢复
    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("fc-persist", workDir, ON);
    // 重放后应与内存一致:summary + m3 + m4
    expect(s2.length).toBe(3);
    const rec = s2.getHistory();
    expect(rec[0]!.role).toBe("assistant");
    expect(rec[0]!.content).toContain("持久化摘要");
    expect(rec[1]!.content).toBe("m3");
    expect(rec[2]!.content).toBe("m4");
  });

  it("压缩后再 append,重启 recover 历史续接正确(seq 不回退)", async () => {
    const provider = new SummaryMockProvider([{ kind: "ok", content: "摘要2" }]);
    const fc = new FullCompactor({ provider });
    const ON = { persistence: true } as const;

    const mgr1 = new SessionManager();
    const s1 = await mgr1.getOrCreate("fc-persist2", workDir, ON);
    s1.append(userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d"));
    await flush();

    // retainLastN=1:压缩前 3 条,保留尾部 [d]
    await fc.compact(s1, 1);
    await flush();
    // 压缩后 append 新消息
    s1.append(userMsg("after-compact"));
    await flush();

    const mgr2 = new SessionManager();
    const s2 = await mgr2.getOrCreate("fc-persist2", workDir, ON);
    // 期望:summary + d + after-compact
    expect(s2.length).toBe(3);
    const rec = s2.getHistory();
    expect(rec[0]!.content).toContain("摘要2");
    expect(rec[1]!.content).toBe("d");
    expect(rec[2]!.content).toBe("after-compact");
  });
});

describe("FullCompactor 接入 generateWithOverflowRetry(loop 端到端)", () => {
  /** 空工具 Registry mock:Action 阶段需要非空工具列表,但不实际执行工具 */
  class EmptyRegistry implements Registry {
    register(_tool: BaseTool): void {}
    use(): void {}
    getAvailableTools() {
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

  /** 引擎主 provider:按 Behavior 序列响应,记录调用入参字符数 */
  class EngineMockProvider implements LLMProvider {
    readonly calls = 0;
    private i = 0;
    constructor(
      private readonly behaviors: Array<
        { kind: "throw"; error: Error } | { kind: "ok"; content: string }
      >,
    ) {}
    isRetryableError(): boolean {
      return false;
    }
    async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
      void availableTools;
      const beh = this.behaviors[this.i];
      if (!beh) throw new Error("EngineMockProvider: behavior 序列耗尽");
      this.i++;
      void messages;
      if (beh.kind === "throw") throw beh.error;
      return { role: "assistant", content: beh.content };
    }
  }

  it("字符级降级用尽后触发 FullCompactor,压缩成功后重试成功", async () => {
    // 引擎主 provider:4 次 overflow(触发字符级降级用尽)→ 第 5 次(压缩后)成功
    const engineProvider = new EngineMockProvider([
      { kind: "throw", error: new ContextOverflowError("overflow #1") },
      { kind: "throw", error: new ContextOverflowError("overflow #2") },
      { kind: "throw", error: new ContextOverflowError("overflow #3") },
      { kind: "throw", error: new ContextOverflowError("overflow #4") },
      { kind: "ok", content: "压缩后重试成功" },
    ]);
    // 摘要 provider:返回一段摘要
    const summaryProvider = new SummaryMockProvider([{ kind: "ok", content: "## 历史任务快照\n完成任务" }]);
    const fullCompactor = new FullCompactor({ provider: summaryProvider });
    // 大预算 Compactor:不实际触发字符级截断(overflow 由 mock 模拟),保证 context 完整传到 provider
    const compactor = new Compactor({ maxChars: 100000, retainLastMsgs: 20 });
    const engine = new AgentEngine({
      provider: engineProvider,
      registry: new EmptyRegistry(),
      workDir: "/tmp",
      compactor,
      fullCompactor,
      workingMemoryLimit: 20,
    });

    const session = new Session("fc-loop-1", "/tmp");
    // 8 条历史,足够 FullCompactor 压缩前缀(retainLastN≈3,compactedCount=5)
    for (let i = 0; i < 8; i++) {
      session.append({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}-` + "X".repeat(50) });
    }

    const returned = await engine.run(session);
    // 最终返回压缩后重试的成功消息
    expect(returned[returned.length - 1]!.content).toBe("压缩后重试成功");
    // 摘要 provider 被调 1 次(触发了一次模型摘要压缩)
    expect(summaryProvider.calls).toHaveLength(1);
    // 压缩后 session.history 前 5 条被替换为 1 条 summary
    const history = session.getHistory();
    expect(history[0]!.role).toBe("assistant");
    expect(history[0]!.content).toContain("## 历史任务快照");
  });

  it("FullCompactor 压缩也失败时,降级抛出 ContextOverflowError", async () => {
    // 引擎主 provider:4 次 overflow
    const engineProvider = new EngineMockProvider([
      { kind: "throw", error: new ContextOverflowError("overflow #1") },
      { kind: "throw", error: new ContextOverflowError("overflow #2") },
      { kind: "throw", error: new ContextOverflowError("overflow #3") },
      { kind: "throw", error: new ContextOverflowError("overflow #4") },
    ]);
    // 摘要 provider:始终抛错(压缩失败)
    const summaryProvider = new SummaryMockProvider([
      { kind: "throw", error: new Error("summary model unavailable") },
      { kind: "throw", error: new Error("summary model unavailable") },
      { kind: "throw", error: new Error("summary model unavailable") },
    ]);
    const fullCompactor = new FullCompactor({ provider: summaryProvider, maxAttempts: 3 });
    const compactor = new Compactor({ maxChars: 100000, retainLastMsgs: 20 });
    const engine = new AgentEngine({
      provider: engineProvider,
      registry: new EmptyRegistry(),
      workDir: "/tmp",
      compactor,
      fullCompactor,
      workingMemoryLimit: 20,
    });

    const session = new Session("fc-loop-2", "/tmp");
    for (let i = 0; i < 8; i++) {
      session.append({ role: i % 2 === 0 ? "user" : "assistant", content: `msg-${i}-` + "X".repeat(50) });
    }

    // 压缩失败 → 抛 ContextOverflowError(generateWithOverflowRetry 兜底失败)
    await expect(engine.run(session)).rejects.toBeInstanceOf(ContextOverflowError);
    // 摘要 provider 被调 3 次(一次压缩的重试耗尽)
    expect(summaryProvider.calls).toHaveLength(3);
  });
});
