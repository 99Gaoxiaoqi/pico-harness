// TuiReporter 单元测试:验证 engine 事件 → TuiEntry 状态映射正确。
// mock onUpdate 回调,断言 reporter 各方法调用后 entries 快照的形状。

import { describe, expect, it, vi } from "vitest";
import { TuiReporter } from "../../src/tui/tui-reporter.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

describe("TuiReporter", () => {
  /** 辅助:创建 reporter + 捕获 onUpdate 的最新快照 */
  function harness() {
    const snapshots: TuiEntry[][] = [];
    const onUpdate = vi.fn((entries: TuiEntry[]) => snapshots.push([...entries]));
    const reporter = new TuiReporter(onUpdate);
    return { reporter, snapshots, last: () => snapshots[snapshots.length - 1] };
  }

  it("pushUserMessage 追加 user 条目", () => {
    const { reporter, last } = harness();
    reporter.pushUserMessage("你好");
    expect(last()).toEqual([{ kind: "user", content: "你好" }]);
  });

  it("onThinking 追加 thinking 占位条目", () => {
    const { reporter, last } = harness();
    reporter.onThinking();
    expect(last()).toEqual([{ kind: "thinking" }]);
  });

  it("onToolCall → onToolResult 配对更新状态(running→success)", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("read_file", '{"path":"README.md"}');
    let entries = last()!;
    expect(entries[0]).toMatchObject({ kind: "tool", name: "read_file", status: "running" });

    reporter.onToolResult("read_file", "# pico-harness\n一个引擎", false);
    entries = last()!;
    expect(entries[0]).toMatchObject({ kind: "tool", name: "read_file", status: "success" });
    const entry = entries[0]!;
    expect(entry.kind === "tool" ? entry.summary : undefined).toContain("字节");
  });

  it("onToolResult 错误时 status=error", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("bash", '{"command":"bad"}');
    reporter.onToolResult("bash", "command not found", true);
    const entries = last()!;
    expect(entries[0]).toMatchObject({ kind: "tool", name: "bash", status: "error" });
  });

  it("被系统或 hook 拒绝的工具结果标记为 denied", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("bash", '{"command":"rm -rf /"}');
    reporter.onToolResult("bash", "执行被系统拦截。原因: dangerous command", true);
    const entries = last()!;
    expect(entries[0]).toMatchObject({ kind: "tool", name: "bash", status: "denied" });
  });

  it("onTextDelta 流式累积成 assistant 条目", () => {
    const { reporter, last } = harness();
    reporter.onTextDelta("你好");
    expect(last()!).toEqual([{ kind: "assistant", content: "你好" }]);

    reporter.onTextDelta(",世界");
    expect(last()!).toEqual([{ kind: "assistant", content: "你好,世界" }]);
  });

  it("onMessage 固化流式缓冲为权威版本", () => {
    const { reporter, last } = harness();
    reporter.onTextDelta("部分内容");
    reporter.onMessage("完整的最终回复");
    expect(last()!).toEqual([{ kind: "assistant", content: "完整的最终回复" }]);
  });

  it("onMessage 无流式时直接 push assistant 条目", () => {
    const { reporter, last } = harness();
    reporter.onMessage("非流式回复");
    expect(last()!).toEqual([{ kind: "assistant", content: "非流式回复" }]);
  });

  it("多轮对话:user → tool → assistant 顺序保留", () => {
    const { reporter, last } = harness();
    reporter.pushUserMessage("读文件");
    reporter.onToolCall("read_file", '{"path":"a.txt"}');
    reporter.onToolResult("read_file", "内容", false);
    reporter.onMessage("这是文件内容摘要");
    const entries = last()!;
    expect(entries.map((e) => e.kind)).toEqual(["user", "tool", "assistant"]);
  });

  it("多轮流式不串:第2轮 onTextDelta 不追加到第1轮 assistant", () => {
    const { reporter, last } = harness();
    reporter.onStart("/tmp", true);
    // 第1轮:流式 + 固化
    reporter.onTurnStart(1);
    reporter.onTextDelta("你好");
    reporter.onMessage("你好");
    // 工具调用(中间穿插)
    reporter.onToolCall("read_file", '{"path":"a"}');
    reporter.onToolResult("read_file", "内容", false);
    // 第2轮:onTurnStart 重置缓冲 → onTextDelta 应创建新 assistant,不追加到第1轮
    reporter.onTurnStart(2);
    reporter.onTextDelta("结果");
    reporter.onMessage("最终结果");

    const entries = last()!;
    // 应有2条独立的 assistant,内容不混
    const assistants = entries.filter((e) => e.kind === "assistant");
    expect(assistants).toHaveLength(2);
    expect(assistants[0]).toMatchObject({ content: "你好" });
    expect(assistants[1]).toMatchObject({ content: "最终结果" });
  });

  it("并发同名工具:onToolResult 更新最后一个 running 的", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("read_file", '{"path":"a"}');
    reporter.onToolCall("read_file", '{"path":"b"}');
    reporter.onToolResult("read_file", "内容a", false);
    const entries = last()!;
    // 第一个仍 running,第二个 success
    expect(entries[0]).toMatchObject({ status: "running" });
    expect(entries[1]).toMatchObject({ status: "success" });
  });

  it("onUpdate 每次回调传入新数组引用(触发 ink 重渲染)", () => {
    const { reporter, snapshots } = harness();
    reporter.pushUserMessage("a");
    reporter.pushUserMessage("b");
    // 两次快照应是不同数组引用
    expect(snapshots[0]).not.toBe(snapshots[1]);
  });

  it("工具结果摘要截断长输出", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("bash", "{}");
    const longResult = "x".repeat(500) + "\n" + "y".repeat(500);
    reporter.onToolResult("bash", longResult, false);
    const entry = last()![0]!;
    expect(entry.kind === "tool" && entry.summary!.length).toBeLessThan(200);
  });

  it("edit/write/bash 摘要保留路径或命令上下文", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("edit_file", '{"path":"src/a.ts"}');
    reporter.onToolResult("edit_file", "✅ 成功修改文件: src/a.ts\n\n@@\n-old\n+new", false);
    reporter.onToolCall("bash", '{"command":"npm test"}');
    reporter.onToolResult("bash", "tests passed", false);

    const entries = last()!;
    expect(entries[0]).toMatchObject({ kind: "tool", summary: expect.stringContaining("src/a.ts") });
    expect(entries[0]).toMatchObject({ kind: "tool", summary: expect.stringContaining("@@") });
    expect(entries[1]).toMatchObject({ kind: "tool", summary: expect.stringContaining("npm test") });
  });

  it("失败摘要保留可复制错误", () => {
    const { reporter, last } = harness();
    reporter.onToolCall("bash", '{"command":"bad"}');
    reporter.onToolResult("bash", "Error: command failed\nstack trace", true);
    const entry = last()![0]!;
    expect(entry.kind === "tool" ? entry.summary : "").toContain("可复制错误:");
    expect(entry.kind === "tool" ? entry.summary : "").toContain("Error: command failed");
  });

  it("delegate_task 批量结果展示 completed/total,且保留成功与失败摘要", () => {
    const { reporter, last } = harness();
    reporter.onToolCall(
      "delegate_task",
      JSON.stringify({
        tasks: [
          { agent_name: "reviewer", goal: "检查 TUI 子代理展示" },
          { agent_name: "tester", goal: "运行回归测试" },
        ],
      }),
    );
    reporter.onToolResult(
      "delegate_task",
      JSON.stringify({
        results: [
          {
            taskIndex: 0,
            status: "completed",
            summary: "reviewer confirmed the card keeps ordinary tool behavior",
            durationMs: 12,
          },
          {
            taskIndex: 1,
            status: "error",
            error: "TypeError: cannot read property status of undefined",
            durationMs: 9,
          },
        ],
        totalDurationMs: 21,
      }),
      false,
    );

    const entry = last()![0]!;
    expect(entry).toMatchObject({ kind: "tool", name: "delegate_task", status: "error" });
    expect(entry.kind === "tool" ? entry.summary : "").toContain("1/2 completed");
    expect(entry.kind === "tool" ? entry.summary : "").toContain("reviewer confirmed");
    expect(entry.kind === "tool" ? entry.summary : "").toContain("TypeError");
  });

  describe("getMode(SpinnerMode 追踪)", () => {
    it("初始为 idle", () => {
      const { reporter } = harness();
      expect(reporter.getMode()).toBe("idle");
    });

    it("onTurnStart/onStart → requesting(等首包)", () => {
      const { reporter } = harness();
      reporter.onTurnStart(1);
      expect(reporter.getMode()).toBe("requesting");
    });

    it("onThinking → thinking", () => {
      const { reporter } = harness();
      reporter.onThinking();
      expect(reporter.getMode()).toBe("thinking");
    });

    it("onToolCall → tool-use", () => {
      const { reporter } = harness();
      reporter.onToolCall("bash", "{}");
      expect(reporter.getMode()).toBe("tool-use");
    });

    it("onTextDelta → responding", () => {
      const { reporter } = harness();
      reporter.onTextDelta("hi");
      expect(reporter.getMode()).toBe("responding");
    });

    it("onFinish → idle", () => {
      const { reporter } = harness();
      reporter.onThinking();
      reporter.onFinish();
      expect(reporter.getMode()).toBe("idle");
    });
  });
});
