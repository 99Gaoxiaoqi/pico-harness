import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimePlanControlSnapshot,
  type RuntimeQueuedInput,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import {
  DesktopSessionContinuity,
  type DesktopSessionContinuityTransport,
} from "../../../apps/desktop/src/renderer/session-continuity.js";

test("queue mutations reopen continuity before old stream frames can restore removed inputs", async () => {
  let listener!: (frame: RuntimeSessionSubscriptionFrame) => void;
  let releaseClose!: () => void;
  let opens = 0;
  let waitForClose = true;
  let storedQueue: readonly RuntimeQueuedInput[] = [
    {
      queueId: "queued-1",
      sessionId: "session",
      input: { kind: "text", text: "guide now" },
      createdAt: 1,
    },
  ];
  let visibleQueue: readonly RuntimeQueuedInput[] = [];
  const continuity = new DesktopSessionContinuity({
    transport: {
      subscribeFrames(callback) {
        listener = callback;
        return { dispose() {} };
      },
      async open() {
        return {
          session: {
            sessionId: "session",
            workspacePath: "/workspace",
            title: "queue",
            status: "active",
            pinned: false,
            createdAt: 1,
            updatedAt: 1,
          },
          hostEpoch: "host",
          subscriptionId: `subscription-${++opens}`,
          nextSequence: 1,
          watermark: {
            historyEpoch: "history",
            projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
            throughSequence: 1,
          },
          durableTail: [],
          activeOverlay: [],
          queuedInputs: storedQueue,
        };
      },
      async close() {
        if (waitForClose) {
          waitForClose = false;
          await new Promise<void>((resolve) => {
            releaseClose = resolve;
          });
        }
        return { closed: true };
      },
      async page() {
        throw new Error("no older page expected");
      },
      async advance() {
        throw new Error("queue mutation must not need transcript advance");
      },
    },
    onView(_workspacePath, _sessionId, view) {
      visibleQueue = view.queuedInputs;
    },
  });
  try {
    await continuity.open("/workspace", "session");
    assert.equal(visibleQueue.length, 1);
    storedQueue = [];
    visibleQueue = [];
    const refresh = continuity.open("/workspace", "session");
    const frame = (subscriptionId: string): RuntimeSessionSubscriptionFrame => ({
      hostEpoch: "host",
      subscriptionId,
      sessionId: "session",
      sequence: 1,
      type: "subscription.session_delta",
      runId: "run",
      turnId: "turn",
      itemId: "answer",
      streamId: "stream",
      kind: "text",
      startOffsetBytes: 0,
      text: "live",
    });
    listener(frame("subscription-1"));
    assert.deepEqual(visibleQueue, [], "closing old subscription cannot restore its queue");
    releaseClose();
    await refresh;
    listener(frame("subscription-2"));
    assert.deepEqual(visibleQueue, [], "new stream frames retain the refreshed empty queue");
    assert.deepEqual(continuity.view("/workspace", "session")?.queuedInputs, []);

    const renderer = await readFile(
      new URL("../../../apps/desktop/src/renderer/runtime.ts", import.meta.url),
      "utf8",
    );
    for (const method of [
      "updateQueuedInput",
      "removeQueuedInput",
      "reorderQueuedInputs",
      "moveQueuedInputToNext",
      "steerQueuedInput",
    ]) {
      const body = renderer.slice(renderer.indexOf(`async ${method}(`));
      assert.match(
        body.slice(0, body.indexOf("\n      async ", 1)),
        /refreshQueue\(bridge, ref\)/u,
        `${method} must refresh the replica after admission`,
      );
    }
  } finally {
    continuity.dispose();
  }
});

