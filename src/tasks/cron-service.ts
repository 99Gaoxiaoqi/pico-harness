import { realpathSync } from "node:fs";
import {
  RuntimeConflictError,
  RuntimeStore,
  generateRuntimeId,
  type RuntimeStoreOptions,
} from "./runtime-store.js";
import {
  type CronJobRecord,
  type CronRunRecord,
  type RuntimeLeaseRecord,
  type RuntimeEventRecord,
  type TerminalCronRunStatus,
  type YoloPolicySnapshot,
} from "./runtime-types.js";

export interface CronPolicyDecision {
  allowed: boolean;
  reason?: string;
}

/** Runtime/daemon 注入实时工作区信任、hook 和 hardline 校验，不持久化可变决定。 */
export interface CronPolicyGuard {
  evaluate(job: CronJobRecord): CronPolicyDecision;
}

export interface CronServiceOptions extends RuntimeStoreOptions {
  ownerId?: string;
  policyGuard?: CronPolicyGuard;
  generateId?: (prefix: "cron_job" | "cron_run") => string;
}

export interface CreateCronJobInput {
  cronJobId?: string;
  workspacePath: string;
  schedule: string;
  /** IANA zone，在创建时固定，默认当前系统时区。 */
  timeZone?: string;
  prompt: string;
  policySnapshot: YoloPolicySnapshot;
  enabled?: boolean;
}

export interface CronTickResult {
  evaluatedAt: number;
  runs: CronRunRecord[];
}

export interface ClaimCronRunResult {
  run: CronRunRecord;
  /** policy 在 claim 前被撤销时 Run 直接转 blocked，不会发放 lease。 */
  lease?: RuntimeLeaseRecord;
}

/**
 * 无 UI/daemon 依赖的 Cron 领域服务。
 * tick 只考虑调用时所在分钟，因此宕机期间的 trigger 不会被补跑。
 */
export class CronService {
  readonly store: RuntimeStore;
  readonly ownerId: string;
  private readonly now: () => number;
  private readonly policyGuard?: CronPolicyGuard;
  private readonly generateId: NonNullable<CronServiceOptions["generateId"]>;

  constructor(options: CronServiceOptions) {
    this.store = new RuntimeStore(options);
    this.ownerId = options.ownerId ?? `cron:${process.pid}`;
    this.now = options.now ?? Date.now;
    this.policyGuard = options.policyGuard;
    this.generateId = options.generateId ?? generateCronId;
  }

  create(input: CreateCronJobInput): CronJobRecord {
    assertFivePartCron(input.schedule);
    const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    assertTimeZone(timeZone);
    return this.store.createCronJob({
      cronJobId: input.cronJobId ?? this.generateId("cron_job"),
      workspacePath: realpathSync(input.workspacePath),
      schedule: input.schedule,
      timeZone,
      prompt: input.prompt,
      policySnapshot: input.policySnapshot,
      enabled: input.enabled,
    });
  }

  list(workspacePath?: string): CronJobRecord[] {
    return this.store.listCronJobs(workspacePath ? { workspacePath: realpathSync(workspacePath) } : {});
  }

  setEnabled(cronJobId: string, expectedVersion: number, enabled: boolean): CronJobRecord {
    return this.store.setCronJobEnabled(cronJobId, expectedVersion, enabled);
  }

  delete(cronJobId: string, expectedVersion: number): CronJobRecord {
    return this.store.deleteCronJob(cronJobId, expectedVersion);
  }

  /** 仅扫描当前分钟；即使上次 tick 很早以前，也绝不补跑遗漏分钟。 */
  tick(at = this.now()): CronTickResult {
    const scheduledFor = floorToMinute(at);
    const runs: CronRunRecord[] = [];
    for (const job of this.store.listCronJobs({ enabled: true })) {
      if (!matchesCron(job.schedule, scheduledFor, job.timeZone)) continue;
      const decision = this.evaluate(job);
      runs.push(
        this.store.createCronRun({
          cronRunId: this.generateId("cron_run"),
          cronJobId: job.cronJobId,
          scheduledFor,
          status: decision.allowed ? "queued" : "blocked",
          reason: decision.reason,
        }),
      );
    }
    return { evaluatedAt: at, runs };
  }

