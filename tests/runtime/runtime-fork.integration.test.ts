import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager, SessionManager } from "../../src/engine/session.js";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message } from "../../src/schema/message.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { materializeRuntimeHistory } from "../../src/runtime/runtime-event-read-model.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";

describe("runtime session fork", () => {
  let workDir: string;
  let sessions: SessionManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-fork-"));
    sessions = new SessionManager();
  });

  afterEach(async () => {
    sessions.clear();
    globalSessionManager.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("materializes the frozen fork seed without leaking later parent history or usage", async () => {
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    const source = await sessions.getOrCreate("source-a", workDir, { persistence: true });
    await store.initializeSession({ sessionId: source.id, workDir });
    await store.append(runStarted("source-a", "source-run"));
    await store.append(
      message("source-a", "source-run", "source-user", { role: "user", content: "inspect this" }),
    );
    await store.append(
      message("source-a", "source-run", "source-assistant", {
        role: "assistant",
        content: "source answer",
        usage: { promptTokens: 11, completionTokens: 5 },
      }),
    );
    await RuntimeRun.repairSessionProjection(source, { workDir, store });

    await expect(
      new SessionForkService({
        workDir,
        sessionManager: sessions,
        hooks: {
          beforeRuntimeBootstrap() {
            throw new Error("injected crash before Runtime bootstrap");
          },
        },
      }).fork({
        sourceSessionId: source.id,
        targetSessionId: "target-a",
        targetMode: "default",
      }),
    ).rejects.toThrow("injected crash before Runtime bootstrap");
    const target = await sessions.getOrCreate("target-a", workDir, { persistence: true });
    const seed = await target.readDurableRuntimeForkSeed();
    expect(seed).toEqual({
      sourceSessionId: source.id,
      messages: [
        { role: "user", content: "inspect this" },
        { role: "assistant", content: "source answer" },
      ],
    });

    await source.commitMessages({ role: "user", content: "written after fork" });

    await RuntimeRun.bootstrapFork({
      sourceSessionId: source.id,
      targetSessionId: target.id,
      messages: seed!.messages,
      workDir,
      store,
    });
    await RuntimeRun.repairSessionProjection(target, { workDir, store });

    const targetEvents = await store.readSession(target.id);
    expect(targetEvents.some((event) => event.kind === "session.forked")).toBe(true);
    expect(targetEvents.filter((event) => event.kind === "message.committed")).toHaveLength(2);
    expect(target.getModelContext()).toEqual(seed!.messages);
    expect(
      target.getModelContext().some((message) => message.content === "written after fork"),
    ).toBe(false);
    expect(await store.readSessionManifest(target.id)).toMatchObject({
      sessionId: target.id,
      historySource: "runtime-event-v1",
    });
    expect(targetEvents.find((event) => event.kind === "session.forked")?.data).toMatchObject({
      parentSessionId: source.id,
      throughEventId: "source-assistant",
      messageCount: seed!.messages.length,
    });
    expect(targetEvents.at(-1)?.kind).toBe("run.terminal");
    await target.close();

    const reopened = await new SessionManager().getOrCreate("target-a", workDir, {
      persistence: true,
    });
    expect(reopened.getRuntimeStateSnapshot().usage).toMatchObject({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      totalProviderCalls: 0,
    });
    await reopened.close();
  });

  it("resumes a partial Runtime fork bootstrap from the target's durable seed", async () => {
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    const source = await sessions.getOrCreate("source-a", workDir, { persistence: true });
    await store.initializeSession({ sessionId: source.id, workDir });
    await store.append(runStarted("source-a", "source-run"));
    await store.append(
      message("source-a", "source-run", "source-user", { role: "user", content: "inspect this" }),
    );
    await store.append(
      message("source-a", "source-run", "source-assistant", {
        role: "assistant",
        content: "source answer",
      }),
    );
    await RuntimeRun.repairSessionProjection(source, { workDir, store });
    await expect(
      new SessionForkService({
        workDir,
        sessionManager: sessions,
        hooks: {
          beforeRuntimeBootstrap() {
            throw new Error("injected crash before Runtime bootstrap");
          },
        },
      }).fork({
        sourceSessionId: source.id,
        targetSessionId: "target-a",
        targetMode: "default",
      }),
    ).rejects.toThrow("injected crash before Runtime bootstrap");
    expect(await store.readSessionManifest("target-a")).toBeUndefined();
    const target = await sessions.getOrCreate("target-a", workDir, { persistence: true });
    const seed = await target.readDurableRuntimeForkSeed();
    expect(seed).toBeDefined();

    const interrupted = await RuntimeRun.start({
      sessionId: target.id,
      workDir,
      store,
    });
    await interrupted.run(async () => {
      await interrupted.recordImportedMessage(seed!.messages[0]!);
    });

    await expect(
      RuntimeRun.bootstrapFork({
        sourceSessionId: seed!.sourceSessionId,
        targetSessionId: target.id,
        messages: seed!.messages,
        workDir,
        store,
      }),
    ).resolves.toBe(true);
    await RuntimeRun.repairSessionProjection(target, { workDir, store });

    const events = await store.readSession(target.id);
    expect(events.filter((event) => event.kind === "message.committed")).toHaveLength(
      seed!.messages.length,
    );
    expect(events.filter((event) => event.kind === "session.forked")).toHaveLength(1);
    expect(events.find((event) => event.kind === "session.forked")?.data).toMatchObject({
      parentSessionId: source.id,
      messageCount: seed!.messages.length,
    });
    expect(target.getModelContext()).toEqual(seed!.messages);
    await expect(
      RuntimeRun.bootstrapFork({
        sourceSessionId: seed!.sourceSessionId,
        targetSessionId: target.id,
        messages: seed!.messages,
        workDir,
        store,
      }),
    ).resolves.toBe(false);
    await target.close();
  });

  it("AgentRuntime resumes a published fork seed before constructing model context", async () => {
    const store = new RuntimeEventStore({ baseDir: resolvePicoPaths(workDir).workspace.runs });
    const source = await sessions.getOrCreate("source-a", workDir, { persistence: true });
    await store.initializeSession({ sessionId: source.id, workDir });
    await store.append(runStarted("source-a", "source-run"));
    await store.append(
      message("source-a", "source-run", "source-user", { role: "user", content: "inspect this" }),
    );
    await store.append(
      message("source-a", "source-run", "source-assistant", {
        role: "assistant",
        content: "source answer",
      }),
    );
    await RuntimeRun.repairSessionProjection(source, { workDir, store });
    await expect(
      new SessionForkService({
        workDir,
        sessionManager: sessions,
        hooks: {
          beforeRuntimeBootstrap() {
            throw new Error("injected crash before Runtime bootstrap");
          },
        },
      }).fork({
        sourceSessionId: source.id,
        targetSessionId: "target-a",
        targetMode: "default",
      }),
    ).rejects.toThrow("injected crash before Runtime bootstrap");
    expect(await store.readSessionManifest("target-a")).toBeUndefined();

    const provider = new ForkCompletionProvider();
    const result = await executeAgentRuntime(
      { prompt: "continue from the fork", dir: workDir, session: "target-a" },
      { provider, reporter: new SilentReporter() },
    );

    expect(result.finalMessage).toBe("fork resumed");
    expect(provider.calls).toHaveLength(1);
    const events = await store.readSession("target-a");
    expect(events.filter((event) => event.kind === "history.rewound")).toEqual([]);
    expect(materializeRuntimeHistory(events).map((message) => message.content)).toEqual(
      expect.arrayContaining(["inspect this", "source answer", "continue from the fork"]),
    );
    expect(provider.calls[0]?.map((message) => message.content)).toEqual(
      expect.arrayContaining(["inspect this", "source answer", "continue from the fork"]),
    );
    expect(events.filter((event) => event.kind === "session.forked")).toHaveLength(1);
    expect(events.find((event) => event.kind === "session.forked")?.data).toMatchObject({
      parentSessionId: source.id,
      messageCount: 2,
    });
  });
});

class ForkCompletionProvider implements LLMProvider {
  readonly calls: Message[][] = [];

  async generate(messages: Message[]): Promise<Message> {
    this.calls.push(structuredClone(messages));
    return { role: "assistant", content: "fork resumed" };
  }
}

function runStarted(sessionId: string, runId: string): RuntimeEvent {
  return {
    ...eventBase(sessionId, runId, "run-started"),
    kind: "run.started",
    data: { workDir: "/workspace" },
  };
}

function message(
  sessionId: string,
  runId: string,
  eventId: string,
  value: {
    role: "user" | "assistant";
    content: string;
    usage?: { promptTokens: number; completionTokens: number };
  },
): RuntimeEvent {
  return {
    ...eventBase(sessionId, runId, eventId),
    kind: "message.committed",
    data: { message: value },
  };
}

function eventBase(sessionId: string, runId: string, eventId: string) {
  return {
    schemaVersion: 1 as const,
    eventId,
    sessionId,
    invocationId: "invocation-a",
    runId,
    turnId: "turn-a",
    at: "2026-07-15T00:00:00.000Z",
    partial: false,
    visibility: "model" as const,
  };
}
