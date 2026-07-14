import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CronService, matchesCron } from "../../src/tasks/cron-service.js";
import type { YoloPolicySnapshot } from "../../src/tasks/runtime-types.js";

describe("CronService durable ledger integration", () => {
  const directories: string[] = [];
  const closeables: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const closeable of closeables.splice(0)) closeable.close();
    for (const directory of directories.splice(0))
      rmSync(directory, { recursive: true, force: true });
  });

  it("以五段 Cron、SQLite 租约与不可变 YOLO 快照记录运行，漏掉分钟不补跑", () => {
    const workDir = makeTempDir(directories);
    let now = Date.UTC(2026, 0, 1, 12, 0, 15);
    let id = 0;
    const service = new CronService({
      workDir,
      ownerId: "daemon-a",
      now: () => now,
      generateId: (prefix) => `${prefix}-${++id}`,
    });
    closeables.push(service);

    const first = service.create({
      workspacePath: workDir,
      schedule: "*/5 * * * *",
      timeZone: "UTC",
      prompt: "run the repository checks",
      policySnapshot: yoloPolicy(now),
    });
    const second = service.create({
      workspacePath: workDir,
      schedule: "*/5 * * * *",
      timeZone: "UTC",
      prompt: "this must not overlap the first run",
      policySnapshot: yoloPolicy(now),
    });
    expect(first.workspacePath).toBe(realpathSync(workDir));

    const tick = service.tick();
    expect(tick.runs).toEqual([
      expect.objectContaining({ cronJobId: first.cronJobId, status: "queued" }),
      expect.objectContaining({
        cronJobId: second.cronJobId,
        status: "skipped",
        reason: "workspace_busy",
      }),
    ]);
    // 同一分钟多次 tick 不会生成重复 Run。
    expect(service.tick().runs.map((run) => run.cronRunId)).toEqual(
      tick.runs.map((run) => run.cronRunId),
    );

    const claimed = service.claim(tick.runs[0]!.cronRunId, 60_000);
    expect(claimed).toMatchObject({
      run: { status: "running", ownerId: "daemon-a" },
      lease: { ownerId: "daemon-a", leaseEpoch: 1 },
    });
    const finished = service.finish({
      cronRunId: claimed.run.cronRunId,
      leaseEpoch: claimed.lease!.leaseEpoch,
      expectedVersion: claimed.run.version,
      status: "succeeded",
      result: { summary: "done" },
    });
    expect(finished).toMatchObject({ status: "succeeded", result: { summary: "done" } });

    now = Date.UTC(2026, 0, 1, 12, 6, 15);
    expect(service.tick().runs).toEqual([]); // 12:05 的遗漏 trigger 不补跑。
    expect(service.events({ workspacePath: workDir }).map((event) => event.topic)).toEqual(
      expect.arrayContaining([
        "cron.job.created",
        "cron.run.queued",
        "cron.run.skipped",
        "cron.run.running",
        "cron.run.succeeded",
      ]),
    );
  });

  it("策略撤销直接 blocked，不创建 PendingApproval，并可从 v2 数据库原子迁移", () => {
    const workDir = makeTempDir(directories);
    let allow = true;
    const service = new CronService({
      workDir,
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      policyGuard: {
        evaluate: () => (allow ? { allowed: true } : { allowed: false, reason: "hook_denied" }),
      },
    });
    closeables.push(service);
    const job = service.create({
      workspacePath: workDir,
      schedule: "0 12 * * *",
      timeZone: "UTC",
      prompt: "guarded work",
      policySnapshot: yoloPolicy(Date.UTC(2026, 0, 1, 11, 0)),
    });
    const queued = service.tick().runs[0]!;
    allow = false;
    const blocked = service.claim(queued.cronRunId);
    expect(blocked).toEqual({
      run: expect.objectContaining({ status: "blocked", reason: "hook_denied" }),
    });
    expect(service.runs({ cronJobId: job.cronJobId })).toHaveLength(1);

    service.close();
    closeables.pop();
    const databasePath = join(workDir, ".claw", "runtime.sqlite");
    const raw = new Database(databasePath);
    raw.exec(
      "DROP TABLE runtime_events; DROP TABLE cron_runs; DROP TABLE cron_jobs; DELETE FROM schema_migrations WHERE version >= 3",
    );
    raw.close();

    const migrated = new CronService({ workDir });
    closeables.push(migrated);
    expect(migrated.store.getCronJob(job.cronJobId)).toEqual(undefined);
    expect(migrated.store.listRuntimeEvents()).toEqual([]);
  });

  it("按指定时区匹配，并拒绝非五段表达式", () => {
    expect(matchesCron("0 20 * * *", Date.UTC(2026, 0, 1, 12, 0), "Asia/Shanghai")).toBe(true);
    expect(() => matchesCron("@daily", Date.now(), "UTC")).toThrow(/五段/);
  });

  it("写入时拒绝空或非法工具网络 allowlist，并规范化旧版策略字段", () => {
    const workDir = makeTempDir(directories);
    const service = new CronService({ workDir });
    closeables.push(service);
    const base = yoloPolicy(Date.now());

    for (const allowedToolNetworkHosts of [[], ["*.example.com"]]) {
      expect(() =>
        service.create({
          workspacePath: workDir,
          schedule: "0 12 * * *",
          timeZone: "UTC",
          prompt: "must not persist",
          policySnapshot: {
            ...base,
            toolNetworkPolicy: "allowlist",
            allowedToolNetworkHosts,
          },
        }),
      ).toThrow(/allowlist|hostname/);
    }
    expect(service.list()).toEqual([]);

    const { toolNetworkPolicy: _toolNetworkPolicy, ...legacyBase } = base;
    const legacyPolicy = {
      ...legacyBase,
      networkPolicy: "allowlist",
      allowedNetworkHosts: ["EXAMPLE.COM."],
    } as unknown as YoloPolicySnapshot;
    const migrated = service.create({
      workspacePath: workDir,
      schedule: "0 12 * * *",
      timeZone: "UTC",
      prompt: "legacy policy",
      policySnapshot: legacyPolicy,
    });
    expect(migrated.policySnapshot).toMatchObject({
      toolNetworkPolicy: "allowlist",
      allowedToolNetworkHosts: ["example.com"],
    });
    expect(migrated.policySnapshot).not.toHaveProperty("networkPolicy");

    const raw = new Database(service.store.databasePath);
    raw
      .prepare("UPDATE cron_jobs SET policy_snapshot_json = ? WHERE cron_job_id = ?")
      .run(JSON.stringify(legacyPolicy), migrated.cronJobId);
    raw.close();
    expect(service.store.getCronJob(migrated.cronJobId)?.policySnapshot).toMatchObject({
      toolNetworkPolicy: "allowlist",
      allowedToolNetworkHosts: ["example.com"],
    });

    const legacyMcpPolicy = {
      ...base,
      allowedTools: ["read_file", "mcp__legacy__query"],
    };
    const rawMcp = new Database(service.store.databasePath);
    rawMcp
      .prepare("UPDATE cron_jobs SET policy_snapshot_json = ? WHERE cron_job_id = ?")
      .run(JSON.stringify(legacyMcpPolicy), migrated.cronJobId);
    rawMcp.close();
    expect(service.store.getCronJob(migrated.cronJobId)?.policySnapshot.allowedTools).toEqual([
      "read_file",
    ]);
  });

  it("仅删除已禁用且没有运行中 Run 的 Cron Job", () => {
    const workDir = makeTempDir(directories);
    const now = Date.UTC(2026, 0, 1, 12, 0);
    const service = new CronService({ workDir, now: () => now });
    closeables.push(service);
    const job = service.create({
      workspacePath: workDir,
      schedule: "0 12 * * *",
      timeZone: "UTC",
      prompt: "delete safely",
      policySnapshot: yoloPolicy(now),
    });
    expect(() => service.delete(job.cronJobId, job.version)).toThrow(/先禁用/);

    const running = service.claim(service.tick().runs[0]!.cronRunId);
    const disabled = service.setEnabled(job.cronJobId, job.version, false);
    expect(() => service.delete(job.cronJobId, disabled.version)).toThrow(/运行中的 Run/);

    service.finish({
      cronRunId: running.run.cronRunId,
      leaseEpoch: running.lease!.leaseEpoch,
      expectedVersion: running.run.version,
      status: "cancelled",
    });
    expect(service.delete(job.cronJobId, disabled.version)).toMatchObject({
      cronJobId: job.cronJobId,
    });
    expect(service.list()).toEqual([]);
    expect(service.events().at(-1)).toMatchObject({
      topic: "cron.job.deleted",
      payload: { cronJobId: job.cronJobId },
    });
  });

  it("持久化桌面名称、CAS 更新并记录立即运行", () => {
    const workDir = makeTempDir(directories);
    const now = Date.UTC(2026, 0, 1, 12, 0, 15);
    const service = new CronService({ workDir, now: () => now });
    closeables.push(service);
    const created = service.create({
      workspacePath: workDir,
      name: "Daily repository health",
      schedule: "0 12 * * *",
      timeZone: "UTC",
      prompt: "check the repository",
      enabled: false,
      policySnapshot: yoloPolicy(now),
    });
    expect(created.name).toBe("Daily repository health");

    const updated = service.update(created.cronJobId, created.version, {
      name: "Morning health",
      prompt: "check and summarize the repository",
      schedule: "30 8 * * 1-5",
    });
    expect(updated).toMatchObject({
      name: "Morning health",
      prompt: "check and summarize the repository",
      schedule: "30 8 * * 1-5",
      version: created.version + 1,
    });
    expect(() =>
      service.update(created.cronJobId, created.version, { name: "stale write" }),
    ).toThrow(/版本已变化/u);

    const manual = service.runNow(created.cronJobId);
    expect(manual).toMatchObject({ cronJobId: created.cronJobId, status: "queued" });
    expect(manual.scheduledFor).toBe(now);
    const repeated = service.runNow(created.cronJobId);
    expect(repeated).toMatchObject({ cronJobId: created.cronJobId, status: "skipped" });
    expect(repeated.cronRunId).not.toBe(manual.cronRunId);
    expect(repeated.scheduledFor).toBe(now + 1);
  });

  it("daemon 重启只收口 lease 已过期的 running Run，并解除工作区阻塞", () => {
    const workDir = makeTempDir(directories);
    let now = Date.UTC(2026, 0, 1, 12, 0, 0);
    const first = new CronService({ workDir, now: () => now, ownerId: "daemon-before-crash" });
    closeables.push(first);
    const job = first.create({
      workspacePath: workDir,
      schedule: "* * * * *",
      timeZone: "UTC",
      prompt: "recover me",
      policySnapshot: yoloPolicy(now),
    });
    const queued = first.tick(now).runs[0]!;
    const claimed = first.claim(queued.cronRunId, 1_000);
    now += 500;
    first.heartbeat(queued.cronRunId, claimed.lease!.leaseEpoch, 1_000);

    const restarted = new CronService({ workDir, now: () => now, ownerId: "daemon-after-crash" });
    closeables.push(restarted);
    expect(restarted.recoverInterruptedRuns()).toEqual([]);
    now += 1_001;
    expect(restarted.recoverInterruptedRuns()).toEqual([
      expect.objectContaining({
        cronRunId: queued.cronRunId,
        status: "failed",
        reason: "daemon_interrupted_after_lease_expiry",
      }),
    ]);
    now = Date.UTC(2026, 0, 1, 12, 1, 0);
    expect(restarted.tick(now).runs).toEqual([
      expect.objectContaining({ cronJobId: job.cronJobId, status: "queued" }),
    ]);
    expect(restarted.events({ workspacePath: workDir }).at(-2)).toEqual(
      expect.objectContaining({
        topic: "cron.run.failed",
        payload: expect.objectContaining({ recovered: true }),
      }),
    );
  });
});

function makeTempDir(directories: string[]): string {
  const directory = mkdtempSync(join(tmpdir(), "pico-cron-ledger-"));
  directories.push(directory);
  return directory;
}

function yoloPolicy(createdAt: number) {
  return {
    mode: "yolo" as const,
    backgroundEnabled: true as const,
    trustedWorkspace: true as const,
    toolNetworkPolicy: "disabled" as const,
    allowedTools: ["bash", "read_file", "write_file"],
    hardlineVersion: "hardline-v1",
    hookVersion: "hook-v1",
    createdAt,
  };
}