  claim(cronRunId: string, leaseTtlMs?: number): ClaimCronRunResult {
    const run = this.store.getCronRun(cronRunId);
    if (!run) throw new Error(`未知 Cron Run: ${cronRunId}`);
    const job = this.store.getCronJob(run.cronJobId);
    if (!job) throw new Error(`Cron Run ${cronRunId} 缺少对应 Job`);
    const decision = this.evaluate(job);
    if (!decision.allowed) {
      return {
        run: this.store.blockQueuedCronRun(cronRunId, decision.reason ?? "policy_blocked"),
      };
    }
    const lease = this.store.acquireLease(`cron-run:${cronRunId}`, this.ownerId, leaseTtlMs);
    try {
      const claimed = this.store.claimCronRun({
        cronRunId,
        ownerId: this.ownerId,
        leaseEpoch: lease.leaseEpoch,
      });
      return { run: claimed, lease };
    } catch (error) {
      try {
        this.store.releaseLease(`cron-run:${cronRunId}`, this.ownerId, lease.leaseEpoch);
      } catch (releaseError) {
        if (!(releaseError instanceof RuntimeConflictError)) throw releaseError;
      }
      throw error;
    }
  }

  heartbeat(cronRunId: string, leaseEpoch: number, ttlMs?: number): RuntimeLeaseRecord {
    return this.store.heartbeatLease(`cron-run:${cronRunId}`, this.ownerId, leaseEpoch, ttlMs);
  }

  block(cronRunId: string, reason: string): CronRunRecord {
    return this.store.blockQueuedCronRun(cronRunId, reason);
  }

  skip(cronRunId: string, reason = "workspace_busy"): CronRunRecord {
    return this.store.skipQueuedCronRun(cronRunId, reason);
  }

  finish(input: {
    cronRunId: string;
    leaseEpoch: number;
    expectedVersion: number;
    status: Exclude<TerminalCronRunStatus, "skipped">;
    reason?: string;
    result?: Record<string, unknown>;
  }): CronRunRecord {
    const run = this.store.finishCronRun({ ...input, ownerId: this.ownerId });
    try {
      this.store.releaseLease(`cron-run:${input.cronRunId}`, this.ownerId, input.leaseEpoch);
    } catch (error) {
      if (!(error instanceof RuntimeConflictError)) throw error;
    }
    return run;
  }

  runs(input: { cronJobId?: string; workspacePath?: string; limit?: number } = {}): CronRunRecord[] {
    return this.store.listCronRuns({
      ...input,
      ...(input.workspacePath ? { workspacePath: realpathSync(input.workspacePath) } : {}),
    });
  }

  events(input: { afterEventId?: string; workspacePath?: string; limit?: number } = {}): RuntimeEventRecord[] {
    return this.store.listRuntimeEvents({
      ...input,
      ...(input.workspacePath ? { workspacePath: realpathSync(input.workspacePath) } : {}),
    });
  }

  close(): void {
    this.store.close();
  }

  private evaluate(job: CronJobRecord): CronPolicyDecision {
    const snapshot = job.policySnapshot;
    if (snapshot.mode !== "yolo" || !snapshot.backgroundEnabled || !snapshot.trustedWorkspace) {
      return { allowed: false, reason: "background_yolo_required" };
    }
    return this.policyGuard?.evaluate(job) ?? { allowed: true };
  }
}

export function floorToMinute(timestamp: number): number {
  return Math.floor(timestamp / 60_000) * 60_000;
}

