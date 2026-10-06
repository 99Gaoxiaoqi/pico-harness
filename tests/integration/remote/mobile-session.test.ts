import assert from "node:assert/strict";
import test from "node:test";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeSessionSubscriptionFrame,
  type RuntimeResult,
} from "@pico/protocol/mobile";
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
  const watermark = {
    historyEpoch: "history",
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    throughSequence: 1,
  };
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
    ["old", "tail"],
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

const recoverySession = {
  sessionId: "recovery",
  workspacePath: "/authorized",
  title: "recovery fixture",
  status: "active" as const,
  pinned: false,
  createdAt: 1,
  updatedAt: 1,
};
function recoveryRecord(id: string, sequence: number, revision = 1) {
  return {
    itemId: id,
    itemRevision: revision,
    positionSequence: sequence,
    positionOrdinal: 0,
    item: { id, kind: "assistantMessage" as const, content: `${id}:${revision}` },
  };
}
function recoveryWatermark(sequence: number, historyEpoch = "history") {
  return {
    historyEpoch,
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    throughSequence: sequence,
  };
}
function recoveryCursor(sequence: number, through: number, historyEpoch = "history") {
  return {
    ...recoveryWatermark(through, historyEpoch),
    positionSequence: sequence,
    positionOrdinal: 0,
    byteOffset: 0,
  };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("手机后台恢复用新快照及新游标补齐阅读范围，刷新不复活已删除历史", async (t) => {
  let opens = 0;
  let pagesInFlight = 0;
  let maxPagesInFlight = 0;
  const restoring = deferred<void>();
  const release = deferred<void>();
  let displayed: readonly string[] = [];
  const port = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "session.subscription.close") return { closed: true };
      if (method === "session.subscription.open") {
        opens++;
        const through = opens === 1 ? 10 : 10 + opens;
        return {
          session: recoverySession,
          hostEpoch: "host",
          subscriptionId: `sub-${opens}`,
          nextSequence: 1,
          watermark: recoveryWatermark(through),
          durableTail:
            opens === 1
              ? [recoveryRecord("deleted-tail", 9), recoveryRecord("tail", 10)]
              : [recoveryRecord("tail", through, opens)],
          activeOverlay: [],
          queuedInputs: [],
          olderCursor: recoveryCursor(opens === 1 ? 9 : through, through),
        } satisfies RuntimeResult<"session.subscription.open">;
      }
      if (method === "session.transcript.page") {
        pagesInFlight++;
        maxPagesInFlight = Math.max(maxPagesInFlight, pagesInFlight);
        try {
          const cursor = params.cursor as ReturnType<typeof recoveryCursor>;
          const through = cursor.throughSequence;
          if (opens === 2 && cursor.positionSequence === 12) {
            restoring.resolve();
            await release.promise;
          }
          if (cursor.positionSequence > 5)
            return {
              watermark: recoveryWatermark(through),
              items:
                opens === 1
                  ? [recoveryRecord("deleted-page", 2), recoveryRecord("anchor", 5)]
                  : [recoveryRecord("anchor", 5, opens)],
              nextCursor: recoveryCursor(opens === 1 ? 2 : 5, through),
            };
          return { watermark: recoveryWatermark(through), items: [recoveryRecord("first", 0)] };
        } finally {
          pagesInFlight--;
        }
      }
      throw new Error(method);
    },
  } as RuntimePort;
  const transcript = new MobileTranscript(port, "w", recoverySession.sessionId, (view) => {
    displayed = view.records.map((record) => record.itemId);
  });
  t.after(() => transcript.dispose());
  await transcript.open();
  await transcript.older();
  await transcript.older();
  assert.deepEqual(displayed, ["first", "deleted-page", "anchor", "deleted-tail", "tail"]);
  assert.equal(transcript.restoreVersion, 1);
  transcript.suspend();
  assert.equal(transcript.ready, false);
  assert.equal(displayed[0], "first", "后台保留已加载只读记录");
  const resumed = transcript.open();
  await restoring.promise;
  assert.equal(transcript.ready, false);
  assert.deepEqual(
    displayed,
    ["first", "deleted-page", "anchor", "deleted-tail", "tail"],
    "恢复早页期间不发布短 tail",
  );
  release.resolve();
  await resumed;
  assert.equal(transcript.ready, true);
  assert.equal(transcript.restoreVersion, 2);
  assert.deepEqual(displayed, ["first", "anchor", "tail"], "删除项不得从旧快照合并回来");
  assert.equal(transcript.replica.view.records[1]?.itemRevision, 2);
  await transcript.open();
  assert.equal(transcript.restoreVersion, 3, "计划或未知结果触发 open 也恢复范围");
  assert.deepEqual(displayed, ["first", "anchor", "tail"]);
  assert.equal(maxPagesInFlight, 1, "早页恢复串行请求");
});

