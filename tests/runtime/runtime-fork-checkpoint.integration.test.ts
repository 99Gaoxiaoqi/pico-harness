import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SessionForkService } from "../../src/engine/session-fork-service.js";
import { SessionManager } from "../../src/engine/session.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { RuntimeEvent } from "../../src/runtime/runtime-event.js";
import { materializeRuntimeHistory } from "../../src/runtime/runtime-event-read-model.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { RuntimeRun } from "../../src/runtime/runtime-run.js";
import type { Message } from "../../src/schema/message.js";

describe("runtime fork checkpoint projection", () => {
  let workDir: string;
  let sessions: SessionManager;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-runtime-fork-checkpoint-"));
    sessions = new SessionManager();
  });

  afterEach(async () => {
    sessions.clear();
    await rm(resolvePicoPaths(workDir).workspace.root, { recursive: true, force: true });
    await rm(workDir, { recursive: true, force: true });
  });

  it("preserves the source checkpoint model projection while retaining the full transcript", async () => {
    const store = new RuntimeEventStore({
      databasePath: resolvePicoPaths(workDir).workspace.runtimeDatabase,
    });
    const source = await sessions.getOrCreate("source-checkpoint", workDir, {
      persistence: true,
    });
    await store.initializeSession({ sessionId: source.id, workDir });
    await store.append(runStarted(source.id, "source-run", workDir));
    await store.append(message(source.id, "source-run", "source-old-user", "user", "old user"));
    await store.append(
      message(source.id, "source-run", "source-old-assistant", "assistant", "old answer"),
    );
    await store.append(checkpoint(source.id, "source-run"));
    await store.append(message(source.id, "source-run", "source-tail-user", "user", "tail user"));
    await store.append(
      message(source.id, "source-run", "source-tail-assistant", "assistant", "tail answer"),
    );
    await store.append(runTerminal(source.id, "source-run"));
    await RuntimeRun.repairSessionProjection(source, { workDir, store });

    const sourceEvents = await store.readSession(source.id);
    const sourceTranscript = source.getHistory();
    const sourceModelHistory = materializeRuntimeHistory(sourceEvents);
    expect(sourceTranscript.map(({ content }) => content)).toEqual([
      "old user",
      "old answer",
      "tail user",
      "tail answer",
    ]);
    expect(sourceModelHistory.map(({ content }) => content)).toEqual([
      "summary of old exchange",
      "tail user",
      "tail answer",
    ]);

    await expect(
      new SessionForkService({ workDir, sessionManager: sessions, runtimeStore: store }).fork({
        sourceSessionId: source.id,
        targetSessionId: "target-checkpoint",
        targetMode: "default",
      }),
    ).resolves.toMatchObject({ operation: { state: "completed" } });

    const target = await sessions.getOrCreate("target-checkpoint", workDir, {
      persistence: true,
    });
    const targetEvents = await store.readSession(target.id);
    expect(target.getHistory()).toEqual(sourceTranscript);
    expect(materializeRuntimeHistory(targetEvents)).toEqual(sourceModelHistory);
    expect(targetEvents.filter((event) => event.kind === "context.checkpoint.recorded")).toHaveLength(
      1,
    );
    await source.close();
    await target.close();
  });
});

function runStarted(sessionId: string, runId: string, workDir: string): RuntimeEvent {
  return {
    ...eventBase(sessionId, runId, "source-started", "internal"),
    kind: "run.started",
    data: { workDir },
  };
}

function message(
  sessionId: string,
  runId: string,
  eventId: string,
  role: Message["role"],
  content: string,
): RuntimeEvent {
  return {
    ...eventBase(sessionId, runId, eventId, "model"),
    kind: "message.committed",
    data: { message: { role, content } },
  };
}

function checkpoint(sessionId: string, runId: string): RuntimeEvent {
  return {
    ...eventBase(sessionId, runId, "source-checkpoint", "internal"),
    kind: "context.checkpoint.recorded",
    data: {
      checkpointId: "checkpoint-a",
      coveredEventCount: 2,
      sourceDigest: "source-prefix-digest",
      throughEventId: "source-old-assistant",
      summary: {
        role: "assistant",
        content: "summary of old exchange",
        providerData: { picoKind: "runtime_checkpoint" },
      },
    },
  };
}

function runTerminal(sessionId: string, runId: string): RuntimeEvent {
  return {
    ...eventBase(sessionId, runId, "source-terminal", "internal"),
    kind: "run.terminal",
    data: { status: "completed" },
  };
}

function eventBase(
  sessionId: string,
  runId: string,
  eventId: string,
  visibility: "model" | "internal",
) {
  return {
    schemaVersion: 1 as const,
    eventId,
    sessionId,
    invocationId: "source-invocation",
    runId,
    turnId: "source-turn",
    at: "2026-07-15T00:00:00.000Z",
    partial: false,
    visibility,
  };
}
