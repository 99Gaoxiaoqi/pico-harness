import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { JsonObject } from "../../src/daemon/protocol.js";
import {
  FIRST_SEND_CLAIM_RETENTION_MS,
  normalizeWorkspacePath,
} from "../../src/daemon/desktop-conversation-state.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import { SqliteDesktopConversationStateStore } from "../../src/storage/sqlite/sqlite-desktop-conversation-state-store.js";
import {
  resolveWorkspaceSqliteStorageRoot,
  withWorkspaceSqliteLease,
} from "../../src/storage/sqlite/workspace-scopes.js";

/**
 * ADR 28 验收:desktop conversation-state 收编 SQLite control scope。
 * - B1 写入经单条 BEGIN IMMEDIATE 事务:事务中途失败不落半状态(写路径 + 迁移路径)。
 * - B2 迁移恰好一次:legacy JSON 按 workspace 分片导入、原文件改名 .migrated、
 *   库内标记防双导入(改名前崩溃重跑不复活已出队条目)。
 * - B3 幂等 send / 队列 / claim 行为与 JSON 版等价。
 */

interface Fixture {
  readonly root: string;
  readonly picoHome: string;
  readonly workspaceA: string;
  readonly workspaceB: string;
  readonly legacyJsonPath: string;
}

function createFixture(prefix: string): Fixture {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const picoHome = join(root, "pico-home");
  mkdirSync(join(picoHome, "desktop"), { recursive: true });
  const workspaceA = join(root, "ws-a");
  const workspaceB = join(root, "ws-b");
  mkdirSync(workspaceA);
  mkdirSync(workspaceB);
  return {
    root,
    picoHome,
    workspaceA,
    workspaceB,
    legacyJsonPath: join(picoHome, "desktop", "conversation-state.json"),
  };
}

function cleanupFixture(root: string): void {
  closeAllOperationalDatabasesForTest();
  rmSync(root, { recursive: true, force: true });
}

interface WorkspaceRowCounts {
  readonly queue: number;
  readonly idempotency: number;
  readonly claims: number;
  readonly legacyImportMarker: unknown;
}

function readWorkspaceRowCounts(fixture: Fixture, workspacePath: string): WorkspaceRowCounts {
  const storageRoot = resolveWorkspaceSqliteStorageRoot({
    workDir: workspacePath,
    picoHome: fixture.picoHome,
  });
  return withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("read", () => {
      const countOf = (sql: string): number =>
        (lease.database.prepare(sql).get() as { n: number }).n;
      return {
        queue: countOf("SELECT COUNT(*) AS n FROM desktop_input_queue"),
        idempotency: countOf("SELECT COUNT(*) AS n FROM desktop_idempotency"),
        claims: countOf("SELECT COUNT(*) AS n FROM desktop_first_send_claims"),
        legacyImportMarker: lease.database
          .prepare(
            "SELECT value_json FROM control_metadata WHERE key = 'desktopConversationStateLegacyImport'",
          )
          .get(),
      };
    }),
  );
}

function writeLegacyJson(fixture: Fixture, state: unknown): void {
  writeFileSync(fixture.legacyJsonPath, JSON.stringify(state));
}

