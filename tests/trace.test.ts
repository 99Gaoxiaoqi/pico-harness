import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import { Span, Tracer, exportTraceToFile } from "../src/observability/trace.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";

/** 跨平台安全删除:Windows 上 SQLite 句柄未释放时 rm 触发 EBUSY,退避重试兜底 */
async function safeRm(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await rm(path, { recursive: true, force: true });
      return;
    } catch (err) {
      if (String(err).includes("EBUSY") || String(err).includes("EPERM") || String(err).includes("ENOTEMPTY")) {
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
        continue;
      }
      throw err;
    }
  }
}
import type { BaseTool, Registry } from "../src/tools/registry.js";

class ScriptedProvider implements LLMProvider {
  private i = 0;

  async generate(): Promise<Message> {
    this.i++;
    if (this.i === 1) {
      return {
        role: "assistant",
        content: "先执行工具",
        toolCalls: [{ id: "call_bash", name: "bash", arguments: '{"command":"pwd"}' }],
        usage: { promptTokens: 10, completionTokens: 5 },
      };
    }
    return {
      role: "assistant",
      content: "完成",
      usage: { promptTokens: 12, completionTokens: 4 },
    };
  }
}

class RecordingRegistry implements Registry {
  register(_tool: BaseTool): void {}
  use(): void {}

  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "bash",
        description: "run a bash command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    return {
      toolCallId: call.id,
      output: "README.md\npackage.json\n",
      isError: false,
    };
  }

  isReadOnlyTool(_name: string): boolean {
    return true;
  }
}

describe("trace export", () => {
  it("sanitizes session ids before writing trace filenames", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-trace-export-"));
    const root = new Span("Agent.Run", null);
    root.end();

    try {
      const tracePath = exportTraceToFile(root, workDir, "console:/tmp/project");

      expect(tracePath).toContain(".claw/traces");
      expect(basename(tracePath)).toMatch(/^trace_console__tmp_project_\d+\.json$/);
      expect(JSON.parse(await readFile(tracePath, "utf8"))).toMatchObject({
        name: "Agent.Run",
      });
    } finally {
      await safeRm(workDir);
    }
  });

  it("records the engine run, turn, model, and tool spans under .claw/traces", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-trace-run-"));
    const session = new Session("trace:session/001", workDir);
    const tracer = new Tracer();
    session.append({ role: "user", content: "追踪这次运行" });

    const engine = new AgentEngine({
      provider: new ScriptedProvider(),
      registry: new RecordingRegistry(),
      workDir,
      systemPrompt: "Trace system prompt.",
      tracer,
    });

    try {
      await engine.run(session);

      const traceFiles = await readdir(join(workDir, ".claw", "traces"));
      expect(traceFiles).toHaveLength(1);
      expect(traceFiles[0]).toMatch(/^trace_trace_session_001_\d+\.json$/);

      const exported = JSON.parse(
        await readFile(join(workDir, ".claw", "traces", traceFiles[0]!), "utf8"),
      ) as {
        name?: string;
        attributes?: Record<string, unknown>;
        children?: Array<{
          name?: string;
          attributes?: Record<string, unknown>;
          children?: Array<{ name?: string; attributes?: Record<string, unknown> }>;
        }>;
      };
      const firstTurn = exported.children?.[0];
      const firstTurnChildren = firstTurn?.children ?? [];

      expect(exported).toMatchObject({
        name: "Agent.Run",
        attributes: {
          sessionId: "trace:session/001",
          workDir,
          planMode: false,
        },
      });
      expect(exported.children?.map((span) => span.name)).toEqual(["Turn-1", "Turn-2"]);
      expect(firstTurn).toMatchObject({
        name: "Turn-1",
        attributes: {
          contextMessageCount: 2,
          compactedMessageCount: 2,
          availableToolCount: 1,
        },
      });
      expect(firstTurnChildren.map((span) => span.name)).toContain("LLM.Action");
      expect(firstTurnChildren.map((span) => span.name)).toContain("Tool.Execute");
      expect(firstTurnChildren.find((span) => span.name === "LLM.Action")).toMatchObject({
        attributes: {
          inputMessageCount: 2,
          availableToolCount: 1,
          outputContentLength: "先执行工具".length,
          toolCallCount: 1,
          promptTokens: 10,
          completionTokens: 5,
        },
      });
      expect(firstTurnChildren.find((span) => span.name === "Tool.Execute")).toMatchObject({
        attributes: {
          toolName: "bash",
          toolCallId: "call_bash",
          arguments: '{"command":"pwd"}',
          isError: false,
          outputPreview: "README.md\npackage.json\n",
        },
      });
    } finally {
      await safeRm(workDir);
    }
  });
});
