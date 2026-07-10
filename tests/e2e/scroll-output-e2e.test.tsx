import React from "react";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { render, type Instance } from "ink";
import { afterEach, describe, expect, it } from "vitest";
import { ToolResultArtifactStore } from "../../src/context/artifact-store.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { Session } from "../../src/engine/session.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { App } from "../../src/tui/app.js";
import { TUI_RENDER_OPTIONS } from "../../src/tui/repl.js";
import { resolveTuiRenderStdout } from "../../src/tui/terminal-grid.js";
import type { TuiEntry } from "../../src/tui/tui-reporter.js";
import { BashTool, ReadFileTool, ToolRegistry } from "../../src/tools/registry-impl.js";
import { createToolResultObservationProcessor } from "../../src/tools/tool-result-observation.js";

const MOUSE_ENABLE = "\u001b[?1000h\u001b[?1006h";
const MOUSE_DISABLE = "\u001b[?1006l\u001b[?1000l";
const WHEEL_UP = "\u001b[<64;10;10M";
const WHEEL_DOWN = "\u001b[<65;10;10M";

class PagingScenarioProvider implements LLMProvider {
  readonly toolSnapshots: ToolDefinition[][] = [];
  bashObservation = "";
  readObservation = "";
  private turn = 0;

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    this.toolSnapshots.push(availableTools);
    this.turn++;

    if (this.turn === 1) {
      return {
        role: "assistant",
        content: "produce the large output",
        toolCalls: [
          {
            id: "bash-large-output",
            name: "bash",
            arguments: JSON.stringify({ command: "cat large-output.log" }),
          },
        ],
      };
    }

    if (this.turn === 2) {
      this.bashObservation = requireObservation(messages, "bash-large-output");
      const artifactPath = this.bashObservation.match(/^artifactPath:\s*(.+)$/mu)?.[1]?.trim();
      if (!artifactPath) throw new Error("bash observation did not expose artifactPath");
      return {
        role: "assistant",
        content: "read a page from the artifact",
        toolCalls: [
          {
            id: "read-artifact-page",
            name: "read_file",
            arguments: JSON.stringify({ path: artifactPath, offset: 201, limit: 180 }),
          },
        ],
      };
    }

    this.readObservation = requireObservation(messages, "read-artifact-page");
    return { role: "assistant", content: "paging complete" };
  }
}

