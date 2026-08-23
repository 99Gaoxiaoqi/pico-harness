import assert from "node:assert/strict";
import test from "node:test";
import type { RuntimeSessionSubscriptionFrame } from "@pico/protocol";
import {
  ACTIVE_OVERLAY_FLUSH_BYTES,
  PersistentActiveOverlay,
  parseActiveOverlayPayload,
  type ActiveOverlayPersistInput,
} from "../../src/daemon/session-active-overlay.js";

const base = {
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  itemId: "message:message-1:assistant",
  streamId: "assistant:run-1:turn-1",
  kind: "text" as const,
  anchorSequence: 3,
};

test("active overlay persists the first delta before publishing and uses UTF-8 byte offsets", async () => {
  const writes: ActiveOverlayPersistInput[] = [];
  const deltas: Extract<RuntimeSessionSubscriptionFrame, { type: "subscription.session_delta" }>[] =
    [];
  let release: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const overlay = new PersistentActiveOverlay(
    {
      async upsert(input) {
        writes.push(input);
        await gate;
        return { version: input.expectedVersion + 1 };
      },
    },
    {
      publishDelta(delta) {
        deltas.push(delta as (typeof deltas)[number]);
      },
      publishContinuityDegraded() {
        assert.fail("continuity should not degrade");
      },
    },
  );

  const first = overlay.append({ ...base, text: "中🙂" });
  await Promise.resolve();
  assert.equal(writes.length, 1);
  assert.equal(deltas.length, 0);
  release?.();
  await first;
  assert.equal(deltas[0]?.startOffsetBytes, 0);
  assert.equal(new TextEncoder().encode(deltas[0]?.text).byteLength, 7);

  await overlay.append({ ...base, text: "a" });
  assert.equal(deltas[1]?.startOffsetBytes, 7);
  await overlay.complete(base.streamId);
  assert.equal(writes.length, 1, "durable final 删除 partial 后 complete 不得再写回");
  assert.deepEqual(parseActiveOverlayPayload(writes[0]?.payload), writes[0]?.payload);
});

test("active overlay completion does not misreport degradation after durable final cleanup", async () => {
  let writes = 0;
  const degraded: string[] = [];
  const overlay = new PersistentActiveOverlay(
    {
      async upsert(input) {
        writes += 1;
        if (writes > 1) throw new Error("partial was atomically removed by durable final");
        return { version: input.expectedVersion + 1 };
      },
    },
    {
      publishDelta() {},
      publishContinuityDegraded(reason) {
        degraded.push(reason);
      },
    },
  );

  await overlay.append({ ...base, text: "prefix" });
  await overlay.append({ ...base, text: "final suffix" });
  await overlay.complete(base.streamId);
  await overlay.flush();

  assert.equal(writes, 1);
  assert.deepEqual(degraded, []);
});

test("active overlay flushes at 8KiB and degrades once per Run without stopping live", async () => {
  let calls = 0;
  const deltas: string[] = [];
  const degraded: string[] = [];
  const overlay = new PersistentActiveOverlay(
    {
      async upsert(input) {
        calls += 1;
        if (calls > 1) throw new Error("disk unavailable");
        return { version: input.expectedVersion + 1 };
      },
    },
    {
      publishDelta(delta) {
        const text = delta.text;
        assert.equal(typeof text, "string");
        deltas.push(text as string);
      },
      publishContinuityDegraded(reason) {
        degraded.push(reason);
      },
    },
  );

  await overlay.append({ ...base, text: "first" });
  await overlay.append({ ...base, text: "x".repeat(ACTIVE_OVERLAY_FLUSH_BYTES) });
  await overlay.flush();
  await overlay.append({ ...base, text: "still-live" });
  await overlay.flush();

  await overlay.append({
    ...base,
    streamId: "thinking:run-1:turn-1",
    kind: "thinking",
    text: "思考",
  });
  await overlay.flush();

  await overlay.append({
    ...base,
    runId: "run-2",
    streamId: "assistant:run-2:turn-1",
    text: "next-run",
  });

  assert.equal(calls, 3, "同一 Run 降级后不得继续持久化其他 stream；下一 Run 可重新尝试");
  assert.deepEqual(degraded, ["partial_persistence_failed", "partial_persistence_failed"]);
  assert.deepEqual(deltas, [
    "first",
    "x".repeat(ACTIVE_OVERLAY_FLUSH_BYTES),
    "still-live",
    "思考",
    "next-run",
  ]);
});

test("active overlay rolls old UTF-8 content and reports truncation honestly", async () => {
  const writes: ActiveOverlayPersistInput[] = [];
  const overlay = new PersistentActiveOverlay(
    {
      async upsert(input) {
        writes.push(input);
        return { version: input.expectedVersion + 1 };
      },
    },
    { publishDelta() {}, publishContinuityDegraded() {} },
    80,
    8,
  );

  await overlay.append({ ...base, text: "中中中" });
  await overlay.flush();
  const snapshot = overlay.snapshot()[0];
  assert.equal(snapshot?.endOffsetBytes, 9);
  assert.equal(snapshot?.truncatedBeforeBytes, 3);
  assert.equal(snapshot?.text, "中中");
  assert.equal(writes.at(-1)?.payload.text, "中中");
});
