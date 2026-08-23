import assert from "node:assert/strict";
import { test } from "node:test";
import { TRANSCRIPT_PROJECTOR_VERSION, type RuntimeSessionSubscriptionFrame } from "@pico/protocol";
import {
  DesktopSessionContinuity,
  type DesktopSessionContinuityTransport,
} from "../../apps/desktop/src/renderer/session-continuity.js";

test("desktop session continuity: raw early frame and advance update one replica", async () => {
  let listener: ((frame: RuntimeSessionSubscriptionFrame) => void) | undefined;
  const calls: string[] = [];
  const watermark = (throughSequence: number) => ({
    historyEpoch: "history-1",
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    throughSequence,
  });
  const transport = {
    subscribeFrames(frameListener: (frame: RuntimeSessionSubscriptionFrame) => void) {
      listener = frameListener;
      return { dispose: () => (listener = undefined) };
    },
    async open() {
      calls.push("open");
      listener?.({
        hostEpoch: "host-1",
        subscriptionId: "subscription-1",
        sessionId: "session-1",
        sequence: 1,
        type: "subscription.session_delta",
        runId: "run-1",
        turnId: "turn-1",
        itemId: "answer",
        streamId: "stream-1",
        kind: "text",
        startOffsetBytes: 0,
        text: "live",
      });
      return {
        session: {
          sessionId: "session-1",
          workspacePath: "/workspace",
          title: "test",
          status: "active",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        hostEpoch: "host-1",
        subscriptionId: "subscription-1",
        nextSequence: 1,
        watermark: watermark(1),
        durableTail: [
          {
            itemId: "question",
            itemRevision: 1,
            positionSequence: 1,
            positionOrdinal: 0,
            item: { id: "question", kind: "userMessage", content: "question" },
          },
        ],
        activeOverlay: [],
        queuedInputs: [],
      };
    },
    async close() {
      calls.push("close");
      return { closed: true as const };
    },
    async page() {
      throw new Error("no older page expected");
    },
    async advance() {
      calls.push("advance");
      return {
        after: watermark(1),
        through: watermark(2),
        changes: [
          {
            op: "upsert" as const,
            record: {
              itemId: "answer",
              itemRevision: 1,
              positionSequence: 2,
              positionOrdinal: 0,
              item: { id: "answer", kind: "assistantMessage" as const, content: "durable" },
            },
          },
        ],
      };
    },
  } as DesktopSessionContinuityTransport;
  const views: string[][] = [];
  const continuity = new DesktopSessionContinuity({
    transport,
    onView: (_workspacePath, _sessionId, view) => {
      views.push([
        ...view.records.map((record) => record.itemId),
        ...view.activeOverlay.map((overlay) => `overlay:${overlay.itemId}:${overlay.text}`),
      ]);
    },
  });

  await continuity.open("/workspace", "session-1");
  assert.deepEqual(views.at(-1), ["question", "overlay:answer:live"]);
  listener?.({
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sessionId: "session-1",
    sequence: 2,
    type: "subscription.transcript_advanced",
    watermark: watermark(2),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["open", "advance"]);
  assert.deepEqual(views.at(-1), ["question", "answer"]);

  listener?.({
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sessionId: "session-1",
    sequence: 4,
    type: "subscription.session_delta",
    runId: "run-1",
    turnId: "turn-1",
    itemId: "gap",
    streamId: "stream-gap",
    kind: "text",
    startOffsetBytes: 0,
    text: "gap",
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["open", "advance", "close", "open"]);
  assert.deepEqual(views.at(-1), ["question", "overlay:answer:live"]);
  continuity.dispose();
});
