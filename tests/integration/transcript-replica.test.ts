import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeResult,
  type RuntimeSession,
  type RuntimeSessionSubscriptionFrame,
  type RuntimeTranscriptItemRecord,
  type RuntimeTranscriptWatermark,
} from "@pico/protocol";
import { TranscriptReplica } from "@pico/transcript-replica";

const sessionId = "session-replica";

function watermark(
  throughSequence: number,
  historyEpoch = "history-1",
): RuntimeTranscriptWatermark {
  return {
    historyEpoch,
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    throughSequence,
  };
}

function record(
  itemId: string,
  itemRevision: number,
  positionSequence: number,
  content: string,
): RuntimeTranscriptItemRecord {
  return {
    itemId,
    itemRevision,
    positionSequence,
    positionOrdinal: 1,
    item: { id: itemId, kind: "assistantMessage", content },
  };
}

function openResult(
  input: Partial<RuntimeResult<"session.subscription.open">> = {},
): RuntimeResult<"session.subscription.open"> {
  return {
    session: {
      sessionId,
      workspacePath: "/workspace",
      title: "Replica",
      status: "active",
      createdAt: 1,
      updatedAt: 1,
    } as RuntimeSession,
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    nextSequence: 1,
    watermark: watermark(1),
    durableTail: [record("answer", 1, 1, "old")],
    activeOverlay: [],
    queuedInputs: [],
    ...input,
  };
}

function frame(
  sequence: number,
  value: Omit<
    Extract<RuntimeSessionSubscriptionFrame, { readonly type: "subscription.session_delta" }>,
    "hostEpoch" | "subscriptionId" | "sessionId" | "sequence"
  >,
  identity: { readonly hostEpoch?: string; readonly subscriptionId?: string } = {},
): RuntimeSessionSubscriptionFrame {
  return {
    hostEpoch: identity.hostEpoch ?? "host-1",
    subscriptionId: identity.subscriptionId ?? "subscription-1",
    sessionId,
    sequence,
    ...value,
  } as RuntimeSessionSubscriptionFrame;
}

test("transcript replica: open installs atomically and drains early UTF-8 frames", () => {
  const replica = new TranscriptReplica(sessionId);
  const token = replica.beginOpen();
  assert.deepEqual(
    replica.receiveFrame(
      frame(1, {
        type: "subscription.session_delta",
        runId: "run-1",
        turnId: "turn-1",
        itemId: "answer-live",
        streamId: "stream-1",
        kind: "text",
        startOffsetBytes: 0,
        text: "你",
      }),
    ),
    { kind: "buffered" },
  );
  assert.equal(replica.view.records.length, 0, "open response 前不得暴露半安装快照");

  assert.equal(replica.installOpen(token, openResult()), true);
  assert.equal(replica.view.phase, "ready");
  assert.equal(replica.view.nextSequence, 2);
  assert.deepEqual(
    replica.view.records.map((item) => item.itemId),
    ["answer"],
  );
  assert.equal(replica.view.activeOverlay[0]?.text, "你");
  assert.equal(replica.view.activeOverlay[0]?.endOffsetBytes, 3, "offset 按 UTF-8 byte 计算");
});

test("transcript replica: sequence and UTF-8 offset gaps fence into recovering", () => {
  const sequenceReplica = new TranscriptReplica(sessionId);
  const sequenceOpen = sequenceReplica.beginOpen();
  assert.equal(sequenceReplica.installOpen(sequenceOpen, openResult()), true);
  assert.deepEqual(
    sequenceReplica.receiveFrame(
      frame(2, {
        type: "subscription.session_delta",
        runId: "run-1",
        turnId: "turn-1",
        itemId: "answer-live",
        streamId: "stream-1",
        kind: "text",
        startOffsetBytes: 0,
        text: "late",
      }),
    ),
    { kind: "recovering", reason: "sequence_gap" },
  );

  const offsetReplica = new TranscriptReplica(sessionId);
  const offsetOpen = offsetReplica.beginOpen();
  assert.equal(offsetReplica.installOpen(offsetOpen, openResult()), true);
  offsetReplica.receiveFrame(
    frame(1, {
      type: "subscription.session_delta",
      runId: "run-1",
      turnId: "turn-1",
      itemId: "answer-live",
      streamId: "stream-1",
      kind: "text",
      startOffsetBytes: 0,
      text: "你",
    }),
  );
  assert.deepEqual(
    offsetReplica.receiveFrame(
      frame(2, {
        type: "subscription.session_delta",
        runId: "run-1",
        turnId: "turn-1",
        itemId: "answer-live",
        streamId: "stream-1",
        kind: "text",
        startOffsetBytes: 2,
        text: "x",
      }),
    ),
    { kind: "recovering", reason: "utf8_offset_gap" },
  );
  assert.equal(offsetReplica.view.activeOverlay[0]?.text, "你", "gap frame 不得部分落地");
});

