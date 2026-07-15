import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { ToolResultArtifactStore, type ArtifactCloneMapping } from "../context/artifact-store.js";
import { FileSessionSummaryStore } from "../memory/summary-store.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RuntimeEventStore } from "../runtime/runtime-event-store.js";
import { RuntimeRun } from "../runtime/runtime-run.js";
import { fileHistoryCloneSession, fileHistoryDefaultBaseDir } from "../safety/file-history.js";
import type { Message } from "../schema/message.js";
import { readVersionedJson, writeJsonAtomic } from "../storage/atomic-json.js";
import {
  ForkOperationCoordinator,
  ForkOperationConflictError,
  type ForkOperationCallbacks,
  type ForkPreparedBundle,
  type ForkReconciliationResult,
  type ForkSourceCursor,
} from "../storage/fork-operation-coordinator.js";
import {
  StorageOperationJournal,
  type ForkStorageOperation,
} from "../storage/operation-journal.js";
import type {
  PersistedInteractionMode,
  PersistedSessionSettings,
  SessionRuntimeStatePatch,
} from "./session-runtime.js";
import { normalizeSessionRuntimeStatePatch } from "./session-runtime.js";
import {
  globalSessionManager,
  type DurableSessionForkSnapshot,
  type SessionManager,
} from "./session.js";

const SAFE_SESSION_ID = /^[A-Za-z0-9._-]+$/u;
const FROZEN_FORK_BUNDLE_VERSION = 1 as const;
const FROZEN_FORK_BUNDLE_NAME = "runtime-fork.json";
const FORK_SIDECARS_VERSION = 1 as const;
const FORK_SIDECARS_NAME = "fork-sidecars.json";

export interface SessionForkServiceHooks {
  /** 故障注入：sidecar 结果已可重放、Runtime 发布前。 */
  readonly afterSidecars?: (operation: ForkStorageOperation) => void | Promise<void>;
  /** 故障注入：Runtime fork bootstrap 写入前。 */
  readonly beforeRuntimeBootstrap?: (operation: ForkStorageOperation) => void | Promise<void>;
}

export interface SessionForkServiceOptions {
  readonly workDir: string;
  readonly sessionManager?: SessionManager;
  readonly journal?: StorageOperationJournal;
  readonly runtimeStore?: RuntimeEventStore;
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

interface FrozenForkBundle {
  readonly schemaVersion: typeof FROZEN_FORK_BUNDLE_VERSION;
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly sourceCursor: ForkSourceCursor;
  readonly messages: readonly Message[];
  readonly sourceTitle?: string;
  readonly settings?: PersistedSessionSettings;
  readonly goal?: NonNullable<SessionRuntimeStatePatch["goal"]>;
}

interface PersistedArtifactCloneMapping {
  readonly sourceId: string;
  readonly sourcePath: string;
  readonly targetId: string;
  readonly targetPath: string;
}

interface ForkSidecarsBundle {
  readonly schemaVersion: typeof FORK_SIDECARS_VERSION;
  readonly operationId: string;
  readonly sourceSessionId: string;
  readonly targetSessionId: string;
  readonly artifactMappings: readonly PersistedArtifactCloneMapping[];
}

/** Runtime SQLite 的 fork marker 是唯一发布点；staging 只保存崩溃恢复输入。 */
export class SessionForkService {
  readonly workDir: string;
  readonly journal: StorageOperationJournal;
  private readonly sessionManager: SessionManager;
  private readonly runtimeStore: RuntimeEventStore;
  private readonly fileHistoryBaseDir: string;
  private readonly summaryIndexPath: string;
  private readonly artifactBaseDir: string;
  private readonly hooks?: SessionForkServiceHooks;
  private readonly createOperationId: () => string;
  private readonly coordinator: ForkOperationCoordinator;