/** 这些场景只经过生产 Registry / Engine / App / Ink 边界，不直接测纯 helper。 */
describe("阶段 10：滚动窗口与大型工具输出集成验收", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it("Bash 完整落盘后可由 Read 分页回查，且不产生第二个 artifact", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-scroll-output-e2e-"));
    cleanups.push(() => rm(workDir, { recursive: true, force: true }));
    const lines = Array.from(
      { length: 420 },
      (_, index) => `ROW_${String(index + 1).padStart(4, "0")}_${"x".repeat(88)}`,
    );
    const fullOutput = `${lines.join("\n")}\n`;
    expect(fullOutput.length).toBeGreaterThan(30_000);
    await writeFile(join(workDir, "large-output.log"), fullOutput, "utf8");

    const registry = new ToolRegistry({ truncateResults: false });
    registry.register(new BashTool(workDir, undefined, { allowBackground: false }));
    registry.register(new ReadFileTool(workDir));
    const store = new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
    });
    const provider = new PagingScenarioProvider();
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      maxTurns: 4,
      observationProcessor: createToolResultObservationProcessor({ store }),
    });
    const session = new Session("scroll-output-e2e", workDir);
    session.append({ role: "user", content: "生成大输出并分页回查" });

    await engine.run(session);

    expect(provider.bashObservation).toContain("[大型工具输出已外部化]");
    expect(provider.bashObservation).toContain(`originalChars: ${fullOutput.length}`);
    const artifactPath = provider.bashObservation.match(/^artifactPath:\s*(.+)$/mu)?.[1]?.trim();
    expect(artifactPath).toBeDefined();
    await expect(readFile(artifactPath!, "utf8")).resolves.toBe(fullOutput);

    expect(provider.readObservation).not.toContain("[大型工具输出已外部化]");
    expect(provider.readObservation).toContain("201\tROW_0201_");
    expect(provider.readObservation).toContain("当前显示 201-380 行");
    expect(provider.readObservation).toContain("PARTIAL");
    expect(provider.readObservation).toMatch(/"offset"\s*:\s*381/u);

    const artifactEntries = await readdir(dirname(artifactPath!));
    expect(artifactEntries.filter((entry) => entry.endsWith(".txt"))).toHaveLength(1);
    expect(artifactEntries.filter((entry) => entry.endsWith(".json"))).toHaveLength(1);
    const readDefinition = provider.toolSnapshots[0]?.find((tool) => tool.name === "read_file");
    expect(readDefinition?.inputSchema.properties).toMatchObject({
      offset: expect.any(Object),
      limit: expect.any(Object),
    });
  });

  it("展开工具后追加模型消息会恢复跟底", async () => {
    const onSubmit = () => undefined;
    const initialEntries: TuiEntry[] = [
      {
        kind: "tool",
        name: "read_file",
        args: JSON.stringify({ path: "large-output.log" }),
        status: "success",
        summary: "TOOL_PAGE_FIRST\nTOOL_PAGE_LAST",
      },
      ...Array.from({ length: 28 }, (_, index) => ({
        kind: "assistant" as const,
        content: `old-tail-${index}`,
      })),
    ];
    const app = (entries: TuiEntry[]) => (
      <App
        model="local-model"
        provider="openai"
        workDir="/workspace/demo"
        entries={entries}
        running={false}
        onSubmit={onSubmit}
      />
    );
    const harness = createInteractiveApp(app(initialEntries), { columns: 72, rows: 20 });

    try {
      await harness.flush();
      const expanded = await harness.write("\u0005");
      expect(expanded).toContain("TOOL_PAGE_LAST");

      const followed = await harness.rerender(
        app([...initialEntries, { kind: "assistant", content: "FINAL_AFTER_EXPANDED_TOOL" }]),
      );
      expect(followed).toContain("FINAL_AFTER_EXPANDED_TOOL");
      expect(followed).not.toContain("new messages");
    } finally {
      await harness.cleanup();
    }
  });

  it("鼠标上滚后保持历史视口，滚回底部后重新跟随新消息", async () => {
    const onSubmit = () => undefined;
    const initialEntries: TuiEntry[] = Array.from({ length: 48 }, (_, index) => ({
      kind: "assistant",
      content: `wheel-message-${String(index).padStart(2, "0")}`,
    }));
    const app = (entries: TuiEntry[]) => (
      <App
        model="local-model"
        provider="openai"
        workDir="/workspace/demo"
        entries={entries}
        running={false}
        onSubmit={onSubmit}
      />
    );
    const harness = createInteractiveApp(app(initialEntries), { columns: 64, rows: 18 });

    try {
      await harness.flush();
      for (let index = 0; index < 8; index++) await harness.write(WHEEL_UP);

      const pendingEntries: TuiEntry[] = [
        ...initialEntries,
        { kind: "assistant", content: "PENDING_WHILE_MANUAL" },
      ];
      const manual = await harness.rerender(app(pendingEntries));
      expect(manual).toContain("1 new messages");
      expect(manual).not.toContain("PENDING_WHILE_MANUAL");

      let atBottom = "";
      for (let index = 0; index < 24; index++) atBottom = await harness.write(WHEEL_DOWN);
      expect(atBottom).toContain("PENDING_WHILE_MANUAL");
      expect(atBottom).not.toContain("new messages");

      const followed = await harness.rerender(
        app([...pendingEntries, { kind: "assistant", content: "FOLLOWED_AFTER_BOTTOM" }]),
      );
      expect(followed).toContain("FOLLOWED_AFTER_BOTTOM");
      expect(followed).not.toContain("new messages");
    } finally {
      await harness.cleanup();
    }
  });

  it("交互 App 挂载时开启 mouse mode，卸载时按逆序关闭", async () => {
    const harness = createInteractiveApp(
      <App
        model="local-model"
        provider="openai"
        workDir="/workspace/demo"
        entries={[]}
        running={false}
        onSubmit={() => undefined}
      />,
    );

    await harness.flush();
    expect(harness.rawOutput()).toContain(MOUSE_ENABLE);
    await harness.cleanup();
    expect(harness.rawOutput()).toContain(MOUSE_DISABLE);
  });

  it("生产全屏在 PTY 与前端尺寸漂移后流式更新不越界或重复刷屏", async () => {
    // ChatGPT.app 真实故障：后端仍为 166x17，xterm 前端已 fit 到约 87x40。
    const terminal = new ImmediateWrapTerminal(87, 40);
    const user: TuiEntry = { kind: "user", content: "USER_CJK_MARKER_这个skill是在哪拿的" };
    const app = (entries: TuiEntry[], running: boolean) => (
      <App
        model="local-model"
        provider="openai"
        workDir="/workspace/demo"
        sessionMode="yolo"
        permissionMode="yolo"
        entries={entries}
        running={running}
        onSubmit={() => undefined}
      />
    );
    const harness = await createProductionFrameHarness(app([user], true), terminal, {
      columns: 166,
      rows: 17,
    });

    try {
      await harness.wait(280); // 让 80ms spinner 真实跨过多帧。
      await harness.resize(80, 17);
      await harness.wait(120);
      await harness.rerender(
        app([user, { kind: "assistant", content: "FINAL_CJK_MARKER_这份skill来自工作区" }], true),
      );
      await harness.wait(120);
      await harness.rerender(
        app(
          [
            user,
            {
              kind: "assistant",
              content: "FINAL_CJK_MARKER_这份skill来自工作区，流式回答已完成",
            },
          ],
          false,
        ),
      );

      const visible = terminal.visibleText();
      expect(visible.match(/phase idle · mode yolo/gu)).toHaveLength(1);
      expect(visible).not.toContain("phase running · mode yolo");
      expect(visible.match(/USER_CJK_MARKER/gu)).toHaveLength(1);
      expect(visible.match(/FINAL_CJK_MARKER/gu)).toHaveLength(1);
      expect(visible.split("\n").filter((line) => /^─+$/u.test(line))).toEqual(["─".repeat(79)]);
      expect(harness.probeQueries()).toBe(1);
      expect(harness.appFramesBeforeProbe()).toBe(0);
      expect(harness.rawText().match(/phase running · mode yolo/gu)?.length ?? 0).toBeGreaterThan(
        1,
      );
      expect(terminal.wrapEvents).toBe(0);
      expect(terminal.scrollEvents).toBe(0);
      expect(terminal.scrollbackText()).not.toMatch(
        /phase (?:running|idle) · mode yolo|USER_CJK_MARKER|FINAL_CJK_MARKER/u,
      );
    } finally {
      await harness.cleanup();
    }
  });
});

