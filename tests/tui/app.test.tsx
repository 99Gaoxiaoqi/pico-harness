import React from "react";
import { renderToString, Text } from "ink";
import { describe, expect, it, vi } from "vitest";
import {
  App,
  nextTranscriptScroll,
  resolveAppKeyEvent,
  resolveTranscriptScrollKey,
} from "../../src/tui/app.js";

describe("App", () => {
  it("renders history messages separately from the single bottom input box", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[
          { kind: "user", content: "你好" },
          { kind: "assistant", content: "你好！" },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("你好");
    expect(output).toContain("你好！");
    expect(output).toContain("pico · glm-5.2 · /workspace/demo");
    expect(output).toContain("glm-5.2/openai");
    expect(output).toContain("mode new");
    expect(output).toContain("perm ask");
    expect(output).toContain("think off");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(1);
    expect(countOccurrences(output, "Enter 发送")).toBe(0);
    expect(countOccurrences(output, "Tab 补全")).toBe(0);
  });

  it("keeps the bottom input active while running so new prompts can queue", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[{ kind: "assistant", content: "处理中" }]}
        running
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("处理中");
    expect(output).not.toContain("Running…");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(1);
    expect(countOccurrences(output, "Enter 发送")).toBe(0);
  });

  it("does not render spinner while assistant text is streaming", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[{ kind: "assistant", content: "正在输出" }]}
        running
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("正在输出");
    expect(output).not.toContain("生成回复中");
  });

  it("renders the focused modal and disables the bottom input while modal is active", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[{ kind: "user", content: "打开设置" }]}
        running={false}
        dialogRequests={[
          { id: "tips", layer: "overlay", priority: 10, content: <Text>Overlay tips</Text> },
          { id: "settings", layer: "modal", priority: 50, content: <Text>Settings modal</Text> },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("打开设置");
    expect(output).toContain("Settings modal");
    expect(output).not.toContain("Overlay tips");
    expect(output).toContain("Use dialog controls");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(0);
  });

  it("renders approval as an inline overlay without disabling the bottom input", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="new"
        entries={[
          { kind: "user", content: "更新文件" },
          { kind: "tool", name: "write_file", args: '{"path":"AIHOT.md"}', status: "approval" },
        ]}
        running
        dialogRequests={[
          {
            id: "approval:pending",
            layer: "overlay",
            priority: 80,
            content: <Text>Approval required: write_file</Text>,
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("Approval required: write_file");
    expect(output).not.toContain("Use dialog controls");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(1);
  });

  it("passes provider, permission mode, and thinking effort into the runtime status", () => {
    const output = renderToString(
      <App
        model="claude-sonnet"
        provider="claude"
        workDir="/workspace/demo"
        sessionMode="resume"
        permissionMode="acceptEdits"
        thinkingEffort="high"
        entries={[]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("pico · claude-sonnet · /workspace/demo");
    expect(output).toContain("claude-sonnet/claude");
    expect(output).toContain("mode resume");
    expect(output).toContain("perm acceptEdits");
    expect(output).toContain("think high");
  });

  it("maps global Ctrl shortcuts to interrupt, exit, and redraw semantics", () => {
    expect(resolveAppKeyEvent("c", { ctrl: true }, false)).toBeNull();
    expect(resolveAppKeyEvent("c", { ctrl: true }, true)).toBe("interrupt");
    expect(resolveAppKeyEvent("d", { ctrl: true }, true)).toBe("exit");
    expect(resolveAppKeyEvent("l", { ctrl: true }, false)).toBe("redraw");
  });

  it("renders the bottom transcript window for long conversations", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 60 }, (_, i) => ({
          kind: "assistant" as const,
          content: `message-${i}`,
        }))}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("message-59");
    expect(output).not.toContain("message-0");
  });

  it("renders the tail of a long streaming assistant response", () => {
    const output = renderToString(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          { kind: "assistant", content: "old context" },
          {
            kind: "assistant",
            content: Array.from({ length: 40 }, (_, i) => `tail-line-${i}`).join("\n"),
          },
        ]}
        running
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("tail-line-39");
    expect(output).not.toContain("tail-line-0");
  });

  it("computes transcript page scrolling around the bottom anchor", () => {
    expect(nextTranscriptScroll(null, "pageUp", 10, 100)).toBe(82);
    expect(nextTranscriptScroll(82, "pageDown", 10, 100)).toBe(null);
    expect(nextTranscriptScroll(5, "top", 10, 100)).toBe(0);
    expect(nextTranscriptScroll(5, "bottom", 10, 100)).toBeNull();
  });

  it("maps running plain arrows to transcript scrolling for terminal wheel events", () => {
    expect(resolveTranscriptScrollKey({ upArrow: true }, true)).toBe("lineUp");
    expect(resolveTranscriptScrollKey({ downArrow: true }, true)).toBe("lineDown");
    expect(resolveTranscriptScrollKey({ upArrow: true }, false)).toBeNull();
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}
