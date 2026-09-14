import assert from "node:assert/strict";
import test from "node:test";
import { assertDurableTranscriptEvent } from "@pico/core";

function transcriptBase(type: string): Record<string, unknown> {
  return {
    eventId: "transcript:1",
    sequence: 1,
    createdAt: 1,
    type,
  };
}

test("Core durable transcript contract accepts canonical facts and rejects live-only facts", () => {
  assert.doesNotThrow(() =>
    assertDurableTranscriptEvent({
      ...transcriptBase("tool.started"),
      entryId: "entry:1",
      toolCallId: "tool:1",
      providerCallId: "call:1",
      name: "read_file",
      args: '{"path":"README.md"}',
    }),
  );

  assert.throws(
    () =>
      assertDurableTranscriptEvent({
        ...transcriptBase("assistant.stream.delta"),
        entryId: "entry:1",
        streamId: "stream:1",
        delta: "partial",
      }),
    /presentation-only/u,
  );

  assert.throws(
    () =>
      assertDurableTranscriptEvent({
        ...transcriptBase("entry.appended"),
        entryId: "entry:1",
        entry: { kind: "thinking", content: "   " },
      }),
    /presentation-only/u,
  );
});
