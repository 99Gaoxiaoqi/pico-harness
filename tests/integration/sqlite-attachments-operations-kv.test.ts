import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DatabaseSync } from "node:sqlite";
import {
  EvidenceArchive,
  formatEvidenceUri,
  parseEvidenceUri,
} from "../../src/context/evidence-archive.js";
import { seedRuntimeToolExchange } from "./helpers/legacy-evidence-fixture.js";
import { TodoStore } from "../../src/context/todo-store.js";
import {
  createFileHistoryState,
  fileHistoryBeginRewindPoint,
  fileHistoryCloneSession,
  fileHistoryDiscardFrom,
  fileHistoryLoadState,
  fileHistoryRegisterRoot,
  fileHistoryRewind,
  fileHistoryTrackEdit,
  type FileHistoryIo,
} from "../../src/safety/file-history.js";
import { StorageOperationJournal } from "../../src/storage/operation-journal.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

/**
 * 票 08(波次 3):attachments/operations/kv 三 scope 的 SQLite 迁移验收。
 * 覆盖:journal 状态机 + 崩溃中断恢复、evidence 索引入库 + URI/分页、
 * file-history manifest 等价 + blob CAS 去重、todo 事务原子性,以及
 * "evidence 清单 JSON / storage-operations / todo.json 不再产生" 的目录断言。
 */

interface WorkspaceFixture {
  readonly root: string;
  readonly workDir: string;
  readonly picoHome: string;
  readonly storageRoot: string;
  readonly evidenceRoot: string;
  readonly fileHistory: FileHistoryIo;
}

async function workspaceFixture(context: TestContext, prefix: string): Promise<WorkspaceFixture> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  context.after(() => rm(root, { recursive: true, force: true }));
  const workDir = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workDir, { recursive: true });
  await mkdir(picoHome, { recursive: true });
  // 与生产同口径:storageRoot 由 resolvePicoPaths 派生(workspaces/<id> 哈希段)。
  const paths = resolvePicoPaths(workDir, { picoHome });
  const storageRoot = paths.workspace.root;
  const evidenceRoot = paths.workspace.evidence;
  return {
    root,
    workDir,
    picoHome,
    storageRoot,
    evidenceRoot,
    fileHistory: { baseDir: paths.home.fileHistory, storageRoot },
  };
}

// ---------------------------------------------------------------------------
// operations scope:journal 状态机 / CAS / 崩溃恢复 / fork 单查询
// ---------------------------------------------------------------------------

function forkOperationInput(overrides: Record<string, unknown> = {}) {
  return {
    kind: "fork" as const,
    sessionId: "source-session",
    sourceSessionId: "source-session",
    sourceCursor: { logId: "source-session", seq: 4, epoch: 0, eventId: "event-4" },
    targetSessionId: "target-session",
    targetMode: "default" as const,
    stagingDirectory: "unused-staging",
    ...overrides,
  };
}

test("operation journal advances the saga state machine with CAS and recovers interrupts", async (context) => {
  const fixture = await workspaceFixture(context, "pico-ops-journal-");
  const journal = new StorageOperationJournal({
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
  });

  const created = await journal.create(forkOperationInput({ operationId: "fork-op-1" }));
  assert.equal(created.state, "prepared");
  assert.equal(created.version, 1);

  // journal 落在 pico.sqlite,storage-operations/ 目录不再产生。
  assert.equal(existsSync(join(fixture.storageRoot, "storage-operations")), false);
  assert.equal(existsSync(join(fixture.storageRoot, "pico.sqlite")), true);

  // 状态机推进:prepared → workspace_applied → session_committed → sidecars_committed → completed。
  let operation = await journal.advance({
    operationId: "fork-op-1",
    expectedVersion: 1,
    nextState: "workspace_applied",
  });
  assert.equal(operation.version, 2);
  operation = await journal.advance({
    operationId: "fork-op-1",
    expectedVersion: operation.version,
    nextState: "session_committed",
  });
  operation = await journal.advance({
    operationId: "fork-op-1",
    expectedVersion: operation.version,
    nextState: "sidecars_committed",
  });

  // 崩溃中断恢复视角:非终态操作出现在 listUnfinished(一条查询)。
  const unfinished = await journal.listUnfinished();
  assert.equal(unfinished.length, 1);
  assert.equal(unfinished[0]!.operationId, "fork-op-1");

  // 旧 version 提交 → CAS 冲突。
  await assert.rejects(
    journal.advance({
      operationId: "fork-op-1",
      expectedVersion: 2,
      nextState: "completed",
    }),
    /version conflict/u,
  );
  // 非法跃迁:session_committed → workspace_applied。
  await assert.rejects(
    journal.advance({
      operationId: "fork-op-1",
      expectedVersion: operation.version,
      nextState: "workspace_applied",
    }),
    /Invalid storage operation transition/u,
  );

  operation = await journal.advance({
    operationId: "fork-op-1",
    expectedVersion: operation.version,
    nextState: "completed",
  });
  assert.equal(operation.state, "completed");
  assert.equal((await journal.listUnfinished()).length, 0);
  // completed 后不可再迁移。
  await assert.rejects(
    journal.advance({
      operationId: "fork-op-1",
      expectedVersion: operation.version,
      nextState: "aborted",
    }),
    /Invalid storage operation transition/u,
  );
});