function requireObservation(messages: Message[], toolCallId: string): string {
  const observation = messages.findLast((message) => message.toolCallId === toolCallId)?.content;
  if (!observation) throw new Error(`missing observation for ${toolCallId}`);
  return observation;
}

function createInteractiveApp(
  node: React.ReactNode,
  dimensions: { columns: number; rows: number } = { columns: 80, rows: 24 },
): {
  flush: () => Promise<void>;
  write: (input: string) => Promise<string>;
  rerender: (node: React.ReactNode) => Promise<string>;
  rawOutput: () => string;
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
    setRawMode: () => undefined,
    ref: () => undefined,
    unref: () => undefined,
  });
  Object.defineProperties(stdout, {
    isTTY: { value: true },
    columns: { value: dimensions.columns, writable: true },
    rows: { value: dimensions.rows, writable: true },
  });

  let output = "";
  let cleaned = false;
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

  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await instance.waitUntilRenderFlush();
  }

  return {
    flush,
    async write(input: string): Promise<string> {
      const offset = output.length;
      stdin.write(input);
      await flush();
      return stripAnsi(output.slice(offset));
    },
    async rerender(nextNode: React.ReactNode): Promise<string> {
      const offset = output.length;
      instance.rerender(nextNode);
      await flush();
      return stripAnsi(output.slice(offset));
    },
    rawOutput: () => output,
    async cleanup(): Promise<void> {
      if (cleaned) return;
      cleaned = true;
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

async function createProductionFrameHarness(
  node: React.ReactNode,
  terminal: ImmediateWrapTerminal,
  reportedDimensions: { columns: number; rows: number },
): Promise<{
  wait: (milliseconds: number) => Promise<void>;
  resize: (columns: number, rows: number) => Promise<void>;
  rerender: (node: React.ReactNode) => Promise<void>;
  rawText: () => string;
  probeQueries: () => number;
  appFramesBeforeProbe: () => number;
  cleanup: () => Promise<void>;
}> {
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
    columns: { value: reportedDimensions.columns, writable: true },
    rows: { value: reportedDimensions.rows, writable: true },
  });
  let rawOutput = "";
  let probeQueries = 0;
  let probeComplete = false;
  let appFramesBeforeProbe = 0;
  stdout.on("data", (chunk) => {
    const output = String(chunk);
    rawOutput += output;
    terminal.write(output);
    if (!probeComplete && stripAnsi(output).includes("phase ")) appFramesBeforeProbe++;
    if (!output.includes("\u001b[6n")) return;
    probeQueries++;
    const response = terminal.cursorPositionResponse();
    const splitAt = Math.max(1, Math.floor(response.length / 2));
    stdin.write(response.slice(0, splitAt));
    queueMicrotask(() => {
      stdin.write(response.slice(splitAt));
      probeComplete = true;
    });
  });

  const renderStdout = await resolveTuiRenderStdout(
    stdin as unknown as NodeJS.ReadStream,
    stdout as unknown as NodeJS.WriteStream,
    { CODEX_SHELL: "1" },
    50,
  );

  const instance: Instance = render(node, {
    ...TUI_RENDER_OPTIONS,
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout: renderStdout,
    stderr: stderr as unknown as NodeJS.WriteStream,
    debug: false,
    interactive: true,
  });

  const wait = async (milliseconds: number): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
    await instance.waitUntilRenderFlush();
  };

  return {
    wait,
    async resize(columns: number, rows: number): Promise<void> {
      Object.assign(stdout, { columns, rows });
      stdout.emit("resize");
      await wait(50);
    },
    async rerender(nextNode: React.ReactNode): Promise<void> {
      instance.rerender(nextNode);
      await wait(50);
    },
    rawText: () => stripAnsi(rawOutput),
    probeQueries: () => probeQueries,
    appFramesBeforeProbe: () => appFramesBeforeProbe,
    async cleanup(): Promise<void> {
      instance.unmount();
      await instance.waitUntilExit();
      instance.cleanup();
    },
  };
}

