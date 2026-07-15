import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentEngine } from "../../src/engine/loop.js";
import { RunLedger } from "../../src/engine/run-ledger.js";
import { Session } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolCall, ToolDefinition, ToolResult } from "../../src/schema/message.js";
import type { BaseTool, Registry } from "../../src/tools/registry.js";

describe("RunLedger integration", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-run-ledger-"));
  });

  afterEach(async () => {
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("makes the append-only terminal fact authoritative over the run projection", async () => {
    const baseDir = join(workDir, "runs");
    const ledger = await RunLedger.start({
      baseDir,
      sessionId: "session-a",
      workDir,
      runId: "run-a",
    });

    expect((await ledger.load()).header.status).toBe("running");
    await ledger.finish("completed");

    const snapshot = await ledger.load();
    expect(snapshot.header).toMatchObject({
      runId: "run-a",
      sessionId: "session-a",
      status: "completed",
      terminalEventId: expect.any(String) as string,
    });
    expect(snapshot.events.map((event) => event.type)).toEqual(["run.started", "run.terminal"]);

    const projection = JSON.parse(
      await readFile(join(baseDir, "session-a", "run-a", "run.json"), "utf8"),
    ) as { status: string };
    expect(projection.status).toBe("completed");
  });

  it("conservatively interrupts an unfinished run exactly once on recovery", async () => {
    const baseDir = join(workDir, "runs");
    const runDir = join(baseDir, "session-a", "run-a");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      join(runDir, "events.jsonl"),
      `${JSON.stringify({
        schemaVersion: 1,
        eventId: "start-a",
        runId: "run-a",
        at: "2026-07-15T00:00:00.000Z",
        type: "run.started",
        data: { sessionId: "session-a", workDir },
      })}\n`,
      "utf8",
    );

    const firstRecovery = await RunLedger.reconcileIncompleteRuns({
      baseDir,
      sessionId: "session-a",
    });
    expect(firstRecovery).toMatchObject([
      { runId: "run-a", status: "interrupted", terminalReason: "recovered_without_terminal_fact" },
    ]);
    expect(await RunLedger.reconcileIncompleteRuns({ baseDir, sessionId: "session-a" })).toEqual(
      [],
    );

    const events = (await readFile(join(runDir, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; data: Record<string, string> });
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: "run.terminal",
      data: { status: "interrupted", reason: "recovered_without_terminal_fact" },
    });
  });

  it("does not interrupt an active run owned by this process", async () => {
    const baseDir = join(workDir, "runs");
    const ledger = await RunLedger.start({
      baseDir,
      sessionId: "session-a",
      workDir,
      runId: "run-a",
    });

    expect(await RunLedger.reconcileIncompleteRuns({ baseDir, sessionId: "session-a" })).toEqual(
      [],
    );
    await ledger.finish("completed");
  });

  it("records ordered, content-free control facts for turns and completed tool observations", async () => {
    const baseDir = join(workDir, "runs");
    const ledger = await RunLedger.start({
      baseDir,
      sessionId: "session-a",
      workDir,
      runId: "run-a",
    });

    await expect(
      ledger.recordToolStarted({ callId: "call-a", toolName: "read_file", turn: 1 }),
    ).rejects.toThrow("invalid tool start fact");
    await ledger.recordTurnStarted({ turn: 1 });
    await ledger.recordToolStarted({ callId: "call-a", toolName: "read_file", turn: 1 });
    await ledger.recordToolObservationCommitted({
      callId: "call-a",
      toolName: "read_file",
      turn: 1,
      isError: false,
    });
    await ledger.finish("completed");

    const snapshot = await ledger.load();
    expect(snapshot.events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.started",
      "tool.started",
      "tool.observation_committed",
      "run.terminal",
    ]);
    const serialized = await readFile(join(baseDir, "session-a", "run-a", "events.jsonl"), "utf8");
    expect(serialized).not.toContain("secret tool output");
    expect(serialized).not.toContain("arguments");
  });

  it("records cancelled and failed terminal states at the AgentEngine boundary", async () => {
    const cancelledSession = await createPersistentSession("cancelled-session", workDir);
    const cancelledEngine = new AgentEngine({
      provider: new ScriptedProvider([{ role: "assistant", content: "unused" }]),
      registry: new EmptyRegistry(),
      workDir,
    });
    const controller = new AbortController();
    controller.abort();
    await expect(
      cancelledEngine.run(cancelledSession, undefined, undefined, controller.signal),
    ).rejects.toThrow();
    await cancelledSession.close();

    const failedSession = await createPersistentSession("failed-session", workDir);
    const failedEngine = new AgentEngine({
      provider: new ThrowingProvider(),
      registry: new EmptyRegistry(),
      workDir,
    });
    await expect(failedEngine.run(failedSession)).rejects.toThrow("provider failed");
    await failedSession.close();

    await expect(latestRunHeader(workDir, "cancelled-session")).resolves.toMatchObject({
      status: "cancelled",
      terminalReason: "aborted",
    });
    await expect(latestRunHeader(workDir, "failed-session")).resolves.toMatchObject({
      status: "failed",
      terminalReason: "Error: provider failed",
    });
  });

  it("writes tool control facts only after a real Engine tool exchange reaches Session", async () => {
    const session = await createPersistentSession("tool-session", workDir);
    const engine = new AgentEngine({
      provider: new ScriptedProvider([
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' }],
        },
        { role: "assistant", content: "done" },
      ]),
      registry: new OutputRegistry(),
      workDir,
    });

    await engine.run(session);
    await session.close();

    const events = await latestRunEvents(workDir, "tool-session");
    expect(events.map((event) => event.type)).toEqual([
      "run.started",
      "turn.started",
      "tool.started",
      "tool.observation_committed",
      "turn.started",
      "run.terminal",
    ]);
    expect(JSON.stringify(events)).not.toContain("highly sensitive tool output");
    expect(JSON.stringify(events)).not.toContain('{"path":"a.txt"}');
  });
});