test("operation journal dispositions recover needs_attention with recorded phase", async (context) => {
  const fixture = await workspaceFixture(context, "pico-ops-disposition-");
  const journal = new StorageOperationJournal({
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
  });
  await journal.create(forkOperationInput({ operationId: "fork-op-2" }));
  const failed = await journal.advance({
    operationId: "fork-op-2",
    expectedVersion: 1,
    nextState: "needs_attention",
    error: { phase: "workspace_applied", message: "simulated crash mid-saga" },
  });
  assert.equal(failed.state, "needs_attention");
  assert.deepEqual(await journal.listNeedsAttention(), [failed]);

  // 人工 retry 回到 journal 记录的失败 phase,不能由调用方猜测。
  const retried = await journal.retryNeedsAttention({
    operationId: "fork-op-2",
    expectedVersion: failed.version,
    reason: "operator retry",
  });
  assert.equal(retried.state, "workspace_applied");
  assert.equal(retried.dispositions?.length, 1);
  assert.equal(retried.dispositions?.[0]?.action, "retry");
  assert.equal(retried.dispositions?.[0]?.failure?.message, "simulated crash mid-saga");
  assert.equal(retried.error, undefined);

  // retry 后再次失败 → abort 不可逆终态(含 dispositions 累积)。
  const failedAgain = await journal.advance({
    operationId: "fork-op-2",
    expectedVersion: retried.version,
    nextState: "needs_attention",
    error: { phase: "workspace_applied", message: "still broken" },
  });
  const aborted = await journal.abortNeedsAttention({
    operationId: "fork-op-2",
    expectedVersion: failedAgain.version,
    reason: "operator abort",
  });
  assert.equal(aborted.state, "aborted");
  assert.equal(aborted.dispositions?.length, 2);
  // 非 needs_attention 状态不接受 disposition。
  await assert.rejects(
    journal.abortNeedsAttention({
      operationId: "fork-op-2",
      expectedVersion: aborted.version,
      reason: "double abort",
    }),
    /not needs_attention/u,
  );
});

test("operation journal serves fork publication lookup as one query", async (context) => {
  const fixture = await workspaceFixture(context, "pico-ops-fork-targets-");
  const journal = new StorageOperationJournal({
    workDir: fixture.workDir,
    picoHome: fixture.picoHome,
  });
  await journal.create(forkOperationInput({ operationId: "fork-a", targetSessionId: "target-a" }));
  await journal.create(forkOperationInput({ operationId: "fork-b", targetSessionId: "target-b" }));
  await journal.create(
    forkOperationInput({
      operationId: "rewind-1",
      kind: "rewind",
      mode: "both",
      precondition: {
        sessionLastSeq: 3,
        effectiveHistoryDigest: "d".repeat(8),
        fileHistoryRevision: 2,
      },
      target: {
        messageId: "m1",
        sourceMessageEventId: "user-message:m1",
        messageIndex: 0,
        userPrompt: "p",
      },
      files: [],
    }),
  );
  // completed 需走完整 Saga 链(prepared→…→completed),单步直达 completed 非法。
  await journal.advance({
    operationId: "fork-a",
    expectedVersion: 1,
    nextState: "workspace_applied",
  });
  await journal.advance({
    operationId: "fork-a",
    expectedVersion: 2,
    nextState: "session_committed",
  });
  await journal.advance({
    operationId: "fork-a",
    expectedVersion: 3,
    nextState: "sidecars_committed",
  });
  await journal.advance({ operationId: "fork-a", expectedVersion: 4, nextState: "completed" });
  await journal.advance({
    operationId: "fork-b",
    expectedVersion: 1,
    nextState: "aborted",
  });

  const targets = await journal.listForkTargets();
  // aborted fork 不计入;rewind 不计入;completed fork 标记 hasCompleted。
  assert.deepEqual([...targets.keys()].sort(), ["target-a"]);
  assert.deepEqual(targets.get("target-a"), { hasCompleted: true });
});

// ---------------------------------------------------------------------------
// attachments scope:evidence 清单入库 + blob 留 FS
// ---------------------------------------------------------------------------

