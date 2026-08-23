import type {
  RuntimeActiveOverlayEntry,
  RuntimeParams,
  RuntimeQueuedInput,
  RuntimeResult,
  RuntimeRun,
  RuntimeSession,
  RuntimeTranscriptAdvanceCursor,
  RuntimeTranscriptChange,
  RuntimeTranscriptItemFragment,
  RuntimeTranscriptItemRecord,
  RuntimeTranscriptPageCursor,
  RuntimeTranscriptWatermark,
} from "./protocol.js";
import { canonicalizeWorkspacePath, resolvePicoPaths } from "../paths/pico-paths.js";
import type {
  RuntimeRunPartials,
  RuntimeTranscriptChangeCursor,
  RuntimeTranscriptAdvancePage,
  RuntimeTranscriptAdvancePageOptions,
  RuntimeTranscriptProjectionCursor,
  RuntimeTranscriptProjectedItemFragment,
  RuntimeTranscriptProjectionPage,
  RuntimeTranscriptProjectionPageOptions,
  RuntimeTranscriptProjectionWatermark,
} from "../storage/runtime-event-store-contracts.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type {
  SessionContinuityDataSource,
  SessionSubscriptionSnapshot,
} from "./session-subscription-owner.js";
import { parseActiveOverlayPayload } from "./session-active-overlay.js";

const DEFAULT_TAIL_LIMIT = 100;
const DEFAULT_PAGE_LIMIT = 100;
const DEFAULT_PAGE_BYTES = 512 * 1024;
const MAX_PAGE_LIMIT = 250;
const MAX_PAGE_BYTES = 768 * 1024;

interface ProjectionStore {
  readTranscriptWatermark(sessionId: string): Promise<RuntimeTranscriptProjectionWatermark>;
  readTranscriptProjectionPage(
    options: RuntimeTranscriptProjectionPageOptions,
  ): Promise<RuntimeTranscriptProjectionPage>;
  readTranscriptAdvancePage(
    options: RuntimeTranscriptAdvancePageOptions,
  ): Promise<RuntimeTranscriptAdvancePage>;
  readRunPartials(sessionId: string, runId: string): Promise<RuntimeRunPartials>;
  close(): void;
}

export interface SessionContinuityMetadata {
  readonly session: RuntimeSession;
  readonly queuedInputs: readonly RuntimeQueuedInput[];
  readonly activeRun?: RuntimeRun;
}

export interface SqliteSessionContinuitySourceOptions {
  readonly picoHome: string;
  readonly readMetadata: (
    workspacePath: string,
    sessionId: string,
  ) => Promise<SessionContinuityMetadata>;
}

/** Store-backed fixed-watermark read side used by Runtime Host session operations. */
export class SqliteSessionContinuitySource implements SessionContinuityDataSource {
  constructor(private readonly options: SqliteSessionContinuitySourceOptions) {}

  async readOpenSnapshot(
    params: RuntimeParams<"session.subscription.open">,
  ): Promise<SessionSubscriptionSnapshot> {
    const workspacePath = await canonicalizeWorkspacePath(params.workspacePath);
    const metadata = await this.options.readMetadata(workspacePath, params.sessionId);
    const store = this.openStore(workspacePath);
    try {
      const page = await store.readTranscriptProjectionPage({
        sessionId: params.sessionId,
        maxBytes: boundedBytes(params.maxBytes),
        limit: boundedLimit(params.tailLimit, DEFAULT_TAIL_LIMIT),
      });
      const activeOverlay = metadata.activeRun
        ? projectRunPartials(
            await store.readRunPartials(params.sessionId, metadata.activeRun.runId),
            metadata.activeRun.runId,
            page.watermark.throughSequence,
          )
        : [];
      return {
        session: metadata.session,
        watermark: watermark(page.watermark),
        durableTail: page.items.map(itemRecord),
        ...(page.fragments?.length
          ? { durableTailFragments: page.fragments.map(itemFragment) }
          : {}),
        activeOverlay,
        queuedInputs: metadata.queuedInputs,
        ...(metadata.activeRun ? { activeRun: metadata.activeRun } : {}),
        ...(page.nextCursor ? { olderCursor: pageCursor(page.nextCursor) } : {}),
      };
    } finally {
      store.close();
    }
  }

  async readTranscriptPage(
    params: RuntimeParams<"session.transcript.page">,
  ): Promise<RuntimeResult<"session.transcript.page">> {
    const workspacePath = await canonicalizeWorkspacePath(params.workspacePath);
    const store = this.openStore(workspacePath);
    try {
      const page = await store.readTranscriptProjectionPage({
        sessionId: params.sessionId,
        through: params.through,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        maxBytes: boundedBytes(params.maxBytes),
        limit: boundedLimit(params.limit, DEFAULT_PAGE_LIMIT),
      });
      return {
        watermark: watermark(page.watermark),
        items: page.items.map(itemRecord),
        ...(page.fragments?.length ? { fragments: page.fragments.map(itemFragment) } : {}),
        ...(page.nextCursor ? { nextCursor: pageCursor(page.nextCursor) } : {}),
      };
    } finally {
      store.close();
    }
  }