/** 模拟 ChatGPT.app 终端的右边界立即 wrap，而非 xterm 的 wrap-pending。 */
class ImmediateWrapTerminal {
  columns: number;
  rows: number;
  wrapEvents = 0;
  scrollEvents = 0;
  private screen: string[][];
  private scrollback: string[] = [];
  private x = 0;
  private y = 0;
  private savedX = 0;
  private savedY = 0;

  constructor(columns: number, rows: number) {
    this.columns = columns;
    this.rows = rows;
    this.screen = Array.from({ length: rows }, () => this.blankLine());
  }

  write(chunk: string): void {
    for (let index = 0; index < chunk.length; ) {
      if (chunk[index] === "\u001b" && chunk[index + 1] === "[") {
        const end = findCsiEnd(chunk, index + 2);
        if (end === -1) return;
        this.applyCsi(chunk.slice(index + 2, end), chunk[end]!);
        index = end + 1;
        continue;
      }
      if (chunk[index] === "\u001b" && chunk[index + 1] === "]") {
        const bell = chunk.indexOf("\u0007", index + 2);
        const stringTerminator = chunk.indexOf("\u001b\\", index + 2);
        const end = [bell, stringTerminator].filter((value) => value >= 0).sort((a, b) => a - b)[0];
        if (end === undefined) return;
        index = end + (end === stringTerminator ? 2 : 1);
        continue;
      }
      if (chunk[index] === "\r") {
        this.x = 0;
        index++;
        continue;
      }
      if (chunk[index] === "\n") {
        this.x = 0;
        this.lineFeed();
        index++;
        continue;
      }
      if (chunk[index] === "\u0007") {
        index++;
        continue;
      }

      const codePoint = chunk.codePointAt(index);
      if (codePoint === undefined) break;
      const value = String.fromCodePoint(codePoint);
      const width = terminalCharacterWidth(codePoint);
      index += value.length;
      if (width === 0) continue;
      if (this.x + width > this.columns) {
        this.wrapEvents++;
        this.x = 0;
        this.lineFeed();
      }
      this.screen[this.y]![this.x] = value;
      if (width === 2 && this.x + 1 < this.columns) this.screen[this.y]![this.x + 1] = "";
      this.x += width;
      if (this.x >= this.columns) {
        this.wrapEvents++;
        this.x = 0;
        this.lineFeed();
      }
    }
  }

