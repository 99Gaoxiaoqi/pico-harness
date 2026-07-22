import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recoverMemoryReviewJobs } from "../src/runtime/memory-review-recovery.js";
import { RuntimeEventStore } from "../src/runtime/runtime-event-store.js";

const runCount = positiveInteger(process.argv[2], 5_000, "runCount");
const assistantBytes = positiveInteger(process.argv[3], 8_192, "assistantBytes");
const root = await mkdtemp(join(tmpdir(), "pico-memory-recovery-benchmark-"));
const databasePath = join(root, "runtime.sqlite");
const sessionId = "memory-recovery-benchmark";
const store = new RuntimeEventStore({ databasePath });
const assistantBody = "x".repeat(assistantBytes);

try {
  await store.initializeSession({ sessionId, workDir: root });
  const startedAt = performance.now();
  for (let batchStart = 0; batchStart < runCount; batchStart += 100) {
    const batchEnd = Math.min(runCount, batchStart + 100);
    await store.appendBatch(
      Array.from({ length: batchEnd - batchStart }, (_, offset) => {
        const index = batchStart + offset;
        const runId = `benchmark-run-${index}`;
        const base = {
          schemaVersion: 1 as const,
          sessionId,
          invocationId: `benchmark-invocation-${index}`,
          runId,
          turnId: `benchmark-turn-${index}`,
          at: "2026-07-22T00:00:00.000Z",
          partial: false,
        };
        return [
          {
            ...base,
            eventId: `benchmark-started-${index}`,
            visibility: "internal" as const,
            kind: "run.started" as const,
            data: { workDir: root },
          },
          {
            ...base,
            eventId: `benchmark-user-${index}`,
            visibility: "model" as const,
            kind: "message.committed" as const,
            data: { message: { role: "user" as const, content: `ordinary input ${index}` } },
          },
          {
            ...base,
            eventId: `benchmark-assistant-${index}`,
            visibility: "model" as const,
            kind: "message.committed" as const,
            data: { message: { role: "assistant" as const, content: assistantBody } },
          },
          {
            ...base,
            eventId: `benchmark-terminal-${index}`,
            visibility: "internal" as const,
            kind: "run.terminal" as const,
            data: { status: "completed" as const },
          },
        ];
      }).flat(),
    );
  }
  store.close();
  globalThis.gc?.();
  const baseline = process.memoryUsage();
  let peakHeapUsed = baseline.heapUsed;
  let peakRss = baseline.rss;
  const sampler = setInterval(() => {
    const sample = process.memoryUsage();
    peakHeapUsed = Math.max(peakHeapUsed, sample.heapUsed);
    peakRss = Math.max(peakRss, sample.rss);
  }, 1);
  const recoveryStartedAt = performance.now();
  const recovered = await recoverMemoryReviewJobs({
    runtimeDatabasePath: databasePath,
    scheduler: { enqueue: () => undefined },
  });
  clearInterval(sampler);
  const final = process.memoryUsage();
  peakHeapUsed = Math.max(peakHeapUsed, final.heapUsed);
  peakRss = Math.max(peakRss, final.rss);
  process.stdout.write(
    `${JSON.stringify(
      {
        runCount,
        eventCount: runCount * 4,
        assistantBytes,
        payloadMiB: Number(((runCount * assistantBytes) / 1024 / 1024).toFixed(2)),
        recovered,
        fixtureMs: Number((recoveryStartedAt - startedAt).toFixed(1)),
        recoveryMs: Number((performance.now() - recoveryStartedAt).toFixed(1)),
        peakHeapDeltaMiB: Number(((peakHeapUsed - baseline.heapUsed) / 1024 / 1024).toFixed(2)),
        peakRssDeltaMiB: Number(((peakRss - baseline.rss) / 1024 / 1024).toFixed(2)),
      },
      undefined,
      2,
    )}\n`,
  );
} finally {
  store.close();
  await rm(root, { recursive: true, force: true });
}

function positiveInteger(value: string | undefined, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}
