import {
  TRANSCRIPT_PROJECTOR_VERSION,
  type RuntimeActiveOverlayEntry,
  type RuntimeQueuedInput,
  type RuntimeResult,
  type RuntimeRun,
  type RuntimeSessionSubscriptionFrame,
  type RuntimeTranscriptAdvanceCursor,
  type RuntimeTranscriptChange,
  type RuntimeTranscriptItemFragment,
  type RuntimeTranscriptItemRecord,
  type RuntimeTranscriptPageCursor,
  type RuntimeTranscriptWatermark,
} from "@pico/protocol";

const DEFAULT_MAX_EARLY_FRAMES = 512;
const DEFAULT_MAX_EARLY_FRAME_BYTES = 1024 * 1024;

export type TranscriptReplicaPhase = "idle" | "opening" | "ready" | "recovering";

export type TranscriptReplicaRecoveryReason =
  | "early_frame_overflow"
  | "history_epoch_changed"
  | "projector_version_changed"
  | "sequence_gap"
  | "utf8_offset_gap"
  | "advance_gap"
  | "continuity_degraded"
  | "subscription_closed"
  | "invalid_open";

export interface TranscriptReplicaOptions {
  readonly maxEarlyFrames?: number;
  readonly maxEarlyFrameBytes?: number;
}

export interface TranscriptReplicaView {
  readonly phase: TranscriptReplicaPhase;
  readonly generation: number;
  readonly sessionId: string;
  readonly hostEpoch?: string;
  readonly subscriptionId?: string;
  readonly nextSequence?: number;
  readonly watermark?: RuntimeTranscriptWatermark;
  readonly pendingWatermark?: RuntimeTranscriptWatermark;
  readonly records: readonly RuntimeTranscriptItemRecord[];
  readonly activeOverlay: readonly RuntimeActiveOverlayEntry[];
  readonly queuedInputs: readonly RuntimeQueuedInput[];
  readonly activeRun?: RuntimeRun;
  readonly olderCursor?: RuntimeTranscriptPageCursor;
  readonly recoveryReason?: TranscriptReplicaRecoveryReason;
}

export interface TranscriptReplicaOpenToken {
  readonly generation: number;
}

export interface TranscriptReplicaAdvanceRequest {
  readonly token: number;
  readonly generation: number;
  readonly after: RuntimeTranscriptWatermark;
  readonly through: RuntimeTranscriptWatermark;
  readonly cursor?: RuntimeTranscriptAdvanceCursor;
}

export interface TranscriptReplicaOlderRequest {
  readonly generation: number;
  readonly through: RuntimeTranscriptWatermark;
  readonly cursor: RuntimeTranscriptPageCursor;
}

export type TranscriptReplicaFrameResult =
  | { readonly kind: "buffered" | "applied" | "ignored" }
  | { readonly kind: "recovering"; readonly reason: TranscriptReplicaRecoveryReason };

export type TranscriptReplicaAdvanceResult =
  | { readonly kind: "ignored" | "applied" }
  | { readonly kind: "next"; readonly request: TranscriptReplicaAdvanceRequest }
  | { readonly kind: "recovering"; readonly reason: TranscriptReplicaRecoveryReason };

interface AdvanceState {
  readonly token: number;
  readonly generation: number;
  readonly after: RuntimeTranscriptWatermark;
  readonly through: RuntimeTranscriptWatermark;
  readonly changes: RuntimeTranscriptChange[];
  readonly fragments: Map<string, ItemFragmentAssembly>;
  cursor?: RuntimeTranscriptAdvanceCursor;
}

interface ItemFragmentAssembly {
  readonly itemId: string;
  readonly itemRevision: number;
  readonly positionSequence: number;
  readonly positionOrdinal: number;
  readonly totalBytes: number;
  json: string;
  byteLength: number;
}

interface OpenDraft {
  readonly records: Map<string, RuntimeTranscriptItemRecord>;
  readonly revisions: Map<string, number>;
  readonly overlays: Map<string, RuntimeActiveOverlayEntry>;
  readonly watermark: RuntimeTranscriptWatermark;
  pendingWatermark?: RuntimeTranscriptWatermark;
  readonly hostEpoch: string;
  readonly subscriptionId: string;
  nextSequence: number;
  activeRun?: RuntimeRun;
}

