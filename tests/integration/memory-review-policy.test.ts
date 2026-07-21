import assert from "node:assert/strict";
import test from "node:test";
import type { Job } from "../../src/memory/domain.js";
import {
  evaluateMemoryReviewBudget,
  evaluateMemoryReviewBudgetForJobs,
  MEMORY_REVIEW_BUDGETS,
} from "../../src/memory/memory-review-policy.js";

const now = new Date("2026-07-22T12:00:00.000Z");

test("memory review modes expose bounded rolling budgets", () => {
  assert.deepEqual(MEMORY_REVIEW_BUDGETS, {
    eco: { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 },
    balanced: {
      maxCalls: 8,
      maxInputTokens: 16_000,
      maxOutputTokens: 2_000,
      maxCostUsd: 0.1,
    },
    quality: {
      maxCalls: 16,
      maxInputTokens: 32_000,
      maxOutputTokens: 4_000,
      maxCostUsd: 0.25,
    },
  });
  const eco = evaluateMemoryReviewBudget("eco", [], now);
  assert.equal(eco.allowed, false);
  assert.equal(eco.reason, "eco-mode");
  assert.equal(eco.nextRecoveryAt, undefined);
});

test("balanced review budget aggregates a rolling day and reports exact recovery", () => {
  const entries = Array.from({ length: 8 }, (_, index) => ({
    terminalAt: new Date(now.getTime() - (8 - index) * 60 * 60 * 1_000).toISOString(),
    inputTokens: 1_000,
    outputTokens: 100,
    costUsd: 0.01,
  }));
  const exhausted = evaluateMemoryReviewBudget("balanced", entries, now);
  assert.equal(exhausted.allowed, false);
  assert.equal(exhausted.reason, "budget-exhausted");
  assert.equal(exhausted.nextRecoveryAt, "2026-07-23T04:00:00.000Z");
  assert.deepEqual(exhausted.usage, {
    calls: 8,
    inputTokens: 8_000,
    outputTokens: 800,
    costUsd: 0.08,
  });

  const afterRecovery = evaluateMemoryReviewBudget(
    "balanced",
    entries,
    new Date("2026-07-23T04:00:00.001Z"),
  );
  assert.equal(afterRecovery.allowed, true);
  assert.equal(afterRecovery.usage.calls, 7);
});

test("job adapter counts only terminal extraction model metrics and stores no bodies", () => {
  const jobs = [
    job({ jobId: "success", status: "succeeded", inputTokens: 16_000 }),
    job({ jobId: "failed", status: "failed", inputTokens: 0, outputTokens: 0, costUsd: 0 }),
    job({ jobId: "queued", status: "queued", inputTokens: 50_000 }),
    job({ jobId: "notification", type: "notification.memory.proposed", inputTokens: 50_000 }),
  ];
  const decision = evaluateMemoryReviewBudgetForJobs("balanced", jobs, now);
  assert.equal(decision.allowed, false);
  assert.deepEqual(decision.usage, {
    calls: 2,
    inputTokens: 16_000,
    outputTokens: 50,
    costUsd: 0.01,
  });
  assert.equal(JSON.stringify(decision).includes("content"), false);
});

function job(overrides: Partial<Job> & Pick<Job, "jobId">): Job {
  const { jobId, ...patch } = overrides;
  return {
    jobId,
    workspaceId: "workspace-test" as Job["workspaceId"],
    type: "terminal-extraction",
    status: "succeeded",
    terminalEventId: `terminal-${jobId}`,
    extractorVersion: "test-v1",
    cursor: { sessionId: "session-1", sequence: 1 },
    attemptCount: 1,
    maxAttempts: 3,
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.01,
    version: 1,
    createdAt: "2026-07-22T10:00:00.000Z",
    updatedAt: "2026-07-22T11:00:00.000Z",
    terminalAt: "2026-07-22T11:00:00.000Z",
    ...patch,
  };
}