test("evidence manifests live in sqlite; blobs keep the FS CAS layout", async (context) => {
  const fixture = await workspaceFixture(context, "pico-evidence-sqlite-");
  const archive = new EvidenceArchive({ baseDir: fixture.evidenceRoot });

  // 票 E3:生产写路径已退役,清单行由 legacy 夹具直建(存储层行为不变)。
  const output = "工具原始输出".repeat(50);
  const reference = await seedRuntimeToolExchange({
    evidenceRoot: fixture.evidenceRoot,
    storageRoot: fixture.storageRoot,
    archivedAt: "2026-08-19T00:00:00.000Z",
    sessionId: "evidence-session",
    toolCallId: "call-1",
    toolName: "bash",
    rawArguments: '{"cmd":"fixture"}',
    rawOutput: output,
    isError: false,
  });

  // 读回:manifest 行 + blob 完整性。
  const manifest = await archive.readRuntimeToolExchange(reference);
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(await archive.readRuntimeToolOutput(reference), output);

  // 幂等重档:同 content → 同引用,不新增行。
  const again = await seedRuntimeToolExchange({
    evidenceRoot: fixture.evidenceRoot,
    storageRoot: fixture.storageRoot,
    archivedAt: "2026-08-19T00:00:00.000Z",
    sessionId: "evidence-session",
    toolCallId: "call-1",
    toolName: "bash",
    rawArguments: '{"cmd":"fixture"}',
    rawOutput: output,
    isError: false,
  });
  assert.equal(again.contentHash, reference.contentHash);

  // URI 解析 + 字节分页语义保持。
  const uri = formatEvidenceUri(reference);
  const parsed = parseEvidenceUri(uri);
  assert.equal(parsed.sessionId, "evidence-session");
  const page = await archive.readEvidencePage(parsed, { limitBytes: 12 });
  assert.equal(page.totalBytes, Buffer.byteLength(output, "utf8"));
  assert.ok(page.truncated);
  assert.ok(page.content.length > 0);
  assert.equal(page.nextOffsetBytes, page.endOffsetBytes);
  const secondPage = await archive.readEvidencePage(parsed, {
    offsetBytes: page.nextOffsetBytes!,
    limitBytes: 1_024 * 64,
  });
  assert.equal(secondPage.truncated, false);
  assert.equal(page.content + secondPage.content, output);

  // 缺失引用:保持 ENOENT 形状。
  await assert.rejects(
    archive.readRuntimeToolExchange({
      ...reference,
      contentHash: "0".repeat(64),
    }),
    { code: "ENOENT" },
  );

  // 行篡改 → 内容哈希失配 fail-closed。
  const database = new DatabaseSync(join(fixture.storageRoot, "pico.sqlite"));
  try {
    database.prepare("UPDATE evidence_records SET content_json = ? WHERE content_hash = ?").run(
      JSON.stringify({
        kind: "tool-exchange",
        sessionId: "evidence-session",
        toolCallId: "call-1",
        toolName: "forged",
        arguments: '{"cmd":"fixture"}',
        rawOutput: manifest.content.rawOutput,
        isError: false,
      }),
      reference.contentHash,
    );
  } finally {
    database.close();
  }
  await assert.rejects(archive.readRuntimeToolExchange(reference), /content hash mismatch/u);

  // 目录断言:清单 JSON 与会话目录不再产生;blob CAS 目录保持。
  assert.equal(existsSync(join(fixture.evidenceRoot, "evidence-session")), false);
  assert.equal(
    existsSync(join(fixture.evidenceRoot, "evidence-session", `${reference.contentHash}.json`)),
    false,
  );
  const blobPath = join(
    fixture.evidenceRoot,
    "blobs",
    "sha256",
    manifest.content.rawOutput.digest.slice(0, 2),
    manifest.content.rawOutput.digest,
  );
  assert.equal(await readFile(blobPath, "utf8"), output);
});

// ---------------------------------------------------------------------------
// attachments scope:file-history manifest 行化 + blob CAS 去重 + rewind 回放
// ---------------------------------------------------------------------------

