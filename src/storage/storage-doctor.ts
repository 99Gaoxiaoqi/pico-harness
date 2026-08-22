import { existsSync, type Stats } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { RuntimeProjectionService } from "../engine/runtime-projection-service.js";
import { createFileHistoryState, fileHistoryLoadState } from "../safety/file-history.js";
import { FileHistoryBlobStore } from "./file-history-blob-store.js";
import {
  isTerminalStorageOperation,
  StorageOperationJournal,
  type StorageOperation,
} from "./operation-journal.js";
import { canonicalizeWorkspacePath, resolvePicoPaths } from "../paths/pico-paths.js";
import type { WorkspaceId } from "../paths/pico-paths.js";
import { SqliteRuntimeEventStore } from "./sqlite/sqlite-runtime-event-store.js";
import type { RuntimeSessionManifest } from "./runtime-event-store-contracts.js";
import { SqliteTaskRunStore } from "./sqlite/sqlite-task-run-store.js";
import {
  operationalDatabasePath,
  openOperationalDatabaseReadOnly,
} from "./sqlite/sqlite-database.js";
import { assertCurrentOperationalTargetSchemaSync } from "./sqlite/sqlite-schema.js";
import { ALL_WORKSPACE_SQLITE_SCOPES } from "./sqlite/workspace-scopes.js";
import { withWorkspaceBindingScope } from "./sqlite/sqlite-workspace-storage.js";
import { listFileHistorySessionIds } from "./sqlite/file-history-manifest-store.js";
import { readWorkspaceSqliteStorageRootIdentitySync } from "./sqlite/sqlite-workspace-storage.js";
import type { WorkspaceStorageRootIdentity } from "./sqlite/sqlite-workspace-storage.js";

/**
 * SQLite 纪元的跨持久层只读诊断器(票 09 重写,ADR 24 §5/M6)。
 *
 * scan = PRAGMA 一致性(integrity_check/foreign_key_check)+ workspace binding
 * 身份校验 + 各 scope 行扫描(sessions 投影重放、task_runs 巡检、memory
 * workspaceId 绑定、operations journal、file-history manifest+blob 对账)。
 * JSONL 纪元的锁仪式、commit.json WAL 与 manifest.json 投影重建已随旧存储面
 * 退役;旧布局(.storage/sessions/task-runs/control/memory/storage-operations/
 * todo.json)按 legacy 残留报告——SQLite 纪元不迁移历史,pico.sqlite 是当前
 * 唯一事实载体。scan 从不修复/删除权威数据,也不为扫描初始化新库。
 */

const LEGACY_LOCK_TOMBSTONE_RE = /^\.lock\.tombstone-[a-f0-9]{64}$/u;
const LEGACY_LOCK_CANDIDATE_RE =
  /^\.lock\.candidate-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

/** v2 JSONL 纪元的 canonical 目录与协调器:出现任意一个即为旧纪元残留。 */
const LEGACY_SESSION_CENTRIC_ENTRIES = [
  ".storage",
  "sessions",
  "task-runs",
  "control",
  "memory",
  "storage-operations",
  "todo.json",
] as const;

export const STORAGE_DOCTOR_SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type StorageDoctorSeverity = (typeof STORAGE_DOCTOR_SEVERITIES)[number];

export const STORAGE_DOCTOR_COMPONENTS = [
  "session",
  "runtime",
  "task",
  "memory",
  "operation",
  "file_history",
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
  /** Canonical workspace state root; retained name preserves the diagnostic API. */
  readonly runtimeStorageRoot?: string;
  readonly now?: () => Date;
}

export interface StorageDoctorRepairOptions {
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
  readonly rebuiltDerivedProjections: boolean;
  readonly reconciledOperationIds: readonly string[];
  readonly needsAttentionOperationIds: readonly string[];
}

export class StorageDoctor {
  private readonly workDir: string;
  private readonly picoHome?: string;
  private readonly fileHistoryDir: string;
  private readonly runtimeStorageRoot: string;
  private readonly workspaceId: WorkspaceId;
  private readonly legacyStoragePaths: readonly string[];
  private readonly legacyJsonRuntimePath: string;
  private readonly legacyTasksPath: string;
  private readonly now: () => Date;

