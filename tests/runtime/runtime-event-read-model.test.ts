import { describe, expect, it } from "vitest";
import {
  RuntimeEventReadModelIntegrityError,
  materializeRuntimeHistory,
  projectRuntimeEventsToMessageEntries,
  projectRuntimeEventsToMessages,
} from "../../src/runtime/runtime-event-read-model.js";
import { assertRuntimeEvent } from "../../src/runtime/runtime-event.js";
import type { Message } from "../../src/schema/message.js";
import type {
  RuntimeCheckpointRecordedEvent,
  RuntimeEvent,
  RuntimeEventBase,
  RuntimeEventVisibility,
  RuntimeHistoryRewoundEvent,
  RuntimeMessageCommittedEvent,
} from "../../src/runtime/runtime-event.js";

describe("runtime event read model", () => {
  it("projects a complete model-visible tool exchange without sharing event payloads", () => {
    const user = committed("event-user", { role: "user", content: "inspect the file" });
    const assistant = committed("event-call", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: '{"path":"a.txt"}' }],
      providerData: { nested: { source: "event" } },
    });
    const observation = committed("event-result", {
      role: "user",
      content: "file contents",
      toolCallId: "call-1",
    });
    const final = committed("event-final", { role: "assistant", content: "done" });
    const events = [user, assistant, observation, final];
    const expected = [
      user.data.message,
      assistant.data.message,
      observation.data.message,
      final.data.message,
    ];

    const projected = projectRuntimeEventsToMessages(events);
    expect(projected).toEqual(expected);
    expect(materializeRuntimeHistory(events)).toEqual(expected);
    expect(projectRuntimeEventsToMessageEntries(events)).toEqual(
      events.map((event) => ({
        eventId: event.eventId,
        message: event.kind === "message.committed" ? event.data.message : undefined,
      })),
    );

    projected[1]!.toolCalls![0]!.name = "changed";
    (projected[1]!.providerData!["nested"] as { source: string }).source = "projection";

    expect(assistant.data.message.toolCalls![0]!.name).toBe("read_file");
    expect((assistant.data.message.providerData!["nested"] as { source: string }).source).toBe(
      "event",
    );
  });

  it("skips partial, non-model, and non-message runtime events", () => {
    const events: RuntimeEvent[] = [
      runStarted("event-run-started"),
      committed("event-partial", { role: "assistant", content: "streaming" }, { partial: true }),
      committed(
        "event-internal",
        { role: "assistant", content: "private" },
        { visibility: "internal" },
      ),
      committed(
        "event-transcript",
        { role: "assistant", content: "display only" },
        { visibility: "transcript" },
      ),
      committed("event-visible", { role: "user", content: "keep this" }),
    ];

    expect(projectRuntimeEventsToMessages(events)).toEqual([
      { role: "user", content: "keep this" },
    ]);
  });

  it("replaces the projected prefix with rolling checkpoint summaries", () => {
    const user = committed("event-user", { role: "user", content: "inspect" });
    const assistant = committed("event-call", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
    });
    const observation = committed("event-result", {
      role: "user",
      content: "contents",
      toolCallId: "call-1",
    });
    const firstSummary: Message = {
      role: "user",
      content: "The file has been inspected.",
      providerData: { nested: { source: "checkpoint" } },
    };
    const firstCheckpoint = checkpoint("event-checkpoint-1", observation.eventId, firstSummary);
    const final = committed("event-final", { role: "assistant", content: "done" });
    const secondCheckpoint = checkpoint("event-checkpoint-2", firstCheckpoint.eventId, {
      role: "user",
      content: "The inspection is summarized.",
    });
    const finalCheckpoint = checkpoint("event-checkpoint-3", final.eventId, {
      role: "user",
      content: "The task is complete.",
    });

    const entries = projectRuntimeEventsToMessageEntries([
      user,
      assistant,
      observation,
      firstCheckpoint,
      final,
      secondCheckpoint,
      finalCheckpoint,
    ]);

    expect(entries).toEqual([
      {
        eventId: finalCheckpoint.eventId,
        message: { role: "user", content: "The task is complete." },
      },
    ]);
    expect(
      materializeRuntimeHistory([user, assistant, observation, firstCheckpoint, final]),
    ).toEqual([firstSummary, final.data.message]);

    const firstCheckpointEntry = projectRuntimeEventsToMessageEntries([
      user,
      assistant,
      observation,
      firstCheckpoint,
    ])[0]!;
    firstCheckpointEntry.message.content = "mutated projection";
    (firstCheckpointEntry.message.providerData!["nested"] as { source: string }).source = "mutated";

    expect(firstSummary.content).toBe("The file has been inspected.");
    expect((firstSummary.providerData!["nested"] as { source: string }).source).toBe("checkpoint");
  });

  it("rejects unmatched tool calls and observations without a source batch", () => {
    expect(() =>
      materializeRuntimeHistory([
        committed("event-call", {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
        }),
      ]),
    ).toThrow(RuntimeEventReadModelIntegrityError);

    expect(() =>
      projectRuntimeEventsToMessages([
        committed("event-orphan", { role: "user", content: "orphan", toolCallId: "call-missing" }),
      ]),
    ).toThrow(RuntimeEventReadModelIntegrityError);
  });

  it("rewinds the visible projection through the referenced event without deleting facts", () => {
    const user = committed("event-user", { role: "user", content: "inspect" });
    const assistant = committed("event-call", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
    });
    const observation = committed("event-result", {
      role: "user",
      content: "contents",
      toolCallId: "call-1",
    });
    const discarded = committed("event-discarded", { role: "assistant", content: "old answer" });
    const rewind = historyRewound("event-rewind", observation.eventId);
    const replacement = committed("event-replacement", {
      role: "assistant",
      content: "new answer",
    });
    const events = [user, assistant, observation, discarded, rewind, replacement];

    expect(materializeRuntimeHistory(events)).toEqual([
      user.data.message,
      assistant.data.message,
      observation.data.message,
      replacement.data.message,
    ]);
    expect(events).toContain(discarded);
    expect(discarded.data.message.content).toBe("old answer");
  });

  it("rejects checkpoints that leave an unpaired tool observation", () => {
    const user = committed("event-user", { role: "user", content: "inspect" });
    const assistant = committed("event-call", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "call-1", name: "read_file", arguments: "{}" }],
    });
    const observation = committed("event-result", {
      role: "user",
      content: "contents",
      toolCallId: "call-1",
    });
    const checkpointEvent = checkpoint("event-checkpoint", assistant.eventId, {
      role: "user",
      content: "The tool call is summarized.",
    });

    expect(() =>
      materializeRuntimeHistory([user, assistant, observation, checkpointEvent]),
    ).toThrow("Tool result call-1 has no preceding tool-call batch");
  });

  it("rejects checkpoint and rewind references that are unknown or no longer projected", () => {
    const user = committed("event-user", { role: "user", content: "inspect" });
    const checkpointEvent = checkpoint("event-checkpoint", user.eventId, {
      role: "user",
      content: "The request is summarized.",
    });
    const staleCheckpoint = checkpoint("event-checkpoint-stale", user.eventId, {
      role: "user",
      content: "This should not be reachable.",
    });

    expect(() => materializeRuntimeHistory([checkpointEvent])).toThrow(
      "Runtime checkpoint event-checkpoint references an unknown prior event event-user",
    );
    expect(() => materializeRuntimeHistory([user, checkpointEvent, staleCheckpoint])).toThrow(
      "Runtime checkpoint event-checkpoint-stale references event event-user, but it is not in the current model projection",
    );
    expect(() =>
      materializeRuntimeHistory([historyRewound("event-rewind", "event-missing")]),
    ).toThrow(
      "Runtime history rewind event-rewind references an unknown prior event event-missing",
    );
  });

  it("validates paired rolling checkpoint fields while keeping legacy checkpoint facts decodable", () => {
    const checkpointEvent = checkpoint("event-checkpoint", "event-user", {
      role: "user",
      content: "The request is summarized.",
    });

    expect(() => assertRuntimeEvent(checkpointEvent)).not.toThrow();
    expect(() =>
      assertRuntimeEvent({
        ...checkpointEvent,
        data: {
          checkpointId: "checkpoint-1",
          coveredEventCount: 1,
          sourceDigest: "digest-1",
          throughEventId: "event-user",
        },
      }),
    ).toThrow("Runtime checkpoint must include throughEventId and summary together");
    expect(() =>
      assertRuntimeEvent({
        ...checkpointEvent,
        data: {
          checkpointId: "checkpoint-1",
          coveredEventCount: 1,
          sourceDigest: "digest-1",
          throughEventId: "event-user",
          summary: { role: "tool", content: "not model-readable" },
        },
      }),
    ).toThrow("Runtime message payload is invalid");
    expect(() => assertRuntimeEvent(legacyCheckpoint("event-legacy-checkpoint"))).not.toThrow();
  });
});

