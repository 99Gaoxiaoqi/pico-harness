import { randomUUID } from "node:crypto";
import { lstat, mkdir, rm } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ToolResultArtifactStore, type ArtifactCloneMapping } from "../context/artifact-store.js";
import { FileSessionSummaryStore } from "../memory/summary-store.js";
import type { Message } from "../schema/message.js";
import {
  fileHistoryCloneSession,
  fileHistoryDefaultBaseDir,
} from "../safety/file-history.js";
import {
  ForkOperationCoordinator,
  ForkOperationConflictError,
  type ForkOperationCallbacks,
  type ForkPreparedSessionFile,
  type ForkReconciliationResult,
  type ForkTargetSessionIdentity,
} from "../storage/fork-operation-coordinator.js";
import { StorageOperationJournal, type ForkStorageOperation } from "../storage/operation-journal.js";
import {
  getDefaultSessionCatalogProjector,
  type SessionCatalogProjector,
} from "../storage/session-catalog-projection.js";
import { createSessionIdentity } from "./session-identity.js";
import type {
  PersistedInteractionMode,
  PersistedSessionSettings,
  SessionRuntimeStatePatch,
} from "./session-runtime.js";
import {
  globalSessionManager,
  type DurableSessionForkSnapshot,
  type SessionManager,
} from "./session.js";
import {
  SessionStore,
  type SessionEvent,
  type SessionLineage,
  type SessionMetaV3,
} from "./session-store.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;

export interface SessionForkServiceHooks {
  /** 故障注入：sidecar 全部可重放提交后、JSONL 公布前。 */
  readonly afterSidecars?: (operation: ForkStorageOperation) => void | Promise<void>;
}

export interface SessionForkServiceOptions {
  readonly workDir: string;
  readonly sessionManager?: SessionManager;
  readonly journal?: StorageOperationJournal;
  readonly catalogProjector?: SessionCatalogProjector;
  readonly fileHistoryBaseDir?: string;
  readonly summaryIndexPath?: string;
  readonly artifactBaseDir?: string;
  readonly hooks?: SessionForkServiceHooks;
  readonly createOperationId?: () => string;
}

export interface ForkSessionInput {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  /** fork 不继承 source 权限 mode，由当前产品启动默认值决定。 */
  readonly targetMode: PersistedInteractionMode;
}

export interface ForkSessionResult {
  readonly operation: ForkStorageOperation;
  readonly sourceTitle?: string;
  readonly targetTitle?: string;
}

export class SessionForkNeedsAttentionError extends Error {
  constructor(readonly operation: ForkStorageOperation) {
    super(
      "Fork " +
        operation.operationId +
        " 需要人工处理: " +
        (operation.error?.message ?? operation.state),
    );
    this.name = "SessionForkNeedsAttentionError";
  }
}

interface FrozenForkSource {
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly targetMode: PersistedInteractionMode;
  readonly snapshot: DurableSessionForkSnapshot;
}

interface ClonedSidecars {
  readonly artifactMappings: readonly ArtifactCloneMapping[];
}

/**
 * Session JSONL 是 fork 的公布 commit marker。File History / Summary /
 * Artifact 先幂等提交，只有它们全部完成后 Coordinator 才会 rename
 * 隐藏 JSONL 并投影 Catalog。
 */
export class SessionForkService {
  readonly workDir: string;
  readonly journal: StorageOperationJournal;
  private readonly sessionManager: SessionManager;
  private readonly catalogProjector: SessionCatalogProjector;
  private readonly fileHistoryBaseDir: string;
  private readonly summaryIndexPath: string;
  private readonly artifactBaseDir: string;
  private readonly hooks?: SessionForkServiceHooks;
  private readonly createOperationId: () => string;
  private readonly frozenByOperation = new Map<string, FrozenForkSource>();
  private readonly coordinator: ForkOperationCoordinator;

  constructor(options: SessionForkServiceOptions) {
    this.workDir = resolve(options.workDir);
    this.sessionManager = options.sessionManager ?? globalSessionManager;
    this.journal = options.journal ?? new StorageOperationJournal({ workDir: this.workDir });
    this.catalogProjector = options.catalogProjector ?? getDefaultSessionCatalogProjector();
    this.fileHistoryBaseDir = options.fileHistoryBaseDir ?? fileHistoryDefaultBaseDir();
    this.summaryIndexPath =
      options.summaryIndexPath ?? join(this.workDir, ".claw", "memory", "summaries.json");
    this.artifactBaseDir =
      options.artifactBaseDir ?? join(this.workDir, ".claw", "artifacts");
    this.hooks = options.hooks;
    this.createOperationId = options.createOperationId ?? randomUUID;
    this.coordinator = new ForkOperationCoordinator({
      journal: this.journal,
      callbacks: this.createCallbacks(),
    });
  }

