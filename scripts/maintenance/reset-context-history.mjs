import { createHash } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";

// Offline, explicit-path maintenance only. Never imported by the product runtime.
export const PRESERVED_TABLES = Object.freeze([
  "operational_schema_migrations",
  "workspace_storage_binding",
  "event_log_epoch",
  "cron_jobs",
]);
export const CLEARED_TABLES = Object.freeze([
  "sessions",
  "runtime_events",
  "session_catalog_projection",
  "session_messages",
  "runtime_continuation_claims",
  "runtime_owner_fences",
  "runtime_run_projection",
  "runtime_partial_snapshots",
  "runtime_partial_segments",
  "runtime_tool_operations",
  "runtime_tool_journal",
  "runtime_checkpoint_projection",
  "runtime_eventlog_metadata",
  "runtime_storage_assets",
  "runtime_transcript_projection_state",
  "runtime_transcript_item_versions",
  "runtime_transcript_changes",
  "task_runs",
  "task_run_events",
  "control_metadata",
  "jobs",
  "job_attempts",
  "runtime_leases",
  "cron_runs",
  "daemon_commands",
  "daemon_runs",
  "job_commands",
  "completion_outbox",
  "merge_requests",
  "daemon_events",
  "desktop_idempotency",
  "desktop_input_queue",
  "desktop_first_send_claims",
  "desktop_rewind_claims",
  "usage_accounting_versions",
  "usage_attempt_owners",
  "usage_attempt_revisions",
  "usage_deleted_sessions",
  "usage_physical_attempts",
  "session_latest_context",
  "storage_operations",
  "file_history",
  "file_history_snapshots",
  "retention_gc_intents",
  "event_log_blob_gc_intents",
  "session_task_ledgers",
  "session_tasks",
  "session_task_commands",
  "session_artifact_ledgers",
  "artifact_blobs",
  "session_artifacts",
  "session_artifact_ingests",
  "session_artifact_commands",
  "agent_graphs",
  "agent_graph_schedule_revisions",
  "agent_graph_operator_provisions",
  "agent_graph_activation_claims",
  "agent_graph_record_refs",
  "agent_graph_yield_interests",
  "agent_graph_supervisor_wakes",
  "agent_graph_supervisor_wake_attempts",
  "agent_graph_resource_refs",
  "agent_graph_workspace_resources",
  "agent_graph_diagnostics",
  "agent_graph_swarm_checkpoints",
  "deep_research_events",
]);
const SIDE_CHAT_KEY = "desktop.side-chat.leases.v1";
const quote = (name) => `"${name.replaceAll('"', '""')}"`;

