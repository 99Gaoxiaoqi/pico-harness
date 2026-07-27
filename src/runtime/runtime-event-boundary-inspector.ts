import type { RuntimeEvent } from "../storage/runtime-event.js";
import type { RuntimeEventStore, RuntimeEventStoreEntry } from "../storage/runtime-event-store.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import type {
  RuntimeBoundaryInspection,
  RuntimeBoundaryInspector,
} from "./safe-boundary-resume.js";
import type { TaskRuntimeBoundary } from "../tasks/task-run-contract.js";

export interface RuntimeEventBoundaryInspectorOptions {
  readonly store: Pick<RuntimeEventStore, "readSessionEntries" | "readSessionManifest">;
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
    const entries = await this.options.store.readSessionEntries(boundary.sessionId);
    const runEntries = entries.filter(({ event }) => event.runId === boundary.runId);
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
      eventHighWater: entries.at(-1)?.sequence ?? 0,
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
    if (event.kind === "tool.started" && event.refs?.toolCallId) {
      pending.add(event.refs.toolCallId);
      continue;
    }
    if (
      event.kind === "message.committed" &&
      event.data.message.role === "user" &&
      event.data.message.toolCallId &&
      event.data.message.providerData?.["picoKind"] !== "synthetic_tool_result"
    ) {
      pending.delete(event.data.message.toolCallId);
    }
  }
  return [...pending].sort();
}
