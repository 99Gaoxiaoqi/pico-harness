import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeNotification,
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeRun,
  type RuntimeSessionSubscriptionFrame,
} from "../../../packages/protocol/src/index.js";
import {
  SessionSubscriptionRegistry,
  type SessionContinuityDataSource,
  type SessionSubscriptionSnapshot,
} from "@pico/pico-host/session-subscription-owner";
import { TranscriptReplica } from "@pico/transcript-replica";

const workspacePath = "/workspace";
const sessionId = "session-1";
const watermark = {
  historyEpoch: "history-1",
  projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
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
    },
    watermark,
    durableTail: [],
    activeOverlay: [],
    queuedInputs: [],
  };
}

class FakeSource implements SessionContinuityDataSource {
  readonly pageCalls: RuntimeParams<"session.transcript.page">[] = [];
  readonly advanceCalls: RuntimeParams<"session.transcript.advance">[] = [];
  currentWatermark = watermark;
  openSnapshot = snapshot();
  beforeOpenObserved?: () => void;

  async readOpenSnapshot(): Promise<SessionSubscriptionSnapshot> {
    this.beforeOpenObserved?.();
    return this.openSnapshot;
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

  async readTranscriptWatermark() {
    return this.currentWatermark;
  }
}

test("session subscription flushes Active Overlay before capturing the open snapshot", async () => {
  const source = new FakeSource();
  let flushed = false;
  source.beforeOpenObserved = () => assert.equal(flushed, true);
  const registry = new SessionSubscriptionRegistry("host-epoch-1", source, async () => {
    flushed = true;
  });

  await registry.open(
    { workspacePath, sessionId },
    { connectionId: "connection-1", push: async () => undefined },
  );
  assert.equal(flushed, true);
});

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
    itemId: "message:turn:run-1:2:assistant",
    streamId: "assistant:live:run-1:2",
    kind: "text",
    startOffsetBytes: 0,
    text: "hello",
  });
});

test("open bootstrap seeds absolute offsets and drops a concurrently queued duplicate delta", async () => {
  const source = new FakeSource();
  source.openSnapshot = {
    ...snapshot(),
    activeOverlay: [
      {
        runId: "run-1",
        turnId: "turn-1",
        itemId: "message:turn-1:assistant",
        streamId: "assistant:run-1:turn-1",
        kind: "text",
        startOffsetBytes: 0,
        endOffsetBytes: 5,
        text: "hello",
        anchorSequence: 7,
      },
    ],
  };
  const registry = new SessionSubscriptionRegistry("host-epoch-1", source, async () => {
    registry.publishSessionDelta({
      workspacePath,
      sessionId,
      runId: "run-1",
      turnId: "turn-1",
      itemId: "message:turn-1:assistant",
      streamId: "assistant:run-1:turn-1",
      kind: "text",
      startOffsetBytes: 0,
      text: "hello",
    });
  });
  const received: RuntimeSessionSubscriptionFrame[] = [];
  const opened = await registry.open(
    { workspacePath, sessionId },
    { connectionId: "connection-1", push: async (frame) => void received.push(frame) },
  );
  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection-1");
  await tick();
  assert.equal(received.length, 0, "bootstrap 已覆盖的绝对范围不得再次发送");

  registry.publishSessionDelta({
    workspacePath,
    sessionId,
    runId: "run-1",
    turnId: "turn-1",
    itemId: "message:turn-1:assistant",
    streamId: "assistant:run-1:turn-1",
    kind: "text",
    startOffsetBytes: 5,
    text: "!",
  });
  await waitFor(() => received.length === 1);
  assert.equal(
    received[0]?.type === "subscription.session_delta" ? received[0].startOffsetBytes : undefined,
    5,
  );
});

