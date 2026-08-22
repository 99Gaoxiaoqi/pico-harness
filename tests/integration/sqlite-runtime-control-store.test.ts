import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  operationalDatabasePath,
  openOperationalDatabaseReadOnly,
} from "../../src/storage/sqlite/sqlite-database.js";
import {
  RuntimeConflictError,
  SqliteRuntimeControlStore,
} from "../../src/storage/sqlite/sqlite-runtime-control-store.js";

/**
 * 票 06 验收:SQLite 版控制面(control scope)。
 * - job 生命周期(claim/lease/心跳/finish/outbox/投递)与 daemon 重启恢复
 * - cron 调度恢复(recoverInterruptedCronRuns 语义对齐旧 RuntimeStore)
 * - 单 BEGIN IMMEDIATE 事务原子性 + revision CAS
 * - usage 双账本记账与按会话统计
 * - control/ 三文件不再产生
 */

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "pico-sqlite-control-store-"));
}

function testPolicySnapshot() {
  return {
    mode: "yolo" as const,
    backgroundEnabled: true as const,
    trustedWorkspace: true as const,
    toolNetworkPolicy: "disabled" as const,
    allowedTools: [],
    hardlineVersion: "test-hardline",
    hookVersion: "test-hooks",
    createdAt: 1_000,
  };
}

/** 只读连接直接读 control_metadata,黑盒校验 revision 只随提交推进。 */
function readRevision(root: string): number {
  const database = openOperationalDatabaseReadOnly(root);
  try {
    const row = database
      .prepare("SELECT value_json FROM control_metadata WHERE key = 'revision'")
      .get() as { value_json: string };
    return JSON.parse(row.value_json) as number;
  } finally {
    database.close();
  }
}

