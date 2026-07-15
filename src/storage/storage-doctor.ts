import { createHash } from "node:crypto";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import Database from "better-sqlite3";
import { decodeRuntimeEventJson, type RuntimeEvent } from "../runtime/runtime-event.js";
import { materializeRuntimeHistory } from "../runtime/runtime-event-read-model.js";
import {
  projectRuntimeSessionMessages,
  projectRuntimeSessionState,
} from "../runtime/runtime-session-projection.js";
import { createFileHistoryState, fileHistoryLoadState } from "../safety/file-history.js";
import { quarantineCorruptJson, type QuarantinedJson } from "./atomic-json.js";
import { FileHistoryBlobStore } from "./file-history-blob-store.js";
import {
  isTerminalStorageOperation,
  StorageOperationJournal,
  type StorageOperation,
} from "./operation-journal.js";
import { canonicalizeWorkspacePath, resolvePicoPaths } from "../paths/pico-paths.js";
import {
  preflightRuntimeSchema,
  RUNTIME_SCHEMA_VERSION,
  type RuntimeSchemaPreflightResult,
} from "./runtime-schema-preflight.js";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_OPERATION_ID_RE = /^[A-Za-z0-9._-]+$/u;

export const STORAGE_DOCTOR_SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type StorageDoctorSeverity = (typeof STORAGE_DOCTOR_SEVERITIES)[number];

export const STORAGE_DOCTOR_COMPONENTS = [
  "session",
  "runtime",
  "operation",
  "file_history",
  "summary",
  "artifact",
  "projection",
] as const;
export type StorageDoctorComponent = (typeof STORAGE_DOCTOR_COMPONENTS)[number];

export interface StorageDoctorFinding {
  readonly code: string;
  readonly severity: StorageDoctorSeverity;
  readonly component: StorageDoctorComponent;
  readonly path: string;
  readonly message: string;
  readonly recommendation: string;
  /** 只有 derived/sidecar 才允许 Doctor 在显式 repair 中隔离。 */
  readonly authority: "authoritative" | "derived" | "sidecar";
}

export interface StorageDoctorReport {
  readonly scannedAt: string;
  readonly healthy: boolean;
  readonly findings: readonly StorageDoctorFinding[];
  readonly scanned: Readonly<Record<StorageDoctorComponent, number>>;
}

export interface StorageDoctorOptions {
  readonly workDir: string;
  /** Host-owned Pico state root. Omitted callers keep the process default. */
  readonly picoHome?: string;
  readonly fileHistoryDir?: string;
  readonly runtimeDatabasePath?: string;
  readonly summariesDir?: string;
  readonly artifactsDir?: string;
  readonly now?: () => Date;
}

export interface StorageDoctorRepairOptions {
  /** 只隔离可重建的 Summary/损坏 Artifact metadata，不触碰 Session/FileHistory/Runtime。 */
  readonly quarantineMalformedSidecars?: boolean;
  /** 投影具体实现由组装层提供，Doctor 不反向修改真源。 */
  readonly rebuildDerivedProjections?: () => void | Promise<void>;
  /** 显式请求协调时，forwarder 必须完成真实副作用及 journal 推进。 */
  readonly reconcileOperations?: {
    readonly forward: (
      operation: StorageOperation,
      journal: StorageOperationJournal,
    ) => "forwarded" | "needs_attention" | Promise<"forwarded" | "needs_attention">;
  };
}

export interface StorageDoctorRepairResult {
  readonly quarantined: readonly QuarantinedJson[];
  readonly rebuiltDerivedProjections: boolean;
  readonly reconciledOperationIds: readonly string[];
  readonly needsAttentionOperationIds: readonly string[];
}

interface AgentSessionRow {
  readonly session_id: string;
  readonly work_dir: string;
  readonly history_source: string;
  readonly created_at: string;
  readonly active_branch_id: string;
}

interface AgentRuntimeEventRow {
  readonly sequence: number;
  readonly session_id: string;
  readonly run_id: string;
  readonly event_id: string;
  readonly kind: string;
  readonly at: string;
  readonly event_json: string;
}

/**
 * 跨持久层的只读诊断器。scan 从不修复/删除权威数据；repair 也只执行
 * 调用方明确开启的安全动作。
 */
export class StorageDoctor {
  private readonly workDir: string;
  private readonly picoHome?: string;
  private readonly fileHistoryDir: string;
  private readonly runtimeDatabasePath: string;
  private readonly summariesDir: string;
  private readonly artifactsDir: string;
  private readonly now: () => Date;