  async readTranscriptAdvance(
    params: RuntimeParams<"session.transcript.advance">,
  ): Promise<RuntimeResult<"session.transcript.advance">> {
    const workspacePath = await canonicalizeWorkspacePath(params.workspacePath);
    const store = this.openStore(workspacePath);
    try {
      const page = await store.readTranscriptAdvancePage({
        sessionId: params.sessionId,
        after: params.after,
        through: params.through,
        ...(params.cursor ? { cursor: params.cursor } : {}),
        maxBytes: boundedBytes(params.maxBytes),
        limit: boundedLimit(params.limit, DEFAULT_PAGE_LIMIT),
      });
      return {
        after: watermark(page.after),
        through: watermark(page.through),
        changes: page.changes.map(
          (change): RuntimeTranscriptChange =>
            change.op === "upsert"
              ? { op: "upsert", record: itemRecord(change.record) }
              : {
                  op: "remove",
                  itemId: change.itemId,
                  itemRevision: change.itemRevision,
                },
        ),
        ...(page.fragments?.length ? { fragments: page.fragments.map(itemFragment) } : {}),
        ...(page.nextCursor ? { nextCursor: advanceCursor(page.nextCursor) } : {}),
      };
    } finally {
      store.close();
    }
  }

  async readTranscriptWatermark(
    workspacePath: string,
    sessionId: string,
  ): Promise<RuntimeTranscriptWatermark> {
    const canonical = await canonicalizeWorkspacePath(workspacePath);
    const store = this.openStore(canonical);
    try {
      return watermark(await store.readTranscriptWatermark(sessionId));
    } finally {
      store.close();
    }
  }

  private openStore(workspacePath: string): ProjectionStore {
    const storageRoot = resolvePicoPaths(workspacePath, {
      picoHome: this.options.picoHome,
    }).workspace.root;
    // The projection methods are supplied by the frozen Store implementation in
    // the integration branch. Keeping this adapter structural avoids widening the
    // shared Store contract from the Host-owned branch.
    return new SqliteRuntimeEventStore({ storageRoot }) as unknown as ProjectionStore;
  }
}

function boundedLimit(value: number | undefined, fallback: number): number {
  return Math.max(1, Math.min(value ?? fallback, MAX_PAGE_LIMIT));
}

function boundedBytes(value: number | undefined): number {
  return Math.max(1024, Math.min(value ?? DEFAULT_PAGE_BYTES, MAX_PAGE_BYTES));
}

function watermark(value: RuntimeTranscriptProjectionWatermark): RuntimeTranscriptWatermark {
  return {
    historyEpoch: value.historyEpoch,
    projectorVersion: value.projectorVersion,
    throughSequence: value.throughSequence,
  };
}

function itemRecord(value: {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly payload: unknown;
}): RuntimeTranscriptItemRecord {
  return {
    itemId: value.itemId,
    itemRevision: value.itemRevision,
    positionSequence: value.positionSequence,
    positionOrdinal: value.positionOrdinal,
    item: value.payload as RuntimeTranscriptItemRecord["item"],
  };
}

function itemFragment(
  value: RuntimeTranscriptProjectedItemFragment,
): RuntimeTranscriptItemFragment {
  return {
    itemId: value.itemId,
    itemRevision: value.itemRevision,
    positionSequence: value.positionSequence,
    positionOrdinal: value.positionOrdinal,
    byteOffset: value.byteOffset,
    byteLength: value.byteLength,
    totalBytes: value.totalBytes,
    json: value.json,
  };
}

function pageCursor(value: RuntimeTranscriptProjectionCursor): RuntimeTranscriptPageCursor {
  return {
    historyEpoch: value.historyEpoch,
    projectorVersion: value.projectorVersion,
    throughSequence: value.throughSequence,
    positionSequence: value.positionSequence,
    positionOrdinal: value.positionOrdinal,
    byteOffset: value.byteOffset,
  };
}

function advanceCursor(value: RuntimeTranscriptChangeCursor): RuntimeTranscriptAdvanceCursor {
  return {
    historyEpoch: value.historyEpoch,
    projectorVersion: value.projectorVersion,
    fromSequence: value.fromSequence,
    throughSequence: value.throughSequence,
    changeSequence: value.changeSequence,
    ordinal: value.ordinal,
    byteOffset: value.byteOffset,
  };
}

function projectRunPartials(
  partials: RuntimeRunPartials,
  runId: string,
  anchorSequence: number,
): RuntimeActiveOverlayEntry[] {
  const entries = new Map<string, RuntimeActiveOverlayEntry>();
  for (const partial of [...partials.snapshots, ...partials.segments]) {
    const projected = activeOverlayEntry(partial.payload, runId, anchorSequence);
    if (projected) entries.set(projected.streamId, projected);
  }
  return [...entries.values()];
}

function activeOverlayEntry(
  value: unknown,
  runId: string,
  _anchorSequence: number,
): RuntimeActiveOverlayEntry | undefined {
  const candidate = parseActiveOverlayPayload(value);
  if (!candidate || candidate.runId !== runId) return undefined;
  return {
    runId,
    turnId: candidate.turnId,
    itemId: candidate.itemId,
    streamId: candidate.streamId,
    kind: candidate.kind,
    startOffsetBytes: candidate.startOffsetBytes,
    endOffsetBytes: candidate.endOffsetBytes,
    text: candidate.text,
    anchorSequence: candidate.anchorSequence,
    ...(candidate.stream ? { stream: candidate.stream } : {}),
    ...(candidate.truncatedBeforeBytes > 0
      ? { truncatedBeforeBytes: candidate.truncatedBeforeBytes }
      : {}),
    ...(candidate.complete ? { complete: true } : {}),
  };
}
