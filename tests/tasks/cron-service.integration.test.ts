import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { CronService, matchesCron } from "../../src/tasks/cron-service.js";

describe("CronService durable ledger integration", () => {
  const directories: string[] = [];
  const closeables: Array<{ close(): void }> = [];

  afterEach(() => {
    for (const closeable of closeables.splice(0)) closeable.close();
    for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
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
      expect.objectContaining({ cronJobId: second.cronJobId, status: "skipped", reason: "workspace_busy" }),
    ]);
    // 同一分钟多次 tick 不会生成重复 Run。
    expect(service.tick().runs.map((run) => run.cronRunId)).toEqual(tick.runs.map((run) => run.cronRunId));

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
      expect.arrayContaining(["cron.job.created", "cron.run.queued", "cron.run.skipped", "cron.run.running", "cron.run.succeeded"]),
    );
  });

  it("策略撤销直接 blocked，不创建 PendingApproval，并可从 v2 数据库原子迁移", () => {
    const workDir = makeTempDir(directories);
    let allow = true;
    const service = new CronService({
      workDir,
      now: () => Date.UTC(2026, 0, 1, 12, 0),
      policyGuard: { evaluate: () => (allow ? { allowed: true } : { allowed: false, reason: "hook_denied" }) },
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
    expect(blocked).toEqual({ run: expect.objectContaining({ status: "blocked", reason: "hook_denied" }) });
    expect(service.runs({ cronJobId: job.cronJobId })).toHaveLength(1);

    service.close();
    closeables.pop();
    const databasePath = join(workDir, ".claw", "runtime.sqlite");
    const raw = new Database(databasePath);
    raw.exec("DROP TABLE runtime_events; DROP TABLE cron_runs; DROP TABLE cron_jobs; DELETE FROM schema_migrations WHERE version = 3");
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
    expect(service.delete(job.cronJobId, disabled.version)).toMatchObject({ cronJobId: job.cronJobId });
    expect(service.list()).toEqual([]);
    expect(service.events().at(-1)).toMatchObject({
      topic: "cron.job.deleted",
      payload: { cronJobId: job.cronJobId },
    });
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
    networkPolicy: "disabled" as const,
    allowedTools: ["bash", "read_file", "write_file"],
    hardlineVersion: "hardline-v1",
    hookVersion: "hook-v1",
    createdAt,
  };
}
