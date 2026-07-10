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

/**
 * 阶段 10 验收套件先在并行开发期间固化用户主链路；两条功能分支合入后解除 skip。
 * 这些场景只经过生产 Registry / Engine / App / Ink 边界，不直接测纯 helper。
 */
describe.skip("阶段 10：滚动窗口与大型工具输出集成验收", () => {
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

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-?]*[ -/]*[@-~]`, "gu");

function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}
