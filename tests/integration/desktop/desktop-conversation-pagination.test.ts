import assert from "node:assert/strict";
import test from "node:test";
import { TRANSCRIPT_PROJECTOR_VERSION } from "@pico/protocol";
import { parseConversation } from "../../../apps/desktop/src/renderer/conversation/runtime-projection.js";

test("Desktop conversation only derives hasEarlier from nextCursor", () => {
  const withoutCursor = parseConversation({ items: [] }, "/workspace", "session");
  assert.equal(withoutCursor.hasEarlier, false);

  const withCursor = parseConversation(
    {
      items: [],
      nextCursor: {
        historyEpoch: "history-1",
        projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
        throughSequence: 4,
        positionSequence: 2,
        positionOrdinal: 1,
        byteOffset: 0,
      },
    },
    "/workspace",
    "session",
  );
  assert.equal(withCursor.hasEarlier, true);
});
