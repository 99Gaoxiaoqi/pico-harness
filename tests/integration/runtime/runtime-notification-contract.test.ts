import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createRuntimeNotification,
  isRuntimeNotification,
  LOCAL_RUNTIME_PROTOCOL_VERSION,
  parseRuntimeNotification,
  parseRuntimeResult,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
} from "@pico/protocol";

const workspacePath = "/workspace";

function runUpdated() {
  return createRuntimeNotification({
    eventId: "event-run-updated",
    topic: "run.updated",
    scope: { workspacePath, sessionId: "session-1", runId: "run-1" },
    resourceVersion: 2,
    at: 2,
    payload: {
      run: {
        runId: "run-1",
        workspacePath,
        sessionId: "session-1",
        description: "current run",
        status: "paused",
        startedAt: 1,
        updatedAt: 2,
        version: 2,
      },
    },
  });
}

test("Runtime notification 仅接受当前白名单与精确 envelope/payload", () => {
  const current = runUpdated();
  assert.equal(isRuntimeNotification(current), true);
  assert.strictEqual(parseRuntimeNotification(current), current);

  assert.equal(isRuntimeNotification({ ...current, topic: "run.paused" }), false);
  assert.equal(isRuntimeNotification({ ...current, legacy: true }), false);
  assert.equal(
    isRuntimeNotification({ ...current, payload: { ...current.payload, legacyRunId: "run-1" } }),
    false,
  );
});

test("Runtime notification scope 与 payload identity 必须一致且拒绝额外 scope", () => {
  const current = runUpdated();
  assert.equal(
    isRuntimeNotification({
      ...current,
      scope: { ...current.scope, runId: "run-other" },
    }),
    false,
  );
  assert.equal(
    isRuntimeNotification({
      ...current,
      scope: { ...current.scope, approvalId: "approval-legacy" },
    }),
    false,
  );
});

test("approval.requested 保持当前 tool 判别联合并校验 run identity", () => {
  const approval = createRuntimeNotification({
    eventId: "event-approval",
    topic: "approval.requested",
    scope: { workspacePath, sessionId: "session-1", runId: "run-1" },
    resourceVersion: 3,
    at: 3,
    payload: {
      approvalId: "approval-1",
      runId: "run-1",
      request: {
        kind: "tool",
        title: "需要批准",
        detail: "联网访问",
        risk: "high",
        toolName: "web_fetch",
        args: "{}",
        providerCallId: "call-1",
      },
    },
  });
  assert.equal(isRuntimeNotification(approval), true);
  assert.equal(
    isRuntimeNotification({
      ...approval,
      scope: { ...approval.scope, runId: "run-other" },
    }),
    false,
  );
});

test("events replay 与 live parser 共用严格 Runtime notification 解码", () => {
  const current = runUpdated();
  assert.deepEqual(parseRuntimeResult("events.replay", { events: [current], hasMore: false }), {
    events: [current],
    hasMore: false,
  });
  assert.throws(
    () =>
      parseRuntimeResult("events.replay", {
        events: [{ ...current, topic: "run.paused" }],
        hasMore: false,
      }),
    (error: unknown) =>
      error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.INVALID_REQUEST,
  );
});

test("Runtime job result 拒绝空 identity 与旧额外 id", () => {
  const job = {
    jobId: "job-1",
    workspacePath,
    name: "日报",
    prompt: "生成日报",
    schedule: "0 9 * * *",
    enabled: true,
    status: "idle",
    updatedAt: 1,
  } as const;
  assert.deepEqual(parseRuntimeResult("jobs.list", { jobs: [job] }), { jobs: [job] });
  for (const invalid of [
    { ...job, jobId: "" },
    { ...job, id: "job-legacy" },
  ]) {
    assert.throws(
      () => parseRuntimeResult("jobs.list", { jobs: [invalid] }),
      (error: unknown) =>
        error instanceof RuntimeProtocolError && error.code === RUNTIME_ERROR_CODES.INVALID_REQUEST,
    );
  }
});

test("未知 topic 的原始 envelope 被 fail-closed", () => {
  assert.equal(
    isRuntimeNotification({
      protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
      eventId: "event-unknown",
      topic: "workspace.ready",
      scope: { workspacePath },
      resourceVersion: 1,
      at: 1,
      payload: {},
    }),
    false,
  );
});
