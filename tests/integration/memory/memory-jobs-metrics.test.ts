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

test("Host projects current jobs only for opted-in callers; settled time range does not trim pending age", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-jobs-metrics-"));
  const original = SqliteMemoryItemStore.prototype.readExtractionMetrics;
  SqliteMemoryItemStore.prototype.readExtractionMetrics = async () => ({ ...metrics, jobs });
  const host = new DesktopAtomicMemoryService({ picoHome: root, publish: () => {} });
  try {
    const legacy = await host.getMetrics(root, { from: 100, to: 200 });
    assert.deepEqual(legacy, { metrics });
    const current = await host.getMetrics(root, { from: 100, to: 200, includeJobs: true });
    assert.deepEqual(parseRuntimeResult("memory.metrics.get", current).metrics.jobs, jobs);
    SqliteMemoryItemStore.prototype.readExtractionMetrics = async () => ({
      ...metrics,
      jobs: { ...jobs, reasons: [{ reason: "secret /private/path error", count: 1 }] },
    });
    const sanitized = await host.getMetrics(root, { includeJobs: true });
    assert.deepEqual(sanitized.metrics.jobs?.reasons, [{ reason: "unknown", count: 1 }]);
    assert.doesNotMatch(JSON.stringify(sanitized), /secret|private/);
  } finally {
    SqliteMemoryItemStore.prototype.readExtractionMetrics = original;
    host.close();
    await rm(root, { recursive: true, force: true });
  }
});
