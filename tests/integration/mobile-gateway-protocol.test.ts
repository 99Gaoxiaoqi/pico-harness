import assert from "node:assert/strict";
import test from "node:test";
import {
  MAX_MOBILE_IDEMPOTENCY_KEY_LENGTH,
  MAX_MOBILE_MESSAGE_BYTES,
  parseMobileSendMessageBody,
  type MobileRealtimeEvent,
} from "@pico/protocol";

test("mobile message parser accepts only the narrow text contract", () => {
  assert.deepEqual(
    parseMobileSendMessageBody({
      sessionId: "session-1",
      text: "Continue the task",
      idempotencyKey: "mobile-message-1",
    }),
    {
      sessionId: "session-1",
      text: "Continue the task",
      idempotencyKey: "mobile-message-1",
    },
  );
});

test("mobile message parser rejects Runtime-only authority fields", () => {
  assert.throws(
    () =>
      parseMobileSendMessageBody({
        text: "Continue the task",
        idempotencyKey: "mobile-message-1",
        workspacePath: "/private/workspace",
      }),
    /unsupported field: workspacePath/,
  );
  assert.throws(
    () =>
      parseMobileSendMessageBody({
        text: "Continue the task",
        idempotencyKey: "mobile-message-1",
        input: { kind: "agent", name: "reviewer", task: "do everything" },
      }),
    /unsupported field: input/,
  );
});

test("mobile message parser enforces content and idempotency bounds", () => {
  assert.throws(
    () => parseMobileSendMessageBody({ text: "  ", idempotencyKey: "mobile-message-1" }),
    /must not be empty/,
  );
  assert.throws(
    () =>
      parseMobileSendMessageBody({
        text: "a".repeat(MAX_MOBILE_MESSAGE_BYTES + 1),
        idempotencyKey: "mobile-message-1",
      }),
    /exceeds 32768 bytes/,
  );
  assert.throws(
    () =>
      parseMobileSendMessageBody({
        text: "Continue the task",
        idempotencyKey: "a".repeat(MAX_MOBILE_IDEMPOTENCY_KEY_LENGTH + 1),
      }),
    /exceeds 128 characters/,
  );
});

test("mobile realtime events expose only narrow session projections", () => {
  const event: MobileRealtimeEvent = {
    type: "live",
    runId: "run-1",
    item: {
      kind: "assistantMessage",
      operation: "append",
      streamId: "assistant:run-1:1",
      turnId: "turn:run-1:1",
      delta: "Hello",
    },
  };

  assert.deepEqual(event, {
    type: "live",
    runId: "run-1",
    item: {
      kind: "assistantMessage",
      operation: "append",
      streamId: "assistant:run-1:1",
      turnId: "turn:run-1:1",
      delta: "Hello",
    },
  });
  assert.doesNotMatch(JSON.stringify(event), /workspacePath|sourcePath|data/);
});
