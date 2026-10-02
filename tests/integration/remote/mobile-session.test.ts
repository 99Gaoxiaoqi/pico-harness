import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSessionSubscriptionFrame, RuntimeResult } from "@pico/protocol/mobile";
import {
  GenerationFence,
  SerialPoller,
  validateAttachments,
  assertArtifactIntegrity,
  type RuntimePort,
} from "../../../apps/mobile/src/core.js";
import { MobileTranscript } from "../../../apps/mobile/src/transcript.js";

test("手机会话在缺少 toSorted 的引擎中补齐历史、分页并忽略切换后的响应", async (t) => {
  const sorting = Object.getOwnPropertyDescriptor(Array.prototype, "toSorted");
  Object.defineProperty(Array.prototype, "toSorted", { value: undefined, configurable: true });
  t.after(() => {
    if (sorting) Object.defineProperty(Array.prototype, "toSorted", sorting);
  });
  const watermark = { historyEpoch: "history", projectorVersion: 11 as const, throughSequence: 1 };
  const session = {
    sessionId: "s",
    workspacePath: "/authorized",
    title: "mobile",
    status: "active" as const,
    pinned: false,
    createdAt: 1,
    updatedAt: 1,
  };
  const record = (id: string, sequence: number) => ({
    itemId: id,
    itemRevision: 1,
    positionSequence: sequence,
    positionOrdinal: 0,
    item: { id, kind: "assistantMessage" as const, content: id },
  });
  let openCount = 0;
  const calls: string[] = [];
  const port = {
    request: async (method: string, params: Record<string, unknown>, workspaceId: string) => {
      calls.push(method);
      assert.equal(workspaceId, "w");
      assert.equal("workspacePath" in params, false);
      if (method === "session.subscription.open") {
        openCount++;
        return {
          session,
          hostEpoch: "host",
          subscriptionId: `sub-${openCount}`,
          nextSequence: 1,
          watermark,
          durableTail: [record("tail", 1)],
          activeOverlay: [],
          queuedInputs: [],
          olderCursor: { ...watermark, positionSequence: 1, positionOrdinal: 0, byteOffset: 0 },
        } satisfies RuntimeResult<"session.subscription.open">;
      }
      if (method === "session.transcript.advance")
        return {
          after: watermark,
          through: { ...watermark, throughSequence: 2 },
          changes: [{ op: "upsert", record: record("new", 2) }],
        };
      if (method === "session.transcript.page") return { watermark, items: [record("old", 0)] };
      if (method === "session.subscription.close") return { closed: true };
      throw new Error(method);
    },
  } as RuntimePort;
  let updates = 0;
  const transcript = new MobileTranscript(port, "w", "s", () => updates++);
  await transcript.open();
  await transcript.older();
  assert.deepEqual(
    transcript.replica.view.records.map((x) => x.itemId),
    ["old", "tail"],
  );
  const frame: RuntimeSessionSubscriptionFrame = {
    hostEpoch: "host",
    subscriptionId: "sub-1",
    sequence: 1,
    sessionId: "s",
    type: "subscription.transcript_advanced",
    watermark: { ...watermark, throughSequence: 2 },
  };
  await transcript.receive(frame);
  assert.deepEqual(
    transcript.replica.view.records.map((x) => x.itemId),
    ["old", "tail", "new"],
  );
  await transcript.receive({ ...frame, sequence: 3 });
  assert.equal(openCount, 2);
  assert.deepEqual(
    transcript.replica.view.records.map((x) => x.itemId),
    ["tail"],
  );
  transcript.dispose();
  const previous = updates;
  await transcript.receive(frame);
  assert.equal(updates, previous);
  assert.ok(calls.includes("session.subscription.close"));
  const fence = new GenerationFence();
  const current = fence.next();
  fence.next();
  assert.throws(() => fence.assert(current), /丢弃旧响应/);
});

test("手机终端快速前后台切换仍串行轮询，附件和下载损坏阻止交付", async () => {
  const poller = new SerialPoller();
  let concurrent = 0;
  let max = 0;
  let calls = 0;
  let release: () => void = () => {};
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  poller.start(
    async () => {
      concurrent++;
      calls++;
      max = Math.max(max, concurrent);
      await pending;
      concurrent--;
    },
    () => {},
    1,
  );
  poller.stop();
  poller.start(
    async () => {
      concurrent++;
      calls++;
      max = Math.max(max, concurrent);
      concurrent--;
    },
    () => {},
    1,
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls, 1);
  release();
  await new Promise((resolve) => setTimeout(resolve, 8));
  poller.stop();
  assert.equal(max, 1);
  const image = { type: "image_base64" as const, mimeType: "image/jpeg", data: "YQ==" };
  assert.equal(validateAttachments([image]), 1);
  assert.throws(() => validateAttachments(Array.from({ length: 5 }, () => image)), /4/);
  assert.throws(() => validateAttachments([{ ...image, data: "AAAA".repeat(90000) }]), /256/);
  assert.throws(
    () => assertArtifactIntegrity({ sizeBytes: 5, digest: "abc" }, 5, "bad"),
    /校验失败/,
  );
  assertArtifactIntegrity({ sizeBytes: 5, digest: "ABC" }, 5, "abc");
});
