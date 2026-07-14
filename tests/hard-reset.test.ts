// 硬重置兜底机制测试。
// 验证当 compactToBudget 抛 ContextCompactionError(连压缩都救不回来)时,
// loop.ts 清空历史只保留本轮用户输入,让模型重新规划。

import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import { Compactor } from "../src/context/compactor.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { BaseTool, Registry } from "../src/tools/registry.js";

class MockRegistry implements Registry {
  readonly executed: ToolCall[] = [];
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
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
    return { toolCallId: call.id, output: "ok", isError: false };
  }
  isReadOnlyTool(_name: string): boolean {
    return false;
  }
}

describe("硬重置兜底", () => {
  it("压缩彻底失败时清空历史只保留本轮用户输入,模型重新规划", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        callCount++;
        if (callCount === 1) {
          return {
            role: "assistant",
            content: "调工具读大文件",
            toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
          };
        }
        return { role: "assistant", content: "已重新规划完成任务" };
      },
    };

    const registry = new MockRegistry();
    // maxChars=600 能容纳 [system, 本轮 user](约 200 字符),
    // 但装不下含 8KB toolCalls.arguments 的预填历史(toolCalls 不可压缩)
    const compactor = new Compactor({ maxChars: 600, retainLastMsgs: 20 });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      compactor,
    });

    // 预填:旧 user + 带 8KB toolCalls 的 assistant + 对应 ToolResult
    // toolCalls.arguments 是 strongerCompact 唯一不压缩的字段,必然让 compactToBudget 爆掉
    const session = new Session("hard-reset", "/tmp");
    session.append({ role: "user", content: "旧任务" });
    session.append({
      role: "assistant",
      content: "旧回答",
      toolCalls: [{ id: "old1", name: "bash", arguments: "{cmd:'" + "x".repeat(8000) + "'}" }],
    });
    session.append({
      role: "user",
      content: "x".repeat(100),
      toolCallId: "old1",
    });
    session.append({ role: "user", content: "请帮我重构 foo.ts" });

    const returned = await engine.run(session);

    // 不抛错,正常返回
    expect(returned.length).toBeGreaterThan(0);
    // session 历史被截断到本轮用户输入起点
    const history = session.getHistory();
    expect(history[0]!.content).toBe("请帮我重构 foo.ts");
    // 模型在硬重置后至少被重新调用一次
    expect(callCount).toBeGreaterThanOrEqual(2);
  });

  it("本轮用户输入本身超大时二次失败仍抛错", async () => {
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        return { role: "assistant", content: "ok" };
      },
    };
    const registry = new MockRegistry();
    // maxChars 极小,连 [system, user] 都装不下
    const compactor = new Compactor({ maxChars: 50, retainLastMsgs: 1 });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      compactor,
    });

    const session = new Session("hard-reset-2", "/tmp");
    // 本轮用户输入本身就是 10KB,远超 maxChars
    session.append({ role: "user", content: "x".repeat(10000) });

    await expect(engine.run(session)).rejects.toThrow(/Context compaction failed/);
  });

  it("正常场景不触发硬重置", async () => {
    let callCount = 0;
    const provider: LLMProvider = {
      async generate(): Promise<Message> {
        callCount++;
        if (callCount === 1) {
          return {
            role: "assistant",
            content: "调工具",
            toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
          };
        }
        return { role: "assistant", content: "完成" };
      },
    };
    const registry = new MockRegistry();
    // 宽松预算,正常场景不应触发硬重置
    const compactor = new Compactor({ maxChars: 50000, retainLastMsgs: 6 });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir: "/tmp",
      compactor,
    });

    const session = new Session("normal", "/tmp");
    session.append({ role: "user", content: "正常任务" });
    const returned = await engine.run(session);

    expect(returned[returned.length - 1]!.content).toBe("完成");
    // 历史完整保留(本轮用户输入 + assistant + observation + 最终答案)
    const history = session.getHistory();
    expect(history[0]!.content).toBe("正常任务");
    expect(history.length).toBeGreaterThan(2);
  });

  it("Session.truncateTo 截断历史保留指定起点", () => {
    const session = new Session("trunc", "/tmp");
    session.append({ role: "user", content: "msg1" });
    session.append({ role: "assistant", content: "resp1" });
    session.append({ role: "user", content: "msg2" });
    expect(session.length).toBe(3);

    session.truncateTo(2);
    expect(session.length).toBe(1);
    expect(session.getHistory()[0]!.content).toBe("msg2");

    // 边界:fromIndex 超出范围清空
    session.truncateTo(100);
    expect(session.length).toBe(0);

    // 边界:fromIndex 负数从头开始
    session.append({ role: "user", content: "x" });
    session.truncateTo(-1);
    expect(session.length).toBe(1);
  });
});