  constructor(options: StorageDoctorOptions) {
    this.workDir = canonicalizeWorkspacePath(options.workDir);
    this.picoHome = options.picoHome;
    const paths = resolvePicoPaths(this.workDir, {
      ...(this.picoHome ? { picoHome: this.picoHome } : {}),
    });
    this.fileHistoryDir = resolve(options.fileHistoryDir ?? join(paths.home.root, "file-history"));
    this.runtimeDatabasePath = resolve(
      options.runtimeDatabasePath ?? paths.workspace.runtimeDatabase,
    );
    this.summariesDir = resolve(options.summariesDir ?? paths.workspace.summaries);
    this.artifactsDir = resolve(options.artifactsDir ?? paths.workspace.artifacts);
    this.now = options.now ?? (() => new Date());
  }

  async scan(): Promise<StorageDoctorReport> {
    const findings: StorageDoctorFinding[] = [];
    const scanned = Object.fromEntries(
      STORAGE_DOCTOR_COMPONENTS.map((component) => [component, 0]),
    ) as Record<StorageDoctorComponent, number>;
    const runtimeSchema = await this.scanRuntime(findings, scanned);
    await this.scanSessions(findings, scanned, runtimeSchema);
    await this.scanOperations(findings, scanned);
    await this.scanFileHistory(findings, scanned);
    await this.scanSummaries(findings, scanned);
    await this.scanArtifacts(findings, scanned);
    findings.sort(compareFindings);
    return {
      scannedAt: this.now().toISOString(),
      healthy: !findings.some(
        (finding) => finding.severity === "error" || finding.severity === "critical",
      ),
      findings,
      scanned,
    };
  }

  async repair(options: StorageDoctorRepairOptions): Promise<StorageDoctorRepairResult> {
    const quarantined: QuarantinedJson[] = [];
    if (options.quarantineMalformedSidecars === true) {
      const report = await this.scan();
      const safeFindings = report.findings.filter(
        (finding) =>
          finding.authority !== "authoritative" &&
          (finding.code === "summary_malformed" || finding.code === "artifact_metadata_malformed"),
      );
      for (const finding of safeFindings) {
        quarantined.push(
          await quarantineCorruptJson(finding.path, {
            component: finding.component,
            findingCode: finding.code,
            reason: finding.message,
          }),
        );
      }
    }

    let rebuiltDerivedProjections = false;
    if (options.rebuildDerivedProjections) {
      await options.rebuildDerivedProjections();
      rebuiltDerivedProjections = true;
    }

    const reconciledOperationIds: string[] = [];
    const needsAttentionOperationIds: string[] = [];
    if (options.reconcileOperations) {
      const journal = new StorageOperationJournal({
        workDir: this.workDir,
        ...(this.picoHome ? { picoHome: this.picoHome } : {}),
        now: this.now,
      });
      for (const operation of await journal.listUnfinished()) {
        let outcome: "forwarded" | "needs_attention";
        try {
          outcome = await options.reconcileOperations.forward(operation, journal);
        } catch {
          outcome = "needs_attention";
        }
        const latest = await journal.get(operation.operationId);
        if (outcome === "forwarded" && latest?.state === "completed") {
          reconciledOperationIds.push(operation.operationId);
          continue;
        }
        if (latest && !isTerminalStorageOperation(latest.state)) {
          await journal.advance({
            operationId: latest.operationId,
            expectedVersion: latest.version,
            nextState: "needs_attention",
            error: {
              phase: latest.state,
              message: "Storage Doctor could not prove that forward reconciliation completed",
            },
          });
        }
        needsAttentionOperationIds.push(operation.operationId);
      }
    }

    return {
      quarantined,
      rebuiltDerivedProjections,
      reconciledOperationIds: reconciledOperationIds.toSorted(),
      needsAttentionOperationIds: needsAttentionOperationIds.toSorted(),
    };
  }