test("file-history snapshots persist as rows and replay rewind with CAS-deduped blobs", async (context) => {
  const fixture = await workspaceFixture(context, "pico-file-history-sqlite-");
  const io = fixture.fileHistory;
  const sessionId = "fh-session";
  const workFile = join(fixture.workDir, "src.txt");
  await writeFile(workFile, "v1 content\n", "utf8");

  const state = createFileHistoryState();
  fileHistoryRegisterRoot(state, "workspace", fixture.workDir);
  await fileHistoryBeginRewindPoint(
    state,
    {
      messageId: "message-1",
      sourceMessageEventId: "user-message:message-1",
      beforeSessionSeq: 2,
      messageIndex: 0,
      userPrompt: "修改 src.txt",
    },
    sessionId,
    io,
  );
  await fileHistoryTrackEdit(state, workFile, "message-1", sessionId, io);

  // 修改文件后建立第二个 rewind point。
  await writeFile(workFile, "v2 content\n", "utf8");
  await fileHistoryBeginRewindPoint(
    state,
    {
      messageId: "message-2",
      sourceMessageEventId: "user-message:message-2",
      beforeSessionSeq: 5,
      messageIndex: 1,
      userPrompt: "再次修改",
    },
    sessionId,
    io,
  );
  await fileHistoryTrackEdit(state, workFile, "message-2", sessionId, io);
  await writeFile(workFile, "v3 content\n", "utf8");

  // 等价回放:新实例从库行重建 state,rewind 到 message-1 恢复 v1 内容。
  const reloaded = createFileHistoryState();
  fileHistoryRegisterRoot(reloaded, "workspace", fixture.workDir);
  assert.equal(await fileHistoryLoadState(reloaded, sessionId, io), true);
  assert.equal(reloaded.snapshots.length, 2);
  assert.equal(reloaded.revision, state.revision);
  await fileHistoryRewind(reloaded, "message-1", sessionId, io.baseDir);
  assert.equal(await readFile(workFile, "utf8"), "v1 content\n");

  // blob CAS 目录保持;manifest.json 不再产生。
  const blobsDir = join(io.baseDir, "blobs", "sha256");
  assert.equal(existsSync(blobsDir), true);
  const sessionDirName = createHash("sha256").update(sessionId).digest("hex").slice(0, 32);
  assert.equal(existsSync(join(io.baseDir, sessionDirName, "manifest.json")), false);

  // fork clone:行复制 + 幂等 + 冲突检测。
  const cloned = await fileHistoryCloneSession(sessionId, "fh-fork-target", io);
  assert.equal(cloned.created, true);
  assert.ok(cloned.blobCount > 0);
  const idempotent = await fileHistoryCloneSession(sessionId, "fh-fork-target", io);
  assert.equal(idempotent.created, false);

  // 目标被第三方改写后再 clone → 冲突。
  const database = new DatabaseSync(join(fixture.storageRoot, "pico.sqlite"));
  try {
    database
      .prepare("UPDATE file_history SET revision = ? WHERE session_id = ?")
      .run(999, "fh-fork-target");
  } finally {
    database.close();
  }
  await assert.rejects(
    fileHistoryCloneSession(sessionId, "fh-fork-target", io),
    /已存在不同 manifest/u,
  );

  // DiscardFrom 截断后行数同步收缩。
  await fileHistoryDiscardFrom(reloaded, "message-2", sessionId, io);
  const after = createFileHistoryState();
  fileHistoryRegisterRoot(after, "workspace", fixture.workDir);
  await fileHistoryLoadState(after, sessionId, io);
  assert.equal(after.snapshots.length, 1);
});

// ---------------------------------------------------------------------------
// kv scope:todo 事务原子性
// ---------------------------------------------------------------------------

test("todo store persists atomically in workspace_kv without todo.json", async (context) => {
  const fixture = await workspaceFixture(context, "pico-todo-kv-");
  const store = new TodoStore(fixture.workDir, { picoHome: fixture.picoHome });
  await store.load();
  const first = await store.add("第一条", "high");
  await store.add("第二条");
  await store.update(first.id, { status: "completed" });
  assert.equal((await store.buildTodoContext()).includes("[x] #1"), true);

  // 跨实例(跨进程视角):新 store 重建后状态完整——事务原子性使中途崩溃
  // 不可能留下半截清单(单行 UPSERT)。
  const reopened = new TodoStore(fixture.workDir, { picoHome: fixture.picoHome });
  await reopened.reload();
  const items = reopened.list();
  assert.equal(items.length, 2);
  assert.equal(items.find((item) => item.id === first.id)?.status, "completed");

  // todo.json 不再产生;值在 workspace_kv 单行。
  assert.equal(existsSync(join(fixture.storageRoot, "todo.json")), false);
  const database = new DatabaseSync(join(fixture.storageRoot, "pico.sqlite"), { readOnly: true });
  try {
    const rows = database.prepare("SELECT key, value_json FROM workspace_kv").all() as Array<{
      key: string;
      value_json: string;
    }>;
    assert.deepEqual(
      rows.map((row) => row.key),
      ["todo"],
    );
    const value = JSON.parse(rows[0]!.value_json) as { items: unknown[]; nextId: number };
    assert.equal(value.items.length, 2);
    assert.equal(value.nextId, 3);
  } finally {
    database.close();
  }

  // 畸形行 → 降级空清单不抛。
  const writer = new DatabaseSync(join(fixture.storageRoot, "pico.sqlite"));
  try {
    writer.prepare("UPDATE workspace_kv SET value_json = ? WHERE key = 'todo'").run("{broken json");
  } finally {
    writer.close();
  }
  const degraded = new TodoStore(fixture.workDir, { picoHome: fixture.picoHome });
  await degraded.reload();
  assert.equal(degraded.list().length, 0);
});
