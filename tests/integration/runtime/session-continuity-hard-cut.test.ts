import assert from "node:assert/strict";
import test from "node:test";
import {
  DESKTOP_RUNTIME_METHODS,
  RUNTIME_METHODS,
  isEphemeralRuntimeNotificationTopic,
  isRuntimeMethod,
} from "@pico/protocol";

test("session continuity v2 rejects removed transcript and workspace live paths", () => {
  assert.equal(isRuntimeMethod("session.transcript"), false);
  assert.equal(RUNTIME_METHODS.includes("session.transcript" as never), false);
  assert.equal(DESKTOP_RUNTIME_METHODS.includes("session.transcript" as never), false);
  assert.equal(isEphemeralRuntimeNotificationTopic("run.live"), false);
});