function committed(
  eventId: string,
  message: Message,
  options: { readonly partial?: boolean; readonly visibility?: RuntimeEventVisibility } = {},
): RuntimeMessageCommittedEvent {
  return {
    ...eventBase(eventId, options),
    kind: "message.committed",
    data: { message },
  };
}

function historyRewound(eventId: string, throughEventId: string): RuntimeHistoryRewoundEvent {
  return {
    ...eventBase(eventId),
    kind: "history.rewound",
    data: { branchId: "main", throughEventId },
  };
}

function checkpoint(
  eventId: string,
  throughEventId: string,
  summary: Message,
): RuntimeCheckpointRecordedEvent {
  return {
    ...eventBase(eventId, { visibility: "internal" }),
    kind: "context.checkpoint.recorded",
    data: {
      checkpointId: `checkpoint:${eventId}`,
      coveredEventCount: 1,
      sourceDigest: `digest:${eventId}`,
      throughEventId,
      summary,
    },
  };
}

function legacyCheckpoint(eventId: string): RuntimeCheckpointRecordedEvent {
  return {
    ...eventBase(eventId, { visibility: "internal" }),
    kind: "context.checkpoint.recorded",
    data: {
      checkpointId: `checkpoint:${eventId}`,
      coveredEventCount: 0,
      sourceDigest: `digest:${eventId}`,
    },
  };
}

function runStarted(eventId: string): RuntimeEvent {
  return {
    ...eventBase(eventId),
    kind: "run.started",
    data: { workDir: "/workspace" },
  };
}

function eventBase(
  eventId: string,
  options: { readonly partial?: boolean; readonly visibility?: RuntimeEventVisibility } = {},
): RuntimeEventBase {
  return {
    schemaVersion: 1,
    eventId,
    sessionId: "session-1",
    invocationId: "invocation-1",
    runId: "run-1",
    turnId: "turn-1",
    at: "2026-07-15T00:00:00.000Z",
    partial: options.partial ?? false,
    visibility: options.visibility ?? "model",
  };
}
