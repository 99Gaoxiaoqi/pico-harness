import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { FileStorageIntegrityError } from "../../src/storage/local-file-storage.js";
import {
  runIdleSqliteRetentionMaintenance,
  SQLITE_RETENTION_VACUUM_RECLAIMED_BYTES,
} from "../../src/storage/sqlite/sqlite-retention-maintenance.js";

function withDatabase(operation: (database: DatabaseSync) => void): void {
  const root = mkdtempSync(join(tmpdir(), "pico-retention-maintenance-"));
  const database = new DatabaseSync(join(root, "maintenance.sqlite"));
  try {
    database.exec("PRAGMA journal_mode = WAL");
    operation(database);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
}

test("sqlite retention maintenance: checkpoints WAL without vacuum below both thresholds", () => {
  withDatabase((database) => {
    database.exec("CREATE TABLE rows (value BLOB NOT NULL)");
    database.prepare("INSERT INTO rows (value) VALUES (?)").run(Buffer.alloc(1024));

    const result = runIdleSqliteRetentionMaintenance(database, {
      estimatedLogicalBytesReclaimed: 0,
    });

    assert.equal(result.vacuumed, false);
    assert.equal(result.vacuumTrigger, "none");
    assert.ok(result.freelistRatioBeforeVacuum < 0.25);
    const checkpoint = database.prepare("PRAGMA wal_checkpoint(PASSIVE)").get() as {
      log: number;
      checkpointed: number;
    };
    assert.equal(checkpoint.log, 0);
    assert.equal(checkpoint.checkpointed, 0);
  });
});

test("sqlite retention maintenance: vacuums when the freelist reaches 25 percent", () => {
  withDatabase((database) => {
    database.exec("CREATE TABLE rows (value BLOB NOT NULL)");
    const insert = database.prepare("INSERT INTO rows (value) VALUES (?)");
    database.exec("BEGIN");
    for (let index = 0; index < 128; index += 1) insert.run(Buffer.alloc(32 * 1024, index));
    database.exec("COMMIT");
    database.exec("DELETE FROM rows");

    const result = runIdleSqliteRetentionMaintenance(database, {
      estimatedLogicalBytesReclaimed: 0,
    });

    assert.equal(result.vacuumed, true);
    assert.ok(result.freelistRatioBeforeVacuum >= 0.25);
    assert.ok(
      (database.prepare("PRAGMA freelist_count").get() as { freelist_count: number })
        .freelist_count < result.freelistCountBeforeVacuum,
    );
  });
});

test("sqlite retention maintenance: logical reclaim threshold triggers vacuum", () => {
  withDatabase((database) => {
    database.exec("CREATE TABLE rows (value TEXT NOT NULL)");

    const result = runIdleSqliteRetentionMaintenance(database, {
      estimatedLogicalBytesReclaimed: SQLITE_RETENTION_VACUUM_RECLAIMED_BYTES,
    });

    assert.equal(result.vacuumed, true);
    assert.equal(result.vacuumTrigger, "logical_bytes");
  });
});

test("sqlite retention maintenance: refuses to run inside an active transaction", () => {
  withDatabase((database) => {
    database.exec("BEGIN");
    try {
      assert.throws(
        () =>
          runIdleSqliteRetentionMaintenance(database, {
            estimatedLogicalBytesReclaimed: 0,
          }),
        FileStorageIntegrityError,
      );
    } finally {
      database.exec("ROLLBACK");
    }
  });
});
