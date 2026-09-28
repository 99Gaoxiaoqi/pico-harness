import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { redactDiagnostic } from "../../../apps/desktop/src/renderer/diagnostic-copy.js";
import { ModelCommunicationError, providerFailureSummary } from "@pico/core";
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

test("provider detail is visible locally while diagnostic export redacts credentials", () => {
  const message =
    "Model spark is not supported. api_key=sk-local-example123\nAuthorization: Bearer private-token\n/Users/test-user/project <script>alert(1)</script>";
  const raw = providerFailureSummary(
    new ModelCommunicationError(
      "stream_error",
      {
        diagnosticId: "local-detail",
        durationMs: 10,
        httpStatus: 200,
      },
      { message, code: "model_not_supported", requestId: "req-123" },
    ),
  )!;
  const diagnostic = modelCommunicationDiagnostic(raw)!;
  assert.match(diagnostic.providerDetail!, /sk-local-example123/);
  assert.equal(displayExecutionError(raw), "模型响应流错误");
  assert.match(displayExecutionError(raw, true), /Model spark is not supported/);
  const markup = renderToStaticMarkup(
    createElement(ProviderFailureCard, {
      title: diagnostic.title,
      providerDetail: diagnostic.providerDetail,
      diagnosticText: raw,
      canRetry: false,
      onRetry() {},
      onDiagnostics() {},
    }),
  );
  assert.match(markup, /Model spark is not supported/);
  assert.match(markup, /sk-local-example123/);
  assert.match(markup, /复制诊断/);
  assert.doesNotMatch(markup, /<script>/);
  const copied = redactDiagnostic(
    JSON.stringify({
      reason: raw,
      authorization: "Bearer hidden",
      cookie: "session=hidden",
      endpoint: "https://user:pass@example.com/api?access_token=hidden",
      details: "password='two words' refresh_token=hidden",
    }),
  );
  assert.doesNotMatch(
    copied,
    /sk-local-example123|private-token|test-user|user:pass|hidden|two words/,
  );
  assert.match(copied, /Model spark is not supported/);
  assert.match(copied, /req-123/);
  assert.match(copied, /已脱敏/);
  assert.match(raw, /sk-local-example123/);
  assert.deepEqual(
    modelCommunicationDiagnostic(raw.split("\n")[0]! + "\nProvider detail: {broken"),
    { title: "模型响应流错误", diagnosticId: "local-detail" },
  );
});
