import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { projectRuntimeTranscript } from "../../src/daemon/desktop-transcript.js";
import {
  encodeRuntimeFrame,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  MAX_RUNTIME_FRAME_BYTES,
} from "../../src/daemon/protocol.js";
import { replaySessionRecords } from "../../src/engine/session-reducer.js";
import {
  createEmptyUsageSnapshot,
  type SessionHydrationSnapshot,
} from "../../src/engine/session-runtime.js";
import { createSessionIdentity } from "../../src/engine/session-identity.js";
import { SessionStore } from "../../src/engine/session-store.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";
import type { Message } from "../../src/schema/message.js";

describe("Desktop Transcript durable projection integration", () => {
  const cleanups: string[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((path) => rm(path, { recursive: true, force: true })));
  });

  it("restarts from Session JSONL and restores structured entries through the shared projector", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-desktop-transcript-"));
    cleanups.push(workDir);
    const filePath = join(workDir, "session.jsonl");
    const identity = createSessionIdentity({ sessionId: "desktop-restart", cwd: workDir });
    const first = new SessionStore(filePath, identity);
    const events: TranscriptEvent[] = [
      entryEvent(1, "plan", {
        kind: "plan",
        title: "Implementation plan",
        detail: "Persist the transcript",
        state: "active",
      }),
      entryEvent(2, "approval", {
        kind: "approval",
        title: "Allow command?",
        state: "waiting",
        data: { approvalId: "approval-1" },
      }),
      entryEvent(3, "prompt", {
        kind: "prompt",
        title: "Choose a target",
        state: "waiting",
        data: { promptId: "prompt-1" },
      }),
      entryEvent(4, "changes", {
        kind: "changes",
        title: "2 files changed",
        state: "ready",
        data: { additions: 12, deletions: 3 },
      }),
      entryEvent(5, "run", {
        kind: "run-boundary",
        runId: "run-1",
        status: "failed",
        startedAt: 10,
        finishedAt: 20,
        error: "模型路由缺少凭证",
      }),
      {
        eventId: "transcript-event-6",
        sequence: 6,
        createdAt: 60,
        type: "subagent.activity.updated",
        entryId: "entry-subagent",
        activityId: "activity-1",
        activity: {
          task: "Review persistence",
          status: "completed",
          agentName: "Reviewer",
          summary: "No hidden sidecar",
        },
      },
    ];
    await first.commitMessage({ role: "user", content: "visible user message" });
    await first.commitMessage({ role: "system", content: "SECRET_SYSTEM_INJECTION" });
    await first.commitTranscriptEvent(events[0]!);
    await first.commitMessage({
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tool-1", name: "read_file", arguments: '{"path":"README.md"}' }],
    });
    await first.commitMessage({
      role: "user",
      content: "SECRET_RAW_TOOL_RESULT",
      toolCallId: "tool-1",
    });
    for (const event of events.slice(1)) await first.commitTranscriptEvent(event);
    await first.close();

    const restarted = new SessionStore(filePath, identity);
    const replay = replaySessionRecords(await restarted.loadStrict());
    await restarted.close();
    const page = projectRuntimeTranscript(
      hydration(
        workDir,
        replay.history,
        replay.historySequences,
        replay.transcriptEvents,
        replay.transcriptEventSequences,
        replay.maxSeq,
      ),
      { limit: 100 },
    );

    expect(page.items.map((item) => item.kind)).toEqual([
      "userMessage",
      "plan",
      "tool",
      "approval",
      "prompt",
      "changes",
      "runBoundary",
      "subagent",
    ]);
    expect(page.items.find((item) => item.kind === "subagent")).toMatchObject({
      state: "completed",
      data: { activityId: "activity-1" },
    });
    expect(page.items.find((item) => item.kind === "runBoundary")).toMatchObject({
      status: "failed",
      error: "模型路由缺少凭证",
    });
    expect(JSON.stringify(page.items)).not.toContain("SECRET_SYSTEM_INJECTION");
    expect(JSON.stringify(page.items)).not.toContain("SECRET_RAW_TOOL_RESULT");
  });

  it("keeps a compaction summary before retained messages", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-desktop-compaction-order-"));
    cleanups.push(workDir);
    const identity = createSessionIdentity({ sessionId: "desktop-compaction", cwd: workDir });
    const store = new SessionStore(join(workDir, "session.jsonl"), identity);
    const retainedMessage: Message = { role: "user", content: "retained user message" };
    const summaryMessage: Message = {
      role: "assistant",
      content: "summary of older messages",
      providerData: { picoKind: "compaction_summary" },
    };
    await store.commitMessage({ role: "user", content: "old user message" });
    await store.commitMessage({ role: "assistant", content: "old assistant message" });
    await store.commitMessage(retainedMessage);
    await store.commitCompaction(summaryMessage, [retainedMessage]);

    const replay = replaySessionRecords(await store.loadStrict());
    await store.close();
    const page = projectRuntimeTranscript(
      hydration(
        workDir,
        replay.history,
        replay.historySequences,
        replay.transcriptEvents,
        replay.transcriptEventSequences,
        replay.maxSeq,
        "desktop-compaction",
      ),
      { limit: 100 },
    );

    expect(page.items.map((item) => ("content" in item ? item.content : item.kind))).toEqual([
      "summary of older messages",
      "retained user message",
    ]);
  });

  it("drops structured entries from a rewound turn and keeps later replacements", async () => {
    const workDir = await mkdtemp(join(tmpdir(), "pico-desktop-rewind-transcript-"));
    cleanups.push(workDir);
    const identity = createSessionIdentity({ sessionId: "desktop-rewind", cwd: workDir });
    const store = new SessionStore(join(workDir, "session.jsonl"), identity);
    await store.commitMessage({ role: "user", content: "keep this prompt" });
    await store.commitTranscriptEvent(
      entryEvent(1, "old-plan", { kind: "plan", title: "obsolete plan", state: "active" }),
    );
    await store.commitMessage({ role: "assistant", content: "obsolete answer" });
    await store.commitTranscriptEvent(
      entryEvent(2, "old-tool", {
        kind: "tool",
        name: "write_file",
        args: '{"path":"obsolete.txt"}',
        status: "completed",
      }),
    );
    await store.commitRewind(1);
    await store.commitMessage({ role: "assistant", content: "replacement answer" });
    await store.commitTranscriptEvent(
      entryEvent(1, "new-changes", {
        kind: "changes",
        title: "replacement changes",
        state: "ready",
      }),
    );

    const replay = replaySessionRecords(await store.loadStrict());
    await store.close();
    const page = projectRuntimeTranscript(
      hydration(
        workDir,
        replay.history,
        replay.historySequences,
        replay.transcriptEvents,
        replay.transcriptEventSequences,
        replay.maxSeq,
        "desktop-rewind",
      ),
      { limit: 100 },
    );

    expect(page.items.map((item) => item.kind)).toEqual([
      "userMessage",
      "assistantMessage",
      "changes",
    ]);
    expect(JSON.stringify(page.items)).not.toContain("obsolete");
  });

  it("paginates by serialized UTF-8 bytes and marks an oversized item as truncated", () => {
    const workDir = "/tmp/pico-transcript-byte-budget";
    const hugeMultibyteMessage = "汉🤖".repeat(350_000);
    const page = projectRuntimeTranscript(
      hydration(workDir, [{ role: "assistant", content: hugeMultibyteMessage }], [1], [], [], 1),
      { limit: 100, maxBytes: 8 * 1024 },
    );

    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({
      kind: "assistantMessage",
      truncated: true,
    });
    expect(page.items[0]?.originalBytes).toBeGreaterThan(1024 * 1024);
    expect((page.items[0] as { content: string }).content.endsWith("�")).toBe(false);
  });

  it("keeps contiguous pagination below the 1 MB frame limit", () => {
    const workDir = "/tmp/pico-transcript-frame-budget";
    const messages: Message[] = [
      { role: "assistant", content: "a".repeat(620_000) },
      { role: "assistant", content: "b".repeat(620_000) },
    ];
    const page = projectRuntimeTranscript(hydration(workDir, messages, [], [], [], 2), {
      limit: 100,
    });

    expect(Buffer.byteLength(JSON.stringify(page), "utf8")).toBeLessThan(1024 * 1024);
    expect(page.items).toHaveLength(1);
    expect(page.nextBefore).toBeDefined();
    expect(page.items[0]).toMatchObject({ kind: "assistantMessage" });
    const frame = encodeRuntimeFrame({
      kind: "response",
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      requestId: "transcript-byte-budget",
      ok: true,
      result: {
        items: page.items,
        ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}),
        revision: page.revision,
      },
    });
    expect(frame.readUInt32BE(0)).toBeLessThanOrEqual(MAX_RUNTIME_FRAME_BYTES);
  });
});

