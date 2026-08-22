import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SqliteMemoryRepository } from "../../src/storage/sqlite/sqlite-memory-repository.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import {
  MemoryIdempotencyConflictError,
  MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE,
} from "../../src/memory/memory-repository.js";
import { FileStorageIntegrityError } from "../../src/storage/local-file-storage.js";
import {
  recoverMemoryReviewJobs,
  readCanonicalRecoveryRefs,
} from "../../src/runtime/memory-review-recovery.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { WorkspaceId } from "../../src/paths/pico-paths.js";
import type { TerminalMemoryEvidenceRef } from "../../src/memory/proposal-contracts.js";
import type { Message } from "../../src/schema/message.js";

interface Fixture {
  readonly root: string;
  readonly workspace: string;
  readonly storageRoot: string;
  readonly workspaceId: WorkspaceId;
}

/** Windows:WAL/SHM 句柄释放有窗口期,rm 按 EBUSY 有界重试。 */
async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      if (attempt === 0) {
        // 文件纪元的测试可以不关句柄直接 rm;SQLite 纪元先强制放掉本进程
        // 全部 pico.sqlite owner(事后各 close() 钩子对已释放 lease 静默空转)。
        closeAllOperationalDatabasesForTest();
      }
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

async function createFixture(label: string): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-sqlite-memory-${label}-`));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  const paths = resolvePicoPaths(workspace, { picoHome: join(root, "pico-home") });
  return {
    root,
    workspace,
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  };
}

test("提案→采纳→遗忘→重开:六表状态一致、mutations 连续、幂等键可重放", async (context) => {
  const fixture = await createFixture("lifecycle");
  context.after(() => rmRetry(fixture.root));

  const repository = new SqliteMemoryRepository({
    storageRoot: fixture.storageRoot,
    workspaceId: fixture.workspaceId,
  });

  const source = repository.createSource({
    sourceId: "source:lifecycle",
    sessionId: "session:lifecycle",
    digest: "sha256:lifecycle",
    eventIds: ["evt-user-1"],
    idempotencyKey: "source-create-once",
  });
  assert.equal(source.version, 1);

  const proposal = repository.createProposal({
    proposalId: "proposal:lifecycle",
    kind: "project_fact",
    title: "构建命令",
    content: "本项目固定使用 pnpm 构建。",
    reason: "用户明确陈述",
    confidence: 0.9,
    sourceId: source.sourceId,
    idempotencyKey: "proposal-create-once",
  });
  assert.equal(proposal.status, "pending");

  const resolved = repository.resolveProposal({
    proposalId: proposal.proposalId,
    expectedVersion: proposal.version,
    resolution: "accepted",
    idempotencyKey: "proposal-accept-once",
  });
  assert.equal(resolved.proposal.status, "accepted");
  assert.ok(resolved.fact);
  const fact = resolved.fact!;

  // 幂等重放:同键同请求直接返回既有结果,不追加 mutations。
  const mutationsBeforeReplay = repository.listMutations({ limit: 500 }).length;
  const replayed = repository.resolveProposal({
    proposalId: proposal.proposalId,
    expectedVersion: proposal.version,
    resolution: "accepted",
    idempotencyKey: "proposal-accept-once",
  });
  assert.equal(replayed.fact?.factId, fact.factId);
  assert.equal(repository.listMutations({ limit: 500 }).length, mutationsBeforeReplay);

  // 幂等冲突:同键不同请求拒绝。
  assert.throws(
    () =>
      repository.resolveProposal({
        proposalId: proposal.proposalId,
        expectedVersion: proposal.version,
        resolution: "rejected",
        idempotencyKey: "proposal-accept-once",
      }),
    MemoryIdempotencyConflictError,
  );

  const forgotten = repository.forgetFact({
    factId: fact.factId,
    expectedVersion: fact.version,
    idempotencyKey: "fact-forget-once",
  });
  assert.equal(forgotten.state, "forgotten");
  assert.equal(forgotten.title, null);
  assert.equal(forgotten.content, null);
  assert.ok(forgotten.forgottenAt);
  assert.equal(forgotten.pinned, false);

  // 关联提案落 deleted 墓碑;Source 落提取抑制标记。
  const tombstone = repository.getProposal(proposal.proposalId)!;
  assert.equal(tombstone.status, "deleted");
  assert.equal(tombstone.title, null);
  assert.equal(tombstone.content, null);
  assert.equal(tombstone.reason, null);
  assert.ok(tombstone.deletedAt);
  const suppressedSource = repository.getSource(source.sourceId)!;
  assert.ok(suppressedSource.extractionSuppressedAt);

  // 遗忘通知 Job 同事务入队。
  const notificationJobs = repository.listJobs({
    type: MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE,
    limit: 10,
  });
  assert.equal(notificationJobs.length, 1);
  assert.equal(notificationJobs[0]!.cursor.eventId, fact.factId);

  // forget 幂等重放:同键返回同一墓碑,不再抛 already forgotten。
  const forgottenReplay = repository.forgetFact({
    factId: fact.factId,
    expectedVersion: fact.version,
    idempotencyKey: "fact-forget-once",
  });
  assert.equal(forgottenReplay.version, forgotten.version);

  // mutations 连续性:sequence 从 1 连续;幂等键哈希为 64 位 hex。
  const mutations = repository.listMutations({ limit: 500 });
  assert.deepEqual(
    mutations.map((mutation) => mutation.sequence),
    Array.from({ length: mutations.length }, (_, index) => index + 1),
  );
  for (const mutation of mutations) {
    if (mutation.idempotencyKeyHash !== undefined) {
      assert.match(mutation.idempotencyKeyHash, /^[a-f0-9]{64}$/u);
    }
  }
  const mutationSnapshot = mutations;

  repository.close();

  // 崩溃恢复:重开 repository,全部状态与审计一致。
  const reopened = new SqliteMemoryRepository({
    storageRoot: fixture.storageRoot,
    workspaceId: fixture.workspaceId,
  });
  const reopenedFact = reopened.getFact(fact.factId)!;
  assert.equal(reopenedFact.state, "forgotten");
  assert.equal(reopenedFact.title, null);
  assert.deepEqual(reopened.getProposal(proposal.proposalId), tombstone);
  assert.deepEqual(
    reopened.listMutations({ limit: 500 }).map((mutation) => mutation.sequence),
    mutationSnapshot.map((mutation) => mutation.sequence),
  );
  assert.equal(
    reopened.listJobs({ type: MEMORY_FORGOTTEN_NOTIFICATION_JOB_TYPE, limit: 10 }).length,
    1,
  );

  // 重开后的新写入继续沿用连续 sequence。
  reopened.updateSettings({
    expectedVersion: reopened.getSettings().version,
    enabled: false,
    idempotencyKey: "settings-after-reopen",
  });
  const afterReopen = reopened.listMutations({ limit: 500 });
  assert.equal(afterReopen[afterReopen.length - 1]!.sequence, mutationSnapshot.length + 1);
  reopened.close();
});

test("memory/state.json 与 memory/lock 不再产生;workspace 绑定 fail-closed", async (context) => {
  const fixture = await createFixture("layout");
  context.after(() => rmRetry(fixture.root));

  const repository = new SqliteMemoryRepository({
    storageRoot: fixture.storageRoot,
    workspaceId: fixture.workspaceId,
  });
  repository.createFact({
    factId: "fact:layout",
    kind: "project_fact",
    title: "布局",
    content: "memory 全部住在 pico.sqlite。",
  });
  repository.close();

  assert.equal(existsSync(join(fixture.storageRoot, "memory")), false);
  assert.equal(existsSync(join(fixture.storageRoot, "memory", "state.json")), false);
  assert.equal(existsSync(join(fixture.storageRoot, "memory", "lock")), false);
  assert.equal(existsSync(join(fixture.storageRoot, "pico.sqlite")), true);

  assert.throws(
    () =>
      new SqliteMemoryRepository({
        storageRoot: fixture.storageRoot,
        workspaceId: "other-workspace" as typeof fixture.workspaceId,
      }),
    FileStorageIntegrityError,
  );
});

test("readCanonicalRecoveryRefs 查询化结果与全量重放口径一致(多会话多形态终态)", async (context) => {
  const fixture = await createFixture("recovery-equivalence");
  context.after(() => rmRetry(fixture.root));

  const store = new SqliteRuntimeEventStore({ storageRoot: fixture.storageRoot });
  try {
    await seedRecoveryLedger(store, fixture.workspace);

    for (const sessionId of ["recovery-session-a", "recovery-session-b", "recovery-session-c"]) {
      const queried = await readCanonicalRecoveryRefs(store, sessionId);
      const replayed = await referenceReplayRefs(store, sessionId);
      assert.deepEqual(queried, replayed, `session ${sessionId} 查询化口径必须与全量重放一致`);
    }

    // 会话 A:两个直述用户 run + 一个桌面证据复跑 run;失败/恢复/无 assistant 的
    // terminal 不产生 ref。
    const refsA = await readCanonicalRecoveryRefs(store, "recovery-session-a");
    assert.deepEqual(
      refsA.map((ref) => ref.terminalEventId),
      ["terminal-a-1", "terminal-a-2", "terminal-a-4"],
    );
    assert.equal(refsA[2]!.userMessageEventId, "desktop-a-4-pre");

    // 崩溃恢复扫描(enqueue 口径)与同一集合一致。
    const enqueued: string[] = [];
    const recovered = await recoverMemoryReviewJobs({
      runtimeStorageRoot: fixture.storageRoot,
      scheduler: {
        enqueue: (input) => {
          enqueued.push(input.terminalEventId);
        },
      },
    });
    assert.equal(recovered, 3);
    assert.deepEqual([...enqueued].sort(), ["terminal-a-1", "terminal-a-2", "terminal-a-4"]);
  } finally {
    store.close();
  }
});

async function seedRecoveryLedger(
  store: SqliteRuntimeEventStore,
  workspace: string,
): Promise<void> {
  await store.initializeSession({ sessionId: "recovery-session-a", workDir: workspace });
  const base = (runId: string) => ({
    schemaVersion: 2 as const,
    sessionId: "recovery-session-a",
    invocationId: `invocation-${runId}`,
    runId,
    turnId: `turn-${runId}`,
    at: "2026-08-19T00:00:00.000Z",
    partial: false,
  });

  // 会话首条:desktop 输入(run 0,未 terminal——不产生 ref,但保留桌面证据状态)。
  await store.appendBatch([
    {
      ...base("run-a-0"),
      eventId: "start-a-0",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...base("run-a-0"),
      eventId: "desktop-a-0",
      visibility: "model",
      kind: "message.committed",
      data: {
        message: {
          role: "user",
          content: "在桌面端提交的原始指令",
          providerData: { picoKind: "desktop_user_input", displayText: "在桌面端提交的原始指令" },
        },
      },
    },
  ]);

  // run 1:完整 completed run(直述用户消息)→ ref。
  await store.appendBatch([
    {
      ...base("run-a-1"),
      eventId: "start-a-1",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...base("run-a-1"),
      eventId: "user-a-1",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "请记住:服务固定用 uvicorn 启动。" } },
    },
    {
      ...base("run-a-1"),
      eventId: "assistant-a-1",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "已记录。" } },
    },
    {
      ...base("run-a-1"),
      eventId: "terminal-a-1",
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);

  // run 2:completed run(独立直述用户消息)→ ref。
  await store.appendBatch([
    {
      ...base("run-a-2"),
      eventId: "start-a-2",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...base("run-a-2"),
      eventId: "user-a-2",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "工具结果不算数,但这条是直述。" } },
    },
    {
      ...base("run-a-2"),
      eventId: "assistant-a-2",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "done" } },
    },
    {
      ...base("run-a-2"),
      eventId: "terminal-a-2",
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);

  // run 3:failed terminal → 不产生 ref。
  await store.appendBatch([
    {
      ...base("run-a-3"),
      eventId: "start-a-3",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...base("run-a-3"),
      eventId: "user-a-3",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "这条会失败。" } },
    },
    {
      ...base("run-a-3"),
      eventId: "assistant-a-3",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "boom" } },
    },
    {
      ...base("run-a-3"),
      eventId: "terminal-a-3",
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "failed" },
    },
  ]);

  // run 4:completed 且 run 内无用户消息 → 命中 run 前最近一条桌面输入
  // (run-a-3 的普通消息已清除旧桌面状态,这里在其后重新建立一条)。
  await store.appendBatch([
    {
      ...base("run-a-4"),
      eventId: "desktop-a-4-pre",
      visibility: "model",
      kind: "message.committed",
      data: {
        message: {
          role: "user",
          content: "第二次桌面指令",
          providerData: { picoKind: "desktop_user_input", displayText: "第二次桌面指令" },
        },
      },
    },
  ]);
  await store.appendBatch([
    {
      ...base("run-a-4"),
      eventId: "start-a-4",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...base("run-a-4"),
      eventId: "assistant-a-4",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "done" } },
    },
    {
      ...base("run-a-4"),
      eventId: "terminal-a-4",
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
  ]);

  // 会话 B:空会话。
  await store.initializeSession({ sessionId: "recovery-session-b", workDir: workspace });

  // 会话 C:只有隐藏合成用户消息的 completed run(非直述、无桌面证据)→ 无 ref;
  // 另一个 recovered completed → 无 ref。
  await store.initializeSession({ sessionId: "recovery-session-c", workDir: workspace });
  const baseC = (runId: string) => ({
    schemaVersion: 2 as const,
    sessionId: "recovery-session-c",
    invocationId: `invocation-${runId}`,
    runId,
    turnId: `turn-${runId}`,
    at: "2026-08-19T00:00:00.000Z",
    partial: false,
  });
  await store.appendBatch([
    {
      ...baseC("run-c-1"),
      eventId: "start-c-1",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...baseC("run-c-1"),
      eventId: "tool-user-c-1",
      visibility: "model",
      kind: "message.committed",
      data: {
        message: {
          role: "user",
          content: "被隐藏的合成用户消息",
          providerData: { picoHiddenFromTranscript: true },
        },
      },
    },
    {
      ...baseC("run-c-1"),
      eventId: "assistant-c-1",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "done" } },
    },
    {
      ...baseC("run-c-1"),
      eventId: "terminal-c-1",
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed" },
    },
    {
      ...baseC("run-c-2"),
      eventId: "start-c-2",
      visibility: "internal",
      kind: "run.started",
      data: { workDir: workspace },
    },
    {
      ...baseC("run-c-2"),
      eventId: "user-c-2",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "user", content: "恢复的运行。" } },
    },
    {
      ...baseC("run-c-2"),
      eventId: "assistant-c-2",
      visibility: "model",
      kind: "message.committed",
      data: { message: { role: "assistant", content: "done" } },
    },
    {
      ...baseC("run-c-2"),
      eventId: "terminal-c-2",
      visibility: "internal",
      kind: "run.terminal",
      data: { status: "completed", recovered: true },
    },
  ]);
}

interface ReferenceRunState {
  priorDesktopEvidence?: { readonly eventId: string; readonly content: string };
  directUser?: { readonly eventId: string; readonly content: string };
  hasAssistantResponse: boolean;
}

/**
 * 全量重放参照实现:逐事件重放整本账本,与票 07 之前的 CompactRecoveryProjection
 * 同口径。查询化实现(readCanonicalRecoveryRefs)必须与其逐字段一致。
 */
async function referenceReplayRefs(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): Promise<TerminalMemoryEvidenceRef[]> {
  let latestDesktopEvidence: { readonly eventId: string; readonly content: string } | undefined;
  const runs = new Map<string, ReferenceRunState>();
  const refs: TerminalMemoryEvidenceRef[] = [];
  let afterSequence = 0;
  for (;;) {
    const entries = await store.readSessionEntriesPage(sessionId, { afterSequence, limit: 200 });
    if (entries.length === 0) break;
    for (const entry of entries) {
      const { event } = entry;
      if (event.kind === "run.started") {
        runs.set(event.runId, {
          ...(latestDesktopEvidence ? { priorDesktopEvidence: latestDesktopEvidence } : {}),
          hasAssistantResponse: false,
        });
      } else if (
        event.kind === "message.committed" &&
        event.visibility === "model" &&
        !event.partial
      ) {
        const current = runs.get(event.runId);
        if (current) {
          const message = event.data.message;
          const directUser =
            current.directUser ??
            (message.role === "user" &&
            message.toolCallId === undefined &&
            message.providerData?.["picoKind"] === undefined &&
            message.providerData?.["picoHiddenFromTranscript"] !== true
              ? { eventId: event.eventId, content: message.content }
              : undefined);
          runs.set(event.runId, {
            ...(current.priorDesktopEvidence
              ? { priorDesktopEvidence: current.priorDesktopEvidence }
              : {}),
            ...(directUser ? { directUser } : {}),
            hasAssistantResponse: current.hasAssistantResponse || message.role === "assistant",
          });
        }
        const desktop = referenceDesktopText(event.data.message);
        latestDesktopEvidence = desktop ? { eventId: event.eventId, content: desktop } : undefined;
      } else if (event.kind === "run.terminal") {
        const run = runs.get(event.runId);
        if (
          run?.hasAssistantResponse &&
          event.data.status === "completed" &&
          event.data.recovered !== true
        ) {
          const evidence = run.directUser ?? run.priorDesktopEvidence;
          if (evidence) {
            refs.push({
              sessionId,
              runId: event.runId,
              terminalEventId: event.eventId,
              userMessageEventId: evidence.eventId,
              terminalSequence: entry.sequence,
            });
          }
        }
        runs.delete(event.runId);
      }
    }
    afterSequence = entries[entries.length - 1]!.sequence;
    if (entries.length < 200) break;
  }
  return refs;
}

function referenceDesktopText(message: Message): string | undefined {
  if (message.role !== "user" || message.toolCallId !== undefined) return undefined;
  const providerData = message.providerData;
  if (!providerData || providerData["picoKind"] !== "desktop_user_input") return undefined;
  const displayText = providerData["displayText"];
  if (typeof displayText !== "string" || !displayText.trim()) return undefined;
  if (message.content !== displayText) return undefined;
  return displayText;
}
