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
  "usage_baselines",
  "usage_baseline_adjustments",
  "usage_effective_baselines",
  "usage_provider_calls",
  "usage_accounting_calls",
  "evidence_records",
  "evidence_blobs",
];
for (const version of [0, 3, 6]) {
  test(`current baseline upgrades control ${version}, preserves facts, and reopens idempotently`, () => {
    const db = new DatabaseSync(":memory:");
    try {
      if (version !== 0) {
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
        db.exec(`INSERT INTO sessions(session_id,work_dir,created_at,updated_at) VALUES ('chat','/work','2026','2026');
          INSERT INTO runtime_events(event_id,session_id,invocation_id,run_id,turn_id,event_seq,kind,visibility,partial,tx_id,payload_json,at,committed_at)
          VALUES ('body','chat','invocation','run','turn',1,'message.committed','model',0,'tx','{"data":{"message":{"role":"user","content":"正文"}}}','2026','2026');`);
        if (version === 6)
          db.exec(
            `INSERT INTO usage_physical_attempts VALUES ('native','call','chat',NULL,NULL,'run','owner',0,'succeeded','2026','{"accountingSource":"physical","sessionId":"chat"}');`,
          );
        // Retired attachment manifests are removed structurally, never replayed.
        db.exec(`CREATE TABLE evidence_records (session_id TEXT, content_json TEXT);
          CREATE TABLE evidence_blobs (digest TEXT, size_bytes INTEGER);
          UPDATE operational_schema_migrations SET version=1 WHERE scope='attachments';`);
      }
      assert.equal(migrateOperationalDatabaseSync(db, ALL_WORKSPACE_SQLITE_SCOPES), true);
      assertCurrentOperationalTargetSchemaSync(db, ALL_WORKSPACE_SQLITE_SCOPES);
      for (let reopen = 0; reopen < 2; reopen++) {
        assert.equal(migrateOperationalDatabaseSync(db, ALL_WORKSPACE_SQLITE_SCOPES), false);
        for (const name of retired)
          assert.equal(
            db.prepare("SELECT name FROM sqlite_schema WHERE name=?").get(name),
            undefined,
            name,
          );
        if (version !== 0) {
          assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n, 1);
          assert.match(
            String(
              db.prepare("SELECT payload_json FROM runtime_events WHERE event_id='body'").get()!
                .payload_json,
            ),
            /正文/,
          );
        }
        assert.equal(
          db.prepare("SELECT COUNT(*) AS n FROM usage_physical_attempts").get()!.n,
          version === 6 ? 1 : 0,
        );
      }
    } finally {
      db.close();
    }
  });
}
