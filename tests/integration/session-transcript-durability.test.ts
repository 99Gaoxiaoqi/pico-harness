import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Session } from "../../src/engine/session.js";
import type { TranscriptEvent } from "../../src/presentation/transcript-event-store.js";

test("history rewind preserves transcript facts and Session assigns the next durable sequence", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-session-transcript-rewind-"));
  const session = new Session("transcript-rewind", join(root, "workspace"), {
    persistence: true,
    picoHome: join(root, "pico-home"),
  });
  context.after(async () => {
    await session.close();
    await rm(root, { recursive: true, force: true });
  });
  await session.recover();

  await session.commitMessages({ role: "user", content: "kept" });
  await session.recordTranscriptEvent(
    event(99, "user", "entry.appended", {
      entryId: "entry:user",
      entry: { kind: "user", content: "kept" },
    }),
  );
  await session.commitMessages({ role: "assistant", content: "rewound answer" });
  await session.recordTranscriptEvent(
    event(99, "start", "assistant.stream.started", {
      entryId: "entry:assistant",
      streamId: "stream:assistant",
      delta: "rewound ",
    }),
  );
  await session.recordTranscriptEvent(
    event(99, "complete", "assistant.stream.completed", {
      entryId: "entry:assistant",
      streamId: "stream:assistant",
      content: "rewound answer",
    }),
  );

  await session.rewindOnce("test-operation", 1);
  await session.recordTranscriptEvent(
    event(1, "after", "entry.appended", {
      entryId: "entry:after",
      entry: { kind: "system", content: "after rewind" },
    }),
  );

  const snapshot = await session.readHydrationSnapshot();
  assert.deepEqual(
    snapshot.transcriptEvents.map(({ eventId, sequence }) => ({ eventId, sequence })),
    [
      { eventId: "user", sequence: 1 },
      { eventId: "start", sequence: 2 },
      { eventId: "complete", sequence: 3 },
      { eventId: "after", sequence: 4 },
    ],
  );
  assert.deepEqual(snapshot.messages, [{ role: "user", content: "kept" }]);
});

function event<Type extends TranscriptEvent["type"]>(
  sequence: number,
  eventId: string,
  type: Type,
  data: Omit<
    Extract<TranscriptEvent, { type: Type }>,
    "eventId" | "sequence" | "createdAt" | "type"
  >,
): Extract<TranscriptEvent, { type: Type }> {
  return {
    eventId,
    sequence,
    createdAt: 0,
    type,
    ...data,
  } as Extract<TranscriptEvent, { type: Type }>;
}
