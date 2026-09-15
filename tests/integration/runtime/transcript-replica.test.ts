import assert from "node:assert/strict";
import { test } from "node:test";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeResult,
  type RuntimeRun,
  type RuntimeSession,
  type RuntimeSessionSubscriptionFrame,
  type RuntimeTranscriptItemRecord,
  type RuntimeTranscriptWatermark,
} from "@pico/protocol";
import { TranscriptReplica } from "@pico/transcript-replica";

const sessionId = "session-replica";

function run(runId: string, status: RuntimeRun["status"] = "running"): RuntimeRun {
  return {
    runId,
    status,
    sessionId,
    workspacePath: "/workspace",
    description: "test",
    startedAt: 1,
    updatedAt: 2,
    version: 2,
  };
}

test("transcript replica: durable replacement and terminal fences reject late overlays while retaining the current run", () => {
  for (const status of ["succeeded", "failed", "cancelled"] as const) {
    const replica = new TranscriptReplica(sessionId);
    assert.equal(
      replica.installOpen(
        replica.beginOpen(),
        openResult({ durableTail: [], activeRun: run("desktop-1") }),
      ),
      true,
    );
    let sequence = 0;
    const delta = (runId: string, itemId: string, text: string, offset = 0) =>
      replica.receiveFrame(
        frame(++sequence, {
          type: "subscription.session_delta",
          runId,
          turnId: "turn:runtime-1:1",
          itemId,
          streamId: `${runId}:${itemId}`,
          kind: "thinking",
          startOffsetBytes: offset,
          text,
        }),
      );
    const state = (value: RuntimeRun) =>
      replica.receiveFrame({
        hostEpoch: "host-1",
        subscriptionId: "subscription-1",
        sessionId,
        sequence: ++sequence,
        type: "subscription.run_state",
        run: value,
      });
    const itemId = "message:turn:runtime-1:1:thinking";
    delta("desktop-1", itemId, "reasoning");
    const request = replica.beginAdvance(watermark(2))!;
    replica.applyAdvancePage(request, {
      after: request.after,
      through: request.through,
      changes: [
        {
          op: "upsert",
          record: {
            ...record(itemId, 2, 2, "reasoning"),
            item: {
              id: itemId,
              kind: "thinking",
              content: "reasoning",
              runId: "runtime-1",
              turnId: "turn:runtime-1:1",
            },
          },
        },
      ],
    });
    assert.equal(
      replica.view.activeOverlay.length,
      0,
      "durable item replaces live item by identity",
    );
    delta("desktop-1", itemId, "late", 9);
    assert.equal(
      replica.view.phase,
      "ready",
      "late durable-covered frame must not trigger an offset recovery",
    );
    assert.equal(
      replica.view.activeOverlay.length,
      0,
      "late delta cannot duplicate the durable item",
    );
    delta("desktop-1", "pending", "pending");
    state(run("desktop-1", status));
    delta("desktop-1", "pending", "late", 7);
    assert.equal(
      replica.view.activeOverlay.length,
      0,
      `${status} permanently seals the run overlay`,
    );
    state(run("desktop-2"));
    delta("desktop-2", "current", "current");
    state(run("queued-next", "queued"));
    state(run("desktop-1", status));
    delta("desktop-1", "new-late-stream", "late");
    const lateCommit = replica.beginAdvance(watermark(3))!;
    replica.applyAdvancePage(lateCommit, {
      after: lateCommit.after,
      through: lateCommit.through,
      changes: [{ op: "upsert", record: record("pending", 3, 3, "committed after terminal") }],
    });
    delta("desktop-2", "current", " suffix", 7);
    assert.equal(replica.view.activeRun?.runId, "desktop-2");
    assert.deepEqual(
      replica.view.activeOverlay.map((entry) => entry.text),
      ["current suffix"],
    );
    assert.equal(
      replica.view.records.length,
      2,
      "terminal control frames never remove or reject durable history",
    );
  }
});

