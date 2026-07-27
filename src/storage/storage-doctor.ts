import { createHash } from "node:crypto";
import type { Stats } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
import type { WorkspaceId } from "../paths/pico-paths.js";
import { decodeMemoryFileState } from "../memory/memory-file-state.js";
import {
  decodeRuntimeControlState,
  decodeRuntimeEvents,
  decodeUsageLedger,
} from "../tasks/runtime-store.js";
import { TaskRunStore } from "../tasks/task-run-store.js";
import {
  decodeRuntimeSessionManifestProjection,
  RuntimeEventStore,
} from "./runtime-event-store.js";
import {
  inspectFileTransactionMarkerSync,
  readJsonLinesSync,
  withFileLock,
} from "./local-file-storage.js";
import {
  decodeWorkspaceStorageLayout,
  decodeWorkspaceStorageLayoutMarker,
  readWorkspaceStorageRootIdentitySync,
  WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
  WORKSPACE_STORAGE_COMMIT_FILE,
  WORKSPACE_STORAGE_LAYOUT_FILE,
  WORKSPACE_STORAGE_LOCK_DIRECTORY,
} from "./workspace-storage-layout.js";

const SHA256_RE = /^[a-f0-9]{64}$/u;
const SAFE_OPERATION_ID_RE = /^[A-Za-z0-9._-]+$/u;
const LEGACY_LOCK_TOMBSTONE_RE = /^\.lock\.tombstone-[a-f0-9]{64}$/u;
const LEGACY_LOCK_CANDIDATE_RE =
  /^\.lock\.candidate-[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export const STORAGE_DOCTOR_SEVERITIES = ["info", "warning", "error", "critical"] as const;
export type StorageDoctorSeverity = (typeof STORAGE_DOCTOR_SEVERITIES)[number];

export const STORAGE_DOCTOR_COMPONENTS = [
  "session",
  "runtime",
  "task",
  "memory",
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
  /** Canonical workspace state root; retained name preserves the diagnostic API. */
  readonly runtimeStorageRoot?: string;
  readonly summariesDir?: string;
  readonly artifactsDir?: string;
  readonly now?: () => Date;
}

export interface StorageDoctorRepairOptions {
  /** 只隔离可重建的 Summary/损坏 Artifact metadata，不触碰 Session/FileHistory/Runtime。 */
  readonly quarantineMalformedSidecars?: boolean;
  /** 投影具体实现由组装层提供，Doctor 不反向修改真源。 */
  readonly rebuildDerivedProjections?: () => void | Promise<void>;
  /** 从 canonical Session JSONL 重建可丢弃的 manifest.json 投影。 */
  readonly rebuildRuntimeManifests?: boolean;
  /** 从 canonical TaskRun JSONL 重建可丢弃的 manifest.json 投影。 */
  readonly rebuildTaskRunManifests?: boolean;
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
  readonly rebuiltRuntimeManifests: boolean;
  readonly rebuiltTaskRunManifests: boolean;
  readonly reconciledOperationIds: readonly string[];
  readonly needsAttentionOperationIds: readonly string[];
}

/**
 * 跨持久层的只读诊断器。scan 从不修复/删除权威数据；repair 也只执行
 * 调用方明确开启的安全动作。
 */
export class StorageDoctor {
  private readonly workDir: string;
  private readonly picoHome?: string;
  private readonly fileHistoryDir: string;
  private readonly runtimeStorageRoot: string;
  private readonly memoryStorageRoot: string;
  private readonly workspaceId: WorkspaceId;
  private readonly legacyStoragePaths: readonly string[];
  private readonly legacyJsonRuntimePath: string;
  private readonly legacyTasksPath: string;
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
    this.runtimeStorageRoot = resolve(options.runtimeStorageRoot ?? paths.workspace.root);
    this.memoryStorageRoot = resolve(paths.workspace.memory);
    this.workspaceId = paths.workspace.id;
    this.legacyStoragePaths = [
      ...["", "-wal", "-shm"].map((suffix) =>
        resolve(paths.workspace.root, `runtime.sqlite${suffix}`),
      ),
      ...["", "-wal", "-shm"].map((suffix) =>
        resolve(paths.workspace.memory, `memory.sqlite${suffix}`),
      ),
    ];
    this.legacyJsonRuntimePath = resolve(paths.workspace.legacyRuntime);
    this.legacyTasksPath = resolve(paths.workspace.tasks);
    this.summariesDir = resolve(options.summariesDir ?? paths.workspace.summaries);
    this.artifactsDir = resolve(options.artifactsDir ?? paths.workspace.artifacts);
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
      const scanRuntime = async () => {
        const runtimeAvailable = await this.scanRuntime(findings, scanned);
        if (runtimeAvailable) {
          await this.scanSessions(findings, scanned);
          await this.scanTaskRuns(findings, scanned);
        }
      };
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
        const coordinatorPath = join(this.runtimeStorageRoot, ".storage");
        const coordinatorMetadata = await lstatIfExists(coordinatorPath);
        if (!coordinatorMetadata) {
          await scanRuntime();
        } else if (!isRealDirectory(coordinatorMetadata)) {
          findings.push(
            invalidStorageDirectoryFinding(coordinatorPath, "runtime", coordinatorMetadata),
          );
        } else {
          await withFileLock(
            join(this.runtimeStorageRoot, WORKSPACE_STORAGE_LOCK_DIRECTORY),
            `storage-doctor:${process.pid}:runtime`,
            scanRuntime,
          );
        }
      }
    }
    const memoryRootMetadata = await lstatIfExists(this.memoryStorageRoot);
    if (memoryRootMetadata && !isRealDirectory(memoryRootMetadata)) {
      findings.push(
        invalidStorageDirectoryFinding(this.memoryStorageRoot, "memory", memoryRootMetadata),
      );
    } else if (memoryRootMetadata) {
      await withFileLock(
        join(this.memoryStorageRoot, "lock"),
        `storage-doctor:${process.pid}:memory`,
        async () => this.scanMemory(findings, scanned),
      );
    }
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
    let rebuiltRuntimeManifests = false;
    if (options.rebuildRuntimeManifests === true) {
      await new RuntimeEventStore(
        { storageRoot: this.runtimeStorageRoot },
        { repairIncompleteTails: false },
      ).listSessionManifests();
      rebuiltRuntimeManifests = true;
    }
    let rebuiltTaskRunManifests = false;
    if (options.rebuildTaskRunManifests === true) {
      await new TaskRunStore(
        { storageRoot: this.runtimeStorageRoot },
        { repairIncompleteTails: false },
      ).listTaskRunProjections();
      rebuiltTaskRunManifests = true;
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
      rebuiltRuntimeManifests,
      rebuiltTaskRunManifests,
      reconciledOperationIds: reconciledOperationIds.toSorted(),
      needsAttentionOperationIds: needsAttentionOperationIds.toSorted(),
    };
  }

  private async scanSessions(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const store = new RuntimeEventStore(
      { storageRoot: this.runtimeStorageRoot },
      {
        repairManifests: false,
        repairIncompleteTails: false,
        readOnly: true,
      },
    );
    let manifests;
    try {
      manifests = await store.listSessionManifests();
    } catch (error) {
      findings.push(sessionReplayFinding(this.runtimeStorageRoot, error));
      return;
    }

    for (const manifest of manifests) {
      scanned.session++;
      const sessionPath = join(
        this.runtimeStorageRoot,
        "sessions",
        createHash("sha256").update(manifest.sessionId).digest("hex"),
        "session.jsonl",
      );
      const manifestPath = join(
        this.runtimeStorageRoot,
        "sessions",
        createHash("sha256").update(manifest.sessionId).digest("hex"),
        "manifest.json",
      );
      try {
        if (canonicalizeWorkspacePath(manifest.workDir) !== this.workDir) {
          throw new Error(
            `session ${manifest.sessionId} belongs to unexpected workspace ${manifest.workDir}`,
          );
        }
        const events = await store.readSession(manifest.sessionId);
        const canonicalManifest = await store.readSessionManifest(manifest.sessionId);
        if (!canonicalManifest) {
          throw new Error(`session ${manifest.sessionId} disappeared during scan`);
        }
        projectRuntimeSessionState(events);
        projectRuntimeSessionMessages(events);
        materializeRuntimeHistory(events);
        let persistedManifest;
        try {
          persistedManifest = decodeRuntimeSessionManifestProjection(
            parseJson(await readFile(manifestPath, "utf8"), "Runtime session manifest"),
            manifestPath,
          );
        } catch {
          persistedManifest = undefined;
        }
        if (
          !persistedManifest ||
          !isDeepStrictEqual(persistedManifest.manifest, canonicalManifest) ||
          persistedManifest.ledger.byteLength !== (await lstat(sessionPath)).size
        ) {
          findings.push(
            finding(
              "runtime_manifest_rebuild_required",
              "warning",
              "projection",
              manifestPath,
              "Session manifest is missing, malformed, or stale",
              "Run StorageDoctor repair with rebuildRuntimeManifests enabled",
              "derived",
            ),
          );
        }
      } catch (error) {
        findings.push(sessionReplayFinding(sessionPath, error));
      }
    }
  }

  private async scanTaskRuns(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    const taskRunsRoot = join(this.runtimeStorageRoot, "task-runs");
    if (!(await pathExists(taskRunsRoot))) return;
    try {
      const inspection = await new TaskRunStore(
        { storageRoot: this.runtimeStorageRoot },
        {
          repairManifests: false,
          repairIncompleteTails: false,
          readOnly: true,
        },
      ).inspectTaskRuns();
      scanned.task += inspection.projections.length;
      for (const manifestPath of inspection.staleManifestPaths) {
        findings.push(
          finding(
            "task_run_manifest_rebuild_required",
            "warning",
            "projection",
            manifestPath,
            "TaskRun manifest is missing, malformed, or stale",
            "Run StorageDoctor repair with rebuildTaskRunManifests enabled",
            "derived",
          ),
        );
      }
    } catch (error) {
      findings.push(
        finding(
          "task_run_ledger_invalid",
          "critical",
          "task",
          taskRunsRoot,
          errorMessage(error),
          "Preserve the append-only TaskRun ledger and recover it from a verified copy",
          "authoritative",
        ),
      );
    }
  }

  private async scanRuntime(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<boolean> {
    if (!(await pathExists(this.runtimeStorageRoot))) return false;
    scanned.runtime++;
    for (const [relativePath, exclusions] of [
      ["sessions", new Set<string>()],
      ["task-runs", new Set<string>()],
      ["control", new Set<string>()],
      [".storage", new Set(["lock"])],
    ] as const) {
      const path = join(this.runtimeStorageRoot, relativePath);
      if (await pathExists(path)) {
        await this.scanPrivateModes(path, "runtime", findings, exclusions);
      }
    }

    const layoutPath = join(this.runtimeStorageRoot, WORKSPACE_STORAGE_LAYOUT_FILE);
    if (await pathExists(layoutPath)) {
      try {
        const layout = decodeWorkspaceStorageLayoutMarker(
          parseJson(await readFile(layoutPath, "utf8"), "Workspace storage layout"),
          layoutPath,
        );
        if (layout.schemaVersion === 1) {
          findings.push(
            finding(
              "runtime_layout_upgrade_required",
              "warning",
              "runtime",
              layoutPath,
              "Workspace storage layout predates stable root identity",
              "Open the workspace with the current pico build to upgrade the marker under lock",
              "authoritative",
            ),
          );
          return false;
        }
        decodeWorkspaceStorageLayout(layout, layoutPath);
      } catch (error) {
        findings.push(
          finding(
            "runtime_layout_invalid",
            "critical",
            "runtime",
            layoutPath,
            errorMessage(error),
            "Preserve the marker and restore it from a verified copy",
            "authoritative",
          ),
        );
        return false;
      }
      try {
        readWorkspaceStorageRootIdentitySync(this.runtimeStorageRoot);
      } catch (error) {
        findings.push(
          finding(
            "runtime_root_identity_invalid",
            "critical",
            "runtime",
            layoutPath,
            errorMessage(error),
            "Preserve the root and use explicit storage adoption only after verifying its origin",
            "authoritative",
          ),
        );
        return false;
      }
    }

    const commitPath = join(this.runtimeStorageRoot, WORKSPACE_STORAGE_COMMIT_FILE);
    if (await pathExists(commitPath)) {
      let inspection;
      try {
        inspection = inspectFileTransactionMarkerSync(
          this.runtimeStorageRoot,
          WORKSPACE_LAYOUT_TRANSACTION_OPTIONS,
        );
      } catch (error) {
        findings.push(
          finding(
            "runtime_commit_invalid",
            "critical",
            "runtime",
            commitPath,
            errorMessage(error),
            "Preserve the marker and target files for manual transaction recovery",
            "authoritative",
          ),
        );
        return false;
      }
      findings.push(
        finding(
          "runtime_commit_pending",
          "error",
          "runtime",
          commitPath,
          `A durable Runtime file transaction is awaiting recovery (${inspection.status})`,
          "Open the workspace with the current pico build to complete the idempotent transaction",
          "authoritative",
        ),
      );
      return false;
    }

    const statePath = join(this.runtimeStorageRoot, "control", "state.json");
    let stateNextSequence: number | undefined;
    if (await pathExists(statePath)) {
      try {
        const state = decodeRuntimeControlState(
          parseJson(await readFile(statePath, "utf8"), "Runtime control state"),
          statePath,
        );
        stateNextSequence = state.nextRuntimeEventSequence;
      } catch (error) {
        findings.push(
          finding(
            "runtime_state_invalid",
            "critical",
            "runtime",
            statePath,
            errorMessage(error),
            "Preserve the file and restore it from a verified backup or transaction artifact",
            "authoritative",
          ),
        );
      }
    }

    const daemonPath = join(this.runtimeStorageRoot, "control", "daemon-events.jsonl");
    if (await pathExists(daemonPath)) {
      try {
        const events = decodeRuntimeEvents(readJsonLinesSync(daemonPath));
        const eventIds = new Set<string>();
        for (const envelope of events) {
          if (eventIds.has(envelope.event.eventId)) {
            throw new Error(`Duplicate Runtime event ID ${envelope.event.eventId}`);
          }
          eventIds.add(envelope.event.eventId);
        }
        if (stateNextSequence !== undefined && stateNextSequence !== events.length + 1) {
          throw new Error(
            `Runtime event ledger ends at ${events.length}, but state expects ${stateNextSequence - 1}`,
          );
        }
      } catch (error) {
        findings.push(
          finding(
            "runtime_event_ledger_invalid",
            "critical",
            "runtime",
            daemonPath,
            errorMessage(error),
            "Preserve the append-only ledger and recover it from a verified copy",
            "authoritative",
          ),
        );
      }
    }

    const usagePath = join(this.runtimeStorageRoot, "control", "usage-ledger.jsonl");
    if (await pathExists(usagePath)) {
      try {
        const calls = new Set<string>();
        const baselines = new Set<string>();
        for (const envelope of decodeUsageLedger(readJsonLinesSync(usagePath))) {
          const identities =
            envelope.type === "provider-call"
              ? ([calls, envelope.record.callId, "callId"] as const)
              : ([baselines, envelope.record.baselineId, "baselineId"] as const);
          if (identities[0].has(identities[1])) {
            throw new Error(`Duplicate usage ${identities[2]} ${identities[1]}`);
          }
          identities[0].add(identities[1]);
        }
      } catch (error) {
        findings.push(
          finding(
            "runtime_usage_ledger_invalid",
            "critical",
            "runtime",
            usagePath,
            errorMessage(error),
            "Preserve the append-only ledger and recover it from a verified copy",
            "authoritative",
          ),
        );
      }
    }
    return true;
  }

  private async scanMemory(
    findings: StorageDoctorFinding[],
    scanned: Record<StorageDoctorComponent, number>,
  ): Promise<void> {
    if (!(await pathExists(this.memoryStorageRoot))) return;
    const statePath = join(this.memoryStorageRoot, "state.json");
    const commitPath = join(this.memoryStorageRoot, "commit.json");
    if (!(await pathExists(statePath)) && !(await pathExists(commitPath))) return;
    scanned.memory++;
    await this.scanPrivateModes(
      this.memoryStorageRoot,
      "memory",
      findings,
      new Set(["lock", "summaries"]),
    );

    if (await pathExists(commitPath)) {
      try {
        const inspection = inspectFileTransactionMarkerSync(this.memoryStorageRoot);
        findings.push(
          finding(
            "memory_commit_pending",
            "error",
            "memory",
            commitPath,
            `A durable Memory file transaction is awaiting recovery (${inspection.status})`,
            "Open the workspace with the current pico build to complete the idempotent transaction",
            "authoritative",
          ),
        );
      } catch (error) {
        findings.push(
          finding(
            "memory_commit_invalid",
            "critical",
            "memory",
            commitPath,
            errorMessage(error),
            "Preserve the marker and state file for manual transaction recovery",
            "authoritative",
          ),
        );
      }
      return;
    }
    if (!(await pathExists(statePath))) {
      findings.push(
        finding(
          "memory_state_missing",
          "critical",
          "memory",
          statePath,
          "Memory storage exists without state.json",
          "Preserve the directory and restore state.json from a verified backup",
          "authoritative",
        ),
      );
      return;
    }
    try {
      decodeMemoryFileState(
        parseJson(await readFile(statePath, "utf8"), "Memory state"),
        this.workspaceId,
      );
    } catch (error) {
      findings.push(
        finding(
          "memory_state_invalid",
          "critical",
          "memory",
          statePath,
          errorMessage(error),
          "Preserve the file and restore it from a verified backup or transaction artifact",
          "authoritative",
        ),
      );
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
          "legacy_runtime_json_preserved",
          "warning",
          "runtime",
          this.legacyJsonRuntimePath,
          "The pre-v2 Runtime JSON directory is preserved and is not used after layout migration",
          "Keep it as a rollback artifact until the new sessions/control layout is verified",
          "sidecar",
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

  private async scanPrivateModes(
    root: string,
    component: Extract<StorageDoctorComponent, "runtime" | "memory">,
    findings: StorageDoctorFinding[],
    excludedRootEntries: ReadonlySet<string>,
  ): Promise<void> {
    if (process.platform === "win32") return;
    const visit = async (path: string, isRoot: boolean): Promise<void> => {
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
      if (!metadata.isDirectory()) return;
      for (const entry of await readDirectoryEntries(path)) {
        if (isRoot && excludedRootEntries.has(entry.name)) continue;
        await visit(join(path, entry.name), false);
      }
    };
    await visit(root, true);
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

function sessionReplayFinding(path: string, error: unknown): StorageDoctorFinding {
  return finding(
    "session_replay_failed",
    "critical",
    "session",
    path,
    errorMessage(error),
    "Keep the Session ledger unchanged and restore it from a verified backup",
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

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
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