test("手机连续恢复隔离迟到页面，epoch 变化清理旧范围，超限保留新权威记录", async (t) => {
  let opens = 0;
  let epoch = "history";
  let slowPage = false;
  let bounded = false;
  let slowOpen = false;
  let restoredPages = 0;
  const pageStarted = deferred<void>();
  const latePage = deferred<RuntimeResult<"session.transcript.page">>();
  const openStarted = deferred<void>();
  const releaseOpen = deferred<void>();
  let updates = 0;
  const closedSubscriptions: string[] = [];
  const port = {
    request: async (method: string, params: Record<string, unknown>) => {
      if (method === "session.subscription.close") {
        closedSubscriptions.push(String(params.subscriptionId));
        return { closed: true };
      }
      if (method === "session.subscription.open") {
        opens++;
        if (slowOpen) {
          openStarted.resolve();
          await releaseOpen.promise;
        }
        const through = bounded ? 100 : opens + 10;
        return {
          session: recoverySession,
          hostEpoch: "host",
          subscriptionId: `sub-${opens}`,
          nextSequence: 1,
          watermark: recoveryWatermark(through, epoch),
          durableTail: [recoveryRecord(`tail-${opens}`, through)],
          activeOverlay: [],
          queuedInputs: [],
          olderCursor: recoveryCursor(through, through, epoch),
        } satisfies RuntimeResult<"session.subscription.open">;
      }
      if (method === "session.transcript.page") {
        const cursor = params.cursor as ReturnType<typeof recoveryCursor>;
        if (slowPage) {
          slowPage = false;
          pageStarted.resolve();
          return latePage.promise;
        }
        if (bounded) {
          restoredPages++;
          const next = cursor.positionSequence - 1;
          return {
            watermark: recoveryWatermark(100, epoch),
            items: [recoveryRecord(`page-${next}`, next)],
            nextCursor: recoveryCursor(next, 100, epoch),
          };
        }
        return {
          watermark: recoveryWatermark(cursor.throughSequence, epoch),
          items: [recoveryRecord("first", 0)],
        };
      }
      throw new Error(method);
    },
  } as RuntimePort;
  const transcript = new MobileTranscript(port, "w", recoverySession.sessionId, () => updates++);
  t.after(() => transcript.dispose());
  await transcript.open();
  await transcript.older();
  slowPage = true;
  const stale = transcript.open();
  await pageStarted.promise;
  transcript.suspend();
  epoch = "new-history";
  await transcript.open();
  assert.equal(transcript.restoreVersion, 2);
  assert.deepEqual(
    transcript.replica.view.records.map((record) => record.itemId),
    ["tail-3"],
    "新 epoch 不使用旧范围或 cursor",
  );
  const currentUpdates = updates;
  latePage.resolve({ watermark: recoveryWatermark(12), items: [recoveryRecord("late", 0)] });
  await stale;
  assert.equal(updates, currentUpdates, "迟到恢复不发布，不影响新一轮 ready");
  assert.equal(transcript.ready, true);
  await transcript.older();
  bounded = true;
  const version = transcript.restoreVersion;
  await assert.rejects(transcript.open(), /请继续加载更早记录/);
  assert.equal(restoredPages, 20, "恢复页数有界");
  assert.equal(transcript.ready, true, "阅读范围失败不破坏已成功的权威会话同步");
  assert.equal(transcript.restoreVersion, version, "部分恢复不触发滚动恢复");
  assert.equal(
    transcript.replica.view.records.some((record) => record.itemId === "first"),
    false,
    "超限不合并旧早页",
  );
  slowOpen = true;
  const disposedOpen = transcript.open();
  await openStarted.promise;
  const lateSubscription = `sub-${opens}`;
  transcript.dispose();
  const disposedUpdates = updates;
  let otherUpdates = 0;
  const otherPort = {
    request: async () => ({
      session: { ...recoverySession, sessionId: "other-session" },
      hostEpoch: "other-host",
      subscriptionId: "other-sub",
      nextSequence: 1,
      watermark: recoveryWatermark(1),
      durableTail: [recoveryRecord("other-record", 1)],
      activeOverlay: [],
      queuedInputs: [],
    }),
  } as RuntimePort;
  const other = new MobileTranscript(
    otherPort,
    "other-workspace",
    "other-session",
    () => otherUpdates++,
  );
  t.after(() => other.dispose());
  await other.open();
  const currentOtherUpdates = otherUpdates;
  releaseOpen.resolve();
  await disposedOpen;
  await transcript.open();
  assert.ok(closedSubscriptions.includes(lateSubscription), "卸载后迟到的订阅必须释放");
  assert.equal(updates, disposedUpdates, "已切换/卸载的会话不得重新发布");
  assert.equal(otherUpdates, currentOtherUpdates, "旧会话 open 迟到不得污染新上下文");
  assert.equal(other.ready, true);
});