test("transcript replica: advance stages every page then applies changes atomically", () => {
  const replica = new TranscriptReplica(sessionId);
  const token = replica.beginOpen();
  assert.equal(
    replica.installOpen(
      token,
      openResult({
        durableTail: [record("answer", 1, 1, "old"), record("obsolete", 1, 2, "remove")],
        activeOverlay: [
          {
            runId: "run-1",
            turnId: "turn-1",
            itemId: "answer",
            streamId: "answer-stream",
            kind: "text",
            startOffsetBytes: 0,
            endOffsetBytes: 4,
            text: "live",
            anchorSequence: 1,
          },
        ],
        olderCursor: {
          historyEpoch: "history-1",
          projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
          throughSequence: 1,
          positionSequence: 1,
          positionOrdinal: 1,
          byteOffset: 0,
        },
      }),
    ),
    true,
  );
  replica.receiveFrame({
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 1,
    type: "subscription.transcript_advanced",
    watermark: watermark(3),
  });
  const firstRequest = replica.beginAdvance();
  assert.ok(firstRequest);
  const nextCursor = {
    historyEpoch: "history-1",
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    fromSequence: 1,
    throughSequence: 3,
    changeSequence: 2,
    ordinal: 0,
    byteOffset: 0,
  } as const;
  const first = replica.applyAdvancePage(firstRequest, {
    after: watermark(1),
    through: watermark(3),
    changes: [{ op: "upsert", record: record("answer", 2, 1, "new") }],
    nextCursor,
  });
  assert.equal(first.kind, "next");
  assert.equal(
    replica.view.records.find((item) => item.itemId === "answer")?.item.kind === "assistantMessage"
      ? replica.view.records.find((item) => item.itemId === "answer")?.item.content
      : undefined,
    "old",
    "末页前 change 不得可见",
  );
  assert.equal(replica.view.watermark?.throughSequence, 1);
  if (first.kind !== "next") throw new Error("expected next request");
  assert.deepEqual(
    replica.applyAdvancePage(first.request, {
      after: watermark(1),
      through: watermark(3),
      changes: [{ op: "remove", itemId: "obsolete", itemRevision: 2 }],
    }),
    { kind: "applied" },
  );
  assert.equal(replica.view.watermark?.throughSequence, 3);
  assert.deepEqual(
    replica.view.records.map((item) => item.itemId),
    ["answer"],
  );
  assert.equal(replica.view.activeOverlay.length, 0, "durable change 应淘汰同 item overlay");
  assert.equal(
    replica.view.records[0]?.item.kind === "assistantMessage"
      ? replica.view.records[0].item.content
      : undefined,
    "new",
  );

  const olderRequest = replica.beginOlderPage();
  assert.ok(olderRequest);
  assert.equal(
    replica.applyOlderPage(olderRequest, {
      watermark: watermark(1),
      items: [record("answer", 1, 1, "stale"), record("earlier", 1, 0, "earlier")],
    }),
    "applied",
  );
  assert.equal(replica.view.watermark?.throughSequence, 3, "older 页不得回退新水位");
  assert.deepEqual(
    replica.view.records.map((item) => item.itemId),
    ["earlier", "answer"],
  );
  assert.equal(
    replica.view.records[1]?.item.kind === "assistantMessage"
      ? replica.view.records[1].item.content
      : undefined,
    "new",
    "older 记录不得覆盖更高 itemRevision",
  );
});

test("transcript replica: reopen replaces the tail so disconnected removes stay removed", () => {
  const replica = new TranscriptReplica(sessionId);
  const first = replica.beginOpen();
  assert.equal(
    replica.installOpen(
      first,
      openResult({ durableTail: [record("kept", 1, 1, "kept"), record("removed", 1, 2, "old")] }),
    ),
    true,
  );
  const reopen = replica.beginOpen();
  assert.equal(
    replica.installOpen(
      reopen,
      openResult({
        hostEpoch: "host-2",
        subscriptionId: "subscription-2",
        watermark: watermark(3),
        durableTail: [record("kept", 2, 1, "current")],
      }),
    ),
    true,
  );
  assert.deepEqual(
    replica.view.records.map((item) => item.itemId),
    ["kept"],
  );
});

test("transcript replica: epoch, subscription, generation and reset fence stale work", () => {
  const replica = new TranscriptReplica(sessionId);
  const stale = replica.beginOpen();
  const current = replica.beginOpen();
  assert.equal(replica.installOpen(stale, openResult()), false, "stale generation 不得安装");
  replica.receiveFrame(
    frame(
      1,
      {
        type: "subscription.session_delta",
        runId: "run-stale",
        turnId: "turn-stale",
        itemId: "stale",
        streamId: "stale",
        kind: "text",
        startOffsetBytes: 0,
        text: "ignored",
      },
      { subscriptionId: "other-subscription" },
    ),
  );
  assert.equal(replica.installOpen(current, openResult()), true);
  assert.equal(replica.view.activeOverlay.length, 0, "其他 subscription 的早到 frame 应忽略");
  assert.deepEqual(
    replica.receiveFrame({
      hostEpoch: "host-1",
      subscriptionId: "subscription-1",
      sessionId,
      sequence: 1,
      type: "subscription.transcript_advanced",
      watermark: watermark(2, "history-2"),
    }),
    { kind: "recovering", reason: "history_epoch_changed" },
  );
  const generationBeforeReset = replica.view.generation;
  replica.reset();
  assert.equal(replica.view.phase, "idle");
  assert.equal(replica.view.generation, generationBeforeReset + 1);
  assert.equal(replica.view.records.length, 0);
  assert.equal(replica.view.watermark, undefined);
});

test("transcript replica: bounded early-frame queue fails closed", () => {
  const replica = new TranscriptReplica(sessionId, { maxEarlyFrames: 1 });
  replica.beginOpen();
  const early = frame(1, {
    type: "subscription.session_delta",
    runId: "run-1",
    turnId: "turn-1",
    itemId: "answer-live",
    streamId: "stream-1",
    kind: "text",
    startOffsetBytes: 0,
    text: "a",
  });
  assert.deepEqual(replica.receiveFrame(early), { kind: "buffered" });
  assert.deepEqual(replica.receiveFrame({ ...early, sequence: 2, startOffsetBytes: 1 }), {
    kind: "recovering",
    reason: "early_frame_overflow",
  });
});
