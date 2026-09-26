import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { coordinateEventLogHardCut } from "../../../packages/storage/src/event-log-hard-cut-coordinator.js";
import { CURRENT_EVENT_LOG_PROTOCOL_MARKER } from "../../../packages/storage/src/sqlite/event-log-hard-cut-scope.js";
import { SqliteRuntimeEventStore } from "../../../packages/storage/src/sqlite/sqlite-runtime-event-store.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "../../../packages/storage/src/sqlite/workspace-scopes.js";
import { migrateOperationalDatabaseSync } from "../../../packages/storage/src/sqlite/sqlite-schema.js";
import {
  configureSqliteLongTermMemoryDatabase,
  initializeSqliteLongTermMemoryDatabase,
} from "../../../packages/storage/src/sqlite/atomic-memory-schema.js";
// @ts-expect-error Offline maintenance is deliberately a Node-only mjs entrypoint.
import { resetContextHistory } from "../../../scripts/maintenance/reset-context-history.mjs";

function seed(database: DatabaseSync, version: 7 | 8) {
  database.exec("PRAGMA foreign_keys=ON");
  migrateOperationalDatabaseSync(database, ALL_WORKSPACE_SQLITE_SCOPES);
  if (version === 7) {
    // Simulate the exact preceding control shape; the maintenance script never migrates it.
    database.exec(`DROP TRIGGER usage_session_deleted; DROP TABLE session_latest_context; DROP INDEX usage_latest_context_repair;
      CREATE TRIGGER usage_session_deleted AFTER DELETE ON sessions BEGIN
        DELETE FROM usage_accounting_versions WHERE session_id=OLD.session_id;
        INSERT OR IGNORE INTO usage_deleted_sessions(session_id) VALUES(OLD.session_id);
        UPDATE usage_physical_attempts SET session_id=NULL,run_id=NULL,
          record_json=json_remove(record_json,'$.sessionId','$.conversationId','$.runId','$.turnId') WHERE session_id=OLD.session_id;
      END;
      UPDATE operational_schema_migrations SET version=7 WHERE scope='control';`);
  }
  database.exec(`
    INSERT INTO event_log_epoch VALUES(1,1,'retired-protocol','previous-cut','now');
    INSERT INTO sessions(session_id,work_dir,created_at,updated_at) VALUES('s','/work','now','now');
    INSERT INTO runtime_events(event_id,session_id,invocation_id,run_id,turn_id,event_seq,kind,visibility,partial,tx_id,payload_json,at,committed_at)
      VALUES('e','s','i','r','t',1,'message.committed','model',0,'tx','{}','now','now');
    INSERT INTO cron_jobs VALUES('cron','/work','keep schedule','daily','Asia/Shanghai','retained prompt',1,'{}','secret-ref','p/m',1,1,1);
    INSERT INTO cron_runs VALUES('cr','cron','/work',1,'succeeded',NULL,1,1,1,2,NULL,'{"sessionId":"s"}',1);
    INSERT INTO usage_attempt_owners VALUES('owner',123,1);
    INSERT INTO usage_attempt_revisions VALUES('attempt',0,'hash');
    INSERT INTO usage_physical_attempts VALUES('attempt','call','s',NULL,NULL,'r','owner',0,'succeeded','now','{"sessionId":"s"}');
    INSERT INTO usage_accounting_versions VALUES('s',1);
    INSERT INTO usage_deleted_sessions VALUES('earlier');
    INSERT INTO desktop_input_queue VALUES('queue','/work','s','{}',1);
    INSERT INTO runtime_storage_assets VALUES('asset','s','r','tool_result','/business/never-delete.txt','digest',7,'{}','now');
    INSERT INTO agent_graphs VALUES('graph','s',1,'open',1,1,NULL);
    INSERT INTO agent_graph_schedule_revisions VALUES('graph',1,'op','hash','add','{}','s','t','r','call',1);
    INSERT INTO workspace_kv VALUES('desktop.side-chat.leases.v1','[{"sourceSessionId":"s"}]');
    INSERT INTO workspace_kv VALUES('todo','{"tasks":["preserve workspace todo"]}');
    INSERT INTO workspace_kv VALUES('project.config','{"keep":"configuration"}');
    INSERT INTO control_metadata VALUES('nextRuntimeEventSequence','7');
  `);
  if (version === 8)
    database.exec("INSERT INTO session_latest_context VALUES('s','attempt','now','{}')");
}