test("transcript replica: a new run retires old overlays and open reconciles already durable items", () => {
  const replica = new TranscriptReplica(sessionId);
  const overlay = {
    runId: "old",
    turnId: "turn-old",
    itemId: "durable",
    streamId: "old-stream",
    kind: "thinking" as const,
    text: "same",
    startOffsetBytes: 0,
    endOffsetBytes: 4,
    anchorSequence: 1,
  };
  assert.equal(
    replica.installOpen(
      replica.beginOpen(),
      openResult({
        durableTail: [record("durable", 1, 1, "same")],
        activeOverlay: [overlay],
        activeRun: run("old"),
      }),
    ),
    true,
  );
  assert.equal(
    replica.view.activeOverlay.length,
    0,
    "reopen must not show both durable and overlay copies",
  );
  replica.receiveFrame(
    frame(1, {
      type: "subscription.session_delta",
      ...overlay,
      itemId: "unfinished",
      text: "pending",
    }),
  );
  replica.receiveFrame({
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 2,
    type: "subscription.run_state",
    run: run("new"),
  });
  assert.equal(
    replica.view.activeOverlay.length,
    0,
    "new run clears superseded stream even when a terminal event was missed",
  );
  replica.receiveFrame(
    frame(3, {
      type: "subscription.session_delta",
      ...overlay,
      itemId: "unfinished",
      text: "late",
      startOffsetBytes: 7,
    }),
  );
  assert.equal(replica.view.phase, "ready");
  assert.equal(replica.view.activeOverlay.length, 0);
});

test("transcript replica: durable tool starts preserve current output until a durable removal", () => {
  const replica = new TranscriptReplica(sessionId);
  const tool: RuntimeTranscriptItemRecord = {
    ...record("tool:call-1", 1, 1, ""),
    item: {
      id: "tool:call-1",
      kind: "tool",
      name: "bash",
      args: "{}",
      status: "running",
      data: { toolCallId: "call-1", providerCallId: "provider-1", entryId: "entry-1" },
    },
  };
  replica.installOpen(
    replica.beginOpen(),
    openResult({ durableTail: [tool], activeRun: run("current") }),
  );
  const output = {
    type: "subscription.session_delta" as const,
    runId: "current",
    turnId: "turn-current",
    itemId: tool.itemId,
    streamId: "stdout-1",
    kind: "toolOutput" as const,
    stream: "stdout" as const,
    text: "output",
    startOffsetBytes: 0,
  };
  replica.receiveFrame(frame(1, output));
  const update = replica.beginAdvance(watermark(2))!;
  replica.applyAdvancePage(update, {
    after: update.after,
    through: update.through,
    changes: [{ op: "upsert", record: { ...tool, itemRevision: 2 } }],
  });
  replica.receiveFrame(frame(2, { ...output, text: " suffix", startOffsetBytes: 6 }));
  assert.deepEqual(
    replica.view.activeOverlay.map((entry) => entry.text),
    ["output suffix"],
  );
  const removal = replica.beginAdvance(watermark(3))!;
  replica.applyAdvancePage(removal, {
    after: removal.after,
    through: removal.through,
    changes: [{ op: "remove", itemId: tool.itemId, itemRevision: 3 }],
  });
  replica.receiveFrame(frame(3, { ...output, text: "late", startOffsetBytes: 13 }));
  assert.equal(replica.view.activeOverlay.length, 0);
  assert.equal(replica.view.phase, "ready");
});

test("transcript replica: an explicit newer exact-run retry accepts new items without reviving retired streams", () => {
  const replica = new TranscriptReplica(sessionId);
  replica.installOpen(
    replica.beginOpen(),
    openResult({ activeRun: run("retry"), durableTail: [] }),
  );
  const delta = {
    type: "subscription.session_delta" as const,
    runId: "retry",
    turnId: "old-turn",
    itemId: "old-item",
    streamId: "assistant",
    kind: "text" as const,
    text: "old",
    startOffsetBytes: 0,
  };
  replica.receiveFrame(frame(1, delta));
  const state = {
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sessionId,
    type: "subscription.run_state" as const,
  };
  replica.receiveFrame({ ...state, sequence: 2, run: run("retry", "failed") });
  replica.receiveFrame({ ...state, sequence: 3, run: { ...run("retry"), version: 3 } });
  replica.receiveFrame(frame(4, { ...delta, itemId: "new-item", turnId: "new-turn", text: "new" }));
  replica.receiveFrame(frame(5, { ...delta, text: "late", startOffsetBytes: 3 }));
  replica.receiveFrame({ ...state, sequence: 6, run: run("retry", "failed") });
  assert.equal(replica.view.activeRun?.status, "running");
  assert.deepEqual(
    replica.view.activeOverlay.map((entry) => entry.text),
    ["new"],
  );
  assert.equal(replica.view.phase, "ready");
});