/** Reset only this existing operational SQLite file, atomically; external files are never followed. */
export function resetContextHistory(path, { execute = false, runtimeStopped = false } = {}) {
  if (execute && !runtimeStopped)
    throw new Error("Execute requires stopped App/Runtime and --runtime-stopped acknowledgement.");
  const databasePath = realpathSync(resolve(path));
  if (!statSync(databasePath).isFile())
    throw new Error("Database path must name an existing regular file.");
  const database = new DatabaseSync(databasePath, {
    readOnly: !execute,
    enableForeignKeyConstraints: true,
  });
  try {
    database.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
    database.exec(execute ? "BEGIN IMMEDIATE" : "BEGIN");
    try {
      const tables = database
        .prepare(
          "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);
      const known = new Set([...PRESERVED_TABLES, ...CLEARED_TABLES, "workspace_kv"]);
      const unknown = tables.filter((name) => !known.has(name));
      if (unknown.length) throw new Error(`Unknown tables require review: ${unknown.join(", ")}`);
      for (const name of [
        "operational_schema_migrations",
        "sessions",
        "usage_physical_attempts",
        "cron_jobs",
        "workspace_kv",
      ]) {
        if (!tables.includes(name))
          throw new Error(`Not a supported operational database: missing ${name}`);
      }
      const schemaVersions = database
        .prepare("SELECT scope, version FROM operational_schema_migrations ORDER BY scope")
        .all();
      const controlVersion = schemaVersions.find((row) => row.scope === "control")?.version;
      if (controlVersion !== 7 && controlVersion !== 8)
        throw new Error(`Unsupported control schema ${controlVersion}; expected 7 or 8.`);
      assertIntegrity(database);
      const preserved = tables.filter((name) => PRESERVED_TABLES.includes(name));
      const clearing = deleteOrder(
        database,
        tables.filter((name) => CLEARED_TABLES.includes(name)),
      );
      const before = Object.fromEntries(tables.map((name) => [name, count(database, name)]));
      const preservedDigests = preservedFingerprints(database, preserved);
      const removedKvRows = Number(
        database.prepare("SELECT COUNT(*) AS n FROM workspace_kv WHERE key=?").get(SIDE_CHAT_KEY).n,
      );
      const externalAssets = tables.includes("runtime_storage_assets")
        ? database
            .prepare(
              "SELECT asset_id, storage_uri, content_digest, byte_length FROM runtime_storage_assets ORDER BY asset_id",
            )
            .all()
        : [];
      const report = {
        databasePath,
        mode: execute ? "execute" : "dry-run",
        schemaVersions,
        clearedTables: clearing.map((table) => ({ table, rows: before[table] })),
        preservedTables: preserved.map((table) => ({
          table,
          rows: before[table],
          sha256: preservedDigests[table],
        })),
        workspaceKv: {
          removedKeys: [SIDE_CHAT_KEY],
          removedRows: removedKvRows,
          preservedRows: before.workspace_kv - removedKvRows,
        },
        externalAssets,
        externalFilesDeleted: 0,
        precondition:
          "App, RuntimeHost, schedulers and other writers must remain stopped for maintenance and upgrade.",
        checks: {
          foreignKeys: "ok",
          quickCheck: "ok",
          emptyExecutionTables: execute ? "pending" : "not-run",
          preservedRows: execute ? "pending" : "not-run",
        },
      };
      if (execute) {
        for (const table of clearing) database.exec(`DELETE FROM ${quote(table)}`);
        // Session deletion deliberately emits tombstones in control v7/v8. They also belong to the reset.
        database.exec("DELETE FROM usage_deleted_sessions");
        database.prepare("DELETE FROM workspace_kv WHERE key=?").run(SIDE_CHAT_KEY);
        const remaining = clearing.filter((table) => count(database, table) !== 0);
        if (remaining.length) throw new Error(`Execution facts remain: ${remaining.join(", ")}`);
        if (database.prepare("SELECT 1 FROM workspace_kv WHERE key=?").get(SIDE_CHAT_KEY))
          throw new Error("Side-chat session references remain.");
        if (
          JSON.stringify(preservedFingerprints(database, preserved)) !==
          JSON.stringify(preservedDigests)
        )
          throw new Error("Preserved configuration/cron rows changed; rolling back.");
        assertIntegrity(database);
        report.checks.emptyExecutionTables = "ok";
        report.checks.preservedRows = "ok";
      }
      database.exec("COMMIT");
      return report;
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  } finally {
    database.close();
  }
}
function count(database, table) {
  return Number(database.prepare(`SELECT COUNT(*) AS n FROM ${quote(table)}`).get().n);
}
function assertIntegrity(database) {
  if (database.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Foreign-key violations; reset refused.");
  const results = database.prepare("PRAGMA quick_check").all();
  if (results.length !== 1 || Object.values(results[0])[0] !== "ok")
    throw new Error("SQLite quick_check failed; reset refused.");
}
function preservedFingerprints(database, tables) {
  const fingerprints = {};
  for (const table of [...tables, "workspace_kv"]) {
    const rows = database
      .prepare(`SELECT * FROM ${quote(table)}${table === "workspace_kv" ? " WHERE key != ?" : ""}`)
      .all(...(table === "workspace_kv" ? [SIDE_CHAT_KEY] : []));
    const values = rows.map((row) => JSON.stringify(row)).sort();
    fingerprints[table] = createHash("sha256").update(JSON.stringify(values)).digest("hex");
  }
  return fingerprints;
}
function deleteOrder(database, tables) {
  const remaining = new Set(tables);
  const parents = new Map(
    tables.map((table) => [
      table,
      database
        .prepare(`PRAGMA foreign_key_list(${quote(table)})`)
        .all()
        .map((row) => row.table)
        .filter((parent) => parent !== table),
    ]),
  );
  const ordered = [];
  while (remaining.size) {
    const leaves = [...remaining].filter(
      (table) => ![...remaining].some((other) => parents.get(other).includes(table)),
    );
    if (!leaves.length)
      throw new Error("Cyclic foreign keys require manual review; no constraints were disabled.");
    for (const leaf of leaves) {
      ordered.push(leaf);
      remaining.delete(leaf);
    }
  }
  return ordered;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    const paths = [];
    let execute = false,
      runtimeStopped = false,
      dryRun = false;
    for (let index = 0; index < args.length; index++) {
      const arg = args[index];
      if (arg === "--database" && args[index + 1]) paths.push(args[++index]);
      else if (arg === "--execute") execute = true;
      else if (arg === "--dry-run") dryRun = true;
      else if (arg === "--runtime-stopped") runtimeStopped = true;
      else throw new Error(`Unknown argument: ${arg}`);
    }
    if (execute && dryRun) throw new Error("Choose --dry-run or --execute, not both.");
    if (!paths.length)
      throw new Error(
        "Usage: node scripts/maintenance/reset-context-history.mjs --database /absolute/pico.sqlite [--database ...] [--dry-run | --execute --runtime-stopped]",
      );
    for (const path of [...new Set(paths.map((entry) => realpathSync(resolve(entry))))])
      console.log(JSON.stringify(resetContextHistory(path, { execute, runtimeStopped }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