async function createPersistentSession(id: string, workDir: string): Promise<Session> {
  const session = new Session(id, workDir, { persistence: true });
  await session.recover();
  await session.commitMessages({ role: "user", content: "test prompt" });
  return session;
}

async function latestRunHeader(
  workDir: string,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const directory = join(resolvePicoPaths(workDir).workspace.runs, sessionId);
  const runIds = await readdir(directory);
  expect(runIds).toHaveLength(1);
  return JSON.parse(await readFile(join(directory, runIds[0]!, "run.json"), "utf8")) as Record<
    string,
    unknown
  >;
}

async function latestRunEvents(
  workDir: string,
  sessionId: string,
): Promise<Array<{ type: string; data: Record<string, unknown> }>> {
  const directory = join(resolvePicoPaths(workDir).workspace.runs, sessionId);
  const runIds = await readdir(directory);
  expect(runIds).toHaveLength(1);
  return (await readFile(join(directory, runIds[0]!, "events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { type: string; data: Record<string, unknown> });
}

class ScriptedProvider implements LLMProvider {
  constructor(private readonly responses: readonly Message[]) {}
  private index = 0;

  async generate(): Promise<Message> {
    const response = this.responses[this.index++];
    if (!response) throw new Error("provider responses exhausted");
    return response;
  }
}

class ThrowingProvider implements LLMProvider {
  async generate(): Promise<Message> {
    throw new Error("provider failed");
  }
}

class EmptyRegistry implements Registry {
  register(_tool: BaseTool): void {}
  use(): void {}
  getAvailableTools(): ToolDefinition[] {
    return [];
  }
  async execute(call: ToolCall): Promise<ToolResult> {
    return { toolCallId: call.id, output: "unused", isError: false };
  }
  isReadOnlyTool(): boolean {
    return true;
  }
}

class OutputRegistry extends EmptyRegistry {
  override getAvailableTools(): ToolDefinition[] {
    return [{ name: "read_file", description: "read", inputSchema: {} }];
  }

  override async execute(call: ToolCall): Promise<ToolResult> {
    return { toolCallId: call.id, output: "highly sensitive tool output", isError: false };
  }
}