  async fork(input: ForkSessionInput): Promise<ForkSessionResult> {
    assertSafeSessionId(input.sourceSessionId);
    assertSafeSessionId(input.targetSessionId);
    if (input.sourceSessionId === input.targetSessionId) {
      throw new Error("Fork source 与 target sessionId 不能相同");
    }
    await assertTargetNotPublished(this.sessionPath(input.targetSessionId));

    const source = await this.sessionManager.getOrCreate(input.sourceSessionId, this.workDir);
    const snapshot = await source.readDurableForkSnapshot();
    const operationId = this.createOperationId();
    this.frozenByOperation.set(operationId, {
      ...input,
      snapshot,
    });

    const operation = await this.coordinator.execute({
      kind: "fork",
      operationId,
      sessionId: input.sourceSessionId,
      sourceSessionId: input.sourceSessionId,
      sourceCursor: snapshot.cursor,
      targetSessionId: input.targetSessionId,
      stagingDirectory: join(this.workDir, ".claw", "fork-staging", operationId),
    });
    if (operation.state === "needs_attention") throw new SessionForkNeedsAttentionError(operation);
    const sourceTitle = sourceDisplayTitle(snapshot);
    return {
      operation,
      ...(sourceTitle ? { sourceTitle, targetTitle: forkTitleFrom(sourceTitle) } : {}),
    };
  }

  async reconcileUnfinished(): Promise<ForkReconciliationResult[]> {
    return this.coordinator.reconcileUnfinished();
  }

  private createCallbacks(): ForkOperationCallbacks {
    return {
      readSourceCursor: async (operation) => {
        const source = await this.sessionManager.getOrCreate(
          operation.sourceSessionId,
          this.workDir,
        );
        const snapshot = await source.readDurableForkSnapshot();
        if (!this.frozenByOperation.has(operation.operationId)) {
          this.frozenByOperation.set(operation.operationId, {
            sourceSessionId: operation.sourceSessionId,
            targetSessionId: operation.targetSessionId,
            targetMode: "yolo",
            snapshot,
          });
        }
        return snapshot.cursor;
      },
      prepareTargetBundle: async (operation) => this.prepareTargetBundle(operation),
      inspectSessionFile: async (operation, path) => inspectForkSessionFile(operation, path),
      cloneSidecars: async (operation) => {
        // prepareTargetBundle 在返回 JSONL 之前已经冻结并提交全部
        // sidecar。workspace_applied 后不再读 source，否则 source 的
        // 后续追加会把已冻结 fork 误判为冲突。
        await this.hooks?.afterSidecars?.(operation);
      },
      publishCatalog: async (operation, bundle) => {
        // 先补父日志投影，否则全新 Catalog 会把已有 durable
        // parent cursor 的 fork 降级为只含 sessionId 的 stale 条目。
        await this.catalogProjector.projectJournal(this.sessionPath(operation.sourceSessionId));
        await this.catalogProjector.projectJournal(bundle.targetSessionPath);
      },
    };
  }

