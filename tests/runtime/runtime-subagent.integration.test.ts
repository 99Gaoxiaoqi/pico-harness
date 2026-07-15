import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Session } from "../../src/engine/session.js";
import { AgentEngine } from "../../src/engine/loop.js";
import type { Registry } from "../../src/tools/registry.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RuntimeRun, runWithRuntimeToolCall } from "../../src/runtime/runtime-run.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

class SummaryProvider implements LLMProvider {
  async generate(_messages: Message[], _tools: ToolDefinition[]): Promise<Message> {
    return {
      role: "assistant",
      content: "x".repeat(240),
      usage: { promptTokens: 3, completionTokens: 4 },
    };
  }
}

describe("runtime subagent lineage", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-subagent-"));
  });

  afterEach(async () => {
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("records a child run with parent run/tool lineage and an independent terminal fact", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const parentRun = await RuntimeRun.start({ sessionId: session.id, workDir, store });
    const registry = { getAvailableTools: () => [] } as unknown as Registry;
    const engine = new AgentEngine({
      provider: new CostTracker(new SummaryProvider(), "unknown-model", session),
      registry,
      workDir,
    });

    const result = await parentRun.run(() =>
      runWithRuntimeToolCall("parent-delegate", () =>
        engine.runSub("inspect the runtime lineage", registry, undefined, { maxTurns: 2 }),
      ),
    );

    expect(result.status).toBe("completed");
    const starts = (await store.readSession(session.id)).filter(
      (event) => event.kind === "run.started",
    );
    expect(starts).toHaveLength(2);
    const childStarted = starts.find((event) => event.runId !== parentRun.runId);
    if (!childStarted) throw new Error("missing child run");
    expect(childStarted.refs).toMatchObject({
      parentRunId: parentRun.runId,
      parentToolCallId: "parent-delegate",
    });

    const childEvents = await store.readRun(session.id, childStarted.runId);
    expect(childEvents.map((event) => event.kind)).toEqual([
      "run.started",
      "message.committed",
      "model.call.started",
      "model.call.settled",
      "message.committed",
      "message.committed",
      "run.terminal",
    ]);
    expect(childEvents.at(-1)).toMatchObject({
      kind: "run.terminal",
      data: { status: "completed" },
    });
    expect(
      childEvents
        .filter((event) => event.kind === "message.committed")
        .every((event) => event.visibility === "transcript"),
    ).toBe(true);
    await session.close();
  });
});
