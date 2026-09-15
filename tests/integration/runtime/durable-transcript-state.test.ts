import assert from "node:assert/strict";
import test from "node:test";
import type { DurableTranscriptEvent } from "@pico/core/durable-transcript-contract";
import { inspectDurableTranscriptEvents } from "@pico/runtime/durable-transcript-state";
import { projectTranscriptEvents } from "@pico/pico-host/transcript-event-store";

test("Runtime durable Transcript inspector matches the presentation projector tool state", () => {
  const events: DurableTranscriptEvent[] = [
    {
      eventId: "event-1",
      sequence: 1,
      createdAt: 1,
      type: "assistant.stream.started",
      entryId: "entry-assistant",
      streamId: "stream-1",
      delta: "working",
      entryKind: "assistant",
    },
    {
      eventId: "event-2",
      sequence: 2,
      createdAt: 2,
      type: "assistant.stream.completed",
      entryId: "entry-assistant",
      streamId: "stream-1",
      content: "done",
    },
    {
      eventId: "event-3",
      sequence: 3,
      createdAt: 3,
      type: "tool.started",
      entryId: "entry-tool-1",
      toolCallId: "tool-1",
      providerCallId: "provider-1",
      name: "read_file",
      args: "{}",
    },
    {
      eventId: "event-4",
      sequence: 4,
      createdAt: 4,
      type: "tool.approval.requested",
      toolCallId: "tool-1",
      summary: "approve read",
    },
    {
      eventId: "event-5",
      sequence: 5,
      createdAt: 5,
      type: "tool.started",
      entryId: "entry-tool-2",
      toolCallId: "tool-2",
      providerCallId: "provider-1",
      name: "glob",
      args: "{}",
    },
    {
      eventId: "event-6",
      sequence: 6,
      createdAt: 6,
      type: "transcript.truncated",
      entryCount: 2,
      operationId: "truncate-1",
    },
  ];

  const presentation = projectTranscriptEvents(events);
  const runtime = inspectDurableTranscriptEvents(events);
  assert.deepEqual(runtime.activeToolCallIds, Object.keys(presentation.toolCalls));
  assert.deepEqual(runtime.activeToolCallIds, ["tool-1"]);
  assert.equal(runtime.sequence, presentation.sequence);
});

test("Runtime durable Transcript inspector rejects duplicate entry identity", () => {
  const events: DurableTranscriptEvent[] = [
    {
      eventId: "event-1",
      sequence: 1,
      createdAt: 1,
      type: "entry.appended",
      entryId: "entry-1",
      entry: { kind: "user", content: "first" },
    },
    {
      eventId: "event-2",
      sequence: 2,
      createdAt: 2,
      type: "entry.appended",
      entryId: "entry-1",
      entry: { kind: "user", content: "duplicate" },
    },
  ];

  assert.throws(() => projectTranscriptEvents(events), /Duplicate Transcript entry ID/u);
  assert.throws(() => inspectDurableTranscriptEvents(events), /Duplicate Transcript entry ID/u);
});
