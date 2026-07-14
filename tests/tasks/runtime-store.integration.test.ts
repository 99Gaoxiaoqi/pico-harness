import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
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

    expect(service.store.databasePath).toBe(resolvePicoPaths(workDir).workspace.runtimeDatabase);
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
    const started = first.start(queued.jobId, {
      expectedVersion: queued.version,
      attemptId: "attempt-shared",
      leaseTtlMs: 100,
    });
    expect(() => second.start(queued.jobId, { expectedVersion: 2 })).toThrow(/已由 host-a 持有/);
    expect(() =>
      second.terminal({
        jobId: queued.jobId,
        attemptId: started.attempt.attemptId,
        status: "failed",
        expectedJobVersion: started.job.version,
        expectedAttemptVersion: started.attempt.version,
        leaseEpoch: started.lease.leaseEpoch,
        error: "owner-b must not settle owner-a attempt",
      }),
    ).toThrow(/ownerId\/leaseEpoch/);
    expect(first.get(queued.jobId)).toMatchObject({
      job: { status: "running" },
      attempts: [{ status: "running", ownerId: "host-a" }],
    });

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
    expect(
      first.recordProviderCall({
        ...providerCall,
        callId: "call-hook-1",
        purpose: "hook",
      }).inserted,
    ).toBe(true);

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

  it("仅将证据更新的 legacy 终态前滚到 runtime，且不回滚后续权威更新", async () => {
    const workDir = makeTempDir(tempDirs);
    let now = 100;
    const service = new JobService({ workDir, ownerId: "cutover-host", now: () => now });
    closeables.push(service);
    const queued = service.dispatch({
      jobId: "cutover-job",
      type: "local_agent",
      executionClass: "host_bound",
      completionPolicy: "optional",
      description: "queued in sqlite",
      ownerSessionId: "owner-session",
    });
    const alreadyNotified = service.dispatch({
      jobId: "cutover-notified",
      type: "local_agent",
      executionClass: "host_bound",
      completionPolicy: "optional",
      description: "already delivered before cutover",
      ownerSessionId: "owner-session",
    });
    const legacyPath = join(workDir, ".claw", "tasks", "state.json");
    mkdirSync(join(workDir, ".claw", "tasks"), { recursive: true });
    const legacyTerminal = {
      taskId: queued.jobId,
      type: "local_agent",
      status: "completed",
      description: "completed before cutover",
      startTime: 100,
      endTime: 200,
      outputOffset: 17,
      notified: false,
      data: {
        runtimeVersion: queued.version,
        completionId: "completion:cutover-job:1",
        completionSeq: 7,
        completionPolicy: "optional",
        aggregateStatus: "completed",
        activityIds: ["activity-cutover"],
        outputSummary: "legacy result",
      },
    } as const;
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        tasks: [
          legacyTerminal,
          {
            ...legacyTerminal,
            taskId: alreadyNotified.jobId,
            endTime: 210,
            notified: true,
            data: {
              ...legacyTerminal.data,
              completionId: "completion:cutover-notified:1",
            },
          },
        ],
      }),
      "utf8",
    );

    now = 300;
    await expect(service.store.importLegacyTaskStore(legacyPath)).resolves.toEqual({
      imported: 2,
      skipped: 0,
      interrupted: 0,
    });
    expect(service.get(queued.jobId)).toMatchObject({
      job: {
        status: "succeeded",
        version: 2,
        attemptCount: 1,
        terminalAt: 200,
        data: {
          legacyTaskStoreImport: {
            legacyStatus: "completed",
            runtimeVersionBefore: 1,
          },
        },
      },
      attempts: [
        expect.objectContaining({
          status: "succeeded",
          attemptNumber: 1,
          outputOffset: 17,
          finishedAt: 200,
        }),
      ],
    });
    expect(service.pendingCompletions({ ownerSessionId: "owner-session" })).toEqual([
      expect.objectContaining({
        completionId: "completion:cutover-job:1",
        status: "succeeded",
      }),
    ]);
    expect(service.store.getCompletion("completion:cutover-notified:1")).toMatchObject({
      jobId: alreadyNotified.jobId,
      deliveredAt: 300,
    });

    writeFileSync(legacyPath, JSON.stringify({ version: 1, tasks: [legacyTerminal] }), "utf8");
    await expect(service.store.importLegacyTaskStore(legacyPath)).resolves.toEqual({
      imported: 0,
      skipped: 1,
      interrupted: 0,
    });
    now = 400;
    expect(service.retry(queued.jobId, 2)).toMatchObject({ status: "queued", version: 3 });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        tasks: [{ ...legacyTerminal, description: "stale terminal rewritten" }],
      }),
      "utf8",
    );
    await expect(service.store.importLegacyTaskStore(legacyPath)).resolves.toEqual({
      imported: 0,
      skipped: 1,
      interrupted: 0,
    });
    expect(service.get(queued.jobId)?.job).toMatchObject({ status: "queued", version: 3 });
  });

  it("无法判定 legacy 终态新旧时保留原文件并拒绝覆盖 runtime", async () => {
    const workDir = makeTempDir(tempDirs);
    const service = new JobService({ workDir, ownerId: "cutover-host", now: () => 100 });
    closeables.push(service);
    service.dispatch({
      jobId: "ambiguous-job",
      type: "local_agent",
      executionClass: "host_bound",
      completionPolicy: "required",
      description: "authoritative queued",
    });
    const legacyPath = join(workDir, ".claw", "tasks", "state.json");
    mkdirSync(join(workDir, ".claw", "tasks"), { recursive: true });
    writeFileSync(
      legacyPath,
      JSON.stringify({
        version: 1,
        tasks: [
          {
            taskId: "ambiguous-job",
            type: "local_agent",
            status: "failed",
            description: "missing terminal timestamp",
            startTime: 100,
            outputOffset: 0,
            notified: false,
          },
        ],
      }),
      "utf8",
    );

    await expect(service.store.importLegacyTaskStore(legacyPath)).rejects.toThrow(
      /endTime.*runtime queued/,
    );
    expect(service.get("ambiguous-job")?.job).toMatchObject({ status: "queued", version: 1 });
    expect(existsSync(legacyPath)).toBe(true);
  });

  it("从 v4 原子迁移 provider_calls 并接受 hook purpose", () => {
    const workDir = makeTempDir(tempDirs);
    const databasePath = resolvePicoPaths(workDir).workspace.runtimeDatabase;
    const initial = new RuntimeStore({ workDir });
    initial.close();

    const legacy = new Database(databasePath);
    legacy.pragma("foreign_keys = OFF");
    legacy.exec(`
      DROP INDEX provider_calls_session_idx;
      DROP INDEX provider_calls_goal_idx;
      DROP INDEX provider_calls_job_idx;
      ALTER TABLE provider_calls RENAME TO provider_calls_v5;
      CREATE TABLE provider_calls (
        call_id TEXT PRIMARY KEY, session_id TEXT, conversation_id TEXT, goal_id TEXT,
        job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
        attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
        purpose TEXT NOT NULL CHECK (purpose IN ('main','subagent','compaction','aux','grace')),
        provider TEXT NOT NULL, model TEXT NOT NULL, route TEXT,
        status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled')),
        input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
        output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
        cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
        cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
        cost REAL NOT NULL CHECK (cost >= 0), reported_json TEXT, created_at INTEGER NOT NULL
      );
      DROP TABLE provider_calls_v5;
      CREATE INDEX provider_calls_session_idx ON provider_calls(session_id, created_at);
      CREATE INDEX provider_calls_goal_idx ON provider_calls(goal_id, created_at);
      CREATE INDEX provider_calls_job_idx ON provider_calls(job_id, created_at);
      ALTER TABLE cron_jobs DROP COLUMN name;
      DELETE FROM schema_migrations WHERE version >= 5;
    `);
    legacy.close();

    const migrated = new RuntimeStore({ workDir });
    closeables.push(migrated);
    expect(
      migrated.recordProviderCall({
        callId: "hook-after-migration",
        purpose: "hook",
        provider: "openai",
        model: "test",
        status: "succeeded",
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0,
      }).inserted,
    ).toBe(true);
  });

  it("识别并降级桌面预览版写入的 v6 name 迁移标记", () => {
    const workDir = makeTempDir(tempDirs);
    const databasePath = resolvePicoPaths(workDir).workspace.runtimeDatabase;
    const initial = new RuntimeStore({ workDir });
    initial.close();

    const previewDatabase = new Database(databasePath);
    previewDatabase
      .prepare(
        "INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (6, ?, ?)",
      )
      .run("cron_job_display_name", Date.now());
    previewDatabase.close();

    const repaired = new RuntimeStore({ workDir });
    closeables.push(repaired);
    const inspected = new Database(databasePath, { readonly: true });
    const migration = inspected
      .prepare("SELECT MAX(version) AS version FROM schema_migrations")
      .get() as { version: number };
    const hasName = (
      inspected.prepare("PRAGMA table_info(cron_jobs)").all() as Array<{ name: string }>
    ).some((column) => column.name === "name");
    inspected.close();

    expect(migration.version).toBe(5);
    expect(hasName).toBe(true);
  });

  it("不降级未知的未来 schema 标记", () => {
    const workDir = makeTempDir(tempDirs);
    const databasePath = resolvePicoPaths(workDir).workspace.runtimeDatabase;
    const initial = new RuntimeStore({ workDir });
    initial.close();

    const futureDatabase = new Database(databasePath);
    futureDatabase
      .prepare(
        "INSERT OR REPLACE INTO schema_migrations(version, name, applied_at) VALUES (6, ?, ?)",
      )
      .run("unknown_future_migration", Date.now());
    futureDatabase.close();

    expect(() => new RuntimeStore({ workDir })).toThrow(/schema 6.*新于.*5/u);
    const inspected = new Database(databasePath, { readonly: true });
    const migration = inspected
      .prepare("SELECT name FROM schema_migrations WHERE version = 6")
      .get() as { name: string };
    inspected.close();
    expect(migration.name).toBe("unknown_future_migration");
  });
});

function makeTempDir(tempDirs: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "pico-runtime-store-"));
  tempDirs.push(directory);
  return directory;
}
