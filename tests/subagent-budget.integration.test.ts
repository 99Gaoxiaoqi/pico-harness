import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message } from "../src/schema/message.js";
import type { Registry } from "../src/tools/registry.js";

describe("子代理共享执行预算", () => {
  it("并发子代理结算 Token 后阻止新的 Provider 调用", async () => {
    const provider = new ConcurrentProvider(() => ({
      role: "assistant",
      content: "已完成。".repeat(80),
      usage: { promptTokens: 4, completionTokens: 4 },
    }));
    const registry = emptyRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: tmpdir(),
      budgetConfig: { maxTokens: 10 },
    });

    const [first, second] = await Promise.all([
      engine.runSub("first", registry),
      engine.runSub("second", registry),
    ]);

    expect(provider.calls).toBe(2);
    expect([first.status, second.status]).toContain("partial");

    const blocked = await engine.runSub("blocked", registry);
    expect(blocked.status).toBe("partial");
    expect(blocked.summary).toContain("Token 预算 10");
    expect(provider.calls).toBe(2);
  });

  it("并发响应以 Session 成本高水位结算，不重复计费", async () => {
    const session = new Session("subagent-cost-budget", tmpdir(), { persistence: false });
    const provider = new ConcurrentProvider(() => {
      session.recordUsage(0, 0, 0.1);
      return {
        role: "assistant",
        content: "成本核算完成。".repeat(50),
      };
    });
    const registry = emptyRegistry();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: tmpdir(),
      usageSession: session,
      budgetConfig: { maxCostCNY: 0.25 },
    });

    try {
      const [first, second] = await Promise.all([
        engine.runSub("first", registry),
        engine.runSub("second", registry),
      ]);

      expect(first.status).toBe("completed");
      expect(second.status).toBe("completed");
      expect(provider.calls).toBe(2);

      const exhausted = await engine.runSub("third", registry);
      expect(exhausted.status).toBe("partial");
      expect(exhausted.summary).toContain("成本预算 ¥0.25");
      expect(provider.calls).toBe(3);

      const blocked = await engine.runSub("blocked", registry);
      expect(blocked.status).toBe("partial");
      expect(provider.calls).toBe(3);
    } finally {
      await session.close();
    }
  });
});

class ConcurrentProvider implements LLMProvider {
  calls = 0;

  constructor(private readonly response: () => Message) {}

  async generate(): Promise<Message> {
    this.calls++;
    // 让同一事件循环中启动的兄弟子代理都进入 Provider，再结算累计成本。
    await Promise.resolve();
    return this.response();
  }
}

function emptyRegistry(): Registry {
  return {
    register() {},
    use() {},
    getAvailableTools() {
      return [];
    },
    async execute(call) {
      return { toolCallId: call.id, output: "unused", isError: true };
    },
    isReadOnlyTool() {
      return true;
    },
  };
}
