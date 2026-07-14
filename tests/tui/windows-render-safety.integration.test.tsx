import { PassThrough } from "node:stream";
import React from "react";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { effectiveTuiRows } from "../../src/tui/viewport-rows.js";

const CLEAR_TERMINAL = "\u001b[2J\u001b[3J\u001b[H";
const originalPlatform = process.platform;

afterEach(() => {
  Object.defineProperty(process, "platform", { value: originalPlatform });
  vi.resetModules();
});

describe("Windows TUI render safety integration", () => {
  it("reserves one row only for Windows terminals with room to spare", () => {
    expect(effectiveTuiRows(17, "win32")).toBe(16);
    expect(effectiveTuiRows(1, "win32")).toBe(1);
    expect(effectiveTuiRows(17, "darwin")).toBe(17);
    expect(effectiveTuiRows(17, "linux")).toBe(17);
  });

  it("keeps the bottom input visible and avoids Windows fullscreen clears while streaming", async () => {
    Object.defineProperty(process, "platform", { value: "win32" });
    vi.resetModules();

    // Ink captures process.platform when its module is evaluated, so both Ink
    // and App exercise their real win32 branches in this integration test.
    const [{ render }, { App }] = await Promise.all([
      import("ink"),
      import("../../src/tui/app.js"),
    ]);
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    Object.defineProperties(stdin, {
      isTTY: { value: true },
      isRaw: { value: false, writable: true },
    });
    Object.assign(stdin, {
      setRawMode: () => undefined,
      ref: () => undefined,
      unref: () => undefined,
    });
    Object.defineProperties(stdout, {
      isTTY: { value: true },
      columns: { value: 60, writable: true },
      rows: { value: 17, writable: true },
    });
    let rawOutput = "";
    stdout.on("data", (chunk) => {
      rawOutput += String(chunk);
    });

    const frame = (content: string, running: boolean) => (
      <App
        model="windows-model"
        provider="openai"
        workDir="C:\\workspace\\中文项目"
        entries={[
          {
            kind: "user",
            content: `WINDOWS_CJK_MARKER_请分析这段很长的中文输入_${"路径".repeat(20)}`,
          },
          { kind: "assistant", content },
        ]}
        running={running}
        onSubmit={() => undefined}
      />
    );

    const instance = render(frame("正在生成", true), {
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      interactive: true,
      incrementalRendering: true,
      patchConsole: false,
      exitOnCtrlC: false,
    });

    try {
      await instance.waitUntilRenderFlush();
      const firstFrame = stripAnsi(rawOutput);
      expect(firstFrame).toContain("WINDOWS_CJK_MARKER");
      expect(firstFrame).toContain('Try "fix this" or / for commands');
      expect(rawOutput).not.toContain(CLEAR_TERMINAL);

      rawOutput = "";
      for (const content of ["正在生成第一段", "正在生成第二段", "生成完成"]) {
        instance.rerender(frame(content, content !== "生成完成"));
        await instance.waitUntilRenderFlush();
      }

      expect(rawOutput).not.toContain(CLEAR_TERMINAL);
    } finally {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    }
  });
});
