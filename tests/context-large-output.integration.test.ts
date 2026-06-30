import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Compactor } from "../src/context/compactor.js";
import { ToolResultArtifactStore } from "../src/context/artifact-store.js";
import { AgentEngine } from "../src/engine/loop.js";
import { Session } from "../src/engine/session.js";
import type { LLMProvider } from "../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../src/schema/message.js";
import type { Registry } from "../src/tools/registry.js";
import { createToolResultObservationProcessor } from "../src/tools/tool-result-observation.js";

const ONE_MIB = 1024 * 1024;
const ONE_HUNDRED_KIB = 100 * 1024;
const HEAD_TAIL_KEEP = 500;

function assistantToolCall(toolCall: ToolCall): Message {
  return {
    role: "assistant",
    content: `调用 ${toolCall.name} 读取压力日志`,
    toolCalls: [toolCall],
  };
}

function toolResult(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}

function userMsg(content: string): Message {
  return { role: "user", content };
}

function syntheticLog(label: string, size: number): { log: string; middleError: string } {
  const head = `[${label}] BEGIN\n${"H".repeat(640)}\n`;
  const middleError = `[${label}] CRITICAL_IN_MIDDLE code=E_STRESS_CONTEXT\n`;
  const tail = `\n${"T".repeat(640)}\n[${label}] END`;
  const fillerLength = size - head.length - middleError.length - tail.length;
  if (fillerLength <= 0) {
    throw new Error("synthetic log size is too small for fixed sentinels");
  }
  const left = "L".repeat(Math.floor(fillerLength / 2));
  const right = "R".repeat(fillerLength - left.length);
  return { log: `${head}${left}${middleError}${right}${tail}`, middleError };
}

class LargeOutputProvider implements LLMProvider {
  readonly received: Message[][] = [];
  private calls = 0;

  async generate(messages: Message[], _availableTools: ToolDefinition[]): Promise<Message> {
    this.received.push(messages);
    this.calls++;
    if (this.calls === 1) {
      return {
        role: "assistant",
        content: "读日志",
        toolCalls: [{ id: "c1", name: "bash", arguments: '{"command":"cat huge.log"}' }],
      };
    }
    return { role: "assistant", content: "完成" };
  }
}

class LargeOutputRegistry implements Registry {
  constructor(private readonly output: string) {}

  register(): void {
    // 测试替身不需要动态注册工具。
  }

  use(): void {
    // 测试替身不挂载中间件。
  }

  getAvailableTools(): ToolDefinition[] {
    return [
      {
        name: "bash",
        description: "run command",
        inputSchema: { type: "object", properties: { command: { type: "string" } } },
      },
    ];
  }

  async execute(call: ToolCall): Promise<ToolResult> {
    return { toolCallId: call.id, output: this.output, isError: false };
  }

  isReadOnlyTool(): boolean {
    return false;
  }
}

describe("Compactor large ToolResult stress baseline", () => {
  it("truncates a protected 1MiB ToolResult with head and tail snippets", () => {
    const compactor = new Compactor({ maxChars: 4096, retainLastMsgs: 2 });
    const toolCall: ToolCall = {
      id: "protected-log",
      name: "bash",
      arguments: '{"command":"tail -n 100000 app.log"}',
    };
    const { log, middleError } = syntheticLog("protected", ONE_MIB);

    const out = compactor.compact([
      assistantToolCall(toolCall),
      toolResult(toolCall.id, log),
      userMsg("继续分析最近的失败"),
    ]);

    const compacted = out.find((msg) => msg.toolCallId === toolCall.id);
    expect(compacted).toBeDefined();
    if (!compacted) {
      throw new Error("expected protected ToolResult to remain present");
    }
    expect(out[0]?.toolCalls).toEqual([toolCall]);
    expect(compacted.content).toContain("内容过长");
    expect(compacted.content).toContain("已被系统截断");
    expect(compacted.content.startsWith(log.slice(0, HEAD_TAIL_KEEP))).toBe(true);
    expect(compacted.content.endsWith(log.slice(-HEAD_TAIL_KEEP))).toBe(true);
    expect(compacted.content.length).toBeLessThan(log.length);
    expect(compacted.content).not.toContain(middleError);
  });

  it("masks a distant 100KiB ToolResult instead of keeping raw output", () => {
    const compactor = new Compactor({ maxChars: 4096, retainLastMsgs: 2 });
    const toolCall: ToolCall = {
      id: "remote-log",
      name: "bash",
      arguments: '{"command":"cat archived.log"}',
    };
    const { log, middleError } = syntheticLog("remote", ONE_HUNDRED_KIB);

    const out = compactor.compact([
      assistantToolCall(toolCall),
      toolResult(toolCall.id, log),
      userMsg("最近用户问题"),
      { role: "assistant", content: "我会基于最近上下文继续。" },
    ]);

    const masked = out.find((msg) => msg.toolCallId === toolCall.id);
    expect(masked).toBeDefined();
    if (!masked) {
      throw new Error("expected remote ToolResult to remain as a masked observation");
    }
    expect(masked.content).toContain("工具 bash 输出已清理");
    expect(masked.content).toContain(String(log.length));
    expect(masked.content.length).toBeLessThan(300);
    expect(masked.content).not.toContain(middleError);
  });
});

describe("large ToolResult artifact externalization", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-large-output-"));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("Engine 把大 ToolResult 外部化,上下文保留 artifact path 与中间错误摘要", async () => {
    const { log, middleError } = syntheticLog("artifact", ONE_HUNDRED_KIB);
    const provider = new LargeOutputProvider();
    const registry = new LargeOutputRegistry(log);
    const store = new ToolResultArtifactStore({
      baseDir: join(workDir, ".claw", "artifacts"),
    });
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      enableThinking: false,
      observationProcessor: createToolResultObservationProcessor({
        store,
        externalizeThresholdChars: 1024,
        summaryMaxChars: 1200,
      }),
    });
    const session = new Session("large-output", workDir);
    session.append({ role: "user", content: "读取大日志" });

    await engine.run(session);

    const observation = session.getHistory().find((msg) => msg.toolCallId === "c1");
    expect(observation?.content).toContain("[大型工具输出已外部化]");
    expect(observation?.content).toContain("artifactUri:");
    expect(observation?.content).toContain("artifactPath:");
    expect(observation?.content).toContain(middleError.trim());
    expect(observation!.content.length).toBeLessThan(log.length);

    const artifactId = observation!.content.match(/^artifactId: (.+)$/m)?.[1];
    const artifactUri = observation!.content.match(/^artifactUri: (.+)$/m)?.[1];
    const artifactPath = observation!.content.match(/^artifactPath: (.+)$/m)?.[1];
    expect(artifactId).toBeDefined();
    expect(artifactUri).toBe(`artifact://large-output/${artifactId}`);
    expect(artifactPath).toBeDefined();
    const raw = await readFile(artifactPath!, "utf8");
    expect(raw).toBe(log);

    const secondCallMessages = provider.received[1] ?? [];
    const modelObservation = secondCallMessages.find((msg) => msg.toolCallId === "c1");
    expect(modelObservation?.content).toBe(observation?.content);
    expect(modelObservation?.content).not.toContain("L".repeat(1000));
  });
});
