import assert from "node:assert/strict";
import test from "node:test";
import {
  allowsEventLogWrite,
  DEFAULT_EVENT_LOG_RETENTION_POLICY,
  EVENT_LOG_CLOSURE_WRITE_INTENTS,
  planEventLogRetention,
  type EventLogRetentionCandidate,
} from "../../src/storage/event-log-retention-policy.js";

const MIB = 1024 * 1024;

function candidate(
  sessionId: string,
  overrides: Partial<EventLogRetentionCandidate> = {},
): EventLogRetentionCandidate {
  return {
    sessionId,
    logicalBytes: 200 * MIB,
    archivedAt: 100,
    activityAt: "2026-01-01T00:00:00.000Z",
    pinned: false,
    hasActiveRun: false,
    hasUnfinishedOperation: false,
    ...overrides,
  };
}

test("event log retention: defaults use a 2 GiB hard limit and 1.5 GiB low watermark", () => {
  assert.deepEqual(DEFAULT_EVENT_LOG_RETENTION_POLICY, {
    hardLimitBytes: 2 * 1024 * MIB,
    lowWatermarkBytes: 1.5 * 1024 * MIB,
  });
});

test("event log retention: below hard limit admits all writes without deleting", () => {
  const plan = planEventLogRetention({
    currentLogicalBytes: DEFAULT_EVENT_LOG_RETENTION_POLICY.hardLimitBytes - 1,
    currentSessionId: "current",
    sessions: [candidate("archived")],
  });

  assert.deepEqual(plan, {
    status: "within_limit",
    sessionIdsToDelete: [],
    estimatedLogicalBytesReclaimed: 0,
    projectedLogicalBytes: DEFAULT_EVENT_LOG_RETENTION_POLICY.hardLimitBytes - 1,
    canStartNewWork: true,
    canWriteClosure: true,
  });
  assert.equal(
    allowsEventLogWrite(DEFAULT_EVENT_LOG_RETENTION_POLICY.hardLimitBytes - 1, "new_work"),
    true,
  );
});

test("event log retention: filters protected sessions and orders candidates deterministically", () => {
  const sessions = [
    candidate("activity-z", { archivedAt: 10, activityAt: "2026-02-01", logicalBytes: 300 * MIB }),
    candidate("tie-b", { archivedAt: 10, activityAt: "2026-01-01", logicalBytes: 200 * MIB }),
    candidate("tie-a", { archivedAt: 10, activityAt: "2026-01-01", logicalBytes: 100 * MIB }),
    candidate("pinned", { archivedAt: 1, pinned: true, logicalBytes: 800 * MIB }),
    candidate("active", { archivedAt: 1, hasActiveRun: true, logicalBytes: 800 * MIB }),
    candidate("unfinished", {
      archivedAt: 1,
      hasUnfinishedOperation: true,
      logicalBytes: 800 * MIB,
    }),
    candidate("current", { archivedAt: 1, logicalBytes: 800 * MIB }),
    candidate("unarchived", { archivedAt: null, logicalBytes: 800 * MIB }),
  ];

  const plan = planEventLogRetention({
    currentLogicalBytes: 2100 * MIB,
    currentSessionId: "current",
    sessions,
  });

  assert.equal(plan.status, "retention_required");
  assert.deepEqual(plan.sessionIdsToDelete, ["tie-a", "tie-b", "activity-z"]);
  assert.equal(plan.estimatedLogicalBytesReclaimed, 600 * MIB);
  assert.equal(plan.projectedLogicalBytes, 1500 * MIB);
  assert.equal(plan.canStartNewWork, false);
  assert.equal(plan.canWriteClosure, true);
});

test("event log retention: quota-blocked keeps closure writes available when no candidate exists", () => {
  const hardLimit = DEFAULT_EVENT_LOG_RETENTION_POLICY.hardLimitBytes;
  const plan = planEventLogRetention({
    currentLogicalBytes: hardLimit,
    currentSessionId: "current",
    sessions: [candidate("current"), candidate("not-archived", { archivedAt: null })],
  });

  assert.equal(plan.status, "quota_blocked");
  assert.deepEqual(plan.sessionIdsToDelete, []);
  assert.equal(allowsEventLogWrite(hardLimit, "new_work"), false);
  for (const intent of EVENT_LOG_CLOSURE_WRITE_INTENTS) {
    assert.equal(allowsEventLogWrite(hardLimit, intent), true, intent);
  }
});

test("event log retention: insufficient candidates are returned but remain quota-blocked", () => {
  const plan = planEventLogRetention({
    currentLogicalBytes: 2200 * MIB,
    currentSessionId: null,
    sessions: [candidate("only", { logicalBytes: 100 * MIB })],
  });

  assert.equal(plan.status, "quota_blocked");
  assert.deepEqual(plan.sessionIdsToDelete, ["only"]);
  assert.equal(plan.estimatedLogicalBytesReclaimed, 100 * MIB);
  assert.equal(plan.projectedLogicalBytes, 2100 * MIB);
});

test("event log retention: rejects invalid limits and unsafe byte counts", () => {
  assert.throws(
    () =>
      planEventLogRetention({
        currentLogicalBytes: 100,
        currentSessionId: null,
        sessions: [],
        policy: { hardLimitBytes: 100, lowWatermarkBytes: 100 },
      }),
    /lowWatermarkBytes must be lower/,
  );
  assert.throws(
    () =>
      planEventLogRetention({
        currentLogicalBytes: Number.MAX_SAFE_INTEGER + 1,
        currentSessionId: null,
        sessions: [],
      }),
    /currentLogicalBytes must be a non-negative safe integer/,
  );
  assert.throws(
    () =>
      planEventLogRetention({
        currentLogicalBytes: 100,
        currentSessionId: null,
        sessions: [candidate("duplicate"), candidate("duplicate")],
      }),
    /Duplicate retention candidate sessionId: duplicate/,
  );
});
