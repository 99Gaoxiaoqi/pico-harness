import React from "react";
import { PassThrough } from "node:stream";
import { render, Text, type Instance } from "ink";
import { describe, expect, it, vi } from "vitest";
import { App } from "../../src/tui/app.js";
import { TUI_RENDER_OPTIONS } from "../../src/tui/repl.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

const ERASE_WHOLE_LINE = "\u001b[2K";
const CLEAR_VIEWPORT = "\u001b[2J";

describe("TUI incremental rendering integration", () => {
  it("updates send and streaming frames without erasing the viewport", async () => {
    const onSubmit = vi.fn();
    const harness = createProductionHarness(app([], false, onSubmit));

    try {
      await harness.ready();

      const typed = await harness.write("请修复闪烁🚀");
      expect(stripAnsi(typed)).toContain("请修复闪烁🚀▋");
      expect(count(typed, ERASE_WHOLE_LINE)).toBeLessThan(harness.rows);
      expect(typed).not.toContain(CLEAR_VIEWPORT);

      await harness.write("\r");
      expect(onSubmit).toHaveBeenCalledWith({ text: "请修复闪烁🚀", attachments: [] });

      const user: TuiEntry = { kind: "user", content: "用户提问：中文与 Emoji 🚀" };
      const tool: TuiEntry = {
        kind: "tool",
        name: "read_file",
        args: '{"path":"README.md"}',
        status: "success",
        summary: "TOOL_CARD_MARKER 工具运行成功",
      };
      const runningFrame = await harness.rerender(app([user, tool], true, onSubmit));
      expect(stripAnsi(runningFrame)).toContain("phase running");
      expect(stripAnsi(runningFrame)).toContain("用户提问：中文与 Emoji 🚀");
      expect(stripAnsi(runningFrame)).toContain("read · README.md · Success");
      expect(count(runningFrame, ERASE_WHOLE_LINE)).toBeLessThan(harness.rows);
      expect(runningFrame).not.toContain(CLEAR_VIEWPORT);

      let streamingOutput = "";
      for (let index = 1; index <= 10; index += 1) {
        const content = `ASSISTANT_DELTA 流式回答🌏 ${"很长的中文内容".repeat(index)}`;
        streamingOutput += await harness.rerender(
          app([user, tool, { kind: "assistant", content }], true, onSubmit),
        );
      }

      expect(stripAnsi(streamingOutput)).toContain("ASSISTANT_DELTA 流式回答🌏");
      expect(count(streamingOutput, ERASE_WHOLE_LINE)).toBeLessThan(harness.rows);
      expect(streamingOutput).not.toContain(CLEAR_VIEWPORT);

      const dialogFrame = await harness.rerender(
        app(
          [user, tool, { kind: "assistant", content: "FINAL_CJK_EMOJI 已完成 🎉" }],
          false,
          onSubmit,
          <Text>MODAL_MARKER 设置弹窗🚀</Text>,
        ),
      );
      const dialogText = stripAnsi(dialogFrame);
      expect(dialogText).toContain("phase idle");
      expect(dialogText).toContain("MODAL_MARKER 设置弹窗🚀");
      expect(count(dialogFrame, ERASE_WHOLE_LINE)).toBeLessThan(harness.rows);
      expect(dialogFrame).not.toContain(CLEAR_VIEWPORT);
    } finally {
      await harness.cleanup();
    }
  });
});

function app(
  entries: TuiEntry[],
  running: boolean,
  onSubmit: ReturnType<typeof vi.fn>,
  modal?: React.ReactNode,
): React.ReactElement {
  return (
    <App
      model="integration-model"
      provider="openai"
      workDir="/workspace/增量渲染"
      sessionMode="new"
      permissionMode="yolo"
      entries={entries}
      running={running}
      dialogRequests={
        modal ? [{ id: "incremental-modal", layer: "modal", priority: 50, content: modal }] : []
      }
      onSubmit={onSubmit}
    />
  );
}

function createProductionHarness(node: React.ReactNode): {
  rows: number;
  ready: () => Promise<void>;
  write: (input: string) => Promise<string>;
  rerender: (node: React.ReactNode) => Promise<string>;
  cleanup: () => Promise<void>;
} {
  const rows = 24;
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
    columns: { value: 80 },
    rows: { value: rows },
  });

  let output = "";
  stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  const instance: Instance = render(node, {
    ...TUI_RENDER_OPTIONS,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: stdout as unknown as NodeJS.WriteStream,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: false,
    interactive: true,
    // Vitest 会代理 global console，这里只验证生产帧差分，不测 console 转发。
    patchConsole: false,
  });

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 40));
    await instance.waitUntilRenderFlush();
  };
  const capture = async (action: () => void): Promise<string> => {
    const offset = output.length;
    action();
    await settle();
    return output.slice(offset);
  };

  return {
    rows,
    ready: settle,
    write: (input) => capture(() => stdin.write(input)),
    rerender: (nextNode) => capture(() => instance.rerender(nextNode)),
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

function count(value: string, needle: string): number {
  return value.split(needle).length - 1;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
