import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { ProviderPhysicalAttempt } from "@pico/core";
import { operationalDatabasePath } from "@pico/storage";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import {
  querySessionExecution,
  querySessionExecutionSummary,
} from "../../../packages/pico-host/src/session-execution-query.js";

const at = "2026-09-22T00:00:00.000Z";
function event(id: string, kind: RuntimeEvent["kind"], data: object): RuntimeEvent {
  return {
    schemaVersion: 2,
    eventId: id,
    sessionId: "session",
    invocationId: "inv",
    runId: "run",
    turnId: "turn",
    at,
    partial: false,
    visibility: "internal",
    kind,
    data,
  } as RuntimeEvent;
}
function attempt(n: number, extra: Partial<ProviderPhysicalAttempt> = {}): ProviderPhysicalAttempt {
  return {
    attemptId: `attempt-${n}`,
    attempt: n,
    provider: "test-provider",
    model: "test-model",
    startedAt: at,
    completedAt: "2026-09-22T00:00:00.020Z",
    status: "succeeded",
    latencyMs: 20,
    usageBasis: "reported",
    ...extra,
  };
}

test("execution summary and steps use physical evidence once, preserve unknown usage, and survive trace decode failure", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-execution-enriched-"));
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await store.advanceOwnerFence("session", 0);
    await store.appendBatch(
      [
        event("opening", "run.started", { workDir: root, agentSwarmAuthorization: "none" }),
        event("start", "model.call.started", {
          providerCallId: "physical",
          provider: "test-provider",
          model: "test-model",
          purpose: "main",
          logicalCallId: "logical",
          retryAttempt: 1,
        }),
        event("settled", "model.call.settled", {
          providerCallId: "physical",
          logicalCallId: "logical",
          retryAttempt: 1,
          status: "succeeded",
          latencyMs: 50,
          usage: { promptTokens: 9999, completionTokens: 9999 },
          costCNY: 9999,
          costStatus: "estimated",
          attemptCoverage: "complete",
          attempts: [
            attempt(0, {
              status: "failed",
              usageBasis: "missing",
              httpStatus: 429,
              error: "x".repeat(500),
            }),
            attempt(1, {
              usage: {
                promptTokens: 10,
                completionTokens: 8,
                cacheReadTokens: 6,
                reasoningTokens: 3,
                reportedFields: ["prompt", "completion", "cacheRead", "reasoning"],
              },
              timeToFirstTokenMs: 5,
              costCNY: 0.2,
              costStatus: "estimated",
            }),
          ],
        }),
        event("legacy", "model.call.settled", {
          providerCallId: "legacy",
          status: "succeeded",
          latencyMs: 10,
          usage: { promptTokens: 2, completionTokens: 1 },
          costCNY: 0.1,
          costStatus: "estimated",
        }),
        event("partial", "model.call.settled", {
          providerCallId: "partial",
          status: "succeeded",
          latencyMs: 10,
          attemptCoverage: "partial",
          attempts: [
            attempt(0, {
              usageBasis: "partial",
              usage: {
                promptTokens: 0,
                completionTokens: 4,
                cacheReadTokens: 0,
                reasoningTokens: 0,
                reportedFields: ["completion"],
              },
            }),
          ],
        }),
        event("approval", "approval.requested", { approvalId: "approval", toolName: "Read" }),
        event("approved", "approval.settled", { approvalId: "approval", decision: "approved" }),
        {
          ...event("tool-start", "tool.started", {
            toolName: "Read",
            argumentsJson: "{}",
            argumentsHash: createHash("sha256").update("{}").digest("hex"),
            argumentsRedacted: false,
            recoveryMode: "replay_safe",
          }),
          refs: { toolCallId: "tool" },
        },
        {
          ...event("tool-end", "tool.result.recorded", {
            toolName: "Read",
            status: "succeeded",
            body: {
              storage: "inline",
              content: "result",
              sizeBytes: 6,
              sha256: createHash("sha256").update("result").digest("hex"),
            },
            projection: {
              version: 1,
              mode: "full",
              text: "result",
              strategy: "full",
              truncated: false,
            },
          }),
          at: "2026-09-22T00:00:00.025Z",
          visibility: "model",
          refs: { toolCallId: "tool" },
        },
        event("end", "run.terminal", { status: "completed" }),
      ],
      { ownerFence },
    );
    const summary = querySessionExecutionSummary(root, { sessionId: "session" });
    assert.equal(summary.modelCalls, 3);
    assert.equal(summary.toolCalls, 1);
    assert.equal(summary.toolDurationMs, 25);
    assert.equal(summary.physicalAttempts, 3);
    assert.equal(summary.retries, 2);
    assert.equal(summary.inputTokens, 12);
    assert.equal(summary.outputTokens, 13);
    assert.equal(summary.cachedInputTokens, 6);
    assert.equal(summary.reasoningTokens, 3);
    assert.equal(summary.cacheCoverage, "partial");
    assert.equal(summary.meteredCalls, 1);
    assert.equal(summary.unpricedCalls, 2);
    assert.ok(Math.abs(summary.costCNY! - 0.3) < 1e-9);
    const page = querySessionExecution(root, { sessionId: "session" });
    assert.deepEqual(page.summary, summary);
    assert.equal(page.coverage.modelAttempts, "mixed");
    const model = page.runs[0]!.steps[0]!;
    assert.equal(model.providerId, "test-provider");
    assert.equal(model.modelId, "test-model");
    assert.equal(model.retries, 2);
    assert.equal(model.firstTokenLatencyMs, 5);
    assert.equal(model.inputTokens, 10);
    assert.equal(model.cachedInputTokens, 6);
    assert.equal(model.costStatus, "unknown");
    assert.equal(model.attempts![0]!.inputTokens, undefined);
    assert.equal(model.attempts![0]!.error!.length, 500);
    assert.equal(
      page.runs[0]!.steps.find((s) => s.kind === "permission")!.permissionDecision,
      "approved",
    );
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= 48 * 1024);
    const db = new DatabaseSync(operationalDatabasePath(root));
    try {
      db.prepare(
        "UPDATE runtime_events SET payload_json = json_set(payload_json,'$.schemaVersion',999) WHERE event_id='approval'",
      ).run();
    } finally {
      db.close();
    }
    assert.throws(() => querySessionExecution(root, { sessionId: "session" }));
    assert.deepEqual(querySessionExecutionSummary(root, { sessionId: "session" }), summary);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("explicit zero physical attempts never fallback to logical metrics and reported zero cache stays known", async () => {
  const root = mkdtempSync(join(tmpdir(), "pico-execution-zero-"));
  const store = new SqliteRuntimeEventStore({ storageRoot: root });
  try {
    await store.initializeSession({ sessionId: "session", workDir: root });
    const ownerFence = await store.advanceOwnerFence("session", 0);
    await store.appendBatch(
      [
        event("opening", "run.started", { workDir: root, agentSwarmAuthorization: "none" }),
        event("zero", "model.call.settled", {
          providerCallId: "zero",
          status: "failed",
          latencyMs: 1,
          attempts: [],
          attemptCoverage: "complete",
          usage: { promptTokens: 999, completionTokens: 999 },
          costCNY: 999,
          costStatus: "estimated",
        }),
        event("settled", "model.call.settled", {
          providerCallId: "physical",
          status: "succeeded",
          latencyMs: 20,
          attemptCoverage: "complete",
          attempts: [
            attempt(0, {
              usage: {
                promptTokens: 4,
                completionTokens: 2,
                cacheReadTokens: 0,
                reportedFields: ["prompt", "completion", "cacheRead"],
              },
              costCNY: 0,
              costStatus: "included",
            }),
          ],
        }),
      ],
      { ownerFence },
    );
    const page = querySessionExecution(root, { sessionId: "session" });
    assert.equal(page.coverage.modelAttempts, "physical");
    assert.equal(page.summary.modelCalls, 2);
    assert.equal(page.summary.physicalAttempts, 1);
    assert.equal(page.summary.inputTokens, 4);
    assert.equal(page.summary.costCNY, 0);
    assert.equal(page.summary.cachedInputTokens, 0);
    assert.equal(page.summary.cacheCoverage, "complete");
    assert.equal(page.runs[0]!.steps[0]!.inputTokens, undefined);
    assert.deepEqual(page.runs[0]!.steps[0]!.attempts, []);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
