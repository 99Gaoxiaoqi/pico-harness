import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  createTuiTerminalGridSession,
  ENABLE_MOUSE_TRACKING,
  setTerminalMouseTrackingMode,
  type TuiTerminalGridSession,
} from "../../src/tui/terminal-grid.js";

const BEGIN_SYNCHRONIZED_OUTPUT = "\u001b[?2026h";
const END_SYNCHRONIZED_OUTPUT = "\u001b[?2026l";
const CLEAR_TERMINAL = "\u001b[2J\u001b[3J\u001b[H";

describe("TUI resize 同步帧集成", () => {
  let session: TuiTerminalGridSession | undefined;

  afterEach(async () => {
    await session?.dispose();
    session = undefined;
  });

  it("resize 风暴不旁路清屏且保留最终网格与鼠标模式", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
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
      columns: { value: 80, writable: true },
      rows: { value: 24, writable: true },
    });

    let output = "";
    let cprGrid = { columns: 80, rows: 24 };
    stdout.on("data", (chunk) => {
      const value = String(chunk);
      output += value;
      for (let queries = count(value, "\u001b[6n"); queries > 0; queries--) {
        queueMicrotask(() => stdin.write(`\u001b[${cprGrid.rows};${cprGrid.columns}R`));
      }
    });

    session = await createTuiTerminalGridSession(
      stdin as unknown as NodeJS.ReadStream,
      stdout as unknown as NodeJS.WriteStream,
      { CODEX_SHELL: "1" },
      50,
    );
    output = "";
    setTerminalMouseTrackingMode(session.stdout, true);

    cprGrid = { columns: 100, rows: 30 };
    Object.assign(stdout, cprGrid);
    stdout.emit("resize");
    stdout.emit("resize");
    await waitFor(() => session?.stdout.columns === 100 && session.stdout.rows === 30);

    for (const content of ["frame-one", "frame-two", "frame-three"]) {
      session.stdout.write(BEGIN_SYNCHRONIZED_OUTPUT);
      session.stdout.write(content);
      session.stdout.write(END_SYNCHRONIZED_OUTPUT);
    }

    expect(count(output, CLEAR_TERMINAL)).toBe(0);
    expect(count(output, BEGIN_SYNCHRONIZED_OUTPUT)).toBe(3);
    expect(count(output, END_SYNCHRONIZED_OUTPUT)).toBe(3);
    expect(count(output, ENABLE_MOUSE_TRACKING)).toBe(4);
    expect(output).toContain(BEGIN_SYNCHRONIZED_OUTPUT + "frame-one" + ENABLE_MOUSE_TRACKING);
    expect(session.stdout.getWindowSize()).toEqual([100, 30]);
  });
});

function count(value: string, pattern: string): number {
  return value.split(pattern).length - 1;
}

async function waitFor(predicate: () => boolean, timeoutMs = 200): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("等待 TUI 网格刷新超时");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