function entryEvent(
  sequence: number,
  suffix: string,
  entry: Extract<TranscriptEvent, { type: "entry.appended" }>["entry"],
): TranscriptEvent {
  return {
    eventId: `transcript-event-${sequence}`,
    sequence,
    createdAt: sequence * 10,
    type: "entry.appended",
    entryId: `entry-${suffix}`,
    entry,
  };
}

function hydration(
  workDir: string,
  messages: readonly Message[],
  messageSequences: readonly number[],
  transcriptEvents: readonly TranscriptEvent[],
  transcriptEventSequences: readonly number[],
  persistenceSequence: number,
  sessionId = "desktop-restart",
): SessionHydrationSnapshot {
  return {
    schemaVersion: 1,
    persistenceSequence,
    sessionId,
    conversationId: `${sessionId}:0`,
    workDir,
    identity: createSessionIdentity({ sessionId, cwd: workDir }),
    createdAt: "2026-07-15T00:00:00.000Z",
    updatedAt: "2026-07-15T00:00:01.000Z",
    messages: structuredClone(messages),
    messageSequences: [...messageSequences],
    transcriptEvents: structuredClone(transcriptEvents),
    transcriptEventSequences: [...transcriptEventSequences],
    runtime: { stateVersion: 1, usage: createEmptyUsageSnapshot() },
  };
}