test("desktop session continuity: raw early frame and advance update one replica", async () => {
  let listener: ((frame: RuntimeSessionSubscriptionFrame) => void) | undefined;
  let disconnect: (() => void) | undefined;
  const calls: string[] = [];
  const planControls: string[] = [];
  const watermark = (throughSequence: number) => ({
    historyEpoch: "history-1",
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    throughSequence,
  });
  const transport = {
    subscribeFrames(
      frameListener: (frame: RuntimeSessionSubscriptionFrame) => void,
      onDisconnect?: () => void,
    ) {
      listener = frameListener;
      disconnect = onDisconnect;
      return {
        dispose: () => {
          listener = undefined;
          disconnect = undefined;
        },
      };
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
        planControl: {
          version: 1,
          availability: "ready",
          state: "pending_review",
          projection: {
            sessionId: "session-1",
            sessionSequence: 1,
            proposals: [
              {
                planId: "plan-1",
                revision: 1,
                title: "Review",
                steps: [{ id: "step-1", title: "Ship", description: "Ship it", status: "pending" }],
                status: "pending",
                proposedAt: "2026-08-27T00:00:00.000Z",
              },
            ],
            pendingProposal: {
              planId: "plan-1",
              revision: 1,
              title: "Review",
              steps: [{ id: "step-1", title: "Ship", description: "Ship it", status: "pending" }],
              status: "pending",
              proposedAt: "2026-08-27T00:00:00.000Z",
            },
          },
        },
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
    onPlanControl: (_workspacePath, _sessionId, control) => {
      planControls.push(control?.state ?? "disconnected");
    },
  });

  await continuity.open("/workspace", "session-1");
  assert.equal(continuity.planControl("/workspace", "session-1")?.state, "pending_review");
  assert.equal(planControls.at(-1), "pending_review");
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

  disconnect?.();
  assert.equal(planControls.at(-1), "disconnected");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["open", "advance", "close", "open", "close", "open"]);
  assert.equal(planControls.at(-1), "pending_review");
  continuity.dispose();
});

test("desktop session continuity: stale interrupted hydration cannot replace terminal", async () => {
  const terminal: RuntimePlanControlSnapshot = {
    version: 1,
    availability: "ready",
    state: "terminal",
    projection: {
      sessionId: "session-1",
      sessionSequence: 12,
      proposals: [],
      execution: {
        planId: "plan-1",
        revision: 1,
        status: "completed",
        steps: [{ id: "step-1", title: "Done", description: "Done", status: "completed" }],
        startedAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:01.000Z",
      },
    },
  };
  const staleInterrupted: RuntimePlanControlSnapshot = {
    version: 1,
    availability: "ready",
    state: "interrupted",
    projection: {
      sessionId: "session-1",
      sessionSequence: 11,
      proposals: [],
      execution: {
        planId: "plan-1",
        revision: 1,
        status: "interrupted",
        steps: [{ id: "step-1", title: "Done", description: "Done", status: "completed" }],
        startedAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.500Z",
      },
    },
  };
  let opens = 0;
  const controls: string[] = [];
  const transport = {
    subscribeFrames() {
      return { dispose() {} };
    },
    async open() {
      opens++;
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
        hostEpoch: `host-${opens}`,
        subscriptionId: `subscription-${opens}`,
        nextSequence: 1,
        watermark: {
          historyEpoch: "history-1",
          projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
          throughSequence: 0,
        },
        durableTail: [],
        activeOverlay: [],
        queuedInputs: [],
        planControl: opens === 1 ? terminal : staleInterrupted,
      };
    },
    async close() {
      return { closed: true as const };
    },
    async page() {
      throw new Error("no older page expected");
    },
    async advance() {
      throw new Error("no advance expected");
    },
  } as DesktopSessionContinuityTransport;
  const continuity = new DesktopSessionContinuity({
    transport,
    onView() {},
    onPlanControl: (_workspacePath, _sessionId, control) => {
      controls.push(control?.state ?? "disconnected");
    },
  });

  await continuity.open("/workspace", "session-1");
  await continuity.open("/workspace", "session-1");

  assert.equal(opens, 2);
  assert.equal(continuity.planControl("/workspace", "session-1")?.state, "terminal");
  assert.deepEqual(controls, ["terminal", "terminal"]);
  continuity.dispose();
});
