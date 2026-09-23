import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "../../../packages/storage/src/sqlite/workspace-scopes.js";
import {
  assertCurrentOperationalTargetSchemaSync,
  migrateOperationalDatabaseSync,
} from "../../../packages/storage/src/sqlite/sqlite-schema.js";
import { LEGACY_CONTROL_SCOPE } from "../helpers/legacy-control-schema.js";

const retired = [
  "runtime_events_usage_started",
  "usage_baselines",
  "usage_baseline_adjustments",
  "usage_effective_baselines",
  "usage_provider_calls",
  "usage_accounting_calls",
  "evidence_records",
  "evidence_blobs",
];
test("current baseline has only current context tables and reopens idempotently", () => {
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal(migrateOperationalDatabaseSync(db, ALL_WORKSPACE_SQLITE_SCOPES), true);
    assertCurrentOperationalTargetSchemaSync(db, ALL_WORKSPACE_SQLITE_SCOPES);
    assert.equal(migrateOperationalDatabaseSync(db, ALL_WORKSPACE_SQLITE_SCOPES), false);
    for (const name of retired)
      assert.equal(
        db.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name),
        undefined,
        name,
      );
    assert.ok(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='session_latest_context'").get(),
    );
    assert.equal(
      db.prepare("SELECT version FROM operational_schema_migrations WHERE scope='control'").get()!
        .version,
      8,
    );
  } finally {
    db.close();
  }
});
for (const version of [3, 6]) {
  test(`retired control ${version} is rejected without compatibility migration`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      const scopes = ALL_WORKSPACE_SQLITE_SCOPES.map((scope) =>
        scope.name === "control"
          ? {
              ...LEGACY_CONTROL_SCOPE,
              migrations: new Map(
                [...LEGACY_CONTROL_SCOPE.migrations].filter(([v]) => v <= version),
              ),
            }
          : scope,
      );
      migrateOperationalDatabaseSync(db, scopes);
      db.exec(
        "INSERT INTO sessions(session_id,work_dir,created_at,updated_at) VALUES ('chat','/work','2026','2026')",
      );
      assert.throws(() => migrateOperationalDatabaseSync(db, ALL_WORKSPACE_SQLITE_SCOPES));
      assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 1);
    } finally {
      db.close();
    }
  });
}
