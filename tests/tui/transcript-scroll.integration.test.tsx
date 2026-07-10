import React from "react";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { render, type Instance } from "ink";
import { App, type AppProps } from "../../src/tui/app.js";
import { DISABLE_MOUSE_TRACKING, ENABLE_MOUSE_TRACKING } from "../../src/tui/mouse-input.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";

const WHEEL_UP = "\u001b[<64;10;10M";
const WHEEL_DOWN = "\u001b[<65;10;10M";

describe("TUI transcript scrolling integration", () => {
  it("freezes with the wheel, counts new entries, resumes follow at the bottom and on submit", async () => {
    const onSubmit = vi.fn();
    const initialEntries: TuiEntry[] = [longAssistant("history", 60)];
    const harness = createAppHarness(app(initialEntries, onSubmit));

    try {
      await harness.ready();
      expect(harness.rawOutput()).toContain(ENABLE_MOUSE_TRACKING);

      let frame = await harness.write(WHEEL_UP);
      expect(frame).toContain("history-56");
      expect(frame).not.toContain("history-59");

      const appendedEntries: TuiEntry[] = [
        ...initialEntries,
        { kind: "assistant", content: "fresh-tail-marker" },
      ];
      frame = await harness.rerender(app(appendedEntries, onSubmit));
      expect(frame).toContain("↓ 1 new messages");
      expect(frame).not.toContain("fresh-tail-marker");

      for (let index = 0; index < 3; index += 1) {
        frame = await harness.write(WHEEL_DOWN);
      }
      expect(frame).toContain("fresh-tail-marker");
      expect(frame).not.toContain("new messages");

      await harness.write(WHEEL_UP);
      await harness.write("continue");
      frame = await harness.write("\r");
      expect(onSubmit).toHaveBeenCalledWith("continue");
      expect(frame).toContain("fresh-tail-marker");
    } finally {
      const teardown = await harness.cleanup();
      expect(teardown).toContain(DISABLE_MOUSE_TRACKING);
    }
  });

  it("leaves a tool anchor and follows new assistant output", async () => {
    const entries: TuiEntry[] = [
      {
        kind: "tool",
        name: "read_file",
        args: '{"path":"large.txt"}',
        status: "success",
        summary: "expanded-tool-detail",
      },
      longAssistant("answer", 50),
    ];
    const harness = createAppHarness(app(entries, vi.fn()));

    try {
      await harness.ready();
      let frame = await harness.write("\u0005");
      expect(frame).toContain("expanded-tool-detail");
      expect(frame).not.toContain("answer-49");

      frame = await harness.rerender(
        app([...entries, { kind: "assistant", content: "continued-tail-marker" }], vi.fn()),
      );
      expect(frame).toContain("continued-tail-marker");
    } finally {
      await harness.cleanup();
    }
  });
});

function longAssistant(prefix: string, lines: number): TuiEntry {
  return {
    kind: "assistant",
    content: Array.from({ length: lines }, (_, index) => `${prefix}-${index}`).join("\n"),
  };
}

function app(entries: TuiEntry[], onSubmit: AppProps["onSubmit"]): React.ReactElement {
  return (
    <App
      model="integration-model"
      workDir="/workspace/integration"
      entries={entries}
      running={false}
      onSubmit={onSubmit}
    />
  );
}

function createAppHarness(node: React.ReactNode): {
  ready: () => Promise<void>;
  write: (input: string) => Promise<string>;
  rerender: (next: React.ReactNode) => Promise<string>;
  rawOutput: () => string;
  cleanup: () => Promise<string>;
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
    columns: { value: 80 },
    rows: { value: 24 },
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

  const settle = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 15));
    await instance.waitUntilRenderFlush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await instance.waitUntilRenderFlush();
  };

  return {
    async ready(): Promise<void> {
      await settle();
    },
    async write(input: string): Promise<string> {
      const offset = output.length;
      stdin.write(input);
      await settle();
      return stripAnsi(output.slice(offset));
    },
    async rerender(next: React.ReactNode): Promise<string> {
      const offset = output.length;
      instance.rerender(next);
      await settle();
      return stripAnsi(output.slice(offset));
    },
    rawOutput: () => output,
    async cleanup(): Promise<string> {
      const offset = output.length;
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
      return output.slice(offset);
    },
  };
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