  constructor(options: StorageDoctorOptions) {
    this.workDir = canonicalizeWorkspacePath(options.workDir);
    this.picoHome = options.picoHome;
    const paths = resolvePicoPaths(this.workDir, {
      ...(this.picoHome ? { picoHome: this.picoHome } : {}),
    });
    this.fileHistoryDir = resolve(options.fileHistoryDir ?? join(paths.home.root, "file-history"));
    this.runtimeStorageRoot = resolve(options.runtimeStorageRoot ?? paths.workspace.root);
    this.workspaceId = paths.workspace.id;
    this.legacyStoragePaths = [
      ...["", "-wal", "-shm"].map((suffix) =>
        resolve(paths.workspace.root, `runtime.sqlite${suffix}`),
      ),
      ...["", "-wal", "-shm"].map((suffix) =>
        resolve(paths.workspace.root, `memory.sqlite${suffix}`),
      ),
    ];
    this.legacyJsonRuntimePath = resolve(paths.workspace.root, "runtime");
    this.legacyTasksPath = resolve(paths.workspace.root, "tasks");
    this.now = options.now ?? (() => new Date());
  }

  async scan(): Promise<StorageDoctorReport> {
    const findings: StorageDoctorFinding[] = [];
    const scanned = Object.fromEntries(
      STORAGE_DOCTOR_COMPONENTS.map((component) => [component, 0]),
    ) as Record<StorageDoctorComponent, number>;
    await this.scanLegacyStorage(findings);
    const runtimeRootMetadata = await lstatIfExists(this.runtimeStorageRoot);
    if (runtimeRootMetadata) {
      if (!isRealDirectory(runtimeRootMetadata)) {
        findings.push(
          invalidStorageDirectoryFinding(this.runtimeStorageRoot, "runtime", runtimeRootMetadata),
        );
      } else {
        if (process.platform !== "win32" && (runtimeRootMetadata.mode & 0o777) !== 0o700) {
          findings.push(
            finding(
              "storage_permissions_invalid",
              "error",
              "runtime",
              this.runtimeStorageRoot,
              `Expected 700, found mode ${(runtimeRootMetadata.mode & 0o777).toString(8)}`,
              "Restrict the workspace storage root to 0700 before opening this storage",
              "authoritative",
            ),
          );
        }
        await this.scanRuntimeDatabase(findings, scanned);
      }
    }
    await this.scanOperations(findings, scanned);
    await this.scanFileHistory(findings, scanned);
    findings.sort(compareFindings);
    return {
      scannedAt: this.now().toISOString(),
      healthy: !findings.some((item) => item.severity === "error" || item.severity === "critical"),
      findings,
      scanned,
    };
  }

