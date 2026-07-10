import React from "react";
import { PassThrough } from "node:stream";
import { render, renderToString, Text, type Instance } from "ink";
import { describe, expect, it, vi } from "vitest";
import {
  App,
  nextTranscriptScroll,
  resolveAppKeyEvent,
  resolveToolCardToggleKey,
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

  it("renders approval as an inline modal and disables the bottom input", () => {
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
            layer: "modal",
            priority: 80,
            content: <Text>Approval required: write_file</Text>,
          },
        ]}
        onSubmit={vi.fn()}
      />,
    );

    expect(output).toContain("Approval required: write_file");
    expect(output).toContain("Use dialog controls");
    expect(countOccurrences(output, 'Try "fix this" or / for commands')).toBe(0);
    expect(output).not.toContain("┌");
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

  it("keeps plain arrows on input and reserves modified arrows for transcript scrolling", () => {
    expect(resolveTranscriptScrollKey({ upArrow: true })).toBeNull();
    expect(resolveTranscriptScrollKey({ downArrow: true })).toBeNull();
    expect(resolveTranscriptScrollKey({ ctrl: true, upArrow: true })).toBe("lineUp");
    expect(resolveTranscriptScrollKey({ ctrl: true, downArrow: true })).toBe("lineDown");
  });

  it("modal focus blocks transcript and ToolCard shortcuts", () => {
    expect(resolveTranscriptScrollKey({ pageUp: true }, true)).toBeNull();
    expect(resolveToolCardToggleKey("e", {}, true, false)).toBeNull();
    expect(resolveToolCardToggleKey("e", { ctrl: true }, true, false)).toBe("toggle");
    expect(resolveToolCardToggleKey("e", { ctrl: true }, true, true)).toBeNull();
  });

  it("Ctrl+E expands the focused ToolCard without also moving the input cursor", async () => {
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={[
          {
            kind: "tool",
            name: "read_file",
            args: '{"path":"README.md"}',
            status: "success",
            summary: "done",
          },
        ]}
        running={false}
        onSubmit={vi.fn()}
      />,
    );

    try {
      await harness.write("ab");
      await harness.write("\u001b[D");
      const frame = await harness.write("\u0005");

      expect(frame).toContain("参数");
      expect(frame).toContain("a▋b");
      expect(frame).not.toContain("ab▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("running Up stays with input history instead of scrolling the transcript", async () => {
    const onSubmit = vi.fn();
    const harness = createInteractiveApp(
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={Array.from({ length: 30 }, (_, index) => ({
          kind: "assistant" as const,
          content: `message-${index}`,
        }))}
        running
        onSubmit={onSubmit}
      />,
    );

    try {
      await harness.write("first\r");
      expect(onSubmit).toHaveBeenCalledWith("first");
      await harness.write("draft");
      const frame = await harness.write("\u001b[A");

      expect(frame).toContain("first▋");
      expect(frame).not.toContain("draft▋");
    } finally {
      await harness.cleanup();
    }
  });

  it("counts new messages while away from bottom and clears the count on return", async () => {
    const entries = Array.from({ length: 30 }, (_, index) => ({
      kind: "assistant" as const,
      content: `message-${index}`,
    }));
    const app = (nextEntries: typeof entries) => (
      <App
        model="glm-5.2"
        provider="openai"
        workDir="/workspace/demo"
        entries={nextEntries}
        running={false}
        onSubmit={vi.fn()}
      />
    );
    const harness = createInteractiveApp(app(entries));

    try {
      await harness.write("\u001b[5~");
      const withNewMessages = await harness.rerender(
        app([
          ...entries,
          { kind: "assistant", content: "new-1" },
          { kind: "assistant", content: "new-2" },
        ]),
      );
      expect(withNewMessages).toContain("2 new messages");

      const atBottom = await harness.write("\u001b[1;5F");
      expect(atBottom).not.toContain("2 new messages");
    } finally {
      await harness.cleanup();
    }
  });
});

function countOccurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function createInteractiveApp(node: React.ReactNode): {
  write: (input: string) => Promise<string>;
  rerender: (node: React.ReactNode) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  Object.defineProperties(stdin, {
    isTTY: { value: true },
    isRaw: { value: false, writable: true },
  });
  Object.assign(stdin, {
    setRawMode: vi.fn(),
    ref: vi.fn(),
    unref: vi.fn(),
  });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: 80, writable: true },
    rows: { value: 24, writable: true },
  });
  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance: Instance = render(node, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: true,
    interactive: true,
    exitOnCtrlC: false,
    patchConsole: false,
  });

  return {
    async write(input: string): Promise<string> {
      const offset = output.length;
      stdin.write(input);
      await new Promise((resolve) => setTimeout(resolve, 10));
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async rerender(nextNode: React.ReactNode): Promise<string> {
      const offset = output.length;
      instance.rerender(nextNode);
      await instance.waitUntilRenderFlush();
      return stripAnsi(output.slice(offset));
    },
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

function stripAnsi(value: string): string {
  return value.replace(/\u001b\[[0-?]*[ -/]*[@-~]/gu, "");
}