export class TranscriptReplica {
  readonly #sessionId: string;
  readonly #maxEarlyFrames: number;
  readonly #maxEarlyFrameBytes: number;
  #phase: TranscriptReplicaPhase = "idle";
  #generation = 0;
  #nextOperationToken = 1;
  #hostEpoch: string | undefined;
  #subscriptionId: string | undefined;
  #nextSequence: number | undefined;
  #watermark: RuntimeTranscriptWatermark | undefined;
  #pendingWatermark: RuntimeTranscriptWatermark | undefined;
  #records = new Map<string, RuntimeTranscriptItemRecord>();
  #revisions = new Map<string, number>();
  #overlays = new Map<string, RuntimeActiveOverlayEntry>();
  #queuedInputs: readonly RuntimeQueuedInput[] = [];
  #activeRun: RuntimeRun | undefined;
  #olderCursor: RuntimeTranscriptPageCursor | undefined;
  #recoveryReason: TranscriptReplicaRecoveryReason | undefined;
  #earlyFrames: RuntimeSessionSubscriptionFrame[] = [];
  #earlyFrameBytes = 0;
  #advance: AdvanceState | undefined;
  #pageFragments = new Map<string, ItemFragmentAssembly>();

  constructor(sessionId: string, options: TranscriptReplicaOptions = {}) {
    if (!sessionId) throw new Error("TranscriptReplica requires a sessionId");
    this.#sessionId = sessionId;
    this.#maxEarlyFrames = positiveLimit(
      options.maxEarlyFrames,
      DEFAULT_MAX_EARLY_FRAMES,
      "maxEarlyFrames",
    );
    this.#maxEarlyFrameBytes = positiveLimit(
      options.maxEarlyFrameBytes,
      DEFAULT_MAX_EARLY_FRAME_BYTES,
      "maxEarlyFrameBytes",
    );
  }

  get view(): TranscriptReplicaView {
    return {
      phase: this.#phase,
      generation: this.#generation,
      sessionId: this.#sessionId,
      ...(this.#hostEpoch ? { hostEpoch: this.#hostEpoch } : {}),
      ...(this.#subscriptionId ? { subscriptionId: this.#subscriptionId } : {}),
      ...(this.#nextSequence !== undefined ? { nextSequence: this.#nextSequence } : {}),
      ...(this.#watermark ? { watermark: this.#watermark } : {}),
      ...(this.#pendingWatermark ? { pendingWatermark: this.#pendingWatermark } : {}),
      records: orderedRecords(this.#records.values()),
      activeOverlay: [...this.#overlays.values()].toSorted(compareOverlay),
      queuedInputs: this.#queuedInputs,
      ...(this.#activeRun ? { activeRun: this.#activeRun } : {}),
      ...(this.#olderCursor ? { olderCursor: this.#olderCursor } : {}),
      ...(this.#recoveryReason ? { recoveryReason: this.#recoveryReason } : {}),
    };
  }

  beginOpen(): TranscriptReplicaOpenToken {
    this.#generation += 1;
    this.#phase = "opening";
    this.#recoveryReason = undefined;
    this.#earlyFrames = [];
    this.#earlyFrameBytes = 0;
    this.#advance = undefined;
    this.#pageFragments = new Map();
    return { generation: this.#generation };
  }

  installOpen(
    token: TranscriptReplicaOpenToken,
    result: RuntimeResult<"session.subscription.open">,
  ): boolean {
    if (token.generation !== this.#generation || this.#phase !== "opening") return false;
    try {
      assertOpenResult(this.#sessionId, result);
      // open 是权威快照边界。即使 history epoch 未变，断线期间也可能发生
      // remove；保留旧 records 会让已删除条目永久复活。
      const records = new Map<string, RuntimeTranscriptItemRecord>();
      const revisions = new Map<string, number>();
      mergeRecords(records, revisions, result.durableTail);
      const pageFragments = new Map<string, ItemFragmentAssembly>();
      mergeRecords(
        records,
        revisions,
        consumeItemFragments(pageFragments, result.durableTailFragments ?? []),
      );
      if (pageFragments.size > 0 && !result.olderCursor) {
        throw new Error("Open transcript fragment is incomplete without an older cursor");
      }
      const overlays = new Map<string, RuntimeActiveOverlayEntry>();
      for (const overlay of result.activeOverlay) {
        assertOverlay(overlay);
        overlays.set(overlayKey(overlay.runId, overlay.streamId), overlay);
      }
      const draft: OpenDraft = {
        records,
        revisions,
        overlays,
        watermark: result.watermark,
        hostEpoch: result.hostEpoch,
        subscriptionId: result.subscriptionId,
        nextSequence: result.nextSequence,
        ...(result.activeRun ? { activeRun: result.activeRun } : {}),
      };
      for (const frame of this.#earlyFrames) {
        const outcome = applyFrameToDraft(draft, frame);
        if (outcome === "gap") {
          this.enterRecovering(frameGapReason(draft, frame));
          return false;
        }
      }
      this.#records = draft.records;
      this.#revisions = draft.revisions;
      this.#overlays = draft.overlays;
      this.#watermark = draft.watermark;
      this.#pendingWatermark = draft.pendingWatermark;
      this.#hostEpoch = draft.hostEpoch;
      this.#subscriptionId = draft.subscriptionId;
      this.#nextSequence = draft.nextSequence;
      this.#queuedInputs = result.queuedInputs;
      this.#activeRun = draft.activeRun;
      this.#olderCursor = result.olderCursor;
      this.#pageFragments = pageFragments;
      this.#earlyFrames = [];
      this.#earlyFrameBytes = 0;
      if (result.continuityDegradedReason) {
        this.enterRecovering("continuity_degraded");
        return false;
      }
      this.#phase = "ready";
      return true;
    } catch {
      this.enterRecovering("invalid_open");
      return false;
    }
  }

  failOpen(token: TranscriptReplicaOpenToken): void {
    if (token.generation !== this.#generation || this.#phase !== "opening") return;
    this.enterRecovering("invalid_open");
  }

  receiveFrame(frame: RuntimeSessionSubscriptionFrame): TranscriptReplicaFrameResult {
    if (frame.sessionId !== this.#sessionId) return { kind: "ignored" };
    if (this.#phase === "opening") return this.bufferEarlyFrame(frame);
    if (this.#phase !== "ready") return { kind: "ignored" };
    if (frame.hostEpoch !== this.#hostEpoch || frame.subscriptionId !== this.#subscriptionId) {
      return { kind: "ignored" };
    }
    const expected = this.#nextSequence;
    if (expected === undefined) return this.recover("sequence_gap");
    if (frame.sequence < expected) return { kind: "ignored" };
    if (frame.sequence > expected) return this.recover("sequence_gap");
    const draft = this.currentDraft();
    const outcome = applyFrameToDraft(draft, frame);
    if (outcome === "gap") return this.recover(frameGapReason(draft, frame));
    this.installDraftFrameState(draft);
    return { kind: "applied" };
  }

  beginAdvance(
    through: RuntimeTranscriptWatermark | undefined = this.#pendingWatermark,
  ): TranscriptReplicaAdvanceRequest | undefined {
    if (this.#phase !== "ready" || this.#advance || !this.#watermark || !through) return undefined;
    if (!sameHistoryIdentity(this.#watermark, through)) {
      this.enterRecovering(
        this.#watermark.historyEpoch !== through.historyEpoch
          ? "history_epoch_changed"
          : "projector_version_changed",
      );
      return undefined;
    }
    if (through.throughSequence <= this.#watermark.throughSequence) {
      if (
        this.#pendingWatermark &&
        this.#pendingWatermark.throughSequence <= this.#watermark.throughSequence
      ) {
        this.#pendingWatermark = undefined;
      }
      return undefined;
    }
    const advance: AdvanceState = {
      token: this.#nextOperationToken++,
      generation: this.#generation,
      after: this.#watermark,
      through,
      changes: [],
      fragments: new Map(),
    };
    this.#advance = advance;
    return advanceRequest(advance);
  }

  applyAdvancePage(
    request: TranscriptReplicaAdvanceRequest,
    page: RuntimeResult<"session.transcript.advance">,
  ): TranscriptReplicaAdvanceResult {
    const advance = this.#advance;
    if (
      !advance ||
      this.#phase !== "ready" ||
      request.generation !== this.#generation ||
      request.generation !== advance.generation ||
      request.token !== advance.token ||
      !sameOptionalAdvanceCursor(request.cursor, advance.cursor)
    ) {
      return { kind: "ignored" };
    }
    if (
      !sameWatermark(page.after, advance.after) ||
      !sameWatermark(page.through, advance.through)
    ) {
      return this.recover("advance_gap");
    }
    try {
      const completed = consumeItemFragments(advance.fragments, page.fragments ?? []);
      advance.changes.push(
        ...completed.map((record): RuntimeTranscriptChange => ({ op: "upsert", record })),
        ...page.changes,
      );
    } catch {
      return this.recover("advance_gap");
    }
    if (page.nextCursor) {
      if (!validNextAdvanceCursor(page.nextCursor, advance)) {
        return this.recover("advance_gap");
      }
      advance.cursor = page.nextCursor;
      return { kind: "next", request: advanceRequest(advance) };
    }
    if (advance.fragments.size > 0) return this.recover("advance_gap");
    const records = new Map(this.#records);
    const revisions = new Map(this.#revisions);
    applyChanges(records, revisions, advance.changes);
    this.#records = records;
    this.#revisions = revisions;
    this.#watermark = advance.through;
    const changedItemIds = new Set(
      advance.changes.map((change) =>
        change.op === "upsert" ? change.record.itemId : change.itemId,
      ),
    );
    for (const [key, overlay] of this.#overlays) {
      if (changedItemIds.has(overlay.itemId)) this.#overlays.delete(key);
    }
    if (
      this.#pendingWatermark &&
      this.#pendingWatermark.throughSequence <= advance.through.throughSequence
    ) {
      this.#pendingWatermark = undefined;
    }
    this.#advance = undefined;
    return { kind: "applied" };
  }

  beginOlderPage(): TranscriptReplicaOlderRequest | undefined {
    if (this.#phase !== "ready" || !this.#olderCursor) return undefined;
    return {
      generation: this.#generation,
      through: watermarkForPageCursor(this.#olderCursor),
      cursor: this.#olderCursor,
    };
  }

  applyOlderPage(
    request: TranscriptReplicaOlderRequest,
    page: RuntimeResult<"session.transcript.page">,
  ): "applied" | "ignored" | "recovering" {
    if (
      this.#phase !== "ready" ||
      request.generation !== this.#generation ||
      !this.#olderCursor ||
      !samePageCursor(request.cursor, this.#olderCursor)
    ) {
      return "ignored";
    }
    if (!sameWatermark(request.through, page.watermark)) {
      this.enterRecovering("advance_gap");
      return "recovering";
    }
    if (page.nextCursor && !validNextPageCursor(page.nextCursor, request.cursor)) {
      this.enterRecovering("advance_gap");
      return "recovering";
    }
    const records = new Map(this.#records);
    const revisions = new Map(this.#revisions);
    const fragments = cloneItemFragmentAssemblies(this.#pageFragments);
    try {
      mergeRecords(records, revisions, [
        ...consumeItemFragments(fragments, page.fragments ?? []),
        ...page.items,
      ]);
    } catch {
      this.enterRecovering("advance_gap");
      return "recovering";
    }
    if (fragments.size > 0 && !page.nextCursor) {
      this.enterRecovering("advance_gap");
      return "recovering";
    }
    this.#records = records;
    this.#revisions = revisions;
    this.#pageFragments = fragments;
    this.#olderCursor = page.nextCursor;
    return "applied";
  }

  reset(): void {
    this.#generation += 1;
    this.#phase = "idle";
    this.#hostEpoch = undefined;
    this.#subscriptionId = undefined;
    this.#nextSequence = undefined;
    this.#watermark = undefined;
    this.#pendingWatermark = undefined;
    this.#records.clear();
    this.#revisions.clear();
    this.#overlays.clear();
    this.#queuedInputs = [];
    this.#activeRun = undefined;
    this.#olderCursor = undefined;
    this.#recoveryReason = undefined;
    this.#earlyFrames = [];
    this.#earlyFrameBytes = 0;
    this.#advance = undefined;
    this.#pageFragments.clear();
  }

  private bufferEarlyFrame(frame: RuntimeSessionSubscriptionFrame): TranscriptReplicaFrameResult {
    const bytes = utf8Bytes(JSON.stringify(frame));
    if (
      this.#earlyFrames.length + 1 > this.#maxEarlyFrames ||
      this.#earlyFrameBytes + bytes > this.#maxEarlyFrameBytes
    ) {
      return this.recover("early_frame_overflow");
    }
    this.#earlyFrames.push(frame);
    this.#earlyFrameBytes += bytes;
    return { kind: "buffered" };
  }

  private currentDraft(): OpenDraft {
    return {
      records: new Map(this.#records),
      revisions: new Map(this.#revisions),
      overlays: new Map(this.#overlays),
      watermark: this.#watermark!,
      ...(this.#pendingWatermark ? { pendingWatermark: this.#pendingWatermark } : {}),
      hostEpoch: this.#hostEpoch!,
      subscriptionId: this.#subscriptionId!,
      nextSequence: this.#nextSequence!,
      ...(this.#activeRun ? { activeRun: this.#activeRun } : {}),
    };
  }

  private installDraftFrameState(draft: OpenDraft): void {
    this.#overlays = draft.overlays;
    this.#watermark = draft.watermark;
    this.#pendingWatermark = draft.pendingWatermark;
    this.#nextSequence = draft.nextSequence;
    this.#activeRun = draft.activeRun;
  }

  private recover(reason: TranscriptReplicaRecoveryReason): TranscriptReplicaFrameResult & {
    readonly kind: "recovering";
  } {
    this.enterRecovering(reason);
    return { kind: "recovering", reason };
  }

  private enterRecovering(reason: TranscriptReplicaRecoveryReason): void {
    this.#generation += 1;
    this.#phase = "recovering";
    this.#recoveryReason = reason;
    this.#advance = undefined;
    this.#earlyFrames = [];
    this.#earlyFrameBytes = 0;
  }
}

function applyFrameToDraft(
  draft: OpenDraft,
  frame: RuntimeSessionSubscriptionFrame,
): "applied" | "ignored" | "gap" {
  if (frame.hostEpoch !== draft.hostEpoch || frame.subscriptionId !== draft.subscriptionId) {
    return "ignored";
  }
  if (frame.sequence < draft.nextSequence) return "ignored";
  if (frame.sequence > draft.nextSequence) return "gap";
  draft.nextSequence += 1;
  switch (frame.type) {
    case "subscription.session_delta": {
      const key = overlayKey(frame.runId, frame.streamId);
      if (frame.reset && frame.text === "") {
        draft.overlays.delete(key);
        return "applied";
      }
      const current = draft.overlays.get(key);
      const bytes = utf8Bytes(frame.text);
      if (!frame.reset) {
        const expectedOffset = current?.endOffsetBytes ?? 0;
        if (frame.startOffsetBytes !== expectedOffset) return "gap";
      }
      const startOffsetBytes = frame.reset
        ? frame.startOffsetBytes
        : (current?.startOffsetBytes ?? 0);
      const text = frame.reset ? frame.text : `${current?.text ?? ""}${frame.text}`;
      draft.overlays.set(key, {
        runId: frame.runId,
        turnId: frame.turnId,
        itemId: frame.itemId,
        streamId: frame.streamId,
        kind: frame.kind,
        startOffsetBytes,
        endOffsetBytes: frame.startOffsetBytes + bytes,
        text,
        anchorSequence: current?.anchorSequence ?? frame.sequence,
        ...(frame.stream ? { stream: frame.stream } : {}),
        ...(startOffsetBytes > 0 ? { truncatedBeforeBytes: startOffsetBytes } : {}),
        ...(frame.complete ? { complete: true } : {}),
      });
      return "applied";
    }
    case "subscription.run_state":
      draft.activeRun = frame.run;
      if (["cancelled", "failed", "succeeded"].includes(frame.run.status)) {
        for (const [key, overlay] of draft.overlays) {
          if (overlay.runId === frame.run.runId) draft.overlays.delete(key);
        }
      }
      return "applied";
    case "subscription.transcript_advanced":
      if (!sameHistoryIdentity(draft.watermark, frame.watermark)) return "gap";
      if (frame.watermark.throughSequence > draft.watermark.throughSequence) {
        if (
          !draft.pendingWatermark ||
          frame.watermark.throughSequence > draft.pendingWatermark.throughSequence
        ) {
          draft.pendingWatermark = frame.watermark;
        }
      }
      return "applied";
    case "subscription.continuity_degraded":
    case "subscription.closed":
      return "gap";
    case "subscription.tool_event":
    case "subscription.subagent_update":
      return "applied";
  }
}

function frameGapReason(
  draft: OpenDraft,
  frame: RuntimeSessionSubscriptionFrame,
): TranscriptReplicaRecoveryReason {
  if (frame.type === "subscription.continuity_degraded") return "continuity_degraded";
  if (frame.type === "subscription.closed") return "subscription_closed";
  if (
    frame.type === "subscription.transcript_advanced" &&
    frame.watermark.historyEpoch !== draft.watermark.historyEpoch
  ) {
    return "history_epoch_changed";
  }
  if (
    frame.type === "subscription.transcript_advanced" &&
    frame.watermark.projectorVersion !== draft.watermark.projectorVersion
  ) {
    return "projector_version_changed";
  }
  if (frame.sequence !== draft.nextSequence - 1) return "sequence_gap";
  return "utf8_offset_gap";
}

function assertOpenResult(
  sessionId: string,
  result: RuntimeResult<"session.subscription.open">,
): void {
  if (result.session.sessionId !== sessionId)
    throw new Error("Session identity changed during open");
  if (!result.hostEpoch || !result.subscriptionId || result.nextSequence < 1) {
    throw new Error("Subscription identity is invalid");
  }
  assertWatermark(result.watermark);
  for (const record of result.durableTail) assertRecord(record);
  for (const fragment of result.durableTailFragments ?? []) assertItemFragment(fragment);
  if (result.olderCursor) {
    if (
      result.olderCursor.historyEpoch !== result.watermark.historyEpoch ||
      result.olderCursor.projectorVersion !== result.watermark.projectorVersion ||
      result.olderCursor.throughSequence !== result.watermark.throughSequence
    ) {
      throw new Error("Older cursor does not belong to the open watermark");
    }
  }
}

function assertWatermark(watermark: RuntimeTranscriptWatermark): void {
  if (
    !watermark.historyEpoch ||
    watermark.projectorVersion !== TRANSCRIPT_PROJECTOR_VERSION ||
    !Number.isSafeInteger(watermark.throughSequence) ||
    watermark.throughSequence < 0
  ) {
    throw new Error("Transcript watermark is invalid");
  }
}

function assertRecord(record: RuntimeTranscriptItemRecord): void {
  if (
    !record.itemId ||
    record.item.id !== record.itemId ||
    !Number.isSafeInteger(record.itemRevision) ||
    record.itemRevision < 0 ||
    !Number.isSafeInteger(record.positionSequence) ||
    record.positionSequence < 0 ||
    !Number.isSafeInteger(record.positionOrdinal) ||
    record.positionOrdinal < 0
  ) {
    throw new Error("Transcript item record is invalid");
  }
}

function assertItemFragment(fragment: RuntimeTranscriptItemFragment): void {
  if (
    !fragment.itemId ||
    !Number.isSafeInteger(fragment.itemRevision) ||
    fragment.itemRevision < 1 ||
    !Number.isSafeInteger(fragment.positionSequence) ||
    fragment.positionSequence < 0 ||
    !Number.isSafeInteger(fragment.positionOrdinal) ||
    fragment.positionOrdinal < 0 ||
    !Number.isSafeInteger(fragment.byteOffset) ||
    fragment.byteOffset < 0 ||
    !Number.isSafeInteger(fragment.byteLength) ||
    fragment.byteLength < 1 ||
    !Number.isSafeInteger(fragment.totalBytes) ||
    fragment.totalBytes < 1 ||
    fragment.byteOffset + fragment.byteLength > fragment.totalBytes ||
    utf8Bytes(fragment.json) !== fragment.byteLength
  ) {
    throw new Error("Transcript item fragment is invalid");
  }
}

function consumeItemFragments(
  assemblies: Map<string, ItemFragmentAssembly>,
  fragments: readonly RuntimeTranscriptItemFragment[],
): RuntimeTranscriptItemRecord[] {
  const completed: RuntimeTranscriptItemRecord[] = [];
  for (const fragment of fragments) {
    assertItemFragment(fragment);
    const current = assemblies.get(fragment.itemId);
    if (!current) {
      if (fragment.byteOffset !== 0) throw new Error("Transcript item fragment starts with a gap");
      assemblies.set(fragment.itemId, {
        itemId: fragment.itemId,
        itemRevision: fragment.itemRevision,
        positionSequence: fragment.positionSequence,
        positionOrdinal: fragment.positionOrdinal,
        totalBytes: fragment.totalBytes,
        json: fragment.json,
        byteLength: fragment.byteLength,
      });
    } else {
      if (
        current.itemRevision !== fragment.itemRevision ||
        current.positionSequence !== fragment.positionSequence ||
        current.positionOrdinal !== fragment.positionOrdinal ||
        current.totalBytes !== fragment.totalBytes ||
        current.byteLength !== fragment.byteOffset
      ) {
        throw new Error("Transcript item fragments overlap, gap, or change identity");
      }
      current.json += fragment.json;
      current.byteLength += fragment.byteLength;
    }
    const assembled = assemblies.get(fragment.itemId)!;
    if (assembled.byteLength !== utf8Bytes(assembled.json)) {
      throw new Error("Transcript item fragment UTF-8 length drifted while assembling");
    }
    if (assembled.byteLength === assembled.totalBytes) {
      const record: RuntimeTranscriptItemRecord = {
        itemId: assembled.itemId,
        itemRevision: assembled.itemRevision,
        positionSequence: assembled.positionSequence,
        positionOrdinal: assembled.positionOrdinal,
        item: JSON.parse(assembled.json) as RuntimeTranscriptItemRecord["item"],
      };
      assertRecord(record);
      assemblies.delete(fragment.itemId);
      completed.push(record);
    }
  }
  return completed;
}

function cloneItemFragmentAssemblies(
  source: ReadonlyMap<string, ItemFragmentAssembly>,
): Map<string, ItemFragmentAssembly> {
  return new Map([...source].map(([key, value]) => [key, { ...value }]));
}

function assertOverlay(overlay: RuntimeActiveOverlayEntry): void {
  const bytes = utf8Bytes(overlay.text);
  if (
    overlay.startOffsetBytes < 0 ||
    overlay.endOffsetBytes !== overlay.startOffsetBytes + bytes ||
    (overlay.truncatedBeforeBytes !== undefined &&
      overlay.truncatedBeforeBytes !== overlay.startOffsetBytes)
  ) {
    throw new Error("Transcript active overlay byte range is invalid");
  }
}

function mergeRecords(
  records: Map<string, RuntimeTranscriptItemRecord>,
  revisions: Map<string, number>,
  incoming: readonly RuntimeTranscriptItemRecord[],
): void {
  for (const record of incoming) {
    assertRecord(record);
    const knownRevision = revisions.get(record.itemId) ?? -1;
    if (record.itemRevision <= knownRevision) continue;
    records.set(record.itemId, record);
    revisions.set(record.itemId, record.itemRevision);
  }
}

function applyChanges(
  records: Map<string, RuntimeTranscriptItemRecord>,
  revisions: Map<string, number>,
  changes: readonly RuntimeTranscriptChange[],
): void {
  for (const change of changes) {
    if (change.op === "upsert") {
      mergeRecords(records, revisions, [change.record]);
      continue;
    }
    const knownRevision = revisions.get(change.itemId) ?? -1;
    if (change.itemRevision <= knownRevision) continue;
    records.delete(change.itemId);
    revisions.set(change.itemId, change.itemRevision);
  }
}

function orderedRecords(
  records: Iterable<RuntimeTranscriptItemRecord>,
): RuntimeTranscriptItemRecord[] {
  return [...records].toSorted(
    (left, right) =>
      left.positionSequence - right.positionSequence ||
      left.positionOrdinal - right.positionOrdinal ||
      left.itemId.localeCompare(right.itemId),
  );
}

function compareOverlay(left: RuntimeActiveOverlayEntry, right: RuntimeActiveOverlayEntry): number {
  return (
    left.anchorSequence - right.anchorSequence ||
    left.itemId.localeCompare(right.itemId) ||
    left.streamId.localeCompare(right.streamId)
  );
}

function advanceRequest(advance: AdvanceState): TranscriptReplicaAdvanceRequest {
  return {
    token: advance.token,
    generation: advance.generation,
    after: advance.after,
    through: advance.through,
    ...(advance.cursor ? { cursor: advance.cursor } : {}),
  };
}

function validNextAdvanceCursor(
  next: RuntimeTranscriptAdvanceCursor,
  advance: AdvanceState,
): boolean {
  if (
    next.historyEpoch !== advance.through.historyEpoch ||
    next.projectorVersion !== advance.through.projectorVersion ||
    next.fromSequence !== advance.after.throughSequence ||
    next.throughSequence !== advance.through.throughSequence ||
    next.changeSequence < next.fromSequence ||
    next.changeSequence > next.throughSequence
  ) {
    return false;
  }
  const previous = advance.cursor;
  if (!previous) return true;
  return compareAdvanceCursor(next, previous) > 0;
}

function validNextPageCursor(
  next: RuntimeTranscriptPageCursor,
  previous: RuntimeTranscriptPageCursor,
): boolean {
  if (
    next.historyEpoch !== previous.historyEpoch ||
    next.projectorVersion !== previous.projectorVersion ||
    next.throughSequence !== previous.throughSequence
  ) {
    return false;
  }
  if (
    next.positionSequence === previous.positionSequence &&
    next.positionOrdinal === previous.positionOrdinal
  ) {
    return next.byteOffset > previous.byteOffset;
  }
  return (
    next.positionSequence < previous.positionSequence ||
    (next.positionSequence === previous.positionSequence &&
      next.positionOrdinal < previous.positionOrdinal)
  );
}

function compareAdvanceCursor(
  left: RuntimeTranscriptAdvanceCursor,
  right: RuntimeTranscriptAdvanceCursor,
): number {
  return (
    left.changeSequence - right.changeSequence ||
    left.ordinal - right.ordinal ||
    left.byteOffset - right.byteOffset
  );
}

function sameOptionalAdvanceCursor(
  left: RuntimeTranscriptAdvanceCursor | undefined,
  right: RuntimeTranscriptAdvanceCursor | undefined,
): boolean {
  if (!left || !right) return left === right;
  return (
    left.historyEpoch === right.historyEpoch &&
    left.projectorVersion === right.projectorVersion &&
    left.fromSequence === right.fromSequence &&
    left.throughSequence === right.throughSequence &&
    left.changeSequence === right.changeSequence &&
    left.ordinal === right.ordinal &&
    left.byteOffset === right.byteOffset
  );
}

function samePageCursor(
  left: RuntimeTranscriptPageCursor,
  right: RuntimeTranscriptPageCursor,
): boolean {
  return (
    left.historyEpoch === right.historyEpoch &&
    left.projectorVersion === right.projectorVersion &&
    left.throughSequence === right.throughSequence &&
    left.positionSequence === right.positionSequence &&
    left.positionOrdinal === right.positionOrdinal &&
    left.byteOffset === right.byteOffset
  );
}

function watermarkForPageCursor(cursor: RuntimeTranscriptPageCursor): RuntimeTranscriptWatermark {
  return {
    historyEpoch: cursor.historyEpoch,
    projectorVersion: cursor.projectorVersion,
    throughSequence: cursor.throughSequence,
  };
}

function sameHistoryIdentity(
  left: RuntimeTranscriptWatermark,
  right: RuntimeTranscriptWatermark,
): boolean {
  return (
    left.historyEpoch === right.historyEpoch && left.projectorVersion === right.projectorVersion
  );
}

function sameWatermark(
  left: RuntimeTranscriptWatermark,
  right: RuntimeTranscriptWatermark,
): boolean {
  return sameHistoryIdentity(left, right) && left.throughSequence === right.throughSequence;
}

function overlayKey(runId: string, streamId: string): string {
  return `${runId}\u0000${streamId}`;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function positiveLimit(value: number | undefined, fallback: number, name: string): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1) {
    throw new Error(`TranscriptReplica ${name} must be a positive integer`);
  }
  return normalized;
}