  private async prepareTargetBundle(
    operation: ForkStorageOperation,
  ): Promise<ForkPreparedSessionFile> {
    const frozen = await this.getFrozenSource(operation);
    // 提前完成 sidecar 快照，使 operation 进入 workspace_applied 后 source
    // 可以继续追加，后续 forward reconcile 不会读取新的 sidecar 状态。
    let sidecars: ClonedSidecars;
    try {
      sidecars = await this.cloneSidecars(operation);
    } catch (error) {
      throw new ForkOperationConflictError(
        `Fork sidecar 快照无法完整冻结: ${errorMessage(error)}`,
        "staging_corrupt",
      );
    }
    const messages = rewriteArtifactReferences(
      frozen.snapshot.hydration.messages.map(stripMessageUsage),
      operation.sourceSessionId,
      operation.targetSessionId,
      sidecars.artifactMappings,
    );
    const runtimePatch = filteredRuntimePatch(frozen);
    const lineage = {
      relation: "fork",
      rootLogId: frozen.snapshot.rootLogId,
      parent: frozen.snapshot.cursor,
    } satisfies SessionLineage;
    const stagedSessionPath = this.stagedSessionPath(operation);
    const targetSessionPath = this.sessionPath(operation.targetSessionId);
    await mkdir(join(this.workDir, ".claw", "sessions"), { recursive: true, mode: 0o700 });

    if (
      !(await isCompletePreparedJournal(
        stagedSessionPath,
        operation,
        messages,
        lineage,
        runtimePatch,
      ))
    ) {
      await rm(stagedSessionPath, { force: true });
      const targetIdentity = createSessionIdentity({
        sessionId: operation.targetSessionId,
        cwd: frozen.snapshot.hydration.identity.cwd,
        originalCwd: frozen.snapshot.hydration.identity.originalCwd,
        projectRoot: frozen.snapshot.hydration.identity.projectRoot,
        sessionProjectDir: frozen.snapshot.hydration.identity.sessionProjectDir,
      });
      const store = new SessionStore(stagedSessionPath, targetIdentity);
      try {
        await store.commitSeed(messages, lineage, {
          eventId: seedEventId(operation.operationId),
          expectedSeq: 0,
        });
        if (runtimePatch) {
          await store.commitRuntimeState(runtimePatch, {
            eventId: runtimeEventId(operation.operationId),
            expectedSeq: 1,
          });
        }
      } finally {
        await store.close();
      }
    }
    return { stagedSessionPath, targetSessionPath };
  }

  private async getFrozenSource(operation: ForkStorageOperation): Promise<FrozenForkSource> {
    const cached = this.frozenByOperation.get(operation.operationId);
    if (cached) return cached;
    const source = await this.sessionManager.getOrCreate(operation.sourceSessionId, this.workDir);
    const snapshot = await source.readDurableForkSnapshot();
    const frozen = {
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: operation.targetSessionId,
      targetMode: "yolo",
      snapshot,
    } satisfies FrozenForkSource;
    this.frozenByOperation.set(operation.operationId, frozen);
    return frozen;
  }

  private async cloneSidecars(operation: ForkStorageOperation): Promise<ClonedSidecars> {
    await fileHistoryCloneSession(
      operation.sourceSessionId,
      operation.targetSessionId,
      this.fileHistoryBaseDir,
    );
    new FileSessionSummaryStore(this.summaryIndexPath).cloneSession(
      operation.sourceSessionId,
      operation.targetSessionId,
    );
    const artifacts = await new ToolResultArtifactStore({
      baseDir: this.artifactBaseDir,
    }).cloneSession(operation.sourceSessionId, operation.targetSessionId);
    return { artifactMappings: artifacts.mappings };
  }

  private stagedSessionPath(operation: ForkStorageOperation): string {
    return join(
      this.workDir,
      ".claw",
      "sessions",
      "." +
        operation.targetSessionId +
        ".fork-" +
        operation.operationId +
        ".jsonl",
    );
  }

  private sessionPath(sessionId: string): string {
    return join(this.workDir, ".claw", "sessions", sessionId + ".jsonl");
  }
}

export async function reconcileUnfinishedSessionForks(
  workDir: string,
): Promise<ForkReconciliationResult[]> {
  return new SessionForkService({ workDir }).reconcileUnfinished();
}

function filteredRuntimePatch(frozen: FrozenForkSource): SessionRuntimeStatePatch | undefined {
  const source = frozen.snapshot.hydration.runtime;
  const settings = source.settings
    ? filterForkSettings(
        source.settings,
        frozen.sourceSessionId,
        frozen.targetMode,
        sourceDisplayTitle(frozen.snapshot),
      )
    : undefined;
  return settings || source.goal
    ? {
        ...(settings ? { settings } : {}),
        ...(source.goal ? { goal: structuredClone(source.goal) } : {}),
      }
    : undefined;
}

function filterForkSettings(
  settings: PersistedSessionSettings,
  sourceSessionId: string,
  targetMode: PersistedInteractionMode,
  sourceTitle: string | undefined,
): PersistedSessionSettings {
  return {
    ...(sourceTitle ? { title: forkTitleFrom(sourceTitle) } : {}),
    forkFrom: sourceSessionId,
    provider: settings.provider,
    model: settings.model,
    ...(settings.modelRouteId ? { modelRouteId: settings.modelRouteId } : {}),
    mode: targetMode,
    ...(targetMode === "plan" ? { prePlanMode: "yolo" as const } : {}),
    thinkingEffort: settings.thinkingEffort,
    thinkingEffortExplicit: settings.thinkingEffortExplicit,
    additionalDirectories: [],
  };
}

function stripMessageUsage(message: Message): Message {
  const { usage: _usage, ...copy } = structuredClone(message);
  return copy;
}