  constructor(options: SessionForkServiceOptions) {
    this.workDir = resolve(options.workDir);
    this.sessionManager = options.sessionManager ?? globalSessionManager;
    this.journal = options.journal ?? new StorageOperationJournal({ workDir: this.workDir });
    const workspacePaths = resolvePicoPaths(this.workDir).workspace;
    this.runtimeStore =
      options.runtimeStore ??
      new RuntimeEventStore({ databasePath: workspacePaths.runtimeDatabase });
    this.fileHistoryBaseDir = options.fileHistoryBaseDir ?? fileHistoryDefaultBaseDir();
    this.summaryIndexPath =
      options.summaryIndexPath ?? join(workspacePaths.memory, "summaries.json");
    this.artifactBaseDir = options.artifactBaseDir ?? workspacePaths.artifacts;
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
    const source = await this.sessionManager.getOrCreate(input.sourceSessionId, this.workDir);
    return source.serialize(async () => {
      await assertTargetNotPublished(this.runtimeStore, input.targetSessionId);
      const snapshot = await source.readDurableForkSnapshot();
      const operationId = this.createOperationId();
      const stagingDirectory = join(
        resolvePicoPaths(this.workDir).workspace.forkStaging,
        operationId,
      );
      const frozen = createFrozenForkBundle(operationId, input, snapshot);

      // 必须先冻结 payload 再创建 journal。这样 journal 一旦可见，reconcile
      // 就永远不需要从已经继续推进的 source 重建消息。
      await writeJsonAtomic(this.frozenBundlePath(stagingDirectory), frozen);
      const operation = await this.coordinator.execute({
        kind: "fork",
        operationId,
        sessionId: input.sourceSessionId,
        sourceSessionId: input.sourceSessionId,
        sourceCursor: snapshot.cursor,
        targetSessionId: input.targetSessionId,
        targetMode: input.targetMode,
        stagingDirectory,
      });
      if (operation.state === "needs_attention") {
        throw new SessionForkNeedsAttentionError(operation);
      }
      return {
        operation,
        ...(frozen.sourceTitle
          ? {
              sourceTitle: frozen.sourceTitle,
              targetTitle: forkTitleFrom(frozen.sourceTitle),
            }
          : {}),
      };
    });
  }

  async reconcileUnfinished(): Promise<ForkReconciliationResult[]> {
    return this.coordinator.reconcileUnfinished();
  }

  private createCallbacks(): ForkOperationCallbacks {
    return {
      prepareTargetBundle: async (operation, stagingDirectory) => {
        const stagedBundlePath = this.frozenBundlePath(stagingDirectory);
        await this.readFrozenBundle(operation, stagedBundlePath);
        return { stagedBundlePath };
      },
      cloneSidecars: async (operation) => {
        await this.ensureSidecars(operation);
        await this.hooks?.afterSidecars?.(operation);
      },
      publishRuntime: async (operation, bundle) => this.publishRuntime(operation, bundle),
    };
  }

  private async ensureSidecars(operation: ForkStorageOperation): Promise<ForkSidecarsBundle> {
    const existing = await this.tryReadSidecars(operation);
    if (existing) return existing;

    let artifactMappings: readonly ArtifactCloneMapping[];
    try {
      await fileHistoryCloneSession(
        operation.sourceSessionId,
        operation.targetSessionId,
        this.fileHistoryBaseDir,
      );
      new FileSessionSummaryStore(this.summaryIndexPath).cloneSession(
        operation.sourceSessionId,
        operation.targetSessionId,
      );
      artifactMappings = (
        await new ToolResultArtifactStore({ baseDir: this.artifactBaseDir }).cloneSession(
          operation.sourceSessionId,
          operation.targetSessionId,
        )
      ).mappings;
    } catch (error) {
      throw new ForkOperationConflictError(
        `Fork sidecar 快照无法完整冻结: ${errorMessage(error)}`,
        "staging_corrupt",
      );
    }

    const sidecars = {
      schemaVersion: FORK_SIDECARS_VERSION,
      operationId: operation.operationId,
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: operation.targetSessionId,
      artifactMappings: artifactMappings.map(persistArtifactMapping),
    } satisfies ForkSidecarsBundle;
    await writeJsonAtomic(this.sidecarsPath(operation), sidecars);
    return sidecars;
  }