test("sqlite conversation state: idempotency write hits cached result and misses absent keys (B3)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-idem-");
  try {
    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    await store.rememberIdempotent(fixture.workspaceA, "request-1", "fingerprint-1", {
      sessionId: "session-1",
    });
    assert.deepEqual(await store.getIdempotent(fixture.workspaceA, "request-1"), {
      requestFingerprint: "fingerprint-1",
      result: { sessionId: "session-1" },
    });
    assert.equal(await store.getIdempotent(fixture.workspaceA, "request-2"), undefined);
    assert.equal(await store.getIdempotent(fixture.workspaceB, "request-1"), undefined);

    await store.rememberIdempotent(fixture.workspaceA, "request-1", "fingerprint-2", {
      sessionId: "session-2",
    });
    assert.deepEqual(await store.getIdempotent(fixture.workspaceA, "request-1"), {
      requestFingerprint: "fingerprint-2",
      result: { sessionId: "session-2" },
    });
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: queue enqueue/list/remove/clear and first-send claim semantics (B3)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-queue-");
  try {
    let sequence = 0;
    let clock = 2_000;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => (clock += 10),
      generateId: () => `queue-${++sequence}`,
    });
    const canonical = normalizeWorkspacePath(fixture.workspaceA);

    await store.enqueue(fixture.workspaceA, "session-1", { kind: "text", text: "hello" });
    await store.enqueue(fixture.workspaceA, "session-1", {
      kind: "skill",
      name: "review",
      args: "focus",
    });
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), [
      {
        queueId: "queue-1",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "text", text: "hello" },
        createdAt: 2_010,
      },
      {
        queueId: "queue-2",
        workspacePath: canonical,
        sessionId: "session-1",
        input: { kind: "skill", name: "review", args: "focus" },
        createdAt: 2_020,
      },
    ]);
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-2"), []);
    assert.deepEqual(await store.listQueued(fixture.workspaceB, "session-1"), []);

    await store.removeQueued(fixture.workspaceA, "queue-1");
    assert.deepEqual(
      (await store.listQueued(fixture.workspaceA, "session-1")).map((item) => item.queueId),
      ["queue-2"],
    );
    await store.clearQueued(fixture.workspaceA, "session-1");
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), []);

    const claim = await store.claimFirstSend(fixture.workspaceA, "claim-key", "session-1", "fp-1");
    assert.equal(claim.workspacePath, canonical);
    assert.equal(claim.key, "claim-key");
    assert.equal(claim.sessionId, "session-1");
    assert.equal(claim.requestFingerprint, "fp-1");
    assert.equal(typeof claim.createdAt, "number");
    const reclaimed = await store.claimFirstSend(
      fixture.workspaceA,
      "claim-key",
      "session-9",
      "fp-9",
    );
    assert.deepEqual(reclaimed, claim);

    await store.rememberIdempotent(fixture.workspaceA, "claim-key", "fp-1", { ok: true });
    assert.equal(await store.getFirstSendClaim(fixture.workspaceA, "claim-key"), undefined);
    assert.deepEqual(await store.getIdempotent(fixture.workspaceA, "claim-key"), {
      requestFingerprint: "fp-1",
      result: { ok: true },
    });
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: legacy json migrates once per workspace shard and renames to .migrated (B2)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-migrate-");
  try {
    const canonicalA = normalizeWorkspacePath(fixture.workspaceA);
    const canonicalB = normalizeWorkspacePath(fixture.workspaceB);
    const legacyState = {
      version: 2,
      queuedInputs: [
        {
          queueId: "legacy-a",
          workspacePath: canonicalA,
          sessionId: "session-a",
          input: { kind: "text", text: "for-a" },
          createdAt: 100,
        },
        {
          queueId: "legacy-b",
          workspacePath: canonicalB,
          sessionId: "session-b",
          input: { kind: "text", text: "for-b" },
          createdAt: 101,
        },
      ],
      idempotency: [
        {
          workspacePath: canonicalA,
          key: "legacy-key-a",
          requestFingerprint: "fp-a",
          result: { ok: true },
          createdAt: 102,
        },
      ],
      firstSendClaims: [
        {
          workspacePath: canonicalB,
          key: "legacy-claim-b",
          sessionId: "session-b",
          requestFingerprint: "fp-b",
          createdAt: Date.now(),
        },
      ],
    };
    writeLegacyJson(fixture, legacyState);

    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-a"), [
      {
        queueId: "legacy-a",
        workspacePath: canonicalA,
        sessionId: "session-a",
        input: { kind: "text", text: "for-a" },
        createdAt: 100,
      },
    ]);
    assert.deepEqual(await store.listQueued(fixture.workspaceB, "session-b"), [
      {
        queueId: "legacy-b",
        workspacePath: canonicalB,
        sessionId: "session-b",
        input: { kind: "text", text: "for-b" },
        createdAt: 101,
      },
    ]);
    assert.deepEqual(await store.getIdempotent(fixture.workspaceA, "legacy-key-a"), {
      requestFingerprint: "fp-a",
      result: { ok: true },
    });
    const migratedClaim = await store.getFirstSendClaim(fixture.workspaceB, "legacy-claim-b");
    assert.equal(migratedClaim?.sessionId, "session-b");
    assert.equal(migratedClaim?.requestFingerprint, "fp-b");
    assert.equal(existsSync(fixture.legacyJsonPath), false);
    assert.equal(existsSync(`${fixture.legacyJsonPath}.migrated`), true);

    // 防双导入:模拟"导入已提交、改名前崩溃"(标记文件丢失、legacy JSON 复现),
    // 库内 control_metadata 标记必须阻止再次导入——已出队条目不得复活。
    await store.removeQueued(fixture.workspaceA, "legacy-a");
    rmSync(`${fixture.legacyJsonPath}.migrated`);
    writeLegacyJson(fixture, legacyState);
    const reopened = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    assert.deepEqual(await reopened.listQueued(fixture.workspaceA, "session-a"), []);
    assert.equal(existsSync(`${fixture.legacyJsonPath}.migrated`), true);
    const countsB = readWorkspaceRowCounts(fixture, fixture.workspaceB);
    assert.equal(countsB.queue, 1);
    assert.equal(countsB.claims, 1);
    const countsA = readWorkspaceRowCounts(fixture, fixture.workspaceA);
    assert.equal(countsA.queue, 0);
    assert.equal(countsA.idempotency, 1);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: permanently corrupt legacy import is isolated to .failed and the store starts empty (B1, Finding 6)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-import-rollback-");
  try {
    const canonicalA = normalizeWorkspacePath(fixture.workspaceA);
    writeLegacyJson(fixture, {
      version: 2,
      queuedInputs: [
        {
          queueId: "dup-queue",
          workspacePath: canonicalA,
          sessionId: "session-1",
          input: { kind: "text", text: "first" },
          createdAt: 100,
        },
        {
          queueId: "dup-queue",
          workspacePath: canonicalA,
          sessionId: "session-1",
          input: { kind: "text", text: "second" },
          createdAt: 101,
        },
      ],
      idempotency: [
        {
          workspacePath: canonicalA,
          key: "key-1",
          requestFingerprint: "fp-1",
          result: { ok: true },
          createdAt: 102,
        },
      ],
      firstSendClaims: [],
    });

    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    // 导入约束冲突=永久损坏:不再让首个操作抛错(poison-pill),而是隔离 .failed 空态起步。
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), []);
    assert.equal(existsSync(fixture.legacyJsonPath), false);
    assert.equal(existsSync(`${fixture.legacyJsonPath}.failed`), true);
    assert.equal(existsSync(`${fixture.legacyJsonPath}.migrated`), false);
    const counts = readWorkspaceRowCounts(fixture, fixture.workspaceA);
    assert.deepEqual(
      [counts.queue, counts.idempotency, counts.claims, counts.legacyImportMarker],
      [0, 0, 0, undefined],
    );
    // 隔离后 store 可用:新写入正常落库。
    await store.enqueue(fixture.workspaceA, "session-1", { kind: "text", text: "after isolation" });
    assert.equal((await store.listQueued(fixture.workspaceA, "session-1")).length, 1);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: syntactically corrupt legacy JSON is isolated to .failed (B1, Finding 6)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-import-syntax-");
  try {
    writeFileSync(fixture.legacyJsonPath, "{ not valid json", "utf8");
    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), []);
    assert.equal(existsSync(`${fixture.legacyJsonPath}.failed`), true);
    assert.equal(existsSync(fixture.legacyJsonPath), false);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: transient IO read failure is not isolated and keeps retrying (B1, 审查 F1)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-import-transient-");
  try {
    // 目录占位注入读取期 IO 错误(EISDIR):非语法/形状错误 → 不隔离、原样上抛维持重试。
    mkdirSync(fixture.legacyJsonPath);
    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    await assert.rejects(store.listQueued(fixture.workspaceA, "session-1"), /EISDIR/u);
    assert.equal(existsSync(fixture.legacyJsonPath), true, "transient failure must not rename");
    assert.equal(existsSync(`${fixture.legacyJsonPath}.failed`), false);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: isolation never overwrites a previous .failed copy (审查 F4)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-import-failed-keep-");
  try {
    writeFileSync(`${fixture.legacyJsonPath}.failed`, "previous isolated copy", "utf8");
    writeFileSync(fixture.legacyJsonPath, "{ not valid json", "utf8");
    const store = new SqliteDesktopConversationStateStore({ picoHome: fixture.picoHome });
    assert.deepEqual(await store.listQueued(fixture.workspaceA, "session-1"), []);
    assert.equal(
      readFileSync(`${fixture.legacyJsonPath}.failed`, "utf8"),
      "previous isolated copy",
      "existing .failed copy must be preserved",
    );
    const timestamped = readdirSync(join(fixture.picoHome, "desktop")).filter(
      (name) => /\.failed$/u.test(name) && name !== "conversation-state.json.failed",
    );
    assert.equal(timestamped.length, 1, "new isolation goes to a timestamped suffix");
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: write failure inside a transaction rolls back the whole batch (B1)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-write-rollback-");
  try {
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => 5_000,
    });
    const claim = await store.claimFirstSend(fixture.workspaceA, "key-1", "session-1", "fp-1");
    const poisoned = { big: 1n } as unknown as JsonObject;
    await assert.rejects(
      store.rememberIdempotent(fixture.workspaceA, "key-1", "fp-1", poisoned),
      /BigInt/u,
    );
    assert.deepEqual(await store.getFirstSendClaim(fixture.workspaceA, "key-1"), claim);
    assert.equal(await store.getIdempotent(fixture.workspaceA, "key-1"), undefined);
  } finally {
    cleanupFixture(fixture.root);
  }
});

test("sqlite conversation state: first-send claims expire after the retention window (B3)", async () => {
  const fixture = createFixture("pico-conversation-state-sqlite-retention-");
  try {
    let clock = 1_000_000;
    const store = new SqliteDesktopConversationStateStore({
      picoHome: fixture.picoHome,
      now: () => clock,
    });
    await store.claimFirstSend(fixture.workspaceA, "expire-key", "session-1", "fp-1");
    clock += FIRST_SEND_CLAIM_RETENTION_MS + 1;
    assert.equal(await store.getFirstSendClaim(fixture.workspaceA, "expire-key"), undefined);
    const renewed = await store.claimFirstSend(
      fixture.workspaceA,
      "expire-key",
      "session-2",
      "fp-2",
    );
    assert.equal(renewed.sessionId, "session-2");
    assert.equal(renewed.requestFingerprint, "fp-2");
    assert.equal(renewed.createdAt, clock);
  } finally {
    cleanupFixture(fixture.root);
  }
});
