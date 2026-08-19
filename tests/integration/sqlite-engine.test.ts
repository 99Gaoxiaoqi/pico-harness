import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "../../src/storage/local-file-storage.js";
import {
  backupOperationalDatabaseSync,
  operationalDatabasePath,
  openOperationalDatabaseReadOnly,
} from "../../src/storage/sqlite/sqlite-database.js";
import {
  migrateOperationalDatabaseSync,
  assertCurrentOperationalTargetSchemaSync,
  readOperationalSchemaVersionsSync,
  type SqliteSchemaScope,
} from "../../src/storage/sqlite/sqlite-schema.js";
import {
  adoptWorkspaceSqliteStorageRootSync,
  assertWorkspaceSqliteStorageRootIdentitySync,
  prepareWorkspaceSqliteStorageSync,
  readWorkspaceSqliteStorageRootIdentitySync,
  withWorkspaceBindingScope,
} from "../../src/storage/sqlite/sqlite-workspace-storage.js";

const TEST_DOMAIN_LEVEL_1 = `
CREATE TABLE test_rows (
  id INTEGER PRIMARY KEY,
  value TEXT NOT NULL
);
`;
const TEST_DOMAIN_LEVEL_2 = `
CREATE INDEX test_rows_by_value ON test_rows(value);
`;
const TEST_DOMAIN_MIGRATIONS = new Map<number, string>([
  [1, TEST_DOMAIN_LEVEL_1],
  [2, TEST_DOMAIN_LEVEL_2],
]);
const TEST_SCOPES: readonly SqliteSchemaScope[] = [
  { name: "test_domain", migrations: TEST_DOMAIN_MIGRATIONS },
];

function freshRoot(): string {
  return mkdtempSync(join(tmpdir(), "pico-sqlite-engine-"));
}

