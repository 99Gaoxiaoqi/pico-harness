import assert from "node:assert/strict";
import test from "node:test";
import type {
  RuntimeParams,
  RuntimeResult,
  RuntimeSessionSubscriptionFrame,
} from "../../src/daemon/protocol.js";
import {
  SessionSubscriptionRegistry,
  type SessionContinuityDataSource,
  type SessionSubscriptionSnapshot,
} from "../../src/daemon/session-subscription-owner.js";

const workspacePath = "/workspace";
const sessionId = "session-1";
const watermark = {
  historyEpoch: "history-1",
  projectorVersion: 1 as const,
  throughSequence: 7,
};

function snapshot(): SessionSubscriptionSnapshot {
  return {
    session: {
      sessionId,
      workspacePath,
      title: "Session",
      status: "active",
      pinned: false,
      createdAt: 1,
      updatedAt: 1,
    } as SessionSubscriptionSnapshot["session"],
    watermark,
    durableTail: [],
    activeOverlay: [],
    queuedInputs: [],
  };
}

class FakeSource implements SessionContinuityDataSource {
  readonly pageCalls: RuntimeParams<"session.transcript.page">[] = [];
  readonly advanceCalls: RuntimeParams<"session.transcript.advance">[] = [];

  async readOpenSnapshot(): Promise<SessionSubscriptionSnapshot> {
    return snapshot();
  }

  async readTranscriptPage(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<RuntimeResult<"session.transcript.page">> {
    this.pageCalls.push(params);
    return { watermark: params.through, items: [] };
  }

  async readTranscriptAdvance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<RuntimeResult<"session.transcript.advance">> {
    this.advanceCalls.push(params);
    return { after: params.after, through: params.through, changes: [] };
  }
}

test("session subscription stays paused until activation and begins at advertised sequence", async () => {
  const source = new FakeSource();
  const registry = new SessionSubscriptionRegistry("host-epoch-1", source);
  const received: RuntimeSessionSubscriptionFrame[] = [];
  const opened = await registry.open(
    { workspacePath, sessionId },
    {
      connectionId: "connection-1",
      push: async (frame) => {
        received.push(frame);
      },
    },
  );

  assert.equal(opened.hostEpoch, "host-epoch-1");
  assert.equal(opened.nextSequence, 1);
  registry.publishReporterEvent(workspacePath, {
    runId: "run-1",
    sessionId,
    type: "assistant.delta",
    resourceVersion: 1,
    at: 1,
    payload: { turn: 2, delta: "hello" },
  });
  await tick();
  assert.deepEqual(received, [], "response barrier 前不得推送 live frame");

  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection-1");
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], {
    hostEpoch: "host-epoch-1",
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    sessionId,
    type: "subscription.session_delta",
    runId: "run-1",
    turnId: "turn:run-1:2",
    itemId: "message:run-1:turn:run-1:2:assistant",
    streamId: "assistant:live:run-1:2",
    kind: "text",
    startOffsetBytes: 0,
    text: "hello",
  });
});

test("session subscription coalesces later deltas and preserves UTF-8 byte offsets", async () => {
  const registry = new SessionSubscriptionRegistry("host-epoch-1", new FakeSource());
  const received: RuntimeSessionSubscriptionFrame[] = [];
  const opened = await registry.open(
    { workspacePath, sessionId },
    {
      connectionId: "connection-1",
      push: async (frame) => {
        received.push(frame);
      },
    },
  );
  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection-1");

  for (const [resourceVersion, delta] of ["你", "好", "!"].entries()) {
    registry.publishReporterEvent(workspacePath, {
      runId: "run-1",
      sessionId,
      type: "assistant.delta",
      resourceVersion: resourceVersion + 1,
      at: resourceVersion + 1,
      payload: { turn: 1, delta },
    });
  }

  await waitFor(() => received.length === 2, 2_000);
  assert.equal(received[0]?.type, "subscription.session_delta");
  assert.equal(received[0]?.sequence, 1);
  assert.equal(
    received[0]?.type === "subscription.session_delta" ? received[0].startOffsetBytes : -1,
    0,
  );
  assert.equal(received[1]?.sequence, 2);
  assert.equal(
    received[1]?.type === "subscription.session_delta" ? received[1].startOffsetBytes : -1,
    3,
    "第二帧从首个中文字符的 3 字节结尾继续",
  );
  assert.equal(received[1]?.type === "subscription.session_delta" ? received[1].text : "", "好!");
});

test("paused subscription over 512 frames terminates as slow_consumer with a visible gap", async () => {
  const registry = new SessionSubscriptionRegistry("host-epoch-1", new FakeSource());
  const received: RuntimeSessionSubscriptionFrame[] = [];
  const opened = await registry.open(
    { workspacePath, sessionId },
    {
      connectionId: "connection-1",
      push: async (frame) => {
        received.push(frame);
      },
    },
  );
  for (let index = 0; index < 513; index += 1) {
    registry.publishReporterEvent(workspacePath, {
      runId: "run-1",
      sessionId,
      type: "subagent.activity",
      resourceVersion: index + 1,
      at: index + 1,
      payload: { activityId: `activity-${index}`, status: "running" },
    });
  }
  await tick();
  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection-1");
  await waitFor(() => received.length === 1);
  assert.equal(received[0]?.type, "subscription.closed");
  assert.equal(received[0]?.sequence, 514, "丢弃的积压帧必须留下可检测的 sequence gap");
  assert.equal(
    received[0]?.type === "subscription.closed" ? received[0].reason : undefined,
    "slow_consumer",
  );
});

test("page and advance operations preserve fixed watermark inputs", async () => {
  const source = new FakeSource();
  const registry = new SessionSubscriptionRegistry("host-epoch-1", source);
  const through = { ...watermark, throughSequence: 11 };
  const page = await registry.readTranscriptPage({
    workspacePath,
    sessionId,
    through,
    limit: 25,
    maxBytes: 4096,
  });
  const advance = await registry.readTranscriptAdvance({
    workspacePath,
    sessionId,
    after: watermark,
    through,
    limit: 25,
    maxBytes: 4096,
  });
  assert.equal(page.watermark, through);
  assert.equal(advance.after, watermark);
  assert.equal(advance.through, through);
  assert.equal(source.pageCalls.length, 1);
  assert.equal(source.advanceCalls.length, 1);
});

function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