  private async publishRuntime(
    operation: ForkStorageOperation,
    prepared: ForkPreparedBundle,
  ): Promise<void> {
    const frozen = await this.readFrozenBundle(operation, prepared.stagedBundlePath);
    const sidecars = await this.readSidecars(operation);
    const messages = rewriteArtifactReferences(
      frozen.messages,
      operation.sourceSessionId,
      operation.targetSessionId,
      sidecars.artifactMappings,
    );

    await this.hooks?.beforeRuntimeBootstrap?.(operation);
    await RuntimeRun.bootstrapFork({
      sourceSessionId: operation.sourceSessionId,
      targetSessionId: operation.targetSessionId,
      messages,
      workDir: this.workDir,
      store: this.runtimeStore,
    });

    const runtimePatch = filteredRuntimePatch(
      frozen,
      operation.targetMode ?? "yolo",
      operation.createdAt,
    );
    if (runtimePatch) {
      const createdAt = parseForkCreatedAt(operation.createdAt);
      await this.runtimeStore.appendSessionState(operation.targetSessionId, runtimePatch, {
        eventId: runtimeStateEventId(operation.operationId),
        now: () => new Date(createdAt),
      });
    }
  }

  private async readFrozenBundle(
    operation: ForkStorageOperation,
    path: string,
  ): Promise<FrozenForkBundle> {
    try {
      const frozen = await readVersionedJson(path, parseFrozenForkBundle);
      validateFrozenBundleForOperation(frozen, operation, path);
      return frozen;
    } catch (error) {
      if (error instanceof ForkOperationConflictError) throw error;
      throw new ForkOperationConflictError(
        `Frozen Runtime fork bundle cannot be decoded: ${errorMessage(error)}`,
        "staging_corrupt",
        [path],
      );
    }
  }

  private async tryReadSidecars(
    operation: ForkStorageOperation,
  ): Promise<ForkSidecarsBundle | undefined> {
    const path = this.sidecarsPath(operation);
    try {
      const sidecars = await readVersionedJson(path, parseForkSidecarsBundle);
      validateSidecarsForOperation(sidecars, operation, path);
      return sidecars;
    } catch (error) {
      if (isNodeCode(error, "ENOENT")) return undefined;
      if (error instanceof ForkOperationConflictError) throw error;
      throw new ForkOperationConflictError(
        `Fork sidecar result cannot be decoded: ${errorMessage(error)}`,
        "staging_corrupt",
        [path],
      );
    }
  }

  private async readSidecars(operation: ForkStorageOperation): Promise<ForkSidecarsBundle> {
    const sidecars = await this.tryReadSidecars(operation);
    if (sidecars) return sidecars;
    throw new ForkOperationConflictError("Fork sidecar result is missing", "staging_corrupt", [
      this.sidecarsPath(operation),
    ]);
  }

  private frozenBundlePath(stagingDirectory: string): string {
    return join(stagingDirectory, FROZEN_FORK_BUNDLE_NAME);
  }

