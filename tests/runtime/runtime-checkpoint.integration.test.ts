import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Compactor } from "../../src/context/compactor.js";
import { FullCompactor } from "../../src/context/full-compactor.js";
import { Session } from "../../src/engine/session.js";
import { AgentEngine } from "../../src/engine/loop.js";
import { SilentReporter } from "../../src/engine/reporter.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import type { Registry } from "../../src/tools/registry.js";

class FinalProvider implements LLMProvider {
  async generate(_messages: Message[], _tools: ToolDefinition[]): Promise<Message> {
    return {
      role: "assistant",
      content: "completed after checkpoint",
      usage: { promptTokens: 4, completionTokens: 3 },
    };
  }
}

class SummaryProvider implements LLMProvider {
  async generate(_messages: Message[], _tools: ToolDefinition[]): Promise<Message> {
    return {
      role: "assistant",
      content: "Durable summary of the earlier conversation.",
      usage: { promptTokens: 6, completionTokens: 2 },
    };
  }
}

describe("runtime checkpoint integration", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-checkpoint-"));
  });

  afterEach(async () => {
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("uses a canonical checkpoint for model context without compacting the Session/UI projection", async () => {
    const session = new Session("session-a", workDir, { persistence: true });
    await session.recover();
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const runtimeRun = await RuntimeRun.start({ sessionId: session.id, workDir, store });
    const registry = { getAvailableTools: () => [] } as unknown as Registry;
    const engine = new AgentEngine({
      provider: new CostTracker(new FinalProvider(), "unknown-model", session),
      registry,
      workDir,
      reporter: new SilentReporter(),
      compactor: new Compactor({ maxChars: 100_000, retainLastMsgs: 20 }),
      fullCompactor: new FullCompactor({
        provider: new CostTracker(new SummaryProvider(), "unknown-model", session),
      }),
      contextBudget: {
        contextWindowTokens: 1_600,
        reservedOutputTokens: 176,
        safetyMarginTokens: 1_024,
        inputBudgetTokens: 400,
      },
    });
    const rawHistory: Message[] = Array.from({ length: 8 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      content: Array.from({ length: 60 }, (_, word) => `item-${index}-${word}`).join(" "),
    }));

    await runtimeRun.run(() =>
      session.serialize(async () => {
        await session.commitMessages(...rawHistory);
        return engine.run(session);
      }),
    );

    const events = await store.readSession(session.id);
    const checkpoint = events.find((event) => event.kind === "context.checkpoint.recorded");
    expect(checkpoint).toMatchObject({
      data: {
        coveredEventCount: expect.any(Number),
        throughEventId: expect.any(String),
        summary: {
          role: "assistant",
          providerData: { picoKind: "runtime_checkpoint" },
        },
      },
    });
    expect(session.getHistory()).toHaveLength(rawHistory.length + 1);
    expect(session.getHistory()[0]?.content).toBe(rawHistory[0]?.content);
    const modelHistory = await runtimeRun.readModelHistory();
    expect(modelHistory.length).toBeLessThan(session.length);
    expect(modelHistory[0]?.providerData?.["picoKind"]).toBe("runtime_checkpoint");
    expect(modelHistory.at(-1)?.content).toBe("completed after checkpoint");
    expect(events.filter((event) => event.kind === "model.call.settled")).toHaveLength(2);
    await expect(RuntimeRun.repairSessionProjection(session, { workDir, store })).resolves.toBe(
      false,
    );
    await session.close();
  });
});