  private async scanSessions(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
    runtimeSchema: RuntimeSchemaPreflightResult,
  ): Promise<void> {
    if (!hasAgentRuntimeTables(runtimeSchema)) return;
    let database: Database.Database;
    try {
      database = new Database(this.runtimeDatabasePath, { readonly: true, fileMustExist: true });
    } catch (error) {
      findings.push(sessionReplayFinding(this.runtimeDatabasePath, error));
      return;
    }
    try {
      const sessions = database
        .prepare(
          `SELECT session_id, work_dir, history_source, created_at, active_branch_id
           FROM agent_sessions
           ORDER BY session_id`,
        )
        .all() as AgentSessionRow[];
      const readEvents = database.prepare(
        `SELECT sequence, session_id, run_id, event_id, kind, at, event_json
         FROM agent_runtime_events
         WHERE session_id = ?
         ORDER BY sequence`,
      );
      for (const manifest of sessions) {
        scanned.session++;
        try {
          assertNonEmptyString(manifest.session_id, "session_id");
          assertNonEmptyString(manifest.work_dir, "work_dir");
          assertNonEmptyString(manifest.created_at, "created_at");
          assertNonEmptyString(manifest.active_branch_id, "active_branch_id");
          if (manifest.history_source !== "runtime-event-v1") {
            throw new Error(
              `session ${manifest.session_id} has unsupported history source ${String(manifest.history_source)}`,
            );
          }
          if (canonicalizeWorkspacePath(manifest.work_dir) !== this.workDir) {
            throw new Error(
              `session ${manifest.session_id} belongs to unexpected workspace ${manifest.work_dir}`,
            );
          }
          const events = (readEvents.all(manifest.session_id) as AgentRuntimeEventRow[]).map(
            (row) => decodeAgentRuntimeEventRow(row, manifest.session_id),
          );
          projectRuntimeSessionState(events);
          projectRuntimeSessionMessages(events);
          materializeRuntimeHistory(events);
        } catch (error) {
          findings.push(sessionReplayFinding(this.runtimeDatabasePath, error));
        }
      }
    } catch (error) {
      findings.push(sessionReplayFinding(this.runtimeDatabasePath, error));
    } finally {
      database.close();
    }
  }

  private async scanRuntime(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<RuntimeSchemaPreflightResult> {
    const schema = preflightRuntimeSchema(this.runtimeDatabasePath);
    if (schema.status === "database_missing") return schema;
    scanned.runtime++;

    switch (schema.status) {
      case "invalid":
        findings.push(
          finding(
            "runtime_schema_invalid",
            "critical",
            "runtime",
            this.runtimeDatabasePath,
            schema.reason,
            "Preserve the database and inspect its schema before any task execution",
            "authoritative",
          ),
        );
        return schema;
      case "future":
        findings.push(
          finding(
            "runtime_schema_unsupported",
            "critical",
            "runtime",
            this.runtimeDatabasePath,
            `runtime.sqlite schema ${schema.schemaVersion} is newer than supported ${RUNTIME_SCHEMA_VERSION}`,
            "Use a pico build that supports this schema; never downgrade the authoritative database in place",
            "authoritative",
          ),
        );
        break;
      case "current_migration_name_mismatch":
        findings.push(
          finding(
            "runtime_schema_migration_mismatch",
            "critical",
            "runtime",
            this.runtimeDatabasePath,
            `runtime.sqlite schema ${schema.schemaVersion} migration ${schema.migrationName} does not match ${schema.expectedMigrationName}`,
            "Use a pico build that recognizes this migration; never rewrite schema_migrations in place",
            "authoritative",
          ),
        );
        break;
      case "outdated":
        findings.push(
          finding(
            "runtime_schema_outdated",
            "warning",
            "runtime",
            this.runtimeDatabasePath,
            `runtime.sqlite schema ${schema.schemaVersion} requires migration to ${RUNTIME_SCHEMA_VERSION}`,
            "Open it once with the current RuntimeStore to run the forward-only migration",
            "authoritative",
          ),
        );
        break;
      case "current":
      case "schema_migrations_missing":
        break;
    }

    if (schema.tables.agentSessions !== schema.tables.agentRuntimeEvents) {
      findings.push(
        finding(
          "runtime_schema_missing",
          "critical",
          "runtime",
          this.runtimeDatabasePath,
          "runtime.sqlite contains only part of the Agent runtime event schema",
          "Keep the database unchanged and restore or migrate it with a compatible pico build",
          "authoritative",
        ),
      );
    }

    let database: Database.Database | undefined;
    try {
      database = new Database(this.runtimeDatabasePath, { readonly: true, fileMustExist: true });
      const quick = database.pragma("quick_check") as Array<Record<string, unknown>>;
      const integrity = database.pragma("integrity_check") as Array<Record<string, unknown>>;
      const foreignKeys = database.pragma("foreign_key_check") as Array<Record<string, unknown>>;
      if (!pragmaReportsOk(quick) || !pragmaReportsOk(integrity)) {
        findings.push(
          finding(
            "runtime_integrity_failed",
            "critical",
            "runtime",
            this.runtimeDatabasePath,
            `quick_check=${JSON.stringify(quick)} integrity_check=${JSON.stringify(integrity)}`,
            "Stop task execution and restore runtime.sqlite from a known-good backup",
            "authoritative",
          ),
        );
      }
      if (foreignKeys.length > 0) {
        findings.push(
          finding(
            "runtime_foreign_key_failed",
            "critical",
            "runtime",
            this.runtimeDatabasePath,
            `${foreignKeys.length} foreign-key violation(s)`,
            "Do not delete rows automatically; inspect the affected job/attempt records",
            "authoritative",
          ),
        );
      }
    } catch (error) {
      findings.push(
        finding(
          "runtime_open_failed",
          "critical",
          "runtime",
          this.runtimeDatabasePath,
          errorMessage(error),
          "Stop task execution and inspect or restore runtime.sqlite",
          "authoritative",
        ),
      );
    } finally {
      database?.close();
    }
    return schema;
  }

  private async scanOperations(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const journal = new StorageOperationJournal({
      workDir: this.workDir,
      ...(this.picoHome ? { picoHome: this.picoHome } : {}),
      now: this.now,
    });
    for (const entry of await readDirectoryEntries(journal.directory)) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const path = join(journal.directory, entry.name);
      scanned.operation++;
      const operationId = entry.name.slice(0, -5);
      try {
        if (!SAFE_OPERATION_ID_RE.test(operationId)) throw new Error("invalid operation filename");
        const operation = await journal.get(operationId);
        if (!operation) throw new Error("operation disappeared during scan");
        if (operation.state === "needs_attention") {
          findings.push(
            finding(
              "operation_needs_attention",
              "error",
              "operation",
              path,
              `Operation ${operation.operationId} v${operation.version} needs attention at ${operation.error?.phase ?? "unknown phase"}: ${operation.error?.message ?? "no failure reason was recorded"}`,
              `Inspect with /operations show ${operation.operationId}; then use /operations retry ${operation.operationId} ${operation.version} or /operations abort ${operation.operationId} ${operation.version}`,
              "authoritative",
            ),
          );
        } else if (!isTerminalStorageOperation(operation.state)) {
          findings.push(
            finding(
              "operation_unfinished",
              "warning",
              "operation",
              path,
              `Operation ${operation.operationId} is ${operation.state}`,
              "Run explicit repair with an operation-specific idempotent forward coordinator",
              "authoritative",
            ),
          );
        }
      } catch (error) {
        findings.push(
          finding(
            "operation_malformed",
            "critical",
            "operation",
            path,
            errorMessage(error),
            "Do not quarantine automatically; preserve the journal for manual intent recovery",
            "authoritative",
          ),
        );
      }
    }
  }

