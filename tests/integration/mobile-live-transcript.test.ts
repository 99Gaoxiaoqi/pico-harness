import assert from "node:assert/strict";
import test from "node:test";
import type { MobileConversationItem } from "@pico/protocol";
import {
  applyMobileLiveEvent,
  MAX_MOBILE_LIVE_CHARS,
  mergeMobileConversationItems,
} from "../../apps/mobile/src/lib/mobile-live-transcript.js";

test("mobile live answer grows until durable transcript replaces the exact turn", () => {
  const first = applyMobileLiveEvent(
    [],
    live("append", { streamId: "stream-1", turnId: "turn-1", delta: "正在" }),
    [],
  );
  const appended = applyMobileLiveEvent(
    first,
    live("append", { streamId: "stream-1", turnId: "turn-1", delta: "回答" }),
    [],
  );
  assert.equal(appended[0]?.content, "正在回答");
  assert.equal(appended[0]?.streaming, true);

  const durable: MobileConversationItem = {
    id: "assistant-1",
    kind: "assistantMessage",
    content: "正在回答",
    runId: "run-1",
    turnId: "turn-1",
  };
  assert.deepEqual(mergeMobileConversationItems([durable], appended), [durable]);
  assert.deepEqual(
    applyMobileLiveEvent(
      appended,
      live("append", { streamId: "stream-1", turnId: "turn-1", delta: "迟到" }),
      [durable],
    ),
    [],
  );
});

test("mobile live terminal state rejects late deltas and supports clearing reasoning", () => {
  const first = applyMobileLiveEvent(
    [],
    live("append", { streamId: "stream-1", turnId: "turn-1", delta: "回答" }),
    [],
  );
  const completed = applyMobileLiveEvent(first, live("complete", { streamId: "stream-1" }), []);
  assert.equal(completed[0]?.streaming, false);
  assert.deepEqual(
    applyMobileLiveEvent(
      completed,
      live("append", { streamId: "stream-1", turnId: "turn-1", delta: "迟到" }),
      [],
    ),
    completed,
  );

  const thinking = applyMobileLiveEvent(
    [],
    {
      ...live("append", { streamId: "thinking-1", delta: "检查配置" }),
      item: {
        kind: "thinking",
        operation: "append",
        streamId: "thinking-1",
        delta: "检查配置",
      },
    },
    [],
  );
  assert.deepEqual(
    applyMobileLiveEvent(
      thinking,
      {
        ...live("clear", { streamId: "thinking-1" }),
        item: { kind: "thinking", operation: "clear", streamId: "thinking-1" },
      },
      [],
    ),
    [],
  );
});

test("mobile live content stays bounded", () => {
  const items = applyMobileLiveEvent(
    [],
    live("append", { streamId: "stream-1", delta: "x".repeat(MAX_MOBILE_LIVE_CHARS + 10) }),
    [],
  );
  assert.equal(items[0]?.content.length, MAX_MOBILE_LIVE_CHARS);
  assert.equal(items[0]?.truncated, true);
});

function live(
  operation: "append" | "complete" | "clear",
  item: {
    readonly streamId?: string;
    readonly turnId?: string;
    readonly delta?: string;
  },
) {
  return {
    type: "live" as const,
    runId: "run-1",
    item: { kind: "assistantMessage" as const, operation, ...item },
  };
}