test("opening during a coalesced UTF-8 delta does not replay bytes already in the snapshot", async (context) => {
  const registry = new SessionSubscriptionRegistry("host-epoch-1", new FakeSource());
  context.after(() => registry.shutdown());
  const firstFrames: RuntimeSessionSubscriptionFrame[] = [];
  const first = await registry.open(
    { workspacePath, sessionId },
    { connectionId: "connection-1", push: async (frame) => void firstFrames.push(frame) },
  );
  registry.activate(workspacePath, sessionId, first.subscriptionId, "connection-1");

  for (const delta of ["你", "好"]) {
    registry.publishReporterEvent(workspacePath, {
      runId: "run-1",
      sessionId,
      type: "assistant.delta",
      resourceVersion: 1,
      at: 1,
      payload: { turn: 1, delta },
    });
  }
  await waitFor(() => firstFrames.length === 1);

  const replica = new TranscriptReplica(sessionId);
  const token = replica.beginOpen();
  const secondFrames: RuntimeSessionSubscriptionFrame[] = [];
  const second = await registry.open(
    { workspacePath, sessionId },
    {
      connectionId: "connection-2",
      push: async (frame) => {
        secondFrames.push(frame);
        replica.receiveFrame(frame);
      },
    },
  );
  registry.activate(workspacePath, sessionId, second.subscriptionId, "connection-2");
  assert.equal(second.activeOverlay[0]?.text, "你好");
  await waitFor(() => firstFrames.length === 2);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(secondFrames, []);
  assert.equal(replica.installOpen(token, second), true);
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

test("paused subscription over 2 MiB terminates as slow_consumer", async () => {
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
  for (let index = 0; index < 4; index += 1) {
    registry.publishReporterEvent(workspacePath, {
      runId: "run-1",
      sessionId,
      type: "subagent.activity",
      resourceVersion: index + 1,
      at: index + 1,
      payload: { activityId: `activity-${index}`, status: "running", summary: "x".repeat(600_000) },
    });
  }
  await tick();
  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection-1");
  await waitFor(() => received.length === 1);
  assert.equal(received[0]?.type, "subscription.closed");
  assert.equal(
    received[0]?.type === "subscription.closed" ? received[0].reason : undefined,
    "slow_consumer",
  );
});

test("tool output uses the canonical transcript toolCallId and run state is sequenced", async () => {
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
  registry.publishReporterEvent(workspacePath, {
    runId: "run-1",
    sessionId,
    type: "tool.started",
    resourceVersion: 1,
    at: 1,
    payload: {
      turn: 3,
      providerCallId: "provider-call-1",
      toolName: "bash",
      canonicalTranscriptStart: { toolCallId: "canonical-tool-1" },
    },
  });
  registry.publishReporterEvent(workspacePath, {
    runId: "run-1",
    sessionId,
    type: "tool.output",
    resourceVersion: 2,
    at: 2,
    payload: {
      turn: 3,
      providerCallId: "provider-call-1",
      toolName: "bash",
      stream: "stdout",
      chunk: "done",
    },
  });
  registry.publishRuntimeNotification(
    createRuntimeNotification({
      topic: "run.started",
      scope: { workspacePath, sessionId, runId: "run-1" },
      resourceVersion: 3,
      at: 3,
      payload: {
        run: {
          runId: "run-1",
          workspacePath,
          sessionId,
          description: "test",
          status: "running",
          startedAt: 1,
          updatedAt: 3,
          version: 1,
        },
      },
    }),
  );
  await waitFor(() => received.length === 3);
  const toolDelta = received.find(
    (frame) => frame.type === "subscription.session_delta" && frame.kind === "toolOutput",
  );
  assert.equal(
    toolDelta?.type === "subscription.session_delta" ? toolDelta.itemId : undefined,
    "tool:canonical-tool-1",
  );
  assert.deepEqual(
    received.map((frame) => frame.sequence),
    [1, 2, 3],
  );
  assert.equal(received[2]?.type, "subscription.run_state");
});

test("completed streams are removed from owner memory and cannot revive after reopen", async () => {
  const source = new FakeSource();
  const registry = new SessionSubscriptionRegistry("host-epoch-1", source);
  registry.publishSessionDelta({
    workspacePath,
    sessionId,
    runId: "run-1",
    turnId: "turn:run-1:1",
    itemId: "message:turn:run-1:1:assistant",
    streamId: "assistant:live:run-1:1",
    kind: "text",
    startOffsetBytes: 0,
    text: "live",
  });
  registry.publishReporterEvent(workspacePath, {
    runId: "run-1",
    sessionId,
    type: "assistant.message",
    resourceVersion: 2,
    at: 2,
    payload: { turn: 1, content: "live" },
  });
  await tick();

  const reopened = await registry.open(
    { workspacePath, sessionId },
    { connectionId: "connection-2", push: async () => undefined },
  );
  assert.deepEqual(reopened.activeOverlay, []);
});

for (const status of ["failed", "cancelled", "succeeded"] as const) {
  for (const retryStatus of ["running", "paused", "pause_requested", "cancelling"] as const) {
    test(`owner retires ${status} streams across reopen and late deltas while accepting a newer ${retryStatus} retry snapshot`, async () => {
      const source = new FakeSource();
      const registry = new SessionSubscriptionRegistry("host-epoch-1", source);
      const open = () =>
        registry.open(
          { workspacePath, sessionId },
          { connectionId: "test", push: async () => undefined },
        );
      const run = (state: RuntimeRun["status"], version: number): RuntimeRun => ({
        runId: "run-1",
        workspacePath,
        sessionId,
        status: state,
        description: "test",
        version,
        startedAt: 1,
        updatedAt: version,
      });
      const publishRun = (value: RuntimeRun) =>
        registry.publishRuntimeNotification(
          createRuntimeNotification({
            topic: "run.updated",
            scope: { workspacePath, sessionId, runId: value.runId },
            resourceVersion: value.version,
            at: value.version,
            payload: { run: value },
          }),
        );
      const old = {
        runId: "run-1",
        turnId: "old-turn",
        itemId: "old-item",
        streamId: "old-stream",
        kind: "thinking" as const,
        text: "old",
        startOffsetBytes: 0,
        endOffsetBytes: 3,
        anchorSequence: 1,
      };
      try {
        await open();
        publishRun(run("running", 1));
        registry.publishSessionDelta({ workspacePath, sessionId, ...old });
        publishRun(run(status, 2));
        registry.publishSessionDelta({
          workspacePath,
          sessionId,
          ...old,
          text: "late",
          startOffsetBytes: 3,
        });
        registry.publishSessionDelta({
          workspacePath,
          sessionId,
          ...old,
          itemId: "unseen-late",
          streamId: "unseen-late",
          text: "late",
        });
        assert.deepEqual(
          (await open()).activeOverlay,
          [],
          "new subscriptions must never inherit terminal owner memory or late deltas",
        );
        source.openSnapshot = { ...snapshot(), activeRun: run("queued", 3), activeOverlay: [old] };
        assert.deepEqual(
          (await open()).activeOverlay,
          [],
          "queued alone cannot revive a retired run",
        );
        const next = {
          ...old,
          turnId: `${retryStatus}-turn`,
          itemId: `${retryStatus}-item`,
          streamId: `${retryStatus}-stream`,
          text: "new",
        };
        source.openSnapshot = {
          ...snapshot(),
          activeRun: run(retryStatus, 4),
          activeOverlay: [old, next],
        };
        const reopened = await open();
        assert.ok(reopened.activeOverlay.some((entry) => entry.itemId === next.itemId));
        assert.equal(
          reopened.activeOverlay.some((entry) => entry.itemId === old.itemId),
          false,
        );
        publishRun(run(status, 2));
        registry.publishSessionDelta({
          workspacePath,
          sessionId,
          ...old,
          text: "late",
          startOffsetBytes: 3,
        });
        registry.publishSessionDelta({
          workspacePath,
          sessionId,
          ...next,
          text: " suffix",
          startOffsetBytes: 3,
        });
        const final = await open();
        assert.equal(
          final.activeOverlay.some((entry) => entry.itemId === old.itemId),
          false,
        );
        assert.ok(final.activeOverlay.some((entry) => entry.text === "new suffix"));
      } finally {
        registry.shutdown();
      }
    });
  }
}

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

test("committed transcript watermark and workbar invalidations share the sequenced Session channel", async () => {
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
  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection-1");

  source.currentWatermark = { ...watermark, throughSequence: 9 };
  registry.publishTranscriptAdvanced(workspacePath, sessionId);
  await waitFor(() => received.length === 3);
  assert.deepEqual(received[0], {
    hostEpoch: "host-epoch-1",
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    sessionId,
    type: "subscription.transcript_advanced",
    watermark: source.currentWatermark,
  });
  assert.deepEqual(
    received
      .slice(1)
      .map((frame) =>
        frame.type === "subscription.resource_changed" ? frame.resource : frame.type,
      ),
    ["trace", "context"],
  );

  registry.publishTranscriptAdvanced(workspacePath, sessionId);
  await tick();
  assert.equal(received.length, 3, "同一 durable watermark 不得重复发布");
});

test("partial persistence failure is emitted once on the sequenced Session channel", async () => {
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
  registry.publishContinuityDegraded(workspacePath, sessionId, "partial_persistence_failed");
  await waitFor(() => received.length === 1);
  assert.deepEqual(received[0], {
    hostEpoch: "host-epoch-1",
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    sessionId,
    type: "subscription.continuity_degraded",
    reason: "partial_persistence_failed",
  });
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
