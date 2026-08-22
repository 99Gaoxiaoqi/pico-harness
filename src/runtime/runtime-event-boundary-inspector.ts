import type { RuntimeEvent } from "../storage/runtime-event.js";
import type { RuntimeEventStoreEntry } from "../storage/runtime-event-store-contracts.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import type {
  RuntimeBoundaryInspection,
  RuntimeBoundaryInspector,
  RuntimeLaunchExpectation,
  RuntimeLaunchReconciliation,
} from "./safe-boundary-resume.js";
import {
  RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION,
  type TaskRuntimeBoundary,
} from "../tasks/task-run-contract.js";

export interface RuntimeEventBoundaryInspectorOptions {
  /**
   * 票 04:inspect 走 run 索引直读(run 内任意 kind 都要可见——源 run 终态后的
   * 任何新事件都是 fence 信号,kind 切片表达不了),单读事务内附带全会话水位;
   * reconcileLaunch 保留显式全量读——它本身是账本完整性校验器,前缀身份绑定
   * 扫描就是其语义。
   */
  readonly store: Pick<
    SqliteRuntimeEventStore,
    "readSessionEntries" | "readSessionRunBoundary" | "readSessionManifest"
  >;
  /**
   * RuntimeEvent cannot prove whether host-owned background work has settled. Missing evidence
   * therefore defaults to false and parks recovery.
   */
  readonly backgroundOperationsSettled?: (
    boundary: TaskRuntimeBoundary,
  ) => boolean | Promise<boolean>;
  /** Current immutable tool-catalog digest. Missing evidence parks recovery. */
  readonly toolCatalogHash?: (
    boundary: TaskRuntimeBoundary,
  ) => string | undefined | Promise<string | undefined>;
  /** Adapter-specific checkpoints in addition to Runtime checkpoint IDs. */
  readonly additionalCheckpointRefs?: (
    boundary: TaskRuntimeBoundary,
  ) => readonly string[] | Promise<readonly string[]>;
}

/**
 * Derives a conservative safe-resume view from the canonical Session RuntimeEvent ledger.
 *
 * The high-water mark is the Session sequence, not an array offset or a duplicated task log.
 */
export class RuntimeEventBoundaryInspector implements RuntimeBoundaryInspector {
  constructor(private readonly options: RuntimeEventBoundaryInspectorOptions) {}

  async inspect(boundary: TaskRuntimeBoundary): Promise<RuntimeBoundaryInspection> {
    const manifest = await this.options.store.readSessionManifest(boundary.sessionId);
    if (!manifest) {
      return { status: "session_missing", sessionId: boundary.sessionId };
    }
    // run 索引直读 + 全会话水位(票 04):run 事件与水位在 store 单读事务内
    // 取得,保持快照一致。
    const { entries: runEntries, headSequence } = await this.options.store.readSessionRunBoundary(
      boundary.sessionId,
      boundary.runId,
    );
    const startedEntries = runEntries.filter(
      (
        entry,
      ): entry is RuntimeEventStoreEntry & {
        readonly event: Extract<RuntimeEvent, { kind: "run.started" }>;
      } => entry.event.kind === "run.started",
    );
    if (startedEntries.length === 0) {
      return {
        status: "run_missing",
        sessionId: boundary.sessionId,
        runId: boundary.runId,
      };
    }
    if (startedEntries.length > 1) {
      throw new Error(`Runtime run ${boundary.runId} contains multiple run.started facts`);
    }
    const sessionWorkspacePath = canonicalizeWorkspacePath(manifest.workDir);
    const runWorkspacePath = canonicalizeWorkspacePath(startedEntries[0]!.event.data.workDir);
    if (sessionWorkspacePath !== manifest.workDir) {
      throw new Error(`Runtime session ${boundary.sessionId} manifest workDir is not canonical`);
    }
    if (runWorkspacePath !== startedEntries[0]!.event.data.workDir) {
      throw new Error(`Runtime run ${boundary.runId} workDir is not canonical`);
    }

    const terminals = runEntries.filter(
      (
        entry,
      ): entry is RuntimeEventStoreEntry & {
        readonly event: Extract<RuntimeEvent, { kind: "run.terminal" }>;
      } => entry.event.kind === "run.terminal",
    );
    if (terminals.length > 1) {
      throw new Error(`Runtime run ${boundary.runId} contains multiple terminal facts`);
    }

    const pendingApprovalIds = pendingApprovals(runEntries);
    const pendingToolCallIds = pendingToolCalls(runEntries);
    const checkpointRefs = new Set(
      runEntries
        .filter(
          (
            entry,
          ): entry is RuntimeEventStoreEntry & {
            readonly event: Extract<RuntimeEvent, { kind: "context.checkpoint.recorded" }>;
          } => entry.event.kind === "context.checkpoint.recorded",
        )
        .map(({ event }) => event.data.checkpointId),
    );
    for (const reference of (await this.options.additionalCheckpointRefs?.(boundary)) ?? []) {
      if (!reference.trim()) {
        throw new Error(
          `Runtime boundary ${boundary.runId} returned an empty checkpoint reference`,
        );
      }
      checkpointRefs.add(reference);
    }

    const terminal = terminals[0]?.event;
    const toolCatalogHash = await this.options.toolCatalogHash?.(boundary);
    if (toolCatalogHash !== undefined && !toolCatalogHash.trim()) {
      throw new Error(`Runtime boundary ${boundary.runId} returned an empty tool catalog hash`);
    }
    return {
      status: "available",
      sessionId: boundary.sessionId,
      runId: boundary.runId,
      sessionWorkspacePath,
      runWorkspacePath,
      eventHighWater: headSequence,
      sourceRunLastSequence: runEntries.at(-1)!.sequence,
      ...(terminals[0] ? { terminalSequence: terminals[0].sequence } : {}),
      ...(terminal
        ? {
            terminal: {
              eventId: terminal.eventId,
              status: terminal.data.status,
            },
          }
        : {}),
      pendingApprovalIds,
      pendingToolCallIds,
      backgroundOperationsSettled:
        (await this.options.backgroundOperationsSettled?.(boundary)) ?? false,
      ...(toolCatalogHash !== undefined ? { toolCatalogHash } : {}),
      availableCheckpointRefs: [...checkpointRefs].sort(),
    };
  }

