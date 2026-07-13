import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { JobService } from "../../src/tasks/job-service.js";
import { RuntimeConflictError, RuntimeStore } from "../../src/tasks/runtime-store.js";

describe("RuntimeStore + JobService integration", () => {
  const tempDirs: string[] = [];
  const closeables: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const closeable of closeables.splice(0)) closeable.close();
    for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
  });

  it("以强持久 SQLite schema 保存 job/attempt/outbox 并通过 version + leaseEpoch CAS", () => {
    const workDir = makeTempDir(tempDirs);
    let now = 1_000;
    let id = 0;
    const service = new JobService({
      workDir,
      ownerId: "host-a",
      now: () => now,
      generateId: (prefix) => `${prefix}-${++id}`,
    });
    closeables.push(service);

    expect(service.store.databasePath).toBe(join(workDir, ".claw", "runtime.sqlite"));
    expect(service.store.pragmas).toEqual({
      journalMode: "wal",
      foreignKeys: 1,
      busyTimeout: 5_000,
      synchronous: 2,
    });

    const schema = new Database(service.store.databasePath, { readonly: true });
    const tables = (
      schema
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
        .all() as Array<{ name: string }>
    ).map((row) => row.name);
    schema.close();
    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "runtime_leases",
        "jobs",
        "job_attempts",
        "job_commands",
        "completion_outbox",
        "merge_requests",
        "provider_calls",
        "usage_baselines",
      ]),
    );

    const outputPath = join(workDir, "attempt-output.jsonl");
    const queued = service.dispatch({
      jobId: "job-1",
      type: "local_agent",
      executionClass: "recoverable",
      completionPolicy: "required",
      description: "integration worker",
      ownerSessionId: "session-1",
      outputPath,
    });
    expect(queued).toMatchObject({ status: "queued", version: 1, attemptCount: 0 });

    now = 2_000;
    const started = service.start(queued.jobId, {
      expectedVersion: queued.version,
      attemptId: "attempt-1",
      outputPath,
    });
    expect(started).toMatchObject({
      job: { status: "running", version: 2, leaseEpoch: 1, attemptCount: 1 },
      attempt: { status: "running", version: 1, leaseEpoch: 1, attemptNumber: 1 },
      lease: { ownerId: "host-a", leaseEpoch: 1 },
    });

    writeFileSync(outputPath, "0123456789\n最后一行\n", "utf8");
    expect(service.tail(queued.jobId, 5)).toBe("最后一行\n");

    expect(() =>
      service.terminal({
        jobId: queued.jobId,
        attemptId: started.attempt.attemptId,
        status: "succeeded",
        expectedJobVersion: 1,
        expectedAttemptVersion: 1,
        leaseEpoch: started.lease.leaseEpoch,
      }),
    ).toThrow(RuntimeConflictError);

    now = 3_000;
    const terminalInput = {
      jobId: queued.jobId,
      attemptId: started.attempt.attemptId,
      status: "succeeded" as const,
      expectedJobVersion: started.job.version,
      expectedAttemptVersion: started.attempt.version,
      leaseEpoch: started.lease.leaseEpoch,
      outputOffset: 24,
      completionPayload: { summary: "done" },
    };
    const finished = service.terminal(terminalInput);
    expect(finished).toMatchObject({
      job: { status: "succeeded", version: 3 },
      attempt: { status: "succeeded", version: 2, outputOffset: 24 },
      completion: {
        completionId: "completion:attempt-1",
        policy: "required",
        status: "succeeded",
        payload: { summary: "done" },
      },
    });

    // 同一个 attempt 的终态调用与 outbox 写入均幂等。
    expect(service.terminal(terminalInput).completion).toEqual(finished.completion);
    expect(service.pendingCompletions()).toHaveLength(1);
    expect(service.markCompletionDelivered(finished.completion.completionId).deliveredAt).toBe(now);
    expect(service.pendingCompletions()).toEqual([]);

    now = 4_000;
    const retried = service.retry(queued.jobId, finished.job.version);
    const secondAttempt = service.start(queued.jobId, {
      expectedVersion: retried.version,
      attemptId: "attempt-2",
    });
    expect(secondAttempt).toMatchObject({
      job: { status: "running", attemptCount: 2, leaseEpoch: 2 },
      attempt: { attemptNumber: 2, leaseEpoch: 2 },
    });
  });

  it("拒绝第二 owner 抢占活跃 lease，并为 command/provider call 提供幂等键", () => {
    const workDir = makeTempDir(tempDirs);
    let now = 1_000;
    const first = new JobService({ workDir, ownerId: "host-a", now: () => now });
    const second = new JobService({ workDir, ownerId: "host-b", now: () => now });
    closeables.push(first, second);

    const queued = first.dispatch({
      jobId: "job-shared",
      type: "local_bash",
      executionClass: "host_bound",
      completionPolicy: "optional",
      description: "shared",
    });
    first.start(queued.jobId, {
      expectedVersion: queued.version,
      attemptId: "attempt-shared",
      leaseTtlMs: 100,
    });
    expect(() => second.start(queued.jobId, { expectedVersion: 2 })).toThrow(/已由 host-a 持有/);

    const firstMessage = first.sendMessage(queued.jobId, "继续", "command-same");
    expect(firstMessage.inserted).toBe(true);
    expect(first.sendMessage(queued.jobId, "继续", "command-same").inserted).toBe(false);
    expect(() => first.sendMessage(queued.jobId, "不同消息", "command-same")).toThrow(
      RuntimeConflictError,
    );
    expect(first.pendingCommands(queued.jobId)).toHaveLength(1);
    first.markCommandDelivered("command-same");
    expect(first.pendingCommands(queued.jobId)).toEqual([]);

    const providerCall = {
      callId: "call-1",
      sessionId: "session-1",
      jobId: queued.jobId,
      attemptId: "attempt-shared",
      purpose: "subagent" as const,
      provider: "openai",
      model: "model-a",
      status: "succeeded" as const,
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 0,
      cost: 0.02,
    };
    expect(first.recordProviderCall(providerCall).inserted).toBe(true);
    expect(first.recordProviderCall(providerCall).inserted).toBe(false);
    expect(() => first.recordProviderCall({ ...providerCall, provider: "other" })).toThrow(
      RuntimeConflictError,
    );

    const baseline = {
      baselineId: "legacy-usage",
      sessionId: "session-1",
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.01,
      importedAt: 10,
    };
    expect(first.putUsageBaseline(baseline).inserted).toBe(true);
    expect(first.putUsageBaseline(baseline).inserted).toBe(false);

    now = 1_101;
    expect(second.reconcileExpiredJobs()).toEqual([
      expect.objectContaining({ jobId: queued.jobId, status: "interrupted", error: "owner_lost" }),
    ]);
    expect(second.pendingCompletions()).toEqual([
      expect.objectContaining({
        jobId: queued.jobId,
        attemptId: "attempt-shared",
        status: "interrupted",
      }),
    ]);
  });

  it("幂等导入 legacy TaskStore，运行中任务转 interrupted，坏文件隔离且不被空状态覆盖", async () => {
    const workDir = makeTempDir(tempDirs);
    const store = new RuntimeStore({ workDir, now: () => 9_000 });
    closeables.push(store);
    const legacyDir = join(workDir, ".claw", "tasks");
    const legacyPath = join(legacyDir, "state.json");
    mkdirSync(legacyDir, { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            taskId: "a_running",
            type: "local_agent",
            status: "running",
            description: "old running task",
            startTime: 100,
            outputOffset: 12,
            notified: false,
          },
          {
            taskId: "b_done",
            type: "local_bash",
            status: "completed",
            description: "old completed task",
            startTime: 200,
            endTime: 300,
            outputOffset: 4,
            notified: true,
          },
        ],
      }),
      "utf8",
    );

    await expect(store.importLegacyTaskStore(legacyPath)).resolves.toEqual({
      imported: 2,
      skipped: 0,
      interrupted: 1,
    });
    await expect(store.importLegacyTaskStore(legacyPath)).resolves.toEqual({
      imported: 0,
      skipped: 2,
      interrupted: 0,
    });
    expect(store.getJob("a_running")).toMatchObject({
      status: "interrupted",
      error: "imported from legacy TaskStore after host restart",
    });
    expect(store.getJob("b_done")?.status).toBe("succeeded");

    writeFileSync(legacyPath, "{broken", "utf8");
    const quarantined = await store.importLegacyTaskStore(legacyPath);
    expect(quarantined.quarantinePath).toBeDefined();
    expect(existsSync(legacyPath)).toBe(false);
    expect(existsSync(quarantined.quarantinePath!)).toBe(true);
    expect(readdirSync(legacyDir).some((name) => name.endsWith(".diagnostic.json"))).toBe(true);
    expect(store.listJobs()).toHaveLength(2);
  });
});

function makeTempDir(tempDirs: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "pico-runtime-store-"));
  tempDirs.push(directory);
  return directory;
}
