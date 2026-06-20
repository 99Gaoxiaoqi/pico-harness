// CostTracker 成本追踪装饰器的单元测试。
// 覆盖:Token 提取/计费/Session 累加/无 Usage 兜底/耗时记录/装饰器透明性。

import { describe, expect, it, vi } from "vitest";
import { CostTracker } from "../src/observability/tracker.js";
import { Session } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";

/** Mock Provider:返回预设的 Message(含 usage) */
class MockProvider implements LLMProvider {
  constructor(private readonly resp: Message) {}
  async generate(): Promise<Message> {
    return this.resp;
  }
}

/** Mock Provider:抛错 */
class ErrorProvider implements LLMProvider {
  async generate(): Promise<Message> {
    throw new Error("API 炸了");
  }
}

describe("CostTracker", () => {
  it("解析 usage 并计算成本,累加到 Session", async () => {
    const session = new Session("s1", "/tmp");
    const inner = new MockProvider({
      role: "assistant",
      content: "hello",
      usage: { promptTokens: 1000, completionTokens: 200 },
    });
    const tracker = new CostTracker(inner, "glm-5.2", session);

    const resp = await tracker.generate([], []);
    expect(resp.content).toBe("hello");
    expect(resp.usage).toEqual({ promptTokens: 1000, completionTokens: 200 });
    // glm-5.2: input 0.5, output 0.5 (美元/1M token)
    // cost = (1000*0.5 + 200*0.5) / 1e6 * 7.2 = 0.0006 * 7.2 = 0.00432
    expect(session.totalPromptTokens).toBe(1000);
    expect(session.totalCompletionTokens).toBe(200);
    expect(session.totalCostCNY).toBeCloseTo(0.00432, 5);
  });

  it("多次调用累加 Token 和成本", async () => {
    const session = new Session("s1", "/tmp");
    let callCount = 0;
    const inner = new (class implements LLMProvider {
      async generate(): Promise<Message> {
        callCount++;
        return {
          role: "assistant",
          content: "x",
          usage: { promptTokens: 500, completionTokens: 100 },
        };
      }
    })();
    const tracker = new CostTracker(inner, "glm-5.2", session);

    await tracker.generate([], []);
    await tracker.generate([], []);
    await tracker.generate([], []);

    expect(callCount).toBe(3);
    expect(session.totalPromptTokens).toBe(1500);
    expect(session.totalCompletionTokens).toBe(300);
  });

  it("无 usage 数据时不累加,只打印警告", async () => {
    const session = new Session("s1", "/tmp");
    const inner = new MockProvider({ role: "assistant", content: "no usage" });
    const tracker = new CostTracker(inner, "glm-5.2", session);

    const resp = await tracker.generate([], []);
    expect(resp.content).toBe("no usage");
    expect(resp.usage).toBeUndefined();
    expect(session.totalPromptTokens).toBe(0);
    expect(session.totalCostCNY).toBe(0);
  });

  it("底层 Provider 抛错时,错误透传,不计费", async () => {
    const session = new Session("s1", "/tmp");
    const tracker = new CostTracker(new ErrorProvider(), "glm-5.2", session);

    await expect(tracker.generate([], [])).rejects.toThrow("API 炸了");
    expect(session.totalPromptTokens).toBe(0);
    expect(session.totalCostCNY).toBe(0);
  });

  it("未知模型走兜底计价", async () => {
    const session = new Session("s1", "/tmp");
    const inner = new MockProvider({
      role: "assistant",
      content: "x",
      usage: { promptTokens: 1000, completionTokens: 1000 },
    });
    const tracker = new CostTracker(inner, "unknown-model", session);

    await tracker.generate([], []);
    // 兜底价 input 0.5, output 0.5
    // cost = (1000*0.5 + 1000*0.5) / 1e6 * 7.2 = 0.001 * 7.2 = 0.0072
    expect(session.totalCostCNY).toBeCloseTo(0.0072, 5);
  });

  it("无 Session 时不崩溃(仅打印日志)", async () => {
    const inner = new MockProvider({
      role: "assistant",
      content: "x",
      usage: { promptTokens: 100, completionTokens: 50 },
    });
    const tracker = new CostTracker(inner, "glm-5.2");

    const resp = await tracker.generate([], []);
    expect(resp.usage).toEqual({ promptTokens: 100, completionTokens: 50 });
    // 不抛错即通过
  });

  it("装饰器透明性:返回的 Message 与底层 Provider 完全一致", async () => {
    const original: Message = {
      role: "assistant",
      content: "工具调用",
      toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
      usage: { promptTokens: 10, completionTokens: 5 },
    };
    const tracker = new CostTracker(new MockProvider(original), "glm-5.2");

    const resp = await tracker.generate([], []);
    expect(resp.role).toBe(original.role);
    expect(resp.content).toBe(original.content);
    expect(resp.toolCalls).toEqual(original.toolCalls);
    expect(resp.usage).toEqual(original.usage);
  });

  it("记录耗时(耗时大于 0)", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const inner = new (class implements LLMProvider {
      async generate(): Promise<Message> {
        await new Promise((r) => setTimeout(r, 10));
        return { role: "assistant", content: "x", usage: { promptTokens: 1, completionTokens: 1 } };
      }
    })();
    const tracker = new CostTracker(inner, "glm-5.2");

    await tracker.generate([], []);
    // 日志里应含耗时数字
    const calls = logSpy.mock.calls.flat().join(" ");
    expect(calls).toMatch(/耗时: \d+ms/);
    logSpy.mockRestore();
  });
});