/** 5-field Cron parser: *, ranges, lists and steps; day-of-month/day-of-week follow classic OR semantics. */
export function matchesCron(schedule: string, timestamp: number, timeZone: string): boolean {
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parseFivePartCron(schedule);
  const parts = zonedDateParts(timestamp, timeZone);
  if (!minute.matches(parts.minute) || !hour.matches(parts.hour) || !month.matches(parts.month)) return false;
  const domMatches = dayOfMonth.matches(parts.dayOfMonth);
  const dowMatches = dayOfWeek.matches(parts.dayOfWeek);
  return dayOfMonth.wildcard && dayOfWeek.wildcard
    ? true
    : dayOfMonth.wildcard
      ? dowMatches
      : dayOfWeek.wildcard
        ? domMatches
        : domMatches || dowMatches;
}

export function assertFivePartCron(schedule: string): void {
  parseFivePartCron(schedule);
}

interface CronField {
  wildcard: boolean;
  matches(value: number): boolean;
}

function parseFivePartCron(schedule: string): [CronField, CronField, CronField, CronField, CronField] {
  const fields = schedule.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error("Cron 表达式必须恰好有五段");
  return [
    parseField(fields[0]!, 0, 59, "minute"),
    parseField(fields[1]!, 0, 23, "hour"),
    parseField(fields[2]!, 1, 31, "day-of-month"),
    parseField(fields[3]!, 1, 12, "month"),
    parseField(fields[4]!, 0, 6, "day-of-week"),
  ];
}

function parseField(source: string, min: number, max: number, name: string): CronField {
  const values = new Set<number>();
  for (const item of source.split(",")) {
    const [rangeSource, stepSource] = item.split("/");
    if (item.split("/").length > 2 || !rangeSource) throw new Error(`Cron ${name} 字段无效: ${source}`);
    const step = stepSource === undefined ? 1 : parsePositiveInteger(stepSource, `Cron ${name} step`);
    let start: number;
    let end: number;
    if (rangeSource === "*") {
      start = min;
      end = max;
    } else if (/^\d+$/.test(rangeSource)) {
      start = parseCronNumber(rangeSource, min, max, name);
      end = stepSource === undefined ? start : max;
    } else {
      const match = /^(\d+)-(\d+)$/.exec(rangeSource);
      if (!match) throw new Error(`Cron ${name} 字段无效: ${source}`);
      start = parseCronNumber(match[1]!, min, max, name);
      end = parseCronNumber(match[2]!, min, max, name);
      if (start > end) throw new Error(`Cron ${name} 范围起点不能大于终点`);
    }
    for (let value = start; value <= end; value += step) values.add(value);
  }
  if (values.size === 0) throw new Error(`Cron ${name} 字段不能为空`);
  return { wildcard: source === "*", matches: (value) => values.has(value) };
}

function parseCronNumber(value: string, min: number, max: number, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) {
    throw new Error(`Cron ${name} 必须在 ${min}-${max} 范围内`);
  }
  return number;
}

function parsePositiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${name} 必须为正整数`);
  return number;
}

function zonedDateParts(timestamp: number, timeZone: string): {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
} {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    weekday: "short",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
  });
  const values = Object.fromEntries(
    formatter
      .formatToParts(new Date(timestamp))
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const weekday = values["weekday"];
  const dayOfWeek = weekday === "Sun" ? 0 : weekday === "Mon" ? 1 : weekday === "Tue" ? 2 : weekday === "Wed" ? 3 : weekday === "Thu" ? 4 : weekday === "Fri" ? 5 : 6;
  return {
    minute: Number(values["minute"]),
    hour: Number(values["hour"]),
    dayOfMonth: Number(values["day"]),
    month: Number(values["month"]),
    dayOfWeek,
  };
}

function assertTimeZone(timeZone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone }).format();
  } catch {
    throw new Error(`无效时区: ${timeZone}`);
  }
}

function generateCronId(prefix: "cron_job" | "cron_run"): string {
  return generateRuntimeId(prefix);
}