function cleanup(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

test("sqlite engine: prepare initializes database with PRAGMAs and binding", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      const db = preparation.lease.database;
      assert.ok(existsSync(operationalDatabasePath(root)));
      assert.equal(
        (db.prepare("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode,
        "wal",
      );
      assert.equal(
        (db.prepare("PRAGMA busy_timeout").get() as { timeout: number }).timeout,
        5000,
      );
      assert.equal((db.prepare("PRAGMA foreign_keys").get() as { foreign_keys: number }).foreign_keys, 1);
      assert.equal((db.prepare("PRAGMA synchronous").get() as { synchronous: number }).synchronous, 2);
      assert.ok(preparation.rootIdentity.storageRootId.length > 0);
      assert.ok(preparation.rootIdentity.canonicalPath.length > 0);
    } finally {
      preparation.lease.release();
    }

    // 幂等重开:同一 storageRootId,无迁移重放。
    const again = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      assert.equal(
        again.rootIdentity.storageRootId,
        readWorkspaceSqliteStorageRootIdentitySync(root, TEST_SCOPES)?.storageRootId,
      );
      const versions = readOperationalSchemaVersionsSync(again.lease.database);
      assert.equal(versions.get("test_domain"), 2);
      assert.equal(versions.get("workspace"), 1);
    } finally {
      again.lease.release();
    }
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: read-only connection is query_only and version-gated", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    preparation.lease.release();
    const readOnly = openOperationalDatabaseReadOnly(root);
    try {
      assert.ok(existsSync(operationalDatabasePath(root)));
      assert.throws(
        () => readOnly.exec("INSERT INTO test_rows (value) VALUES ('x')"),
        /readonly|query_only/,
      );
    } finally {
      readOnly.close();
    }

    // 版本超前:拒绝只读打开。
    const tamper = new DatabaseSync(operationalDatabasePath(root));
    try {
      tamper.exec("UPDATE operational_schema_migrations SET version = 99 WHERE scope = 'test_domain'");
    } finally {
      tamper.close();
    }
    assert.throws(
      () => readWorkspaceSqliteStorageRootIdentitySync(root, TEST_SCOPES),
      /newer than supported/,
    );
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: shape assertion gates migration only; drift is caught explicitly and by doctor", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    preparation.lease.release();
    const tamper = new DatabaseSync(operationalDatabasePath(root));
    try {
      tamper.exec("DROP INDEX test_rows_by_value");
    } finally {
      tamper.close();
    }
    // 断言降频:版本未推进时常规重开只做注册表检查,不付 ~25ms 的 DDL 重放。
    const reopened = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      try {
        assertCurrentOperationalTargetSchemaSync(
          reopened.lease.database,
          withWorkspaceBindingScope(TEST_SCOPES),
        );
        assert.fail("explicit shape assertion must catch the dropped index");
      } catch (error) {
        assert.match(error instanceof Error ? error.message : String(error), /schema drifted/);
      }
    } finally {
      reopened.lease.release();
    }
    // 版本推进路径(升级)仍会强制断言:注入一个 migration 无法自愈的漂移
    // (多余对象),再把注册表版本回退,重开时迁移重跑也消不掉它。
    const regression = new DatabaseSync(operationalDatabasePath(root));
    try {
      regression.exec("CREATE TABLE rogue_tamper (id INTEGER PRIMARY KEY)");
      regression.exec(
        "UPDATE operational_schema_migrations SET version = 1 WHERE scope = 'test_domain'",
      );
    } finally {
      regression.close();
    }
    assert.throws(
      () => prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES),
      /schema drifted/,
    );
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: legacy JSONL-era layouts are refused", () => {
  const cases: Array<{ setup: (root: string) => void; pattern: RegExp }> = [
    {
      setup: (root) => mkdirSync(join(root, "sessions", "abc"), { recursive: true }),
      pattern: /Legacy session-centric/,
    },
    {
      setup: (root) => mkdirSync(join(root, ".storage"), { recursive: true }),
      pattern: /Legacy session-centric/,
    },
    {
      setup: (root) => {
        mkdirSync(join(root, "runtime"), { recursive: true });
        writeFileSync(join(root, "runtime", "legacy.json"), "{}");
      },
      pattern: /pre-v2 Runtime/,
    },
  ];
  for (const { setup, pattern } of cases) {
    const root = freshRoot();
    try {
      setup(root);
      assert.throws(() => prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES), pattern);
      assert.ok(!existsSync(operationalDatabasePath(root)), "refused open must not create the database");
    } finally {
      cleanup(root);
    }
  }
});