function rewriteArtifactReferences(
  messages: readonly Message[],
  sourceSessionId: string,
  targetSessionId: string,
  mappings: readonly ArtifactCloneMapping[],
): Message[] {
  const replacements: Array<readonly [string, string]> = [];
  for (const mapping of mappings) {
    replacements.push([mapping.sourcePath, mapping.targetPath]);
    replacements.push([
      "artifact://" +
        encodeURIComponent(sourceSessionId) +
        "/" +
        encodeURIComponent(mapping.sourceId),
      "artifact://" +
        encodeURIComponent(targetSessionId) +
        "/" +
        encodeURIComponent(mapping.targetId),
    ]);
  }
  return rewriteStrings(structuredClone(messages), replacements) as Message[];
}

function rewriteStrings(value: unknown, replacements: readonly (readonly [string, string])[]): unknown {
  if (typeof value === "string") {
    return replacements.reduce(
      (current, [source, target]) => current.replaceAll(source, target),
      value,
    );
  }
  if (Array.isArray(value)) return value.map((item) => rewriteStrings(item, replacements));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, rewriteStrings(item, replacements)]),
    );
  }
  return value;
}

async function isCompletePreparedJournal(
  path: string,
  operation: ForkStorageOperation,
  messages: readonly Message[],
  lineage: SessionLineage,
  runtimePatch: SessionRuntimeStatePatch | undefined,
): Promise<boolean> {
  try {
    const snapshot = await new SessionStore(path).inspectJournal({ strict: true });
    const records = snapshot.records;
    if (records.length !== (runtimePatch ? 2 : 1)) return false;
    const seed = records[0];
    if (
      seed?.type !== "event" ||
      seed.eventId !== seedEventId(operation.operationId) ||
      seed.seq !== 0 ||
      seed.epoch !== 0 ||
      seed.kind !== "session.seeded" ||
      !isDeepStrictEqual(seed.data, {
        messages: structuredClone(messages),
        lineage: structuredClone(lineage),
      })
    ) {
      return false;
    }
    if (!runtimePatch) return true;
    const runtime = records[1];
    return (
      runtime?.type === "event" &&
      runtime.eventId === runtimeEventId(operation.operationId) &&
      runtime.seq === 1 &&
      runtime.epoch === 0 &&
      runtime.kind === "runtime.checkpoint" &&
      isDeepStrictEqual(runtime.data.patch, runtimePatch)
    );
  } catch {
    return false;
  }
}

async function inspectForkSessionFile(
  operation: ForkStorageOperation,
  path: string,
): Promise<ForkTargetSessionIdentity | undefined> {
  try {
    const snapshot = await new SessionStore(path).inspectJournal({ strict: true });
    const metadata = snapshot.metadata;
    if (!isSessionMetaV3(metadata) || metadata.sessionId !== operation.targetSessionId) {
      return undefined;
    }
    const seed = snapshot.records.find(
      (record): record is Extract<SessionEvent, { kind: "session.seeded" }> =>
        record.type === "event" && record.kind === "session.seeded",
    );
    const parent = seed?.data.lineage?.parent;
    if (!parent || seed.data.lineage?.relation !== "fork") return undefined;
    return { sessionId: metadata.sessionId, logId: metadata.logId, forkedFrom: parent };
  } catch {
    return undefined;
  }
}

function isSessionMetaV3(value: unknown): value is SessionMetaV3 {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === 3 &&
    "logId" in value &&
    typeof value.logId === "string"
  );
}

function sourceDisplayTitle(snapshot: DurableSessionForkSnapshot): string | undefined {
  const explicit = snapshot.hydration.runtime.settings?.title;
  if (explicit) return explicit;
  return snapshot.hydration.messages.find(
    (message) =>
      message.role === "user" && message.toolCallId === undefined && message.content.trim(),
  )?.content;
}

function forkTitleFrom(sourceTitle: string): string {
  const compacted = sourceTitle.replace(/\s+/gu, " ").trim();
  const prefix = "Fork of ";
  return prefix + compacted.slice(0, 120 - prefix.length);
}

function seedEventId(operationId: string): string {
  return "fork:" + operationId + ":seed";
}

function runtimeEventId(operationId: string): string {
  return "fork:" + operationId + ":runtime";
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("无效 sessionId: " + sessionId);
}

async function assertTargetNotPublished(path: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isFile()) throw new Error("Fork 目标已存在: " + basename(path));
    throw new Error("Fork 目标路径不是普通文件: " + path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