test("sqlite control store: job 建→claim(lease)→心跳→finish→completion outbox→投递标记,重开持久", () => {
  const root = freshRoot();
  let now = 1_000;
  const store = new SqliteRuntimeControlStore({ storageRoot: root, now: () => now });
  try {
    const queued = store.createJob({
      jobId: "job-1",
      type: "local_agent",
      executionClass: "host_bound",
      completionPolicy: "required",
      description: "test",
      ownerSessionId: "owner-session",
      data: { activityIds: ["a-1"] },
    });
    assert.equal(queued.version, 1);
    assert.equal(queued.status, "queued");

    const lease = store.acquireLease("job:job-1", "worker-1", 60_000);
    assert.equal(lease.leaseEpoch, 1);
    now += 10;
    const heartbeat = store.heartbeatLease("job:job-1", "worker-1", lease.leaseEpoch, 60_000);
    assert.equal(heartbeat.expiresAt, now + 60_000);
    assert.equal(heartbeat.version, lease.version + 1);

    now += 10;
    const started = store.startJob({
      jobId: "job-1",
      attemptId: "attempt-1",
      ownerId: "worker-1",
      leaseEpoch: lease.leaseEpoch,
      expectedVersion: queued.version,
    });
    assert.equal(started.job.status, "running");
    assert.equal(started.job.leaseEpoch, lease.leaseEpoch);
    assert.equal(started.attempt.attemptNumber, 1);
    assert.equal(store.getAttempt("attempt-1")?.status, "running");

    now += 10;
    const finished = store.finishJob({
      jobId: "job-1",
      attemptId: "attempt-1",
      ownerId: "worker-1",
      status: "succeeded",
      expectedJobVersion: started.job.version,
      expectedAttemptVersion: started.attempt.version,
      leaseEpoch: lease.leaseEpoch,
      completionId: "completion-1",
      result: { ok: true },
    });
    assert.equal(finished.job.status, "succeeded");
    assert.equal(finished.attempt.status, "succeeded");
    assert.deepEqual(finished.attempt.result, { ok: true });
    assert.equal(finished.completion.completionId, "completion-1");
    assert.equal(finished.completion.policy, "required");
    assert.equal(finished.completion.deliveredAt, undefined);

    const pending = store.listPendingCompletions();
    assert.deepEqual(
      pending.map((completion) => completion.completionId),
      ["completion-1"],
    );

    now += 10;
    const delivered = store.markCompletionDelivered("completion-1");
    assert.equal(typeof delivered.deliveredAt, "number");
    assert.deepEqual(store.listPendingCompletions(), []);
    store.markCompletionDelivered("completion-1");
    assert.equal(store.getCompletion("completion-1")?.deliveredAt, delivered.deliveredAt);

    // 中断恢复:host_bound + lease 过期 → job/attempt interrupted + completion outbox。
    store.createJob({
      jobId: "job-2",
      type: "local_agent",
      executionClass: "host_bound",
      completionPolicy: "optional",
      description: "expiring",
      ownerSessionId: "owner-2",
      data: { activityIds: ["act-1"] },
    });
    const lease2 = store.acquireLease("job:job-2", "worker-2", 100);
    store.startJob({
      jobId: "job-2",
      attemptId: "attempt-2",
      ownerId: "worker-2",
      leaseEpoch: lease2.leaseEpoch,
      expectedVersion: 1,
    });
    now += 1_000;
    const interrupted = store.interruptExpiredJobs();
    assert.equal(interrupted.length, 1);
    assert.equal(interrupted[0]?.jobId, "job-2");
    assert.equal(interrupted[0]?.status, "interrupted");
    assert.equal(store.getAttempt("attempt-2")?.status, "interrupted");
    const job2Completion = store.getCompletion("completion:attempt-2");
    assert.ok(job2Completion);
    assert.equal(job2Completion.status, "interrupted");
    assert.ok(job2Completion.payload?.["delegationCompletion"]);

    store.close();
    const reopened = new SqliteRuntimeControlStore({ storageRoot: root, now: () => now });
    try {
      assert.equal(reopened.getJob("job-1")?.status, "succeeded");
      assert.deepEqual(
        reopened.listAttempts("job-1").map((a) => a.attemptId),
        ["attempt-1"],
      );
      assert.deepEqual(
        reopened.listAttempts("job-1").map((a) => a.result),
        [{ ok: true }],
      );
      assert.equal(reopened.getCompletion("completion-1")?.deliveredAt, delivered.deliveredAt);
      assert.equal(reopened.getJob("job-2")?.status, "interrupted");
      assert.ok(
        reopened.listPendingCompletions().some((c) => c.jobId === "job-2"),
        "中断 completion 重开后仍在待投递队列",
      );
      assert.deepEqual(
        reopened.listJobs({ statuses: ["succeeded"] }).map((job) => job.jobId),
        ["job-1"],
      );
      assert.deepEqual(
        reopened.listJobs({ ownerSessionId: "owner-2" }).map((job) => job.jobId),
        ["job-2"],
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite control store: 单 BEGIN IMMEDIATE 事务原子性 + revision CAS + 幂等命令", () => {
  const root = freshRoot();
  const now = 5_000;
  const store = new SqliteRuntimeControlStore({ storageRoot: root, now: () => now });
  try {
    // 原子性:事件追加与 daemon run 投影同事务;重复 eventId 让整个事务回滚。
    store.appendRuntimeEvent({ eventId: "event-1", topic: "run.started", workspacePath: root });
    const revisionSeeded = readRevision(root);
    assert.ok(revisionSeeded >= 1, "首个写事务必须落 revision");
    assert.throws(
      () =>
        store.appendRuntimeEvent(
          { eventId: "event-1", topic: "run.failed", workspacePath: root },
          {
            daemonRun: {
              runId: "rolled-back-run",
              workspacePath: root,
              description: "must roll back",
              status: "failed",
              startedAt: 1,
              updatedAt: 2,
              finishedAt: 2,
              version: 1,
            },
          },
        ),
      RuntimeConflictError,
    );
    assert.equal(store.getDaemonRun(root, "rolled-back-run"), undefined, "回滚不得留下投影");
    assert.equal(store.listRuntimeEvents().length, 1, "回滚不得重复入账事件");
    assert.equal(readRevision(root), revisionSeeded, "失败写事务不推进 revision");

    // 记录级 CAS:expectedVersion 过期 → 冲突,且无任何部分提交。
    const queued = store.createJob({
      jobId: "job-cas",
      type: "test",
      executionClass: "host_bound",
      completionPolicy: "required",
      description: "cas",
    });
    const lease = store.acquireLease("job:job-cas", "worker-1", 60_000);
    const started = store.startJob({
      jobId: "job-cas",
      attemptId: "attempt-cas",
      ownerId: "worker-1",
      leaseEpoch: lease.leaseEpoch,
      expectedVersion: queued.version,
    });
    const revisionBeforeStale = readRevision(root);
    assert.throws(
      () =>
        store.finishJob({
          jobId: "job-cas",
          attemptId: "attempt-cas",
          ownerId: "worker-1",
          status: "failed",
          expectedJobVersion: started.job.version - 1,
          expectedAttemptVersion: started.attempt.version,
          leaseEpoch: lease.leaseEpoch,
          completionId: "completion-cas",
        }),
      /CAS 失败/u,
    );
    assert.equal(store.getJob("job-cas")?.status, "running");
    assert.equal(store.getAttempt("attempt-cas")?.status, "running");
    assert.equal(store.getCompletion("completion-cas"), undefined);
    assert.equal(readRevision(root), revisionBeforeStale, "CAS 失败的事务整体不提交");

    const revisionBeforeFinish = readRevision(root);
    store.finishJob({
      jobId: "job-cas",
      attemptId: "attempt-cas",
      ownerId: "worker-1",
      status: "succeeded",
      expectedJobVersion: started.job.version,
      expectedAttemptVersion: started.attempt.version,
      leaseEpoch: lease.leaseEpoch,
      completionId: "completion-cas",
    });
    assert.ok(readRevision(root) > revisionBeforeFinish, "成功提交推进 revision");

    // 无操作写不推进 revision(等价旧实现的 no-change 跳过提交)。
    store.markCompletionDelivered("completion-cas");
    const revisionAfterDeliver = readRevision(root);
    store.markCompletionDelivered("completion-cas");
    assert.equal(readRevision(root), revisionAfterDeliver);

    // 幂等命令:重放、参数冲突、嵌套 store 加入同一事务。
    const first = store.executeIdempotentDaemonCommand(
      { commandType: "job.create", idempotencyKey: "request-1", request: { description: "one" } },
      () => {
        const nested = new SqliteRuntimeControlStore({ storageRoot: root });
        try {
          nested.createJob({
            jobId: "nested-job",
            type: "test",
            executionClass: "recoverable",
            completionPolicy: "detached",
            description: "nested",
          });
        } finally {
          nested.close();
        }
        return { result: { jobId: "nested-job" }, resourceId: "nested-job" };
      },
    );
    assert.equal(first.replayed, false);
    assert.equal(first.resourceId, "nested-job");
    assert.equal(store.getJob("nested-job")?.status, "queued");

    const replay = store.executeIdempotentDaemonCommand(
      { commandType: "job.create", idempotencyKey: "request-1", request: { description: "one" } },
      () => {
        throw new Error("must not replay callback");
      },
    );
    assert.equal(replay.replayed, true);
    assert.deepEqual(replay.result, { jobId: "nested-job" });

    assert.throws(
      () =>
        store.executeIdempotentDaemonCommand(
          {
            commandType: "job.create",
            idempotencyKey: "request-1",
            request: { description: "two" },
          },
          () => ({ result: {} as Record<string, unknown> }),
        ),
      /已用于其他参数/u,
    );

    // daemon_events sequence = nextRuntimeEventSequence 同事务分配,单调无空洞。
    const second = store.appendRuntimeEvent({
      eventId: "event-2",
      topic: "run.finished",
      workspacePath: root,
    });
    assert.equal(second.eventId, "event-2");
    assert.deepEqual(
      store.listRuntimeEvents().map((event) => event.eventId),
      ["event-1", "event-2"],
    );
    assert.deepEqual(
      store.listRuntimeEvents({ afterEventId: "event-1" }).map((event) => event.eventId),
      ["event-2"],
    );
    assert.deepEqual(
      store.listRuntimeEvents({ throughEventId: "event-1" }).map((e) => e.eventId),
      ["event-1"],
    );
    assert.equal(store.hasRuntimeEvent("event-2", root), true);
    assert.equal(store.hasRuntimeEvent("missing", root), false);
    assert.equal(store.getRuntimeEventHighWatermark(root)?.eventId, "event-2");
    assert.equal(store.getRuntimeEventHighWatermark("other-workspace"), undefined);
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite control store: cron job/run 生命周期与中断恢复(recoverInterruptedCronRuns)", () => {
  const root = freshRoot();
  let now = 10_000;
  const store = new SqliteRuntimeControlStore({ storageRoot: root, now: () => now });
  try {
    const job = store.createCronJob({
      cronJobId: "cron-1",
      workspacePath: root,
      name: "tick",
      schedule: "* * * * *",
      timeZone: "UTC",
      prompt: "do the thing",
      policySnapshot: testPolicySnapshot(),
    });
    assert.equal(job.version, 1);
    assert.equal(job.name, "tick");
    assert.deepEqual(
      store.listCronJobs({ enabled: true }).map((entry) => entry.cronJobId),
      ["cron-1"],
    );

    const scheduledFor = now + 60_000;
    const run = store.createCronRun({
      cronRunId: "cron-run-1",
      cronJobId: "cron-1",
      scheduledFor,
      status: "queued",
    });
    assert.equal(run.status, "queued");
    assert.equal(run.finishedAt, undefined);
    // 同一 scheduledFor 幂等:返回既有 Run。
    const deduped = store.createCronRun({
      cronRunId: "cron-run-other",
      cronJobId: "cron-1",
      scheduledFor,
      status: "queued",
    });
    assert.equal(deduped.cronRunId, "cron-run-1");
    // workspace 忙(queued/running 占用)→ 新排程 skipped。
    const busy = store.createCronRun({
      cronRunId: "cron-run-2",
      cronJobId: "cron-1",
      scheduledFor: now + 120_000,
      status: "queued",
    });
    assert.equal(busy.status, "skipped");
    assert.equal(busy.reason, "workspace_busy");

    const lease = store.acquireLease("cron-run:cron-run-1", "daemon-1", 5_000);
    now += 10;
    const claimed = store.claimCronRun({
      cronRunId: "cron-run-1",
      ownerId: "daemon-1",
      leaseEpoch: lease.leaseEpoch,
    });
    assert.equal(claimed.status, "running");
    assert.equal(claimed.ownerId, "daemon-1");
    assert.equal(claimed.version, run.version + 1);
    assert.ok(
      store
        .listRuntimeEvents({ workspacePath: root })
        .some((event) => event.topic === "cron.run.running" && event.cronRunId === "cron-run-1"),
    );

    // 删除护栏:运行中不允许删除。
    const disabled = store.setCronJobEnabled("cron-1", job.version, false);
    assert.equal(disabled.enabled, false);
    assert.throws(() => store.deleteCronJob("cron-1", disabled.version), /仍有运行中的 Run/u);

    // daemon 掉线:lease 过期后以新进程视角重开并恢复。
    now += 10_000;
    store.close();
    const daemon = new SqliteRuntimeControlStore({ storageRoot: root, now: () => now });
    try {
      const expiredLease = daemon.getLease("cron-run:cron-run-1");
      assert.ok(expiredLease, "过期 lease 残影仍可查询");
      assert.ok(expiredLease.expiresAt <= now);

      const recovered = daemon.recoverInterruptedCronRuns();
      assert.equal(recovered.length, 1);
      assert.equal(recovered[0]?.cronRunId, "cron-run-1");
      assert.equal(recovered[0]?.status, "failed");
      assert.equal(recovered[0]?.reason, "daemon_interrupted_after_lease_expiry");

      const after = daemon.getCronRun("cron-run-1");
      assert.equal(after?.status, "failed");
      assert.equal(after?.finishedAt, now);
      const settledLease = daemon.getLease("cron-run:cron-run-1");
      assert.ok(settledLease);
      assert.ok(settledLease.expiresAt <= now, "恢复时把过期 lease 就地失效");

      const recoveryEvent = daemon
        .listRuntimeEvents({ workspacePath: root })
        .find((event) => event.topic === "cron.run.failed");
      assert.ok(recoveryEvent);
      assert.deepEqual(recoveryEvent.payload, {
        reason: "daemon_interrupted_after_lease_expiry",
        recovered: true,
      });

      // 恢复后再 finish → 冲突;重复恢复 → 无操作。
      assert.throws(
        () =>
          daemon.finishCronRun({
            cronRunId: "cron-run-1",
            ownerId: "daemon-1",
            leaseEpoch: lease.leaseEpoch,
            expectedVersion: claimed.version,
            status: "succeeded",
          }),
        /owner\/version\/lease 已变化/u,
      );
      assert.deepEqual(daemon.recoverInterruptedCronRuns(), []);

      // 终态后删除 Cron Job:run 级联清理,事件保留。
      const deleted = daemon.deleteCronJob("cron-1", disabled.version);
      assert.equal(deleted.cronJobId, "cron-1");
      assert.deepEqual(daemon.listCronRuns({ cronJobId: "cron-1" }), []);
      assert.deepEqual(daemon.listCronJobs(), []);
    } finally {
      daemon.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite control store: usage 双账本记账与按会话统计", () => {
  const root = freshRoot();
  const store = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    const inserted1 = store.recordProviderCall({
      callId: "call-1",
      sessionId: "session-1",
      purpose: "main",
      provider: "test",
      model: "test",
      status: "succeeded",
      inputTokens: 100,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      cost: 0.5,
    });
    assert.equal(inserted1.inserted, true);
    assert.equal(inserted1.record.createdAt > 0, true);
    store.recordProviderCall({
      callId: "call-2",
      sessionId: "session-2",
      purpose: "subagent",
      provider: "test",
      model: "test",
      status: "succeeded",
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.25,
    });
    assert.equal(
      store.recordProviderCall({
        callId: "call-1",
        sessionId: "session-1",
        purpose: "main",
        provider: "test",
        model: "test",
        status: "succeeded",
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 5,
        cacheWriteTokens: 3,
        cost: 0.5,
      }).inserted,
      false,
      "同 callId 同内容 → 幂等不重记",
    );
    assert.throws(
      () =>
        store.recordProviderCall({
          callId: "call-1",
          sessionId: "session-1",
          purpose: "main",
          provider: "test",
          model: "test",
          status: "failed",
          inputTokens: 100,
          outputTokens: 20,
          cacheReadTokens: 5,
          cacheWriteTokens: 3,
          cost: 0.5,
        }),
      /已被其他调用使用/u,
    );
    assert.throws(
      () =>
        store.recordProviderCall({
          callId: "orphan-call",
          jobId: "missing-job",
          purpose: "main",
          provider: "test",
          model: "test",
          status: "succeeded",
          inputTokens: 1,
          outputTokens: 1,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          cost: 0,
        }),
      /未知任务/u,
    );

    const baseline = store.putUsageBaseline({
      baselineId: "baseline-1",
      sessionId: "session-1",
      inputTokens: 40,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0.125,
      importedAt: 123,
    });
    assert.equal(baseline.inserted, true);
    assert.equal(
      store.putUsageBaseline({
        baselineId: "baseline-1",
        sessionId: "session-1",
        inputTokens: 40,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cost: 0.125,
        importedAt: 123,
      }).inserted,
      false,
    );

    const total = store.getUsageSummary();
    assert.equal(total.providerCallCount, 2);
    assert.equal(total.baselineCount, 1);
    assert.deepEqual(total.providerCalls, {
      inputTokens: 110,
      outputTokens: 25,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      cost: 0.75,
    });
    assert.deepEqual(total.total, {
      inputTokens: 150,
      outputTokens: 25,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      cost: 0.875,
    });

    const bySession = store.getUsageSummary({ sessionId: "session-1" });
    assert.equal(bySession.providerCallCount, 1);
    assert.equal(bySession.baselineCount, 1);
    assert.deepEqual(bySession.total, {
      inputTokens: 140,
      outputTokens: 20,
      cacheReadTokens: 5,
      cacheWriteTokens: 3,
      cost: 0.625,
    });
    assert.deepEqual(
      store.listProviderCalls({ sessionId: "session-2" }).map((call) => call.callId),
      ["call-2"],
    );
    assert.deepEqual(
      store.listUsageBaselines({ sessionId: "session-1" }).map((entry) => entry.baselineId),
      ["baseline-1"],
    );

    store.close();
    const reopened = new SqliteRuntimeControlStore({ storageRoot: root });
    try {
      assert.deepEqual(reopened.getUsageSummary().total, total.total);
      assert.deepEqual(
        reopened.listProviderCalls().map((call) => call.callId),
        ["call-1", "call-2"],
      );
    } finally {
      reopened.close();
    }
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sqlite control store: control/ 三文件不再产生", () => {
  const root = freshRoot();
  const store = new SqliteRuntimeControlStore({ storageRoot: root });
  try {
    store.createJob({
      jobId: "job-1",
      type: "test",
      executionClass: "host_bound",
      completionPolicy: "detached",
      description: "no jsonl",
    });
    store.appendRuntimeEvent({ eventId: "event-1", topic: "run.started", workspacePath: root });
    store.recordProviderCall({
      callId: "call-1",
      purpose: "main",
      provider: "test",
      model: "test",
      status: "succeeded",
      inputTokens: 1,
      outputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
    });

    assert.ok(existsSync(operationalDatabasePath(root)), "pico.sqlite 必须存在");
    assert.equal(existsSync(join(root, "control")), false, "control/ 目录不得产生");
    const entries = readdirSync(root);
    assert.equal(
      entries.some((name) => name.endsWith(".json") || name.endsWith(".jsonl")),
      false,
      "不得产生任何 JSON/JSONL 控制文件",
    );
  } finally {
    store.close();
    rmSync(root, { recursive: true, force: true });
  }
});