  private async scanFileHistory(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const blobStore = new FileHistoryBlobStore({ baseDir: this.fileHistoryDir });
    for (const entry of await readDirectoryEntries(this.fileHistoryDir)) {
      if (!entry.isDirectory() || entry.name === "blobs" || entry.name === ".leases") continue;
      const path = join(this.fileHistoryDir, entry.name, "manifest.json");
      if (!(await pathExists(path))) continue;
      scanned.file_history++;
      try {
        const value = parseJson(await readFile(path, "utf8"), "File History manifest");
        if (
          isRecord(value) &&
          value["schemaVersion"] === undefined &&
          Array.isArray(value["snapshots"]) &&
          Array.isArray(value["trackedFiles"])
        ) {
          findings.push(
            finding(
              "file_history_legacy",
              "warning",
              "file_history",
              path,
              "File History still uses the supported legacy manifest",
              "Let the owning Session migrate it to v2 on its next explicit write",
              "authoritative",
            ),
          );
          continue;
        }
        if (
          !isRecord(value) ||
          value["schemaVersion"] !== 2 ||
          typeof value["sessionId"] !== "string"
        ) {
          throw new Error("manifest is not v2");
        }
        const expectedDirectory = createHash("sha256")
          .update(value["sessionId"])
          .digest("hex")
          .slice(0, 32);
        if (entry.name !== expectedDirectory) {
          throw new Error("manifest directory/sessionId mismatch");
        }
        const state = createFileHistoryState();
        if (!(await fileHistoryLoadState(state, value["sessionId"], this.fileHistoryDir))) {
          throw new Error("manifest disappeared during scan");
        }
        for (const snapshot of state.snapshots) {
          for (const backup of snapshot.trackedFileBackups.values()) {
            if (backup.backupFileName !== null && !backup.blobRef) {
              throw new Error("File History v2 backup is missing its blob reference");
            }
            if (backup.blobRef) await blobStore.read(backup.blobRef);
          }
        }
      } catch (error) {
        findings.push(
          finding(
            "file_history_integrity_failed",
            "critical",
            "file_history",
            path,
            errorMessage(error),
            "Keep the manifest and blobs unchanged; recover from a verified manifest revision",
            "authoritative",
          ),
        );
      }
    }
  }

