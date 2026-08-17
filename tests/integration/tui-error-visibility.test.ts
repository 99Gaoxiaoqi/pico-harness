import assert from "node:assert/strict";
import { test } from "node:test";
import { createRuntimeNotification, type RuntimeNotification } from "@pico/protocol";
import { DaemonEventReporter } from "../../src/tui/daemon-event-reporter.js";
import { buildTranscriptLayout } from "../../src/tui/transcript-layout.js";
import type { TranscriptEntry } from "../../src/presentation/transcript-event-store.js";
import { TuiReporter } from "../../src/tui/tui-reporter.js";

/**
 * 错误可见性收口（2026-08-17）：provider 运行时失败（run 以 failed 收口）
 * 必须在 TUI 产生可见错误条目——此前 failed 归入 onInterrupted，
 * payload.run.error 被丢弃，界面对端点不可达/key 缺失等失败完全静默。
 */

function notification(
  topic: RuntimeNotification["topic"],
  payload: Record<string, unknown>,
  runId = "run_1",
): RuntimeNotification {
  return createRuntimeNotification({
    topic,
    scope: { workspacePath: "C:\\ws", runId },
    resourceVersion: 1,
    at: 1,
    payload: payload as Parameters<typeof createRuntimeNotification>[0]["payload"],
  }) as RuntimeNotification;
}

function errorEntries(reporter: TuiReporter) {
  // 投影条目是 {id, entry} 外层包装。
  return reporter
    .getProjection()
    .entries.map((wrapped) => wrapped.entry)
    .filter((entry) => entry.kind === "error")
    .map((entry) => (entry.kind === "error" ? entry : undefined))
    .filter((entry) => entry !== undefined);
}

test("run.finished failed：错误文本推成可见错误条目", () => {
  const reporter = new TuiReporter();
  const adapter = new DaemonEventReporter({ reporter });

  adapter.handleNotification(notification("run.started", { run: { runId: "run_1", status: "running" } }));
  adapter.handleNotification(
    notification("run.finished", {
      run: { runId: "run_1", status: "failed", error: "Provider deepseek 端点不可达" },
    }),
  );

  const errors = errorEntries(reporter);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /端点不可达/u);
  assert.equal(errors[0]!.retryable, true);
  assert.equal(adapter.running, false, "failed 终态必须收口运行相位");
});

test("run.updated 终态 failed 同样可见（与 run.finished 双通道一致）", () => {
  const reporter = new TuiReporter();
  const adapter = new DaemonEventReporter({ reporter });

  adapter.handleNotification(notification("run.started", { run: { runId: "run_1", status: "running" } }));
  adapter.handleNotification(
    notification("run.updated", {
      run: { runId: "run_1", status: "failed", error: "API key 缺失" },
    }),
  );

  const errors = errorEntries(reporter);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /API key 缺失/u);
});

test("run.finished succeeded/cancelled 不产错误条目（不误伤正常与用户中断）", () => {
  for (const status of ["succeeded", "cancelled", "interrupted"] as const) {
    const reporter = new TuiReporter();
    const adapter = new DaemonEventReporter({ reporter });
    adapter.handleNotification(notification("run.started", { run: { runId: "run_1", status: "running" } }));
    adapter.handleNotification(
      notification("run.finished", { run: { runId: "run_1", status, error: "ignored" } }),
    );
    assert.equal(errorEntries(reporter).length, 0, `status=${status} 不应产错误条目`);
  }
});

test("runtime.error topic：daemon 级错误可见（死通道复活）", () => {
  const reporter = new TuiReporter();
  const adapter = new DaemonEventReporter({ reporter });

  adapter.handleNotification(
    notification("runtime.error", { code: "internal_error", message: "会话装配失败", recoverable: true }),
  );

  const errors = errorEntries(reporter);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!.message, /会话装配失败/u);
});

test("failed run-boundary 水化条目按错误框计高（resume/重连后可见）", () => {
  const failed: TranscriptEntry = {
    kind: "run-boundary",
    runId: "run_1",
    status: "failed",
    startedAt: 1,
    finishedAt: 2,
    error: "Provider 调用失败：connect ECONNREFUSED 127.0.0.1:3000",
  };
  const succeeded: TranscriptEntry = {
    kind: "run-boundary",
    runId: "run_2",
    status: "succeeded",
    startedAt: 1,
    finishedAt: 2,
  };
  const layoutFailed = buildTranscriptLayout([failed], { wrapWidth: 80 });
  const layoutSucceeded = buildTranscriptLayout([succeeded], { wrapWidth: 80 });
  assert.ok(
    layoutFailed.items[0]!.rows > 1,
    "failed 边界必须渲染为多行错误框",
  );
  assert.equal(layoutSucceeded.items[0]!.rows, 1, "非 failed 边界保持单行占位");
});