test("sqlite engine: identity verification and explicit adoption", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    const identity = preparation.rootIdentity;
    preparation.lease.release();

    assertWorkspaceSqliteStorageRootIdentitySync(root, identity, TEST_SCOPES);

    // 模拟拷贝到新物理目录:篡改 binding 的 device 字段。
    const tamper = new DatabaseSync(operationalDatabasePath(root));
    try {
      tamper.exec("UPDATE workspace_storage_binding SET device = '999999'");
    } finally {
      tamper.close();
    }
    assert.throws(
      () => assertWorkspaceSqliteStorageRootIdentitySync(root, identity, TEST_SCOPES),
      /identity changed/,
    );
    const adopted = adoptWorkspaceSqliteStorageRootSync(root, identity.storageRootId, TEST_SCOPES);
    assert.equal(adopted.storageRootId, identity.storageRootId);
    assertWorkspaceSqliteStorageRootIdentitySync(root, adopted, TEST_SCOPES);
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: transactions — WAL snapshot isolation, busy write, nesting, rollback", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      const db = preparation.lease.database;
      preparation.lease.transaction("write", () => {
        db.prepare("INSERT INTO test_rows (value) VALUES ('seed')").run();
      });

      // WAL 快照隔离:写事务未提交时,第二个连接读事务看到旧值。
      const second = new DatabaseSync(operationalDatabasePath(root));
      try {
        second.exec("PRAGMA busy_timeout = 100");
        preparation.lease.transaction("write", () => {
          db.prepare("INSERT INTO test_rows (value) VALUES ('pending')").run();
          const snapshot = second
            .prepare("SELECT COUNT(*) AS n FROM test_rows")
            .get() as { n: number };
          assert.equal(snapshot.n, 1, "uncommitted write must be invisible to a second reader");

          // 写写冲突:第二连接短 busy_timeout 下尝试写 → 抛 SQLITE_BUSY。
          assert.throws(
            () => second.exec("INSERT INTO test_rows (value) VALUES ('racy')"),
            (error: unknown) => {
              const message = error instanceof Error ? error.message : String(error);
              return /busy|locked/i.test(message);
            },
          );
        });
        const visible = second.prepare("SELECT COUNT(*) AS n FROM test_rows").get() as { n: number };
        assert.equal(visible.n, 2, "commit must become visible");
      } finally {
        second.close();
      }

      // 嵌套:write 内嵌 read 合法;read 内嵌 write 非法。
      const nested = preparation.lease.transaction("write", () =>
        preparation.lease.transaction("read", () => "ok"),
      );
      assert.equal(nested, "ok");
      assert.throws(
        () =>
          preparation.lease.transaction("read", () =>
            preparation.lease.transaction("write", () => "no"),
          ),
        /nested write transaction inside a read/,
      );

      // 异常回滚。
      assert.throws(() =>
        preparation.lease.transaction("write", () => {
          db.prepare("INSERT INTO test_rows (value) VALUES ('doomed')").run();
          throw new Error("boom");
        }),
        /boom/,
      );
      const final = db.prepare("SELECT COUNT(*) AS n FROM test_rows").get() as { n: number };
      assert.equal(final.n, 2);
    } finally {
      preparation.lease.release();
    }
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: backup produces a self-contained readable snapshot", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      const db = preparation.lease.database;
      preparation.lease.transaction("write", () => {
        db.prepare("INSERT INTO test_rows (value) VALUES ('kept')").run();
      });
      const backupPath = join(root, "snapshot.sqlite");
      backupOperationalDatabaseSync(preparation.lease, backupPath);
      assert.ok(existsSync(backupPath));
      const snapshot = new DatabaseSync(backupPath, { readOnly: true });
      try {
        const row = snapshot.prepare("SELECT value FROM test_rows").get() as { value: string };
        assert.equal(row.value, "kept");
      } finally {
        snapshot.close();
      }
      assert.throws(
        () => backupOperationalDatabaseSync(preparation.lease, backupPath),
        /already exists/,
      );
    } finally {
      preparation.lease.release();
    }
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: migration framework runs levels sequentially and registers versions", () => {
  const root = freshRoot();
  try {
    const dbPath = operationalDatabasePath(root);
    const bootstrap = new DatabaseSync(dbPath);
    try {
      // 只应用第一级:模拟一个老版本库。
      migrateOperationalDatabaseSync(bootstrap, [
        { name: "test_domain", migrations: new Map([[1, TEST_DOMAIN_MIGRATIONS.get(1)!]]) },
      ]);
    } finally {
      bootstrap.close();
    }
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      const versions = readOperationalSchemaVersionsSync(preparation.lease.database);
      assert.equal(versions.get("test_domain"), 2, "opening must migrate the stale scope forward");
    } finally {
      preparation.lease.release();
    }
  } finally {
    cleanup(root);
  }
});

test("sqlite engine: target-shape assertion accepts a pristine database", () => {
  const root = freshRoot();
  try {
    const preparation = prepareWorkspaceSqliteStorageSync(root, TEST_SCOPES);
    try {
      assertCurrentOperationalTargetSchemaSync(
        preparation.lease.database,
        withWorkspaceBindingScope(TEST_SCOPES),
      );
    } finally {
      preparation.lease.release();
    }
  } finally {
    cleanup(root);
  }
});

// FileStorageIntegrityError 在各门禁路径中作为统一错误类型被引用。
assert.ok(typeof FileStorageIntegrityError === "function");
