import { describe, expect, it } from "vitest";
import {
  RuntimeEventReadModelIntegrityError,
  materializeRuntimeHistory,
  projectRuntimeEventsToMessages,
} from "../../src/runtime/runtime-event-read-model.js";
import type { Message } from "../../src/schema/message.js";
import type {
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
