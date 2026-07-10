// shouldRenderStatically 单元测试:验证各场景下 entry 的 isStatic 判定。
// 覆盖:user/tool-done/tool-running/assistant-static/assistant-streaming/thinking。

import { describe, expect, it } from "vitest";
import React from "react";
import { renderToString } from "ink";
import { MessageList, shouldRenderStatically } from "../../src/tui/message-list.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

describe("shouldRenderStatically", () => {
  it("user 条目:始终固定(true)", () => {
    const e: TuiEntry = { kind: "user", content: "你好" };
    expect(shouldRenderStatically(e, false, false)).toBe(true);
    expect(shouldRenderStatically(e, true, true)).toBe(true);
  });

  it("tool done:已 resolve → 固定(true)", () => {
    const e: TuiEntry = {
      kind: "tool",
      name: "read",
      args: "{}",
      status: "done",
      summary: "10 字节",
    };
    expect(shouldRenderStatically(e, false, false)).toBe(true);
    expect(shouldRenderStatically(e, true, false)).toBe(true);
  });

  it("tool error:已 resolve → 固定(true)", () => {
    const e: TuiEntry = {
      kind: "tool",
      name: "bash",
      args: "{}",
      status: "error",
      summary: "失败",
    };
    expect(shouldRenderStatically(e, true, true)).toBe(true);
  });

  it("tool running:进行中 → 非固定(false)", () => {
    const e: TuiEntry = { kind: "tool", name: "bash", args: "{}", status: "running" };
    expect(shouldRenderStatically(e, true, true)).toBe(false);
    expect(shouldRenderStatically(e, false, false)).toBe(false);
  });

  it("assistant 非末条:历史回复 → 固定(true)", () => {
    const e: TuiEntry = { kind: "assistant", content: "历史回复" };
    expect(shouldRenderStatically(e, false, true)).toBe(true);
    expect(shouldRenderStatically(e, false, false)).toBe(true);
  });

  it("assistant 末条且流式中 → 非固定(false)", () => {
    const e: TuiEntry = { kind: "assistant", content: "正在写…" };
    expect(shouldRenderStatically(e, true, true)).toBe(false);
  });

  it("assistant 末条且非流式 → 固定(true)", () => {
    const e: TuiEntry = { kind: "assistant", content: "已完成回复" };
    expect(shouldRenderStatically(e, true, false)).toBe(true);
  });

  it("thinking:始终非固定(false)", () => {
    const e: TuiEntry = { kind: "thinking" };
    expect(shouldRenderStatically(e, false, false)).toBe(false);
    expect(shouldRenderStatically(e, true, true)).toBe(false);
  });

  it("system 条目:始终固定(true)", () => {
    const e: TuiEntry = { kind: "system", content: "Unknown slash command: /wat" };
    expect(shouldRenderStatically(e, false, false)).toBe(true);
    expect(shouldRenderStatically(e, true, true)).toBe(true);
  });

  it("error 条目:始终固定(true)", () => {
    const e: TuiEntry = { kind: "error", message: "boom", retryable: true, action: "retry" };
    expect(shouldRenderStatically(e, false, false)).toBe(true);
    expect(shouldRenderStatically(e, true, true)).toBe(true);
  });

  it("消息列表统一 user/assistant/system/error 行首符号与缩进", () => {
    const output = renderToString(
      React.createElement(MessageList, {
        layout: buildTranscriptLayout(
          [
            { kind: "user", content: "帮我检查" },
            { kind: "assistant", content: "正在检查" },
            { kind: "system", content: "Unknown command: /wat" },
            { kind: "error", message: "boom", retryable: true, action: "retry" },
            { kind: "assistant", content: "⚠️ 执行出错: should stay assistant" },
          ],
          { wrapWidth: 80 },
        ),
      }),
    );

    expect(output).toContain("❯ 帮我检查");
    expect(output).toContain("✦ 正在检查");
    expect(output).toContain("• Unknown command: /wat");
    expect(output).toContain("! boom");
    expect(output).toContain("retry");
    expect(output).toContain("✦ ⚠️ 执行出错: should stay assistant");
  });

  it("流式 assistant 只让末条动态渲染,历史行不重复出现", () => {
    const output = renderToString(
      React.createElement(MessageList, {
        isStreaming: true,
        layout: buildTranscriptLayout(
          [
            { kind: "assistant", content: "历史回复" },
            {
              kind: "tool",
              name: "read_file",
              args: "{}",
              status: "done",
              summary: "10 字节 · ok",
            },
            { kind: "assistant", content: "正在流式输出" },
          ],
          { wrapWidth: 80 },
        ),
      }),
    );

    expect(countOccurrences(output, "历史回复")).toBe(1);
    expect(countOccurrences(output, "正在流式输出")).toBe(1);
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
