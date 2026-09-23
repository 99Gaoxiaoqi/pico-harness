import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SqliteRuntimeControlStore, type PhysicalAttemptRecord } from "@pico/storage";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import type { RuntimeExecutionPage } from "@pico/protocol";
import { querySessionExecution } from "../../../packages/pico-host/src/session-execution-query.js";
import { ExecutionTraceTimeline } from "../../../apps/desktop/src/renderer/workbar-panels/ExecutionTraceTimeline.js";
import { partitionTimelineRuns } from "../../../apps/desktop/src/renderer/workbar-panels/inspector-timeline-state.js";

Object.assign(globalThis, { React });

function render(execution: RuntimeExecutionPage, selectedTraceId?: string) {
  return renderToStaticMarkup(
    React.createElement(ExecutionTraceTimeline, { execution, selectedTraceId, onSelectTrace() {} }),
  );
}

// Use the durable event projection consumed by Desktop, rather than a second UI-shaped trace store.
test("inspector timeline keeps projected run/turn ownership, honest unknowns and inline selected details", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-inspector-timeline-"));
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  const ledger = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "timeline", workDir: root });
    const ownerFence = await store.advanceOwnerFence("timeline", 0);
    const ownerId = ledger.beginPhysicalAttemptOwner();
    const ids = ["failed", "cancelled", "coverage-gap", "running", "normal", "empty"];
    for (const [index, runId] of ids.entries()) {
      const at = `2026-09-23T01:00:0${index}.000Z`;
      const event = <K extends RuntimeEvent["kind"]>(
        id: string,
        kind: K,
        data: object,
        extra: object = {},
      ) =>
        ({
          schemaVersion: 2,
          eventId: `${runId}-${id}`,
          sessionId: "timeline",
          invocationId: `${runId}-invocation`,
          runId,
          turnId: `${runId}-turn-1`,
          at,
          partial: false,
          visibility: "internal",
          kind,
          data,
          ...extra,
        }) as Extract<RuntimeEvent, { kind: K }>;
      const events: RuntimeEvent[] = [
        event("start", "run.started", { workDir: root, agentSwarmAuthorization: "none" }),
      ];
      if (runId === "normal" || runId === "failed") {
        events.push(
          event("model", "model.call.started", {
            providerCallId: `${runId}-call`,
            provider: "fixture-provider",
            model: "fixture-model",
            purpose: "main",
          }),
        );
        events.push(
          event("settled", "model.call.settled", {
            providerCallId: `${runId}-call`,
            status: runId === "failed" ? "failed" : "succeeded",
            latencyMs: 50,
            costStatus: "unknown",
            ...(runId === "failed" ? { error: "请求失败 · HTTP 402" } : {}),
          }),
        );
        const record: PhysicalAttemptRecord = {
          accountingVersion: 1,
          accountingSource: "physical",
          physicalAttemptId: `${runId}-attempt`,
          providerCallId: `${runId}-call`,
          logicalCallId: `${runId}-call`,
          ownerId,
          sessionId: "timeline",
          runId,
          turnId: `${runId}-turn-1`,
          purpose: "main",
          retryAttempt: 0,
          pricingVersion: "fixture",
          revision: 1,
          attempt: 0,
          provider: "fixture-provider",
          model: "fixture-model",
          startedAt: at,
          completedAt: at.replace(".000Z", ".050Z"),
          status: runId === "failed" ? "failed" : "succeeded",
          latencyMs: 50,
          timeToFirstTokenMs: 20,
          usageBasis: "missing",
          costStatus: "unknown",
          costUnknownReason: "未匹配该 endpoint 与模型的定价",
          ...(runId === "failed"
            ? {
                error: "请求失败 · HTTP 402",
                httpStatus: 402,
                errorClass: "LLMStatusError" as const,
                retryable: false,
              }
            : {}),
        };
        ledger.recordPhysicalAttempt({ ...record, revision: 0, status: "prepared" });
        ledger.recordPhysicalAttempt(record);
      }
      if (runId === "normal") {
        const input = '{"path":"fixture.json","pattern":"TRACE"}';
        const output = '{"matches":["TRACE"]}';
        events.push(
          event(
            "tool",
            "tool.started",
            {
              toolName: "grep",
              argumentsJson: input,
              argumentsHash: createHash("sha256").update(input).digest("hex"),
              argumentsRedacted: false,
              recoveryMode: "replay_safe",
            },
            { turnId: "normal-turn-2", refs: { toolCallId: "grep" } },
          ),
        );
        events.push(
          event(
            "output",
            "tool.result.recorded",
            {
              toolName: "grep",
              status: "succeeded",
              body: {
                storage: "inline",
                content: output,
                sizeBytes: output.length,
                sha256: createHash("sha256").update(output).digest("hex"),
              },
              projection: {
                version: 1,
                mode: "full",
                text: output,
                strategy: "full",
                truncated: true,
              },
            },
            {
              turnId: "normal-turn-2",
              refs: { toolCallId: "grep" },
              at: at.replace(".000Z", ".020Z"),
              visibility: "model",
            },
          ),
        );
        events.push(
          event(
            "permission",
            "approval.requested",
            { approvalId: "permission", toolName: "grep" },
            { turnId: "normal-turn-2" },
          ),
        );
        events.push(
          event(
            "approved",
            "approval.settled",
            { approvalId: "permission", decision: "approved" },
            { turnId: "normal-turn-2" },
          ),
        );
      }
      if (runId === "coverage-gap")
        events.push(
          event(
            "message",
            "message.committed",
            { message: { role: "assistant", content: "unattributed" } },
            { visibility: "model" },
          ),
        );
      if (runId !== "running")
        events.push(
          event(
            "terminal",
            "run.terminal",
            {
              status:
                runId === "failed" ? "failed" : runId === "cancelled" ? "cancelled" : "completed",
              ...(runId === "failed" ? { reason: "请求失败 · HTTP 402" } : {}),
            },
            { at: at.replace(".000Z", ".100Z") },
          ),
        );
      await store.appendBatch(events, { ownerFence });
    }
    const execution = querySessionExecution(root, { sessionId: "timeline" });
    const { visible, empty } = partitionTimelineRuns(execution);
    assert.deepEqual(
      empty.map((run) => run.runId),
      ["empty"],
    );
    assert.ok(visible.some((run) => run.runId === "coverage-gap"));
    assert.ok(visible.some((run) => run.runId === "running"));
    assert.ok(visible.some((run) => run.runId === "cancelled"));
    const initial = render(execution);
    assert.match(initial, /无步骤记录 · 1 条/u);
    assert.match(initial, /data-run-toggle="normal"[^>]*aria-expanded="true"/u);
    assert.match(initial, /data-run-toggle="running"[^>]*aria-expanded="true"/u);
    assert.match(initial, /data-run-toggle="failed"[^>]*aria-expanded="false"/u);
    assert.match(initial, /请求失败 · HTTP 402/u);
    assert.match(initial, /追踪覆盖不足/u);
    assert.match(initial, /已取消/u);
    assert.match(initial, /轮次 1/u);
    assert.match(initial, /轮次 2/u);
    assert.match(initial, /fixture-model/u);
    assert.match(initial, /已批准/u);
    assert.doesNotMatch(initial, /replay_safe|主任务|输入 未知|aria-pressed/u);
    const normal = execution.runs.find((run) => run.runId === "normal")!;
    const tool = normal.steps.find((step) => step.kind === "tool")!;
    const selected = render(execution, tool.id);
    assert.equal((selected.match(/aria-label="执行步骤详情"/gu) ?? []).length, 1);
    assert.ok(
      selected.indexOf('aria-label="执行步骤详情"') > selected.indexOf(`data-step-id="${tool.id}"`),
    );
    assert.match(selected, /复制输入/u);
    assert.match(selected, /复制输出/u);
    assert.match(selected, /内容已截断/u);
    assert.match(selected, /replay_safe/u);
    assert.match(selected, /\{\n {2}&quot;path&quot;: &quot;fixture.json&quot;/u);
    assert.match(selected, /步骤累计/u);
    const failed = execution.runs.find((run) => run.runId === "failed")!.steps[0]!;
    const failedSelected = render(execution, failed.id);
    assert.match(failedSelected, /data-run-toggle="failed"[^>]*aria-expanded="true"/u);
    assert.match(failedSelected, /输入 未知 \/ 输出 未知 Token/u);
    assert.match(failedSelected, /费用未知/u);
    assert.match(failedSelected, /复制模型标识/u);
    assert.match(failedSelected, /未匹配该 endpoint 与模型的定价/u);
    assert.match(failedSelected, /底层调用尝试/u);
    assert.match(failedSelected, /首 Token 耗时/u);
    assert.match(failedSelected, /第 1 次/u);
    assert.match(failedSelected, /失败诊断：LLMStatusError · 不可重试/u);
    assert.doesNotMatch(render(execution, "not-in-window"), /aria-label="执行步骤详情"/u);
  } finally {
    ledger.close();
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