  private async scanSummaries(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    for (const entry of await readDirectoryEntries(this.summariesDir)) {
      if (!entry.isFile() || !/^[a-f0-9]{64}\.json$/u.test(entry.name)) continue;
      const path = join(this.summariesDir, entry.name);
      scanned.summary++;
      try {
        parseSummaryV2(parseJson(await readFile(path, "utf8"), "summary"), entry.name);
      } catch (error) {
        findings.push(
          finding(
            "summary_malformed",
            "error",
            "summary",
            path,
            errorMessage(error),
            "Quarantine this derived sidecar and rebuild it from the RuntimeEvent ledger",
            "derived",
          ),
        );
      }
    }
  }

  private async scanArtifacts(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const sessionsDirectory = join(this.artifactsDir, "sessions");
    for (const sessionEntry of await readDirectoryEntries(sessionsDirectory)) {
      if (!sessionEntry.isDirectory()) continue;
      const artifactDirectory = join(sessionsDirectory, sessionEntry.name, "tool-results");
      const entries = await readDirectoryEntries(artifactDirectory);
      const markers = new Set(
        entries
          .filter((entry) => entry.isFile() && isInspectableJsonSidecar(entry.name))
          .map((entry) => entry.name.slice(0, -5)),
      );
      for (const entry of entries) {
        const path = join(artifactDirectory, entry.name);
        if (entry.isFile() && entry.name.endsWith(".txt")) {
          const id = entry.name.slice(0, -4);
          if (!markers.has(id)) {
            findings.push(
              finding(
                "artifact_missing_commit_marker",
                "warning",
                "artifact",
                path,
                "Artifact content has no v2 metadata commit marker",
                "Retain for grace-period recovery or explicitly quarantine as uncommitted content",
                "sidecar",
              ),
            );
          }
          continue;
        }
        if (!entry.isFile() || !isInspectableJsonSidecar(entry.name)) continue;
        scanned.artifact++;
        try {
          const value = parseArtifactMetaV2(
            parseJson(await readFile(path, "utf8"), "artifact metadata"),
            sessionEntry.name,
            entry.name,
          );
          const contentPath = join(artifactDirectory, `${value.id}.txt`);
          if (value.availability === "available") {
            const contents = await readFile(contentPath);
            if (contents.byteLength !== value.sizeBytes) throw new Error("artifact size mismatch");
            if (createHash("sha256").update(contents).digest("hex") !== value.contentHash) {
              throw new Error("artifact content hash mismatch");
            }
          }
        } catch (error) {
          findings.push(
            finding(
              "artifact_metadata_malformed",
              "error",
              "artifact",
              path,
              errorMessage(error),
              "Quarantine the bad metadata marker; do not modify the RuntimeEvent ledger",
              "sidecar",
            ),
          );
        }
      }
    }
  }
}

function parseSummaryV2(value: unknown, fileName: string): void {
  if (!isRecord(value) || value["schemaVersion"] !== 2 || typeof value["sessionId"] !== "string") {
    throw new Error("invalid summary v2 header");
  }
  const expectedName = `${createHash("sha256").update(value["sessionId"]).digest("hex")}.json`;
  if (fileName !== expectedName) throw new Error("summary filename/sessionId mismatch");
  const summary = value["summary"];
  if (
    !isRecord(summary) ||
    summary["sessionId"] !== value["sessionId"] ||
    typeof summary["summary"] !== "string" ||
    !isNonNegativeInteger(summary["messageCount"]) ||
    typeof summary["createdAt"] !== "string" ||
    typeof summary["updatedAt"] !== "string"
  ) {
    throw new Error("invalid summary v2 payload");
  }
  const basis = summary["basis"];
  if (
    !isRecord(basis) ||
    basis["messageCount"] !== summary["messageCount"] ||
    !(basis["throughEventId"] === null || typeof basis["throughEventId"] === "string") ||
    !(
      basis["prefixDigest"] === null ||
      (typeof basis["prefixDigest"] === "string" && SHA256_RE.test(basis["prefixDigest"]))
    )
  ) {
    throw new Error("invalid summary v2 basis");
  }
}

