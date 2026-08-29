import assert from "node:assert/strict";
import test from "node:test";
import {
  createRuntimeNotification,
  type RuntimeParams,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
  type RuntimeTranscriptWatermark,
} from "../../src/daemon/protocol.js";
import {
  SessionSubscriptionRegistry,
  type SessionContinuityDataSource,
  type SessionSubscriptionSnapshot,
} from "../../src/daemon/session-subscription-owner.js";

const workspacePath = "/workspace";
const sessionId = "session";
const watermark = { historyEpoch: "history", projectorVersion: 3 as const, throughSequence: 2 };

class Source implements SessionContinuityDataSource {
  currentWatermark: RuntimeTranscriptWatermark = watermark;
  async readOpenSnapshot(): Promise<SessionSubscriptionSnapshot> {
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
  async readTranscriptPage(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<RuntimeResult<"session.transcript.page">> {
    return { watermark: params.through, items: [] };
  }
  async readTranscriptAdvance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<RuntimeResult<"session.transcript.advance">> {
    return { after: params.after, through: params.through, changes: [] };
  }
  async readTranscriptWatermark() {
    return this.currentWatermark;
  }
}

test("workbar resource invalidations share the ordered session continuity lane", async () => {
  const source = new Source();
  const registry = new SessionSubscriptionRegistry("host", source);
  const frames: RuntimeSessionSubscriptionFrame[] = [];
  const opened = await registry.open(
    { workspacePath, sessionId },
    {
      connectionId: "connection",
      push: async (frame) => {
        frames.push(frame);
      },
    },
  );
  registry.activate(workspacePath, sessionId, opened.subscriptionId, "connection");
  registry.publishRuntimeNotification(
    createRuntimeNotification({
      topic: "session.resourceChanged",
      scope: { workspacePath, sessionId },
      resourceVersion: 1,
      at: 1,
      payload: { resource: "tasks", revision: 4 },
    }),
  );
  source.currentWatermark = { ...watermark, throughSequence: 3 };
  registry.publishTranscriptAdvanced(workspacePath, sessionId);
  await waitFor(() => frames.length === 4);
  assert.deepEqual(
    frames.map((frame) => frame.type),
    [
      "subscription.resource_changed",
      "subscription.transcript_advanced",
      "subscription.resource_changed",
      "subscription.resource_changed",
    ],
  );
  assert.deepEqual(
    frames.map((frame) => frame.sequence),
    [1, 2, 3, 4],
  );
  assert.deepEqual(frames[0], {
    hostEpoch: "host",
    subscriptionId: opened.subscriptionId,
    sequence: 1,
    sessionId,
    type: "subscription.resource_changed",
    resource: "tasks",
    revision: 4,
  });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  assert.fail("timed out waiting for frames");
}
