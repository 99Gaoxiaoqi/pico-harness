import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { globalApprovalManager } from "../../src/approval/manager.js";
import { EvidenceArchive } from "../../src/context/evidence-archive.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { resetSessionSettingsForTests } from "../../src/input/session-settings.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const SESSION_ID = "runtime-events-e2e";
const TOOL_CALL_ID = "grep-runtime-evidence";
const RAW_MARKER = "RUNTIME_EVENT_RAW_OUTPUT_MARKER";
const FINAL_ANSWER = "The tool call completed and the final answer is ready.";

class ScriptedProvider implements LLMProvider {
  readonly calls: Array<{ messages: readonly Message[]; tools: readonly ToolDefinition[] }> = [];

  constructor(private readonly responses: Message[]) {}

  async generate(messages: Message[], tools: ToolDefinition[]): Promise<Message> {
    this.calls.push({ messages: structuredClone(messages), tools: structuredClone(tools) });
    const response = this.responses.shift();
    if (!response) throw new Error("script exhausted");
    return structuredClone(response);
  }
}

describe("AgentRuntime runtime event E2E", () => {
  const cleanupPaths: string[] = [];

  afterEach(async () => {
    globalApprovalManager.clear();
    globalSessionManager.clear();
    resetSessionSettingsForTests();
    await Promise.all(
      cleanupPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
    );
  });

  it("persists a tool-call run as ordered, correlated canonical runtime events", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-runtime-events-e2e-"));
    const paths = resolvePicoPaths(workDir);
    cleanupPaths.push(workDir, paths.workspace.root);

    const fixtureName = "large-grep-output.txt";
    const longLine = `${RAW_MARKER}:${"x".repeat(1_000)}`;
    await writeFile(
      join(workDir, fixtureName),
      Array.from({ length: 80 }, () => longLine).join("\n"),
      "utf8",
    );
    const toolArguments = JSON.stringify({
      pattern: RAW_MARKER,
      path: ".",
      glob: fixtureName,
      max_results: 80,
    });
    const provider = new ScriptedProvider([
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: TOOL_CALL_ID, name: "grep", arguments: toolArguments }],
        usage: { promptTokens: 1, completionTokens: 1 },
      },
      {
        role: "assistant",
        content: FINAL_ANSWER,
        usage: { promptTokens: 1, completionTokens: 1 },
      },
    ]);
    const prompt = `Find ${RAW_MARKER} in ${fixtureName}.`;

    const result = await executeAgentRuntime(
      { prompt, dir: workDir, session: SESSION_ID },
      { provider, reporter: new SilentReporter() },
    );

    expect(result.finalMessage).toBe(FINAL_ANSWER);
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[0]?.tools.some((tool) => tool.name === "grep")).toBe(true);

    const store = new RuntimeEventStore({ databasePath: paths.workspace.runtimeDatabase });
    const sessionEvents = await store.readSession(SESSION_ID);
    const runStarted = onlyEvent(sessionEvents, "run.started");
    const events = await store.readRun(SESSION_ID, runStarted.runId);

    expect(events).toEqual(sessionEvents);
    expect(events.map((event) => event.kind)).toEqual([
      "run.started",
      "message.committed",
      "model.call.started",
      "model.call.settled",
      "message.committed",
      "tool.started",
      "message.committed",
      "model.call.started",
      "model.call.settled",
      "message.committed",
      "run.terminal",
    ]);
    for (const event of events) {
      expect(event.sessionId).toBe(SESSION_ID);
      expect(event.runId).toBe(runStarted.runId);
      expect(event.invocationId).toBe(runStarted.invocationId);
    }

    const messages = eventsOfKind(events, "message.committed");
    const [userMessage, assistantToolCall, toolResult, finalMessage] = messages;
    expect(messages).toHaveLength(4);
    expect(userMessage?.data.message).toMatchObject({ role: "user", content: prompt });
    expect(assistantToolCall?.data.message).toMatchObject({
      role: "assistant",
      content: "",
      toolCalls: [{ id: TOOL_CALL_ID, name: "grep", arguments: toolArguments }],
    });
    expect(toolResult?.data.message).toMatchObject({ role: "user", toolCallId: TOOL_CALL_ID });
    expect(finalMessage?.data.message).toMatchObject({
      role: "assistant",
      content: FINAL_ANSWER,
    });

    const toolStarted = onlyEvent(events, "tool.started");
    expect(toolStarted.refs?.toolCallId).toBe(TOOL_CALL_ID);
    expect(toolStarted.data).toEqual({
      toolName: "grep",
      argumentsHash: createHash("sha256").update(toolArguments).digest("hex"),
    });
    expect(toolStarted.turnId).toBe(assistantToolCall?.turnId);
    expect(toolStarted.turnId).toBe(toolResult?.turnId);
    expect(toolStarted.refs?.stepId).toBe(assistantToolCall?.refs?.stepId);
    expect(toolStarted.refs?.stepId).toBe(toolResult?.refs?.stepId);
    expect(toolResult?.refs?.toolCallId).toBe(TOOL_CALL_ID);

    const modelStarts = eventsOfKind(events, "model.call.started");
    const modelSettled = eventsOfKind(events, "model.call.settled");
    expect(modelStarts).toHaveLength(2);
    expect(modelSettled).toHaveLength(2);
    for (const [index, started] of modelStarts.entries()) {
      const settled = modelSettled[index]!;
      expect(started.refs?.providerCallId).toBeTruthy();
      expect(settled.refs?.providerCallId).toBe(started.refs?.providerCallId);
      expect(started.data.purpose).toBe("main");
      expect(settled.data.status).toBe("succeeded");
      expect(events.indexOf(started)).toBeLessThan(events.indexOf(settled));
    }
    expect(modelStarts[0]?.turnId).toBe(assistantToolCall?.turnId);
    expect(modelSettled[0]?.turnId).toBe(assistantToolCall?.turnId);
    expect(modelStarts[1]?.turnId).toBe(finalMessage?.turnId);
    expect(modelSettled[1]?.turnId).toBe(finalMessage?.turnId);

    const terminal = onlyEvent(events, "run.terminal");
    expect(terminal.data.status).toBe("completed");
    expect(events.at(-1)).toBe(terminal);

    const evidenceReference = toolResult?.refs?.evidence;
    if (!evidenceReference) throw new Error("tool result event is missing its evidence reference");
    const evidence = await new EvidenceArchive({
      baseDir: paths.workspace.evidence,
    }).readRuntimeToolExchange(evidenceReference);
    expect(evidence.content).toMatchObject({
      sessionId: SESSION_ID,
      toolCallId: TOOL_CALL_ID,
      toolName: "grep",
      arguments: toolArguments,
      isError: false,
    });
    expect(evidence.content.rawOutput.length).toBeGreaterThan(50_000);
    expect(evidence.content.rawOutput).toContain(RAW_MARKER);
    expect(evidence.content.modelVisibleOutput).toBe(toolResult.data.message.content);
    expect(toolResult.data.message.content).toContain("artifactUri:");
    expect(toolResult.data.message.content.length).toBeLessThan(3_000);
    expect(JSON.stringify(events)).not.toContain(evidence.content.rawOutput);
    expect(provider.calls[1]?.messages.at(-1)).toMatchObject({
      role: "user",
      toolCallId: TOOL_CALL_ID,
      content: expect.stringContaining("artifactUri:"),
    });
  });
});

type RuntimeEventOfKind<Kind extends RuntimeEvent["kind"]> = Extract<RuntimeEvent, { kind: Kind }>;

function eventsOfKind<Kind extends RuntimeEvent["kind"]>(
  events: readonly RuntimeEvent[],
  kind: Kind,
): RuntimeEventOfKind<Kind>[] {
  return events.filter((event): event is RuntimeEventOfKind<Kind> => event.kind === kind);
}

function onlyEvent<Kind extends RuntimeEvent["kind"]>(
  events: readonly RuntimeEvent[],
  kind: Kind,
): RuntimeEventOfKind<Kind> {
  const matching = eventsOfKind(events, kind);
  expect(matching).toHaveLength(1);
  return matching[0]!;
}