  async repair(options: StorageDoctorRepairOptions): Promise<StorageDoctorRepairResult> {
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
      rebuiltDerivedProjections,
      reconciledOperationIds: reconciledOperationIds.toSorted(),
      needsAttentionOperationIds: needsAttentionOperationIds.toSorted(),
    };
  }

  /**
   * pico.sqlite 是当前纪元的唯一事实载体:PRAGMA 一致性 + binding 身份 +
   * 私有模式。库不存在(空工作区)时无行可扫,不得为扫描初始化新库。
   */
  private async scanRuntimeDatabase(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    if (!existsSync(operationalDatabasePath(this.runtimeStorageRoot))) return;
    scanned.runtime++;
    const databasePath = operationalDatabasePath(this.runtimeStorageRoot);
    await this.scanPrivateModes(
      this.runtimeStorageRoot,
      "runtime",
      findings,
      new Set(["evidence", "traces", "fork-staging", "agent-recovery-launch-intents"]),
    );

    let database: ReturnType<typeof openOperationalDatabaseReadOnly> | undefined;
    try {
      database = openOperationalDatabaseReadOnly(this.runtimeStorageRoot);
      // 形状断言的家在 doctor:连接重开不再逐次校验(性能),手工改库的
      // 结构漂移在此处检出。
      try {
        assertCurrentOperationalTargetSchemaSync(
          database,
          withWorkspaceBindingScope(ALL_WORKSPACE_SQLITE_SCOPES),
        );
      } catch (error) {
        findings.push(
          finding(
            "runtime_schema_drift",
            "critical",
            "runtime",
            databasePath,
            errorMessage(error),
            "Preserve pico.sqlite unchanged; restore from a verified backup or rebuild the workspace",
            "authoritative",
          ),
        );
      }
      const integrity = database.prepare("PRAGMA integrity_check").all() as unknown[];
      const integrityMessages = integrity
        .map((row) => Object.values(row as Record<string, unknown>)[0])
        .filter((value): value is string => typeof value === "string" && value !== "ok");
      if (integrityMessages.length > 0) {
        findings.push(
          finding(
            "runtime_integrity_check_failed",
            "critical",
            "runtime",
            databasePath,
            integrityMessages.join("; "),
            "Preserve pico.sqlite unchanged and restore the workspace from a verified backup",
            "authoritative",
          ),
        );
      }
      const foreignKeys = database.prepare("PRAGMA foreign_key_check").all() as unknown[];
      if (foreignKeys.length > 0) {
        findings.push(
          finding(
            "runtime_foreign_key_violation",
            "critical",
            "runtime",
            databasePath,
            `${foreignKeys.length} foreign key violation(s): ${safeJson(foreignKeys.slice(0, 5))}`,
            "Preserve pico.sqlite unchanged and restore the workspace from a verified backup",
            "authoritative",
          ),
        );
      }
    } catch (error) {
      findings.push(
        finding(
          "runtime_database_unreadable",
          "critical",
          "runtime",
          databasePath,
          errorMessage(error),
          "Preserve pico.sqlite unchanged; verify file permissions and Node/SQLite availability before retrying",
          "authoritative",
        ),
      );
      return;
    } finally {
      database?.close();
    }

    let rootIdentity: WorkspaceStorageRootIdentity | undefined;
    try {
      rootIdentity = readWorkspaceSqliteStorageRootIdentitySync(this.runtimeStorageRoot);
    } catch (error) {
      findings.push(
        finding(
          "runtime_root_identity_invalid",
          "critical",
          "runtime",
          databasePath,
          errorMessage(error),
          "Preserve the root and use explicit storage adoption only after verifying its origin",
          "authoritative",
        ),
      );
      return;
    }
    if (!rootIdentity) {
      findings.push(
        finding(
          "runtime_workspace_binding_missing",
          "critical",
          "runtime",
          databasePath,
          "pico.sqlite exists without a workspace_storage_binding row",
          "Preserve the database and re-initialize the workspace only after verifying its origin",
          "authoritative",
        ),
      );
      return;
    }

    // 混合状态(pico.sqlite + 旧 JSONL/pre-v2 标记):store 构造器会 fail-closed
    // 拒开,scope 行扫描无法进行——legacy 残留已由 scanLegacyStorage 报告,
    // 这里不再叠加误导性 finding。
    if (this.hasLegacyStorageMarkers()) return;

    this.scanMemoryBinding(findings, scanned);
    await this.scanSessions(findings, scanned);
    await this.scanTaskRuns(findings, scanned);
  }

  private hasLegacyStorageMarkers(): boolean {
    return LEGACY_SESSION_CENTRIC_ENTRIES.some((marker) =>
      existsSync(join(this.runtimeStorageRoot, marker)),
    );
  }

  private scanMemoryBinding(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): void {
    const databasePath = operationalDatabasePath(this.runtimeStorageRoot);
    let workspaceId: string | undefined;
    try {
      const database = openOperationalDatabaseReadOnly(this.runtimeStorageRoot);
      try {
        const row = database
          .prepare("SELECT value_json FROM memory_metadata WHERE key = 'workspaceId'")
          .get() as { value_json?: unknown } | undefined;
        if (typeof row?.["value_json"] === "string") {
          const decoded = JSON.parse(row["value_json"]) as unknown;
          if (typeof decoded === "string") workspaceId = decoded;
        }
      } finally {
        database.close();
      }
    } catch (error) {
      // memory scope 未迁移(schema 版本落后)时只报告,不阻断其余扫描。
      findings.push(
        finding(
          "memory_scope_unreadable",
          "error",
          "memory",
          databasePath,
          errorMessage(error),
          "Open the workspace with the current pico build to migrate the memory schema, then re-run the doctor",
          "authoritative",
        ),
      );
      return;
    }
    if (workspaceId === undefined) return;
    scanned.memory++;
    if (workspaceId !== this.workspaceId) {
      findings.push(
        finding(
          "memory_workspace_mismatch",
          "critical",
          "memory",
          databasePath,
          `Memory storage is bound to workspace ${workspaceId}, but this doctor scanned ${this.workspaceId}`,
          "Preserve the database; memory facts are workspace-private and must not be read across workspaces",
          "authoritative",
        ),
      );
    }
  }

  private async scanSessions(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const databasePath = operationalDatabasePath(this.runtimeStorageRoot);
    let store: SqliteRuntimeEventStore;
    try {
      store = new SqliteRuntimeEventStore({ storageRoot: this.runtimeStorageRoot });
    } catch (error) {
      // 混合状态(旧 JSONL 标记 + pico.sqlite)会让 prepare fail-closed 拒开。
      findings.push(sessionReplayFinding(databasePath, error));
      return;
    }
    try {
      const projectionService = new RuntimeProjectionService(store);
      let manifests: readonly RuntimeSessionManifest[];
      try {
        manifests = await store.listSessionManifests();
      } catch (error) {
        findings.push(sessionReplayFinding(databasePath, error));
        return;
      }

      for (const manifest of manifests) {
        scanned.session++;
        try {
          if (canonicalizeWorkspacePath(manifest.workDir) !== this.workDir) {
            throw new Error(
              `session ${manifest.sessionId} belongs to unexpected workspace ${manifest.workDir}`,
            );
          }
          // 统一投影入口验证:重算 state / raw messages / checkpoint 视图,
          // 任一投影 fail-closed 抛出都会被记录为 session replay 异常。
          await projectionService.getState(manifest.sessionId);
          await projectionService.getMessages(manifest.sessionId, { checkpoint: false });
          await projectionService.getMessages(manifest.sessionId);
        } catch (error) {
          findings.push(sessionReplayFinding(databasePath, error));
        }
      }
    } finally {
      store.close();
    }
  }

  private async scanTaskRuns(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const databasePath = operationalDatabasePath(this.runtimeStorageRoot);
    let store: SqliteTaskRunStore;
    try {
      store = new SqliteTaskRunStore({ storageRoot: this.runtimeStorageRoot });
    } catch (error) {
      findings.push(
        finding(
          "task_run_ledger_invalid",
          "critical",
          "task",
          databasePath,
          errorMessage(error),
          "Preserve pico.sqlite unchanged and recover the workspace from a verified backup",
          "authoritative",
        ),
      );
      return;
    }
    try {
      const inspection = await store.inspectTaskRuns();
      scanned.task += inspection.projections.length;
      for (const mismatch of inspection.storageRootMismatches) {
        findings.push(
          finding(
            "task_run_storage_root_mismatch",
            "error",
            "task",
            databasePath,
            `TaskRun ${mismatch.taskRunId} belongs to storage root ${mismatch.taskRunStorageRootId}, not ${mismatch.currentStorageRootId}`,
            "Preserve the database and explicitly import the TaskRun into this workspace before recovery",
            "authoritative",
          ),
        );
      }
    } catch (error) {
      findings.push(
        finding(
          "task_run_ledger_invalid",
          "critical",
          "task",
          databasePath,
          errorMessage(error),
          "Preserve pico.sqlite unchanged and recover the workspace from a verified backup",
          "authoritative",
        ),
      );
    } finally {
      store.close();
    }
  }

  private async scanOperations(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    // journal 是 pico.sqlite 的 storage_operations 行;库不存在时无行可扫,
    // 不得为扫描而初始化新库。混合状态(legacy 标记)下 prepare 拒开,由
    // legacy finding 说明,这里不叠加误导性 operation finding。
    if (!existsSync(operationalDatabasePath(this.runtimeStorageRoot))) return;
    if (this.hasLegacyStorageMarkers()) return;
    const journal = new StorageOperationJournal({
      workDir: this.workDir,
      ...(this.picoHome ? { picoHome: this.picoHome } : {}),
      now: this.now,
    });
    // 畸形行由 journal.list() fail-closed 抛错,进入 operation_malformed 分支。
    let operations: StorageOperation[];
    try {
      operations = await journal.list();
    } catch (error) {
      findings.push(
        finding(
          "operation_malformed",
          "critical",
          "operation",
          operationalDatabasePath(this.runtimeStorageRoot),
          errorMessage(error),
          "Do not quarantine automatically; preserve the journal for manual intent recovery",
          "authoritative",
        ),
      );
      return;
    }
    for (const operation of operations) {
      scanned.operation++;
      const path = operationalDatabasePath(this.runtimeStorageRoot);
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
    }
  }

  private async scanFileHistory(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    // manifest 行在本 workspace 的 pico.sqlite;库不存在时无行可扫(不初始化
    // 新库)。PICO_HOME 侧只保留 blob CAS 与 legacy 备份文件。混合状态下
    // prepare 拒开,同 scanOperations。
    if (!existsSync(operationalDatabasePath(this.runtimeStorageRoot))) return;
    if (this.hasLegacyStorageMarkers()) return;
    const blobStore = new FileHistoryBlobStore({ baseDir: this.fileHistoryDir });
    const io = { baseDir: this.fileHistoryDir, storageRoot: this.runtimeStorageRoot };
    let sessionIds: readonly string[];
    try {
      sessionIds = listFileHistorySessionIds(this.runtimeStorageRoot);
    } catch (error) {
      findings.push(
        finding(
          "file_history_integrity_failed",
          "critical",
          "file_history",
          operationalDatabasePath(this.runtimeStorageRoot),
          errorMessage(error),
          "Keep the manifest and blobs unchanged; recover from a verified manifest revision",
          "authoritative",
        ),
      );
      return;
    }
    for (const sessionId of sessionIds) {
      scanned.file_history++;
      const path = operationalDatabasePath(this.runtimeStorageRoot);
      try {
        const state = createFileHistoryState();
        if (!(await fileHistoryLoadState(state, sessionId, io))) {
          throw new Error("manifest row disappeared during scan");
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

  private async scanLegacyStorage(findings: StorageDoctorFinding[]): Promise<void> {
    for (const path of this.legacyStoragePaths) {
      if (!(await pathExists(path))) continue;
      findings.push(
        finding(
          path.endsWith("runtime.sqlite")
            ? "legacy_runtime_sqlite_ignored"
            : "legacy_sqlite_file_ignored",
          "warning",
          "runtime",
          path,
          `Legacy SQLite file ${path} exists but is not read by the file storage backend`,
          "Keep it as a manual rollback artifact or remove it only after explicit backup approval",
          "sidecar",
        ),
      );
    }
    for (const marker of LEGACY_SESSION_CENTRIC_ENTRIES) {
      const path = join(this.runtimeStorageRoot, marker);
      if (!(await pathExists(path))) continue;
      findings.push(
        finding(
          "legacy_session_centric_storage_present",
          "warning",
          "runtime",
          path,
          `Legacy session-centric (JSONL) storage entry ${marker} exists; the SQLite era does not migrate history`,
          "Move the legacy state away (or back it up) before initializing this workspace for pico.sqlite",
          "sidecar",
        ),
      );
    }
    const legacyRuntimeEntries = await readDirectoryEntries(this.legacyJsonRuntimePath);
    if (
      legacyRuntimeEntries.some(
        (entry) =>
          entry.name !== "lock" &&
          !LEGACY_LOCK_TOMBSTONE_RE.test(entry.name) &&
          !LEGACY_LOCK_CANDIDATE_RE.test(entry.name),
      )
    ) {
      findings.push(
        finding(
          "legacy_runtime_json_unsupported",
          "critical",
          "runtime",
          this.legacyJsonRuntimePath,
          "Pre-v2 Runtime JSON exists, but current stores do not read, migrate, or rewrite it",
          "Back it up for manual inspection or delete it before initializing fresh Runtime state",
          "authoritative",
        ),
      );
    }
    const legacyTaskEntries = await readDirectoryEntries(this.legacyTasksPath);
    if (legacyTaskEntries.length > 0) {
      findings.push(
        finding(
          "legacy_task_storage_ignored",
          "warning",
          "runtime",
          this.legacyTasksPath,
          "Legacy task files exist but are not read by the RuntimeStore",
          "Keep them unchanged for manual inspection; no automatic import or deletion is performed",
          "sidecar",
        ),
      );
    }
  }

  /**
   * 只巡查当前纪元仍存活的文件面(pico.sqlite、evidence/traces/fork-staging、
   * agent-recovery intents);legacy 目录已由 scanLegacyStorage 报告,不重复噪声。
   */
  private async scanPrivateModes(
    root: string,
    component: Extract<StorageDoctorComponent, "runtime" | "memory">,
    findings: StorageDoctorFinding[],
    allowedRootEntries: ReadonlySet<string>,
  ): Promise<void> {
    if (process.platform === "win32") return;
    const databasePath = join(root, "pico.sqlite");
    if (existsSync(databasePath)) {
      await this.assertPrivateNode(databasePath, component, findings);
    }
    for (const entry of allowedRootEntries) {
      const path = join(root, entry);
      if (!(await pathExists(path))) continue;
      await this.assertPrivateNode(path, component, findings);
    }
  }

  private async assertPrivateNode(
    path: string,
    component: Extract<StorageDoctorComponent, "runtime" | "memory">,
    findings: StorageDoctorFinding[],
  ): Promise<void> {
    let metadata;
    try {
      metadata = await lstat(path);
    } catch (error) {
      findings.push(
        finding(
          "storage_permissions_unreadable",
          "error",
          component,
          path,
          errorMessage(error),
          "Restore private ownership and permissions before opening this storage",
          "authoritative",
        ),
      );
      return;
    }
    if (metadata.isSymbolicLink()) {
      findings.push(
        finding(
          "storage_symlink_rejected",
          "critical",
          component,
          path,
          "Storage data must not be reached through a symbolic link",
          "Move the data to a private local directory and preserve this path for inspection",
          "authoritative",
        ),
      );
      return;
    }
    const expectedMode = metadata.isDirectory() ? 0o700 : metadata.isFile() ? 0o600 : undefined;
    if (expectedMode === undefined || (metadata.mode & 0o777) !== expectedMode) {
      findings.push(
        finding(
          "storage_permissions_invalid",
          "error",
          component,
          path,
          `Expected ${expectedMode?.toString(8) ?? "a regular file/directory"}, found mode ${(metadata.mode & 0o777).toString(8)}`,
          "Restrict directories to 0700 and data files to 0600 before opening this storage",
          "authoritative",
        ),
      );
    }
  }
}

function sessionReplayFinding(path: string, error: unknown): StorageDoctorFinding {
  return finding(
    "session_replay_failed",
    "critical",
    "session",
    path,
    errorMessage(error),
    "Keep pico.sqlite unchanged and restore the workspace from a verified backup",
    "authoritative",
  );
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

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
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

async function lstatIfExists(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (error) {
    if (isNodeCode(error, "ENOENT")) return undefined;
    throw error;
  }
}

function isRealDirectory(metadata: Stats): boolean {
  return metadata.isDirectory() && !metadata.isSymbolicLink();
}

function invalidStorageDirectoryFinding(
  path: string,
  component: Extract<StorageDoctorComponent, "runtime" | "memory">,
  metadata: Stats,
): StorageDoctorFinding {
  return finding(
    metadata.isSymbolicLink() ? "storage_symlink_rejected" : "storage_root_invalid",
    "critical",
    component,
    path,
    metadata.isSymbolicLink()
      ? "Storage data must not be reached through a symbolic link"
      : "Storage root must be a real directory",
    "Move the data to a private real directory and preserve this path for inspection",
    "authoritative",
  );
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