  private sidecarsPath(operation: ForkStorageOperation): string {
    return join(operation.stagingDirectory, FORK_SIDECARS_NAME);
  }
}

export async function reconcileUnfinishedSessionForks(
  workDir: string,
): Promise<ForkReconciliationResult[]> {
  return new SessionForkService({ workDir }).reconcileUnfinished();
}

function createFrozenForkBundle(
  operationId: string,
  input: ForkSessionInput,
  snapshot: DurableSessionForkSnapshot,
): FrozenForkBundle {
  const sourceTitle = sourceDisplayTitle(snapshot);
  return {
    schemaVersion: FROZEN_FORK_BUNDLE_VERSION,
    operationId,
    sourceSessionId: input.sourceSessionId,
    targetSessionId: input.targetSessionId,
    sourceCursor: structuredClone(snapshot.cursor),
    messages: snapshot.hydration.messages.map(stripMessageUsage),
    ...(sourceTitle ? { sourceTitle } : {}),
    ...(snapshot.hydration.runtime.settings
      ? { settings: structuredClone(snapshot.hydration.runtime.settings) }
      : {}),
    ...(snapshot.hydration.runtime.goal
      ? { goal: structuredClone(snapshot.hydration.runtime.goal) }
      : {}),
  };
}

function filteredRuntimePatch(
  frozen: FrozenForkBundle,
  targetMode: PersistedInteractionMode,
  forkCreatedAt: string,
): SessionRuntimeStatePatch | undefined {
  const settings = frozen.settings
    ? filterForkSettings(frozen.settings, frozen.sourceSessionId, targetMode, frozen.sourceTitle)
    : undefined;
  return settings || frozen.goal
    ? {
        ...(settings ? { settings } : {}),
        ...(frozen.goal ? { goal: resetForkGoalUsage(frozen.goal, forkCreatedAt) } : {}),
      }
    : undefined;
}

/** A fork retains the task definition but begins a new independent budget window. */
function resetForkGoalUsage(
  source: NonNullable<SessionRuntimeStatePatch["goal"]>,
  forkCreatedAt: string,
): NonNullable<SessionRuntimeStatePatch["goal"]> {
  const startedAt = parseForkCreatedAt(forkCreatedAt);
  return {
    ...structuredClone(source),
    goals: source.goals.map((goal) => ({
      ...structuredClone(goal),
      budgetUsage: { turns: 0, tokens: 0, costCNY: 0, startedAt },
    })),
  };
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

function persistArtifactMapping(mapping: ArtifactCloneMapping): PersistedArtifactCloneMapping {
  return {
    sourceId: mapping.sourceId,
    sourcePath: mapping.sourcePath,
    targetId: mapping.targetId,
    targetPath: mapping.targetPath,
  };
}

function rewriteArtifactReferences(
  messages: readonly Message[],
  sourceSessionId: string,
  targetSessionId: string,
  mappings: readonly PersistedArtifactCloneMapping[],
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

function rewriteStrings(
  value: unknown,
  replacements: readonly (readonly [string, string])[],
): unknown {
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

function parseFrozenForkBundle(value: unknown): FrozenForkBundle {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== FROZEN_FORK_BUNDLE_VERSION ||
    typeof value["operationId"] !== "string" ||
    typeof value["sourceSessionId"] !== "string" ||
    typeof value["targetSessionId"] !== "string" ||
    !isForkSourceCursor(value["sourceCursor"]) ||
    !Array.isArray(value["messages"]) ||
    !value["messages"].every(isMessageValue) ||
    (value["sourceTitle"] !== undefined && typeof value["sourceTitle"] !== "string")
  ) {
    throw new Error("Invalid frozen Runtime fork bundle");
  }

  const hasSettings = value["settings"] !== undefined;
  const hasGoal = value["goal"] !== undefined;
  const normalized =
    hasSettings || hasGoal
      ? normalizeSessionRuntimeStatePatch({
          ...(hasSettings ? { settings: value["settings"] } : {}),
          ...(hasGoal ? { goal: value["goal"] } : {}),
        })
      : undefined;
  if (
    (hasSettings && !normalized?.settings) ||
    (hasGoal && !normalized?.goal) ||
    (!hasSettings && normalized?.settings) ||
    (!hasGoal && normalized?.goal)
  ) {
    throw new Error("Invalid frozen Runtime state");
  }

  return {
    schemaVersion: FROZEN_FORK_BUNDLE_VERSION,
    operationId: value["operationId"],
    sourceSessionId: value["sourceSessionId"],
    targetSessionId: value["targetSessionId"],
    sourceCursor: structuredClone(value["sourceCursor"]),
    messages: structuredClone(value["messages"] as Message[]),
    ...(value["sourceTitle"] !== undefined ? { sourceTitle: value["sourceTitle"] } : {}),
    ...(normalized?.settings ? { settings: normalized.settings } : {}),
    ...(normalized?.goal ? { goal: normalized.goal } : {}),
  };
}

function parseForkSidecarsBundle(value: unknown): ForkSidecarsBundle {
  if (
    !isRecord(value) ||
    value["schemaVersion"] !== FORK_SIDECARS_VERSION ||
    typeof value["operationId"] !== "string" ||
    typeof value["sourceSessionId"] !== "string" ||
    typeof value["targetSessionId"] !== "string" ||
    !Array.isArray(value["artifactMappings"]) ||
    !value["artifactMappings"].every(isPersistedArtifactMapping)
  ) {
    throw new Error("Invalid fork sidecar result");
  }
  return {
    schemaVersion: FORK_SIDECARS_VERSION,
    operationId: value["operationId"],
    sourceSessionId: value["sourceSessionId"],
    targetSessionId: value["targetSessionId"],
    artifactMappings: structuredClone(value["artifactMappings"] as PersistedArtifactCloneMapping[]),
  };
}

function validateFrozenBundleForOperation(
  frozen: FrozenForkBundle,
  operation: ForkStorageOperation,
  path: string,
): void {
  if (
    frozen.operationId !== operation.operationId ||
    frozen.sourceSessionId !== operation.sourceSessionId ||
    frozen.targetSessionId !== operation.targetSessionId ||
    !sameCursor(frozen.sourceCursor, operation.sourceCursor)
  ) {
    throw new ForkOperationConflictError(
      "Frozen Runtime fork bundle belongs to another operation or source cursor",
      "staging_corrupt",
      [path],
    );
  }
}

function validateSidecarsForOperation(
  sidecars: ForkSidecarsBundle,
  operation: ForkStorageOperation,
  path: string,
): void {
  if (
    sidecars.operationId !== operation.operationId ||
    sidecars.sourceSessionId !== operation.sourceSessionId ||
    sidecars.targetSessionId !== operation.targetSessionId
  ) {
    throw new ForkOperationConflictError(
      "Fork sidecar result belongs to another operation",
      "staging_corrupt",
      [path],
    );
  }
}

function isPersistedArtifactMapping(value: unknown): value is PersistedArtifactCloneMapping {
  return (
    isRecord(value) &&
    typeof value["sourceId"] === "string" &&
    typeof value["sourcePath"] === "string" &&
    typeof value["targetId"] === "string" &&
    typeof value["targetPath"] === "string"
  );
}

function isMessageValue(value: unknown): value is Message {
  return (
    isRecord(value) &&
    (value["role"] === "system" || value["role"] === "user" || value["role"] === "assistant") &&
    typeof value["content"] === "string"
  );
}

function isForkSourceCursor(value: unknown): value is ForkSourceCursor {
  return (
    isRecord(value) &&
    typeof value["logId"] === "string" &&
    isNonNegativeInteger(value["seq"]) &&
    isNonNegativeInteger(value["epoch"]) &&
    typeof value["eventId"] === "string"
  );
}

function sameCursor(left: ForkSourceCursor, right: ForkSourceCursor): boolean {
  return (
    left.logId === right.logId &&
    left.seq === right.seq &&
    left.epoch === right.epoch &&
    left.eventId === right.eventId
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

function runtimeStateEventId(operationId: string): string {
  return "fork:" + operationId + ":state";
}

function parseForkCreatedAt(createdAt: string): number {
  const timestamp = Date.parse(createdAt);
  if (!Number.isFinite(timestamp)) {
    throw new Error(`Fork operation has an invalid createdAt timestamp: ${createdAt}`);
  }
  return timestamp;
}

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID.test(sessionId)) throw new Error("无效 sessionId: " + sessionId);
}

async function assertTargetNotPublished(
  runtimeStore: RuntimeEventStore,
  targetSessionId: string,
): Promise<void> {
  if (await runtimeStore.readSessionManifest(targetSessionId)) {
    throw new Error("Fork 目标 Runtime 已存在: " + targetSessionId);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