interface ParsedArtifactMeta {
  readonly id: string;
  readonly sizeBytes: number;
  readonly contentHash: string;
  readonly availability: "available" | "evicted";
}

function hasAgentRuntimeTables(schema: RuntimeSchemaPreflightResult): boolean {
  return "tables" in schema && schema.tables.agentSessions && schema.tables.agentRuntimeEvents;
}

function decodeAgentRuntimeEventRow(
  row: AgentRuntimeEventRow,
  expectedSessionId: string,
): RuntimeEvent {
  if (!isNonNegativeInteger(row.sequence) || row.sequence < 1) {
    throw new Error(`Runtime event row has invalid sequence ${String(row.sequence)}`);
  }
  for (const [field, value] of [
    ["session_id", row.session_id],
    ["run_id", row.run_id],
    ["event_id", row.event_id],
    ["kind", row.kind],
    ["at", row.at],
    ["event_json", row.event_json],
  ] as const) {
    assertNonEmptyString(value, `agent_runtime_events.${field}`);
  }

  const event = decodeRuntimeEventJson(row.event_json);
  const mismatches: string[] = [];
  if (row.session_id !== expectedSessionId) mismatches.push("row.session_id/session_id");
  if (event.sessionId !== row.session_id) mismatches.push("event.sessionId/row.session_id");
  if (event.runId !== row.run_id) mismatches.push("event.runId/row.run_id");
  if (event.eventId !== row.event_id) mismatches.push("event.eventId/row.event_id");
  if (event.kind !== row.kind) mismatches.push("event.kind/row.kind");
  if (event.at !== row.at) mismatches.push("event.at/row.at");
  if (mismatches.length > 0) {
    throw new Error(
      `Runtime event ${row.event_id} row identity mismatch: ${mismatches.join(", ")}`,
    );
  }
  return event;
}

function sessionReplayFinding(path: string, error: unknown): StorageDoctorFinding {
  return finding(
    "session_replay_failed",
    "critical",
    "session",
    path,
    errorMessage(error),
    "Keep runtime.sqlite unchanged and restore it from a verified backup",
    "authoritative",
  );
}

function parseArtifactMetaV2(
  value: unknown,
  safeSessionId: string,
  fileName: string,
): ParsedArtifactMeta {
  if (!isRecord(value) || value["schemaVersion"] !== 2) throw new Error("artifact is not v2");
  if (
    typeof value["id"] !== "string" ||
    fileName !== `${value["id"]}.json` ||
    value["safeSessionId"] !== safeSessionId ||
    !isNonNegativeInteger(value["sizeBytes"]) ||
    typeof value["contentHash"] !== "string" ||
    !SHA256_RE.test(value["contentHash"]) ||
    (value["availability"] !== "available" && value["availability"] !== "evicted")
  ) {
    throw new Error("invalid artifact v2 metadata");
  }
  return {
    id: value["id"],
    sizeBytes: value["sizeBytes"],
    contentHash: value["contentHash"],
    availability: value["availability"],
  };
}

function finding(
  code: string,
  severity: StorageDoctorSeverity,
  component: StorageDoctorComponent,
  path: string,
  message: string,
  recommendation: string,
  authority: StorageDoctorFinding["authority"],
): StorageDoctorFinding {
  return { code, severity, component, path, message, recommendation, authority };
}

function compareFindings(left: StorageDoctorFinding, right: StorageDoctorFinding): number {
  return (
    STORAGE_DOCTOR_SEVERITIES.indexOf(right.severity) -
      STORAGE_DOCTOR_SEVERITIES.indexOf(left.severity) ||
    left.component.localeCompare(right.component) ||
    left.path.localeCompare(right.path) ||
    left.code.localeCompare(right.code)
  );
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label}: ${errorMessage(error)}`, { cause: error });
  }
}

function pragmaReportsOk(rows: readonly Record<string, unknown>[]): boolean {
  return (
    rows.length === 1 &&
    Object.values(rows[0] ?? {}).length === 1 &&
    Object.values(rows[0] ?? {})[0] === "ok"
  );
}

async function readDirectoryEntries(path: string) {
  try {
    return await readdir(path, { withFileTypes: true });
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return [];
    throw error;
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return false;
    throw error;
  }
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function assertNonEmptyString(value: unknown, field: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function isInspectableJsonSidecar(name: string): boolean {
  return name.endsWith(".json") && !name.startsWith(".") && !name.includes(".corrupt.");
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