  async reconcileLaunch(
    source: TaskRuntimeBoundary,
    expected: RuntimeLaunchExpectation,
  ): Promise<RuntimeLaunchReconciliation> {
    const manifest = await this.options.store.readSessionManifest(source.sessionId);
    if (!manifest) {
      return {
        status: "mismatch",
        reason: "runtime_session_missing",
        message: `Runtime session ${source.sessionId} is missing during launch reconciliation`,
      };
    }
    const entries = await this.options.store.readSessionEntries(source.sessionId);
    if (entries.length < source.eventHighWater) {
      return {
        status: "mismatch",
        reason: "runtime_high_water_mismatch",
        message: `Runtime session ${source.sessionId} regressed before launch reconciliation`,
        detail: { expected: source.eventHighWater, actual: entries.length },
      };
    }

    const priorIdentityBinding = entries
      .slice(0, source.eventHighWater)
      .find(
        ({ event }) =>
          event.runId === expected.runId || event.eventId === expected.runStartedEventId,
      );
    if (priorIdentityBinding) {
      return {
        status: "mismatch",
        reason: "ledger_corrupt",
        message: `Runtime launch identity ${expected.launchId} was bound before its source boundary`,
        detail: {
          actualEventId: priorIdentityBinding.event.eventId,
          actualRunId: priorIdentityBinding.event.runId,
          actualSequence: priorIdentityBinding.sequence,
        },
      };
    }
    if (entries.length === source.eventHighWater) return { status: "not_started" };
    const firstAdvance = entries[source.eventHighWater];
    if (
      !firstAdvance ||
      firstAdvance.sequence !== source.eventHighWater + 1 ||
      firstAdvance.event.kind !== "run.started" ||
      firstAdvance.event.sessionId !== source.sessionId ||
      firstAdvance.event.runId !== expected.runId ||
      firstAdvance.event.eventId !== expected.runStartedEventId
    ) {
      return {
        status: "mismatch",
        reason: "runtime_high_water_mismatch",
        message: `Runtime session ${source.sessionId} advanced with an unknown event`,
        detail: {
          sourceEventHighWater: source.eventHighWater,
          actualEventId: firstAdvance?.event.eventId,
          actualRunId: firstAdvance?.event.runId,
        },
      };
    }
    // H+1 durably binds this admission. Later Session events may belong to subsequent Runs.
    const matchingStarts = entries.filter(
      ({ event }) => event.kind === "run.started" && event.runId === expected.runId,
    );
    const matchingEventIds = entries.filter(
      ({ event }) => event.eventId === expected.runStartedEventId,
    );
    if (
      matchingStarts.length !== 1 ||
      matchingStarts[0]?.sequence !== firstAdvance.sequence ||
      matchingEventIds.length !== 1 ||
      matchingEventIds[0]?.sequence !== firstAdvance.sequence
    ) {
      return {
        status: "mismatch",
        reason: "ledger_corrupt",
        message: `Runtime launch ${expected.launchId} does not have one unique run.started identity`,
      };
    }

    const sessionWorkspacePath = canonicalizeWorkspacePath(manifest.workDir);
    const runWorkspacePath = canonicalizeWorkspacePath(firstAdvance.event.data.workDir);
    if (
      sessionWorkspacePath !== manifest.workDir ||
      runWorkspacePath !== firstAdvance.event.data.workDir ||
      runWorkspacePath !== sessionWorkspacePath
    ) {
      return {
        status: "mismatch",
        reason: "workspace_path_mismatch",
        message: `Runtime launch ${expected.launchId} belongs to another workspace`,
        detail: { sessionWorkspacePath, runWorkspacePath },
      };
    }
    return {
      status: "verified",
      sessionWorkspacePath,
      runWorkspacePath,
      currentEventHighWater: entries.length,
      receipt: {
        schemaVersion: RECOVERABLE_TASK_LAUNCH_RECEIPT_SCHEMA_VERSION,
        launchId: expected.launchId,
        sessionId: source.sessionId,
        runId: expected.runId,
        runStartedEventId: expected.runStartedEventId,
        runStartedSequence: firstAdvance.sequence,
      },
    };
  }
}

function pendingApprovals(entries: readonly RuntimeEventStoreEntry[]): string[] {
  const pending = new Set<string>();
  for (const { event } of entries) {
    if (event.kind === "approval.requested") {
      pending.add(event.data.approvalId);
    } else if (event.kind === "approval.settled") {
      pending.delete(event.data.approvalId);
    }
  }
  return [...pending].sort();
}

function pendingToolCalls(entries: readonly RuntimeEventStoreEntry[]): string[] {
  const pending = new Set<string>();
  for (const { event } of entries) {
    if (event.kind === "tool.started") {
      const toolCallId = event.refs?.toolCallId;
      if (typeof toolCallId !== "string" || !toolCallId.trim()) {
        throw new Error(`Runtime tool.started ${event.eventId} has no stable toolCallId`);
      }
      pending.add(toolCallId);
      continue;
    }
    if (event.kind === "tool.result.recorded" && event.data.projection.mode !== "synthetic") {
      pending.delete(event.refs.toolCallId);
    }
  }
  return [...pending].sort();
}
