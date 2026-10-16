import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createRuntimeRequest, parseStrictRuntimeParams, parseRuntimeResult } from "@pico/protocol";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const metrics = { scope: "user" as const, from: 100, to: 200, groups: [], unknownReceiptCount: 0 };
const jobs = {
  pending: 2,
  working: 1,
  blocked: 3,
  oldestPendingAt: 1,
  reasons: [{ reason: "model_unavailable", count: 3 }],
};

test("jobs protocol is optional, strict and rejects invalid counters and extra private data", () => {
  assert.deepEqual(createRuntimeRequest("memory.metrics.get", { includeJobs: true }).params, {
    includeJobs: true,
  });
  assert.throws(() =>
    parseStrictRuntimeParams("memory.metrics.get", JSON.parse('{"includeJobs":1}')),
  );
  assert.deepEqual(parseRuntimeResult("memory.metrics.get", { metrics }).metrics, metrics);
  assert.deepEqual(
    parseRuntimeResult("memory.metrics.get", { metrics: { ...metrics, jobs } }).metrics.jobs,
    jobs,
  );
  for (const bad of [
    { ...jobs, pending: -1 },
    { ...jobs, working: 1.2 },
    { ...jobs, oldestPendingAt: -1 },
    { ...jobs, path: "/private" },
    { ...jobs, reasons: [{ reason: "x", count: -1 }] },
    { ...jobs, reasons: [{ reason: "x", count: 1, message: "secret" }] },
  ]) {
    assert.throws(() =>
      parseRuntimeResult("memory.metrics.get", { metrics: { ...metrics, jobs: bad } }),
    );
  }
});

test("real Store → Host jobs are current across workspaces, independent of settled receipt range and opt-in compatible", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-jobs-metrics-"));
  let now = 1000;
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"), { now: () => now });
  const host = new DesktopAtomicMemoryService({
    picoHome: root,
    publish: () => {},
    now: () => now,
  });
  const enqueue = (id: string, workspaceKey: string, notBefore = now) =>
    store.enqueueExtractionJob({
      jobId: id,
      sessionId: `session-${id}`,
      workspaceKey,
      workDir: workspaceKey,
      sourceEventId: `event-${id}`,
      sourceHash: `hash-${id}`,
      sourceKind: "terminal",
      sourceOrdinal: 1,
      throughOrdinal: 1,
      trigger: "extract",
      deletionRevision: 0,
      settingsVersion: 1,
      notBefore,
    });
  const claim = async (jobId: string) => {
    const result = await store.claimExtractionJob({
      jobId,
      ownerId: "fixture",
      now,
      leaseDurationMs: 60_000,
    });
    assert.ok(result);
    return result;
  };
  try {
    // This unfinished job predates the entire seven-day settled-receipt range.
    await enqueue("old-pending", "/synthetic/a");
    now = 10 * 86_400_000;
    await enqueue("delayed-pending", "/synthetic/b", now + 86_400_000);
    await enqueue("working", "/synthetic/b");
    await claim("working");
    await enqueue("known-blocked", "/synthetic/a");
    await store.transitionExtractionJob({
      claim: await claim("known-blocked"),
      state: "blocked",
      reason: "provider_unsupported",
    });
    await enqueue("unknown-blocked", "/synthetic/c");
    await store.transitionExtractionJob({
      claim: await claim("unknown-blocked"),
      state: "blocked",
      reason: "private_raw_failure",
    });
    const range = { from: now - 7 * 86_400_000, to: now };
    const legacy = parseRuntimeResult(
      "memory.metrics.get",
      await host.getMetrics("/synthetic/a", range),
    ).metrics;
    assert.deepEqual(legacy, { scope: "user", ...range, groups: [], unknownReceiptCount: 0 });
    assert.equal(
      Object.hasOwn(legacy, "jobs"),
      false,
      "legacy strict clients must see their original shape",
    );
    const current = parseRuntimeResult(
      "memory.metrics.get",
      await host.getMetrics("/synthetic/a", { ...range, includeJobs: true }),
    ).metrics;
    assert.ok(current.jobs);
    assert.deepEqual(
      {
        ...current.jobs,
        reasons: [...current.jobs.reasons].sort((a, b) => a.reason.localeCompare(b.reason)),
      },
      {
        pending: 2,
        working: 1,
        blocked: 2,
        oldestPendingAt: 1000,
        reasons: [
          { reason: "model_unavailable", count: 1 },
          { reason: "unknown", count: 1 },
        ],
      },
    );
    assert.ok(
      current.jobs.oldestPendingAt! < range.from,
      "pending age is not limited to settled history",
    );
    const otherWorkspace = await host.getMetrics("/synthetic/b", { ...range, includeJobs: true });
    assert.deepEqual(
      otherWorkspace.metrics.jobs,
      current.jobs,
      "user jobs include all workspaces, without disclosing paths",
    );
    assert.doesNotMatch(
      JSON.stringify(current),
      /private_raw_failure|synthetic|session-|event-|hash-/,
    );
  } finally {
    host.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