test("offline context reset clears v7/v8 execution facts atomically and preserves cron, workspace configuration and user memory", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-context-reset-"));
  try {
    const memoryPath = join(root, "memory.sqlite");
    const memory = new DatabaseSync(memoryPath);
    configureSqliteLongTermMemoryDatabase(memory);
    initializeSqliteLongTermMemoryDatabase(memory);
    memory.exec(
      `INSERT INTO memory_items VALUES('memory',1,'用户长期偏好必须保留','preference','fact','undated','global',NULL,NULL,NULL,1,'active','user_requested','${"a".repeat(64)}',1,1)`,
    );
    memory.close();
    const originalMemory = await readFile(memoryPath);
    const configPath = join(root, "config.json");
    await writeFile(configPath, '{"credentialRef":"retained"}');
    const businessPath = join(root, "business.txt");
    await writeFile(businessPath, "business data");
    for (const version of [7, 8] as const) {
      const storageRoot = join(root, `v${version}`);
      await mkdir(storageRoot);
      const path = join(storageRoot, "pico.sqlite");
      const setup = new DatabaseSync(path);
      seed(setup, version);
      setup.close();
      const report = resetContextHistory(path);
      assert.equal(report.mode, "dry-run");
      assert.equal(
        report.clearedTables.find(
          (entry: { table: string; rows: number }) => entry.table === "sessions",
        )?.rows,
        1,
      );
      assert.equal(
        report.clearedTables.find((entry: { table: string }) => entry.table === "event_log_epoch")
          ?.rows,
        1,
      );
      assert.equal(report.externalAssets[0].storage_uri, "/business/never-delete.txt");
      assert.throws(() => resetContextHistory(path, { execute: true }), /runtime-stopped/);
      const read = new DatabaseSync(path);
      assert.equal(
        read.prepare("SELECT COUNT(*) AS n FROM sessions").get()!.n,
        1,
        "dry run does not delete",
      );
      assert.equal(
        read.prepare("SELECT protocol_marker FROM event_log_epoch").get()!.protocol_marker,
        "retired-protocol",
      );
      const cron = JSON.stringify(read.prepare("SELECT * FROM cron_jobs").all());
      const versions = JSON.stringify(
        read.prepare("SELECT * FROM operational_schema_migrations").all(),
      );
      read.close();
      const done = resetContextHistory(path, { execute: true, runtimeStopped: true });
      assert.equal(done.checks.emptyExecutionTables, "ok");
      assert.equal(done.checks.preservedRows, "ok");
      assert.equal(done.externalFilesDeleted, 0);
      const verify = new DatabaseSync(path);
      for (const { table } of done.clearedTables)
        assert.equal(verify.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get()!.n, 0, table);
      assert.deepEqual(verify.prepare("PRAGMA foreign_key_check").all(), []);
      assert.equal(JSON.stringify(verify.prepare("SELECT * FROM cron_jobs").all()), cron);
      assert.equal(
        JSON.stringify(verify.prepare("SELECT * FROM operational_schema_migrations").all()),
        versions,
      );
      assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM workspace_kv").get()!.n, 2);
      if (version === 7) migrateOperationalDatabaseSync(verify, ALL_WORKSPACE_SQLITE_SCOPES);
      assert.equal(
        verify
          .prepare("SELECT version FROM operational_schema_migrations WHERE scope='control'")
          .get()!.version,
        8,
      );
      const initialized = coordinateEventLogHardCut(verify);
      assert.equal(initialized.status, "cut");
      if (initialized.status === "blocked") assert.fail("empty history must initialize");
      assert.equal(initialized.marker.protocolMarker, CURRENT_EVENT_LOG_PROTOCOL_MARKER);
      assert.equal(initialized.marker.protocolMarker, "runtime-event-v2");
      assert.equal(coordinateEventLogHardCut(verify).status, "already_current");
      assert.equal(JSON.stringify(verify.prepare("SELECT * FROM cron_jobs").all()), cron);
      verify.close();
      const store = new SqliteRuntimeEventStore({ storageRoot });
      try {
        const manifest = await store.initializeSession({ sessionId: "new-session", workDir: root });
        assert.equal(manifest.historySource, "runtime-event-v2");
        assert.equal(
          (await store.initializeSession({ sessionId: "new-session", workDir: root })).sessionId,
          "new-session",
        );
      } finally {
        store.close();
      }
      assert.equal(
        resetContextHistory(path, { execute: true, runtimeStopped: true }).checks
          .emptyExecutionTables,
        "ok",
        "repeat reset is safe",
      );
    }
    assert.deepEqual(await readFile(memoryPath), originalMemory);
    assert.equal(await readFile(configPath, "utf8"), '{"credentialRef":"retained"}');
    assert.equal(await readFile(businessPath, "utf8"), "business data");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("offline context reset rolls back deletion failures and refuses unexpected tables", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-context-reset-failure-"));
  const path = join(root, "pico.sqlite");
  try {
    const setup = new DatabaseSync(path);
    seed(setup, 8);
    setup.exec(
      "CREATE TRIGGER block_session_reset BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT,'fixture block'); END",
    );
    setup.close();
    assert.throws(
      () => resetContextHistory(path, { execute: true, runtimeStopped: true }),
      /fixture block/,
    );
    const verify = new DatabaseSync(path);
    assert.equal(
      verify.prepare("SELECT protocol_marker FROM event_log_epoch").get()!.protocol_marker,
      "retired-protocol",
    );
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM runtime_events").get()!.n, 1);
    assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM usage_physical_attempts").get()!.n, 1);
    assert.equal(
      verify.prepare("SELECT COUNT(*) AS n FROM agent_graph_schedule_revisions").get()!.n,
      1,
    );
    verify.exec("DROP TRIGGER block_session_reset; CREATE TABLE unreviewed_data (value TEXT)");
    verify.close();
    assert.throws(
      () => resetContextHistory(path, { execute: true, runtimeStopped: true }),
      /Unknown tables/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
