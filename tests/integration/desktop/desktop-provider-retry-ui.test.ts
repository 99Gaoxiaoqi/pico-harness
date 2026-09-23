import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { JsonObject, RuntimeNotification } from "@pico/protocol";
import {
  applyProviderRetryNotification,
  displayExecutionError,
  modelCommunicationDiagnostic,
  providerStatusDiagnostic,
  providerRetryKey,
  type ProviderRetryNotice,
} from "../../../apps/desktop/src/renderer/provider-retry.js";
import {
  ProviderFailureCard,
  ProviderRetryBanner,
} from "../../../apps/desktop/src/renderer/conversation/ProviderRequestStatus.js";

function notification(
  topic: string,
  at: number,
  sessionId = "session-a",
  runId = "run-a",
  payload: JsonObject = {},
): RuntimeNotification {
  return {
    protocolVersion: 2,
    eventId: `${topic}:${at}:${sessionId}:${runId}`,
    topic,
    scope: { workspacePath: "/project", sessionId, runId },
    resourceVersion: 1,
    at,
    payload,
  };
}

const retryPayload = {
  phase: "scheduled",
  failedAttempt: 1,
  nextAttempt: 2,
  maxAttempts: 10,
  delayMs: 8_000,
  errorCategory: "request_failed",
  transportCode: "ETIMEDOUT",
  diagnosticId: "diag-safe-1",
};

test("retry banner follows one run and closes on output without reopening from late events", () => {
  const key = providerRetryKey("/project", "run-a");
  let states = applyProviderRetryNotification(
    {},
    notification("run.providerRetry", 100, "session-a", "run-a", retryPayload),
  );
  assert.equal(states[key]?.notice?.nextAttempt, 2);
  assert.equal(states[providerRetryKey("/project", "run-b")], undefined);
  states = applyProviderRetryNotification(
    states,
    notification("run.providerRetry", 110, "session-a", "run-a", {
      ...retryPayload,
      phase: "started",
    }),
  );
  assert.equal(states[key]?.notice?.phase, "started");
  states = applyProviderRetryNotification(
    states,
    notification("run.timeline", 120, "session-a", "run-a", {
      runId: "run-a",
      item: { eventType: "assistant.thinking", data: { active: true } },
    }),
  );
  assert.equal(states[key]?.notice, undefined);
  assert.equal(states[key]?.lastFailure, undefined);
  const stale = applyProviderRetryNotification(
    states,
    notification("run.providerRetry", 105, "session-a", "run-a", retryPayload),
  );
  assert.equal(stale, states);
  const other = applyProviderRetryNotification(
    states,
    notification("run.providerRetry", 130, "session-b", "run-b", retryPayload),
  );
  assert.equal(other[key]?.notice, undefined);
  assert.equal(other[providerRetryKey("/project", "run-b")]?.notice?.sessionId, "session-b");
  states = applyProviderRetryNotification(
    other,
    notification("run.finished", 140, "session-b", "run-b", { run: {} }),
  );
  assert.equal(states[providerRetryKey("/project", "run-b")]?.notice, undefined);
  assert.equal(
    states[providerRetryKey("/project", "run-b")]?.lastFailure?.diagnosticId,
    "diag-safe-1",
  );
});

test("retry and failure presentation keeps transport details out of conversation", () => {
  const notice: ProviderRetryNotice = {
    workspacePath: "/project",
    sessionId: "session-a",
    runId: "run-a",
    phase: "scheduled",
    failedAttempt: 1,
    nextAttempt: 2,
    maxAttempts: 10,
    delayMs: 8_000,
    at: Date.now(),
    errorCategory: "request_failed",
    transportCode: "ETIMEDOUT",
    diagnosticId: "diag-safe-1",
  };
  const retry = renderToStaticMarkup(createElement(ProviderRetryBanner, { notice }));
  assert.match(retry, /连接中断，正在自动重试/);
  assert.match(retry, /第 2\/10 次/);
  assert.doesNotMatch(retry, /ETIMEDOUT|diag-safe-1/);
  const failure = renderToStaticMarkup(
    createElement(ProviderFailureCard, {
      notice,
      title: "暂时无法连接模型",
      canRetry: true,
      onRetry: () => undefined,
      onDiagnostics: () => undefined,
    }),
  );
  assert.match(failure, /暂时无法连接模型/);
  assert.match(failure, /编辑后重试/);
  assert.match(failure, /查看诊断/);
  assert.doesNotMatch(failure, /ETIMEDOUT|diag-safe-1|ModelCommunicationError/);
  const raw =
    "ModelCommunicationError category=request_failed diagnosticId=diag-safe-1; detail omitted";
  assert.deepEqual(modelCommunicationDiagnostic(raw), {
    title: "模型连接失败",
    diagnosticId: "diag-safe-1",
  });
  assert.equal(displayExecutionError(raw), "模型连接失败");
  assert.equal(displayExecutionError(raw, true), "模型连接失败 · 诊断 ID：diag-safe-1");
  const statusError = "Model API request failed [403]; response omitted";
  assert.deepEqual(providerStatusDiagnostic(statusError), {
    title: "模型服务拒绝请求",
    httpStatus: 403,
  });
  assert.equal(displayExecutionError(statusError), "模型服务拒绝请求 · HTTP 403");
  assert.equal(
    displayExecutionError("LLMStatusError status=403; detail omitted"),
    "模型服务拒绝请求 · HTTP 403",
  );
  const statusFailure = renderToStaticMarkup(
    createElement(ProviderFailureCard, {
      httpStatus: 403,
      title: providerStatusDiagnostic(statusError)!.title,
      canRetry: true,
      onRetry: () => undefined,
      onDiagnostics: () => undefined,
    }),
  );
  assert.match(statusFailure, /请检查当前模型或连接设置/);
  assert.doesNotMatch(statusFailure, /Model API request failed|response omitted/);
  assert.equal(
    displayExecutionError("PermissionDenied: access required"),
    "PermissionDenied: access required",
  );
});