for (const retryStatus of ["paused", "pause_requested", "cancelling"] as const) {
  test(`transcript replica: reopen retains a newer ${retryStatus} exact-run retry and fences queued or stale attempts`, () => {
    const replica = new TranscriptReplica(sessionId);
    replica.installOpen(
      replica.beginOpen(),
      openResult({ activeRun: run("retry"), durableTail: [] }),
    );
    const oldStream = {
      runId: "retry",
      turnId: "old-turn",
      itemId: "old-item",
      streamId: "old-stream",
      kind: "text" as const,
      text: "old",
      startOffsetBytes: 0,
      endOffsetBytes: 3,
      anchorSequence: 1,
    };
    const newStream = {
      ...oldStream,
      turnId: "new-turn",
      itemId: "new-item",
      streamId: "new-stream",
      text: "new",
    };
    replica.receiveFrame(frame(1, { type: "subscription.session_delta", ...oldStream }));
    const state = {
      hostEpoch: "host-1",
      subscriptionId: "subscription-1",
      sessionId,
      type: "subscription.run_state" as const,
    };
    replica.receiveFrame({ ...state, sequence: 2, run: run("retry", "failed") });
    assert.equal(
      replica.installOpen(
        replica.beginOpen(),
        openResult({
          durableTail: [],
          activeRun: { ...run("retry", "queued"), version: 3 },
          activeOverlay: [newStream],
        }),
      ),
      true,
    );
    assert.equal(
      replica.view.activeOverlay.length,
      0,
      "queued is not evidence that an exact retry started",
    );
    assert.equal(
      replica.installOpen(
        replica.beginOpen(),
        openResult({
          durableTail: [],
          activeRun: { ...run("retry", retryStatus), version: 4 },
          activeOverlay: [oldStream, newStream],
        }),
      ),
      true,
    );
    assert.deepEqual(
      replica.view.activeOverlay.map((entry) => entry.itemId),
      ["new-item"],
    );
    replica.receiveFrame({ ...state, sequence: 1, run: run("retry", "running") });
    replica.receiveFrame(
      frame(2, {
        type: "subscription.session_delta",
        ...oldStream,
        text: "late",
        startOffsetBytes: 3,
      }),
    );
    replica.receiveFrame(
      frame(3, {
        type: "subscription.session_delta",
        ...newStream,
        text: " suffix",
        startOffsetBytes: 3,
      }),
    );
    assert.equal(
      replica.view.activeRun?.status,
      retryStatus,
      "old running frames cannot replace the authoritative retry state",
    );
    assert.deepEqual(
      replica.view.activeOverlay.map((entry) => entry.text),
      ["new suffix"],
    );
    assert.equal(replica.view.phase, "ready");
  });
}

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

test("transcript replica: reset-empty and terminal run state clear non-authoritative overlays", () => {
  const replica = new TranscriptReplica(sessionId);
  const token = replica.beginOpen();
  assert.equal(
    replica.installOpen(
      token,
      openResult({
        activeOverlay: [
          {
            runId: "run-1",
            turnId: "turn-1",
            itemId: "answer-live",
            streamId: "stream-1",
            kind: "text",
            startOffsetBytes: 0,
            endOffsetBytes: 4,
            text: "live",
            anchorSequence: 1,
          },
        ],
      }),
    ),
    true,
  );
  assert.equal(
    replica.receiveFrame(
      frame(1, {
        type: "subscription.session_delta",
        runId: "run-1",
        turnId: "turn-1",
        itemId: "answer-live",
        streamId: "stream-1",
        kind: "text",
        startOffsetBytes: 4,
        text: "",
        reset: true,
      }),
    ).kind,
    "applied",
  );
  assert.equal(replica.view.activeOverlay.length, 0);

  replica.receiveFrame(
    frame(2, {
      type: "subscription.session_delta",
      runId: "run-1",
      turnId: "turn-1",
      itemId: "answer-live",
      streamId: "stream-1",
      kind: "text",
      startOffsetBytes: 0,
      text: "again",
    }),
  );
  replica.receiveFrame({
    hostEpoch: "host-1",
    subscriptionId: "subscription-1",
    sessionId,
    sequence: 3,
    type: "subscription.run_state",
    run: {
      runId: "run-1",
      sessionId,
      workspacePath: "/workspace",
      description: "test",
      status: "failed",
      startedAt: 1,
      finishedAt: 2,
      updatedAt: 2,
      version: 2,
    },
  });
  assert.equal(replica.view.activeOverlay.length, 0);
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