  visibleText(): string {
    return this.screen.map((line) => line.join("").trimEnd()).join("\n");
  }

  scrollbackText(): string {
    return this.scrollback.join("\n");
  }

  cursorPositionResponse(): string {
    return `\u001b[${this.y + 1};${this.x + 1}R`;
  }

  private applyCsi(parameters: string, final: string): void {
    const privateMode = parameters.startsWith("?");
    const values = (privateMode ? parameters.slice(1) : parameters)
      .split(";")
      .map((value) => (value === "" ? 0 : Number(value)));
    const amount = Math.max(1, values[0] ?? 0);

    if (privateMode && final === "h" && values.includes(1049)) {
      this.screen = Array.from({ length: this.rows }, () => this.blankLine());
      this.scrollback = [];
      this.x = 0;
      this.y = 0;
      this.scrollEvents = 0;
      return;
    }
    if (privateMode && (final === "h" || final === "l")) return;
    if (final === "m") return;
    if (final === "A") this.y = Math.max(0, this.y - amount);
    else if (final === "B") this.y = Math.min(this.rows - 1, this.y + amount);
    else if (final === "C") this.x = Math.min(this.columns - 1, this.x + amount);
    else if (final === "D") this.x = Math.max(0, this.x - amount);
    else if (final === "E") {
      this.y = Math.min(this.rows - 1, this.y + amount);
      this.x = 0;
    } else if (final === "F") {
      this.y = Math.max(0, this.y - amount);
      this.x = 0;
    } else if (final === "G") this.x = Math.min(this.columns - 1, amount - 1);
    else if (final === "H" || final === "f") {
      this.y = Math.min(this.rows - 1, Math.max(0, (values[0] || 1) - 1));
      this.x = Math.min(this.columns - 1, Math.max(0, (values[1] || 1) - 1));
    } else if (final === "J") this.eraseDisplay(values[0] ?? 0);
    else if (final === "K") this.eraseLine(values[0] ?? 0);
    else if (final === "s") {
      this.savedX = this.x;
      this.savedY = this.y;
    } else if (final === "u") {
      this.x = this.savedX;
      this.y = this.savedY;
    }
  }

  private eraseDisplay(mode: number): void {
    if (mode === 2 || mode === 3) {
      this.screen = Array.from({ length: this.rows }, () => this.blankLine());
      if (mode === 3) this.scrollback = [];
      return;
    }
    for (let column = this.x; column < this.columns; column++) this.screen[this.y]![column] = " ";
    for (let row = this.y + 1; row < this.rows; row++) this.screen[row] = this.blankLine();
  }

  private eraseLine(mode: number): void {
    const from = mode === 1 || mode === 2 ? 0 : this.x;
    const to = mode === 0 ? this.columns : this.x + 1;
    for (let column = from; column < to; column++) this.screen[this.y]![column] = " ";
  }

  private lineFeed(): void {
    this.y++;
    if (this.y < this.rows) return;
    this.scrollback.push(this.screen.shift()!.join("").trimEnd());
    this.screen.push(this.blankLine());
    this.y = this.rows - 1;
    this.scrollEvents++;
  }

  private blankLine(): string[] {
    return Array.from({ length: this.columns }, () => " ");
  }
}

function findCsiEnd(value: string, from: number): number {
  for (let index = from; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code >= 0x40 && code <= 0x7e) return index;
  }
  return -1;
}

function terminalCharacterWidth(codePoint: number): 0 | 1 | 2 {
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0xfe00 && codePoint <= 0xfe0f)) {
    return 0;
  }
  if (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0x1f300 && codePoint <= 0x1faff)
  ) {
    return 2;
  }
  return 1;
}

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
