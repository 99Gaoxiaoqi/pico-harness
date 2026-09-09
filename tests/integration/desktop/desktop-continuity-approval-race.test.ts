import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeResult,
  type RuntimeSessionSubscriptionFrame,
} from "@pico/protocol";
import {
  DesktopSessionContinuity,
  type DesktopSessionContinuityTransport,
} from "../../../apps/desktop/src/renderer/session-continuity.js";

test("审批 transcript 补页遇到订阅缺口时退出旧补页并恢复，不能同步空转阻塞界面", async () => {
  if (process.env.PICO_CONTINUITY_RACE_CHILD !== "1") {
    const childEnv: NodeJS.ProcessEnv = { ...process.env, PICO_CONTINUITY_RACE_CHILD: "1" };
    delete childEnv.NODE_TEST_CONTEXT;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", fileURLToPath(import.meta.url)],
      {
        env: childEnv,
        encoding: "utf8",
        timeout: 5000,
      },
    );
    assert.equal(result.error, undefined, "renderer must yield instead of looping synchronously");
    assert.equal(result.status, 0, result.stdout + result.stderr);
    return;
  }
  const watermark = (throughSequence: number) => ({
    historyEpoch: "history",
    projectorVersion: TRANSCRIPT_PROJECTOR_VERSION,
    throughSequence,
  });
  let listener!: (frame: RuntimeSessionSubscriptionFrame) => void;
  let resolveAdvance!: (value: RuntimeResult<"session.transcript.advance">) => void;
  let resolveClose!: (value: RuntimeResult<"session.subscription.close">) => void;
  let opens = 0;
  let emissions = 0;
  const errors: unknown[] = [];
  const transport: DesktopSessionContinuityTransport = {
    subscribeFrames(callback) {
      listener = callback;
      return { dispose() {} };
    },
    async open() {
      opens += 1;
      return {
        session: {
          sessionId: "session",
          workspacePath: "/workspace",
          title: "approval",
          status: "active",
          pinned: false,
          createdAt: 1,
          updatedAt: 1,
        },
        hostEpoch: "host",
        subscriptionId: `subscription-${opens}`,
        nextSequence: 1,
        watermark: watermark(opens === 1 ? 1 : 2),
        durableTail: [],
        activeOverlay: [],
        queuedInputs: [],
      };
    },
    close() {
      return new Promise((resolve) => {
        resolveClose = resolve;
      });
    },
    async page() {
      throw new Error("unexpected older page");
    },
    advance() {
      return new Promise((resolve) => {
        resolveAdvance = resolve;
      });
    },
  };
  const continuity = new DesktopSessionContinuity({
    transport,
    onView() {
      emissions += 1;
    },
    onError(error) {
      errors.push(error);
    },
  });
  await continuity.open("/workspace", "session");
  listener({
    hostEpoch: "host",
    subscriptionId: "subscription-1",
    sessionId: "session",
    sequence: 1,
    type: "subscription.transcript_advanced",
    watermark: watermark(2),
  });
  listener({
    hostEpoch: "host",
    subscriptionId: "subscription-1",
    sessionId: "session",
    sequence: 3,
    type: "subscription.transcript_advanced",
    watermark: watermark(3),
  });
  resolveAdvance({ after: watermark(1), through: watermark(2), changes: [] });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [], "stale advance must yield to subscription recovery");
  assert.ok(emissions < 10, "recovery must not repeatedly publish unchanged replica state");
  resolveClose({ closed: true });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(opens, 2);
  assert.equal(continuity.view("/workspace", "session")?.phase, "ready");
  assert.equal(continuity.view("/workspace", "session")?.watermark?.throughSequence, 2);
  continuity.dispose();
});
