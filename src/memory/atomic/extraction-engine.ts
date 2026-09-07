import { createHash } from "node:crypto";
import {
  normalizeLongTermMemoryContent,
  validateMemoryTemporalBounds,
  type MemoryExtractionFailureClass,
  type MemoryExtractionReceipt,
  type MemoryItemWrite,
} from "./contracts.js";
import type {
  AtomicMemoryEngineOptions,
  AtomicMemoryResult,
  MemoryCheckpointBoundary,
  MemoryEvidenceEvent,
  MemoryExtractionSnapshot,
  MemoryModelRequest,
} from "./runtime-contracts.js";
import {
  evidenceSource,
  fitAtomicMemoryEvidence,
  localizeAtomicMemoryHistory,
  memoryConversationMessages,
  memoryEvidenceCoverageHash,
  memoryInterpretationContext,
  memoryTextContainsSecret,
  normalizeEvidenceText,
  projectAtomicMemoryEvidence,
  renderAtomicMemoryEvidence,
  type AtomicMemoryEvidence,
} from "./extraction-evidence.js";
import {
  canonicalizationPrompt,
  parseMemoryCanonicalization,
  parseMemoryProposal,
  proposalPrompt,
  type CanonicalMemoryItem,
  type MemoryCitation,
  type MemoryProposalItem,
} from "./extraction-proposal.js";

export { memoryEvidenceCoverageHash } from "./extraction-evidence.js";

interface Range {
  readonly snapshot: MemoryExtractionSnapshot;
  readonly operationId: string;
  readonly after: number;
  readonly through: number;
  readonly coverageHash: string;
  readonly historyAfter: number;
}

type Outcome =
  | {
      readonly kind: "committed";
      readonly receipt: MemoryExtractionReceipt;
      readonly through: number;
    }
  | { readonly kind: "blocked"; readonly reason: string }
  | {
      readonly kind: "failed";
      readonly failureClass: MemoryExtractionFailureClass;
      readonly range: Range;
    };

interface Budget {
  remaining: number;
  localized: boolean;
}
interface Candidate {
  readonly candidateId: string;
  readonly requested: boolean;
  readonly item: MemoryProposalItem;
  readonly evidence: ReadonlyMap<string, AtomicMemoryEvidence>;
}

/** Host owns Session serialization; this engine owns evidence, bounded inference and settlement. */
export class AtomicMemoryExtractionEngine {
  constructor(private readonly options: AtomicMemoryEngineOptions) {}

  async execute(input: MemoryExtractionSnapshot): Promise<AtomicMemoryResult> {
    try {
      const snapshot = freezeSnapshot(input);
      if (!snapshot) return unavailable("invalid_source_boundary");
      return await this.executeFrozen(snapshot);
    } catch {
      // Persistence/configuration failures must never be recorded as bad user evidence.
      return unavailable("unavailable");
    }
  }

  private async executeFrozen(snapshot: MemoryExtractionSnapshot): Promise<AtomicMemoryResult> {
    const store = this.options.store;
    const operationId = extractionOperationId(snapshot);
    const gate = await this.options.gate();
    if (!gate.allowed || snapshot.signal?.aborted) {
      if (!gate.allowed && !temporaryDenial(gate.reason)) await this.recordDenial(snapshot);
      return unavailable(
        snapshot.signal?.aborted ? "aborted" : gate.allowed ? "unavailable" : gate.reason,
      );
    }
    const existing = await store.readExtractionReceipt(operationId);
    if (existing) return this.visibleReceipt(existing);
    if (snapshot.deletionRevision !== (await store.readDeletionRevision()))
      return unavailable("memory_deleted");
    let cursor = await store.readExtractionCursor(snapshot.sessionId);
    const pending = await store.readPendingExtractionFailure(snapshot.sessionId);
    const denied = new Set(
      (await store.readCompactionPolicyDenials(snapshot.sessionId)).map(
        (entry) => entry.compactionCheckpointId,
      ),
    );
    const checkpoints = [...(snapshot.checkpoints ?? [])]
      .filter((checkpoint) => checkpoint.throughOrdinal <= snapshot.boundaryOrdinal)
      .sort((a, b) => a.throughOrdinal - b.throughOrdinal);
    if (checkpoints.some((checkpoint) => !validCheckpoint(snapshot, checkpoint)))
      return unavailable("invalid_checkpoint");
    if (!cursor && !pending && !checkpoints.some((checkpoint) => !checkpoint.bootstrap)) {
      const bootstrap = checkpoints.filter((checkpoint) => checkpoint.bootstrap).at(-1);
      if (bootstrap) {
        if (!(await this.allowed(snapshot))) return unavailable("policy_changed");
        cursor = await store.initializeExtractionCursor(
          snapshot.sessionId,
          bootstrap.throughOrdinal,
        );
      }
    }
    let after = cursor?.processedOrdinal ?? 0;
    if (pending?.firstOperationId === operationId) return unavailable("retry_later");
    const historyAfter = (through: number): number =>
      checkpoints.reduce(
        (max, checkpoint) =>
          denied.has(checkpoint.checkpointId) && checkpoint.throughOrdinal <= through
            ? Math.max(max, checkpoint.throughOrdinal)
            : max,
        0,
      );

    if (pending) {
      if (pending.fromOrdinal !== after + 1 || pending.throughOrdinal > snapshot.boundaryOrdinal)
        return unavailable("pending_boundary_mismatch");
      const pendingBoundary = snapshot.events.find(
        (event) => event.ordinal === pending.throughOrdinal,
      );
      if (!pendingBoundary) return unavailable("pending_boundary_missing");
      if (
        pending.compactionCheckpointId &&
        !checkpoints.some(
          (checkpoint) =>
            checkpoint.checkpointId === pending.compactionCheckpointId &&
            checkpoint.throughOrdinal === pending.throughOrdinal,
        )
      )
        return unavailable("pending_checkpoint_missing");
      const retrySnapshot = historicalSnapshot(
        snapshot,
        pendingBoundary,
        pending.firstTrigger,
        pending.compactionCheckpointId,
      );
      const range = this.range(
        retrySnapshot,
        `memory_retry_${hash([operationId, pending.firstOperationId])}`,
        after,
        pending.throughOrdinal,
        historyAfter(pending.throughOrdinal),
      );
      if (range.coverageHash !== pending.coverageHash)
        return unavailable("pending_coverage_changed");
      // A retry belongs to the generation that originally admitted it. Never replay
      // a pre-deletion explicit request as part of a later automatic task.
      const settled =
        pending.deletionRevision !== snapshot.deletionRevision
          ? await this.commit(range, [], [], undefined, "memory_deleted")
          : await this.settle(await this.processRange(range));
      if (settled.kind !== "committed")
        return unavailable(settled.kind === "blocked" ? settled.reason : "retry_later");
      after = settled.through;
    }

    for (const checkpoint of checkpoints) {
      if (
        checkpoint.bootstrap ||
        checkpoint.throughOrdinal <= after ||
        checkpoint.checkpointId === snapshot.compactionCheckpointId
      )
        continue;
      const boundary = snapshot.events.find(
        (event) => event.ordinal === checkpoint.throughOrdinal,
      )!;
      const checkpointSnapshot = historicalSnapshot(
        snapshot,
        boundary,
        "compaction",
        checkpoint.checkpointId,
      );
      const range = this.range(
        checkpointSnapshot,
        extractionOperationId(checkpointSnapshot),
        after,
        checkpoint.throughOrdinal,
        historyAfter(checkpoint.throughOrdinal),
      );
      const result = denied.has(checkpoint.checkpointId)
        ? await this.commit(range, [], [], undefined, "policy_denied")
        : await this.settle(await this.processRange(range));
      if (result.kind !== "committed")
        return unavailable(result.kind === "blocked" ? result.reason : "retry_later");
      after = result.through;
    }

    if (after >= snapshot.boundaryOrdinal)
      return {
        operationId,
        sessionId: snapshot.sessionId,
        status: "not_applicable",
        requestedItems: [],
        committedAt: cursor?.updatedAt ?? 0,
      };
    const range = this.range(
      snapshot,
      operationId,
      after,
      snapshot.boundaryOrdinal,
      historyAfter(snapshot.boundaryOrdinal),
    );
    const outcome =
      snapshot.compactionCheckpointId && denied.has(snapshot.compactionCheckpointId)
        ? await this.commit(range, [], [], undefined, "policy_denied")
        : await this.settle(await this.processRange(range));
    return outcome.kind === "committed"
      ? outcome.receipt
      : unavailable(outcome.kind === "blocked" ? outcome.reason : "retry_later");
  }

  private range(
    snapshot: MemoryExtractionSnapshot,
    operationId: string,
    after: number,
    through: number,
    historyAfter: number,
  ): Range {
    const entries = snapshot.events.filter(
      (event) => event.ordinal > after && event.ordinal <= through,
    );
    return {
      snapshot:
        snapshot.trigger === "compaction"
          ? {
              ...snapshot,
              sourceMessages: eventMessages(entries),
              sourceTools: undefined,
            }
          : snapshot,
      operationId,
      after,
      through,
      historyAfter,
      coverageHash: memoryEvidenceCoverageHash(entries),
    };
  }

  private async processRange(range: Range, allowSplit = true): Promise<Outcome> {
    const { snapshot } = range;
    const entries = snapshot.events.filter(
      (event) => event.ordinal > range.after && event.ordinal <= range.through,
    );
    if (entries.length === 0) return { kind: "blocked", reason: "coverage_missing" };
    const evidence = projectAtomicMemoryEvidence(entries, snapshot.sourceMessages);
    const fitted = fitAtomicMemoryEvidence(evidence);
    if (!fitted) {
      // A split is still bounded: two independent segments, never recursive slicing.
      const requestedStart =
        snapshot.trigger === "remember"
          ? entries.findIndex(
              (event) => event.runId === snapshot.runId && event.turnId === snapshot.turnId,
            )
          : entries.length;
      const splitIndex = Math.min(
        Math.floor(entries.length / 2),
        requestedStart < 0 ? entries.length - 1 : requestedStart,
      );
      if (!allowSplit || splitIndex < 1) return { kind: "failed", failureClass: "evidence", range };
      const boundary = entries[splitIndex - 1]!;
      const prefixSnapshot = historicalSnapshot(snapshot, boundary, "extract");
      const prefix = this.range(
        prefixSnapshot,
        `memory_segment_${hash([range.operationId, boundary.ordinal])}`,
        range.after,
        boundary.ordinal,
        range.historyAfter,
      );
      const first = await this.processRange(prefix, false);
      if (first.kind !== "committed") return first;
      return this.processRange(
        this.range(
          snapshot,
          range.operationId,
          boundary.ordinal,
          range.through,
          range.historyAfter,
        ),
        false,
      );
    }
    if (
      snapshot.trigger === "remember" &&
      evidence.some(
        (entry) =>
          entry.event.runId === snapshot.runId &&
          entry.event.turnId === snapshot.turnId &&
          entry.texts.some(memoryTextContainsSecret),
      )
    ) {
      return this.commit(range, [], [], "sensitive_information");
    }
    if (fitted.length === 0) return this.commit(range, [], []);
    const budget: Budget = { remaining: 3, localized: false };
    let result: Outcome;
    do {
      result = await this.attempt(range, fitted, budget);
      if (result.kind !== "failed") return result;
    } while (budget.remaining > 0);
    return result;
  }

  private async attempt(
    range: Range,
    evidence: readonly AtomicMemoryEvidence[],
    budget: Budget,
  ): Promise<Outcome> {
    const { snapshot } = range;
    const first = await this.call(
      range,
      "proposal",
      proposalPrompt(snapshot.trigger, renderAtomicMemoryEvidence(evidence)),
      budget,
    );
    if (typeof first !== "string") return first;
    let proposal = parseMemoryProposal(first);
    if (
      !proposal ||
      (snapshot.trigger !== "remember" &&
        (proposal.requestedItems.length > 0 ||
          (proposal.status === "complete" && proposal.requestedStatus !== "not_applicable")))
    )
      return { kind: "failed", failureClass: "schema", range };
    let requestedEvidence = evidence;
    let interpretationContext: string | undefined;
    if (proposal.status === "search_required") {
      if (budget.localized || !proposal.search)
        return { kind: "failed", failureClass: "localization", range };
      budget.localized = true;
      if (!(await this.allowed(snapshot))) return { kind: "blocked", reason: "policy_changed" };
      const history = snapshot.events.filter(
        (event) => event.ordinal > range.historyAfter && event.ordinal <= range.through,
      );
      const found = localizeAtomicMemoryHistory(history, proposal.search);
      if (!found.length) return { kind: "failed", failureClass: "localization", range };
      // Localized evidence is explicitly included in the auxiliary prompt, so older
      // user text need not be part of the original provider prefix to become visible.
      const localized = fitAtomicMemoryEvidence(projectAtomicMemoryEvidence(found));
      if (!localized) return { kind: "failed", failureClass: "localization", range };
      if (
        snapshot.trigger === "remember" &&
        localized.some((entry) => entry.texts.some(memoryTextContainsSecret))
      )
        return this.commit(range, [], [], "sensitive_information");
      interpretationContext = memoryInterpretationContext(found);
      if (snapshot.trigger === "remember") requestedEvidence = localized;
      const localizedRaw = await this.call(
        range,
        "localized",
        proposalPrompt(
          snapshot.trigger,
          renderAtomicMemoryEvidence(snapshot.trigger === "remember" ? localized : evidence),
          interpretationContext,
        ),
        budget,
      );
      if (typeof localizedRaw !== "string") return localizedRaw;
      const resolved = parseMemoryProposal(localizedRaw);
      if (!resolved) return { kind: "failed", failureClass: "schema", range };
      proposal = {
        ...resolved,
        incidentalItems: [...proposal.incidentalItems, ...resolved.incidentalItems],
      };
    }
    if (proposal.status !== "complete")
      return { kind: "failed", failureClass: "localization", range };
    if (
      snapshot.trigger !== "remember" &&
      (proposal.requestedStatus !== "not_applicable" || proposal.requestedItems.length)
    )
      return { kind: "failed", failureClass: "schema", range };
    const requestedByRef = new Map(requestedEvidence.map((entry) => [entry.sourceRef, entry]));
    const incidentalByRef = new Map(evidence.map((entry) => [entry.sourceRef, entry]));
    const candidates: Candidate[] = [];
    for (const [requested, items] of [
      [true, proposal.requestedItems],
      [false, proposal.incidentalItems],
    ] as const) {
      for (const item of items) {
        if (itemSensitive(item, item.evidence)) {
          if (requested) return this.commit(range, [], [], "sensitive_information");
          continue;
        }
        const byRef = requested ? requestedByRef : incidentalByRef;
        const admitted = admitItem(snapshot, item, item.evidence, byRef, requested);
        if (typeof admitted === "string") {
          if (requested) return { kind: "failed", failureClass: admitted, range };
          continue;
        }
        candidates.push({
          candidateId: `candidate_${candidates.length}`,
          requested,
          item,
          evidence: byRef,
        });
      }
    }
    if (!candidates.length) return this.commit(range, [], []);
    const prompt = canonicalizationPrompt(
      candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        requested: candidate.requested,
        evidence: candidate.item.evidence.map((citation) => ({
          ...citation,
          observedAt: candidate.evidence.get(citation.sourceRef)!.event.observedAt,
        })),
        ...(interpretationContext === undefined ? {} : { interpretationContext }),
      })),
    );
    let last: Outcome = { kind: "failed", failureClass: "schema", range };
    while (budget.remaining > 0) {
      const raw = await this.call(range, "canonicalize", prompt, budget);
      if (typeof raw !== "string") {
        if (raw.kind === "blocked") return raw;
        last = raw;
        continue;
      }
      const results = parseMemoryCanonicalization(raw);
      const byId = new Map(results?.map((result) => [result.candidateId, result]));
      if (
        !results ||
        results.length !== candidates.length ||
        byId.size !== candidates.length ||
        candidates.some((candidate) => !byId.has(candidate.candidateId))
      ) {
        last = { kind: "failed", failureClass: "schema", range };
        continue;
      }
      const writes: MemoryItemWrite[] = [];
      const requestedIndexes: number[] = [];
      for (const candidate of candidates) {
        const result = byId.get(candidate.candidateId)!;
        if (result.status === "rejected") {
          if (candidate.requested)
            return { kind: "failed", failureClass: "requested_admission", range };
          continue;
        }
        if (itemSensitive(result.item, candidate.item.evidence)) {
          if (candidate.requested) return this.commit(range, [], [], "sensitive_information");
          continue;
        }
        const admitted = admitItem(
          snapshot,
          result.item,
          candidate.item.evidence,
          candidate.evidence,
          candidate.requested,
        );
        if (typeof admitted === "string") {
          if (candidate.requested) return { kind: "failed", failureClass: admitted, range };
          continue;
        }
        if (candidate.requested) requestedIndexes.push(writes.length);
        writes.push(admitted);
      }
      return this.commit(range, writes, requestedIndexes);
    }
    return last;
  }

  private async call(
    range: Range,
    stage: MemoryModelRequest["stage"],
    prompt: string,
    budget: Budget,
  ): Promise<string | Outcome> {
    if (budget.remaining <= 0) return { kind: "failed", failureClass: "provider", range };
    if (!(await this.allowed(range.snapshot))) return { kind: "blocked", reason: "policy_changed" };
    budget.remaining -= 1;
    const deadline = AbortSignal.timeout(60_000);
    const signal = range.snapshot.signal
      ? AbortSignal.any([range.snapshot.signal, deadline])
      : deadline;
    let onAbort: (() => void) | undefined;
    try {
      const abort = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
      const request: MemoryModelRequest = {
        stage,
        prompt,
        signal,
        ...(stage === "canonicalize"
          ? {}
          : {
              sourceMessages: range.snapshot.sourceMessages,
              ...(range.snapshot.trigger === "compaction" || stage !== "proposal"
                ? {}
                : { sourceTools: range.snapshot.sourceTools }),
            }),
      };
      const result = await Promise.race([this.options.model.call(request), abort]);
      if (!(await this.allowed(range.snapshot)))
        return { kind: "blocked", reason: "policy_changed" };
      return result;
    } catch (error) {
      if (!(await this.allowed(range.snapshot)))
        return { kind: "blocked", reason: "policy_changed" };
      if (blockedModelError(error)) return { kind: "blocked", reason: "model_unavailable" };
      return { kind: "failed", failureClass: "provider", range };
    } finally {
      if (onAbort) signal.removeEventListener("abort", onAbort);
    }
  }

  private async commit(
    range: Range,
    writes: readonly MemoryItemWrite[],
    requestedIndexes: readonly number[],
    noOpReason?: "sensitive_information",
    skipReason?: MemoryExtractionReceipt["skipReason"],
  ): Promise<Outcome> {
    if (skipReason !== "policy_denied" && !(await this.allowed(range.snapshot)))
      return { kind: "blocked", reason: "policy_changed" };
    const { receipt } = await this.options.store.commitExtraction({
      operationId: range.operationId,
      sessionId: range.snapshot.sessionId,
      expectedCursorOrdinal: range.after,
      expectedDeletionRevision: range.snapshot.deletionRevision,
      nextCursorOrdinal: range.through,
      coverageHash: range.coverageHash,
      items: writes,
      requestedItemIndexes: requestedIndexes,
      trigger: range.snapshot.trigger,
      ...(range.snapshot.compactionCheckpointId
        ? { compactionCheckpointId: range.snapshot.compactionCheckpointId }
        : {}),
      ...(noOpReason ? { noOpReason } : {}),
      ...(skipReason ? { skipReason } : {}),
    });
    return { kind: "committed", receipt, through: range.through };
  }

  private async settle(outcome: Outcome): Promise<Outcome> {
    if (outcome.kind !== "failed") return outcome;
    const { range } = outcome;
    if (!(await this.allowed(range.snapshot))) return { kind: "blocked", reason: "policy_changed" };
    const settled = await this.options.store.settleExtractionFailure({
      operationId: range.operationId,
      sessionId: range.snapshot.sessionId,
      expectedCursorOrdinal: range.after,
      expectedDeletionRevision: range.snapshot.deletionRevision,
      failedThroughOrdinal: range.through,
      coverageHash: range.coverageHash,
      failureClass: outcome.failureClass,
      trigger: range.snapshot.trigger,
      ...(range.snapshot.compactionCheckpointId
        ? { compactionCheckpointId: range.snapshot.compactionCheckpointId }
        : {}),
    });
    return settled.status === "discarded"
      ? { kind: "committed", receipt: settled.receipt, through: settled.cursor.processedOrdinal }
      : outcome;
  }

  private async allowed(snapshot: MemoryExtractionSnapshot): Promise<boolean> {
    if (
      snapshot.signal?.aborted ||
      snapshot.deletionRevision !== (await this.options.store.readDeletionRevision())
    )
      return false;
    const gate = await this.options.gate();
    if (!gate.allowed && !temporaryDenial(gate.reason)) await this.recordDenial(snapshot);
    return gate.allowed;
  }

  private async recordDenial(snapshot: MemoryExtractionSnapshot): Promise<void> {
    if (snapshot.trigger !== "compaction" || !snapshot.compactionCheckpointId) return;
    await this.options.store.recordCompactionPolicyDenial({
      sessionId: snapshot.sessionId,
      compactionCheckpointId: snapshot.compactionCheckpointId,
      deniedAt: Date.now(),
    });
    const pending = await this.options.store.readPendingExtractionFailure(snapshot.sessionId);
    if (pending) return;
    const cursor = await this.options.store.readExtractionCursor(snapshot.sessionId);
    const after = cursor?.processedOrdinal ?? 0;
    if (after < snapshot.boundaryOrdinal)
      await this.commit(
        this.range(snapshot, extractionOperationId(snapshot), after, snapshot.boundaryOrdinal, 0),
        [],
        [],
        undefined,
        "policy_denied",
      );
  }

  private async visibleReceipt(receipt: MemoryExtractionReceipt): Promise<MemoryExtractionReceipt> {
    if (!receipt.requestedItems.length) return receipt;
    const requestedItems = [];
    for (const requested of receipt.requestedItems) {
      const record = await this.options.store.readItem(requested.itemId);
      if (!record || record.item.lifecycleState !== "active") continue;
      requestedItems.push(requested);
    }
    return requestedItems.length === receipt.requestedItems.length
      ? receipt
      : {
          ...receipt,
          status: requestedItems.length ? "remembered" : "not_applicable",
          requestedItems,
        };
  }
}

function admitItem(
  snapshot: MemoryExtractionSnapshot,
  item: CanonicalMemoryItem,
  citations: readonly MemoryCitation[],
  evidence: ReadonlyMap<string, AtomicMemoryEvidence>,
  requested: boolean,
): MemoryItemWrite | "evidence" | "requested_admission" {
  const normalized = normalizeLongTermMemoryContent(item.content);
  if (!normalized.ok) return "requested_admission";
  const temporal = {
    temporalType: item.temporalType,
    eventStartedAt: item.eventStartedAt,
    eventEndedAt: item.eventEndedAt,
  };
  try {
    validateMemoryTemporalBounds(temporal);
  } catch {
    return "requested_admission";
  }
  const events = new Map<string, MemoryEvidenceEvent>();
  for (const citation of citations) {
    const source = evidence.get(citation.sourceRef);
    const quote = normalizeEvidenceText(citation.quote);
    if (
      !source ||
      source.event.role !== "user" ||
      Array.from(quote).length < 4 ||
      !source.texts.some((text) => text.includes(quote)) ||
      !normalizeEvidenceText(source.event.text).includes(quote)
    )
      return "evidence";
    events.set(source.event.eventId, source.event);
  }
  if (!events.size) return "evidence";
  const keys = item.keys.flatMap((key) => {
    const value = normalizeLongTermMemoryContent(key.key);
    return value.ok
      ? [
          {
            key: value.value,
            keyType: key.type,
            keyOrigin: requested ? ("user" as const) : ("llm" as const),
          },
        ]
      : [];
  });
  if (!keys.length) return "requested_admission";
  return {
    content: normalized.value,
    kind: item.kind,
    statementType: item.statementType,
    ...temporal,
    scopeType: item.scope,
    scopeKey: item.scope === "workspace" ? snapshot.workspaceKey : null,
    observedAt: Math.max(...[...events.values()].map((event) => event.observedAt)),
    origin: requested ? "user_requested" : "agent_extracted",
    keys,
    sources: [...events.values()].map((event) => evidenceSource(snapshot.sessionId, event)),
  };
}

function itemSensitive(item: CanonicalMemoryItem, citations: readonly MemoryCitation[]): boolean {
  return (
    memoryTextContainsSecret(item.content) ||
    item.keys.some((key) => memoryTextContainsSecret(key.key)) ||
    citations.some((citation) => memoryTextContainsSecret(citation.quote))
  );
}

function historicalSnapshot(
  current: MemoryExtractionSnapshot,
  boundary: MemoryEvidenceEvent,
  trigger: MemoryExtractionSnapshot["trigger"],
  compactionCheckpointId?: string,
): MemoryExtractionSnapshot {
  const events = current.events.filter((event) => event.ordinal <= boundary.ordinal);
  return {
    ...current,
    trigger,
    runId: boundary.runId,
    turnId: boundary.turnId,
    boundaryOrdinal: boundary.ordinal,
    boundaryEventId: boundary.eventId,
    events,
    sourceMessages: eventMessages(events),
    sourceTools: trigger === "compaction" ? undefined : current.sourceTools,
    compactionCheckpointId,
  };
}

function freezeSnapshot(input: MemoryExtractionSnapshot): MemoryExtractionSnapshot | undefined {
  if (
    !Number.isSafeInteger(input.deletionRevision) ||
    input.deletionRevision < 0 ||
    !input.sessionId ||
    !input.workspaceKey ||
    !input.runId ||
    !input.turnId ||
    !Number.isSafeInteger(input.boundaryOrdinal) ||
    input.boundaryOrdinal < 1
  )
    return undefined;
  const events = structuredClone(
    input.events.filter((event) => event.ordinal <= input.boundaryOrdinal),
  ).sort((a, b) => a.ordinal - b.ordinal);
  const seenIds = new Set<string>();
  let previous = 0;
  for (const event of events) {
    if (
      !Number.isSafeInteger(event.ordinal) ||
      event.ordinal <= previous ||
      !event.eventId ||
      seenIds.has(event.eventId) ||
      !event.runId ||
      !event.turnId ||
      !Number.isSafeInteger(event.observedAt) ||
      event.observedAt < 0 ||
      typeof event.text !== "string" ||
      !["user", "assistant", "other"].includes(event.role)
    )
      return undefined;
    seenIds.add(event.eventId);
    previous = event.ordinal;
  }
  const boundary = events.at(-1);
  if (
    !boundary ||
    boundary.ordinal !== input.boundaryOrdinal ||
    boundary.eventId !== input.boundaryEventId
  )
    return undefined;
  if (
    input.trigger !== "compaction" &&
    (boundary.runId !== input.runId || boundary.turnId !== input.turnId)
  )
    return undefined;
  const snapshot = {
    ...input,
    events,
    sourceMessages:
      input.sourceMessages === undefined
        ? eventMessages(events)
        : memoryConversationMessages(structuredClone(input.sourceMessages)),
    sourceTools: input.trigger === "compaction" ? undefined : structuredClone(input.sourceTools),
    checkpoints: structuredClone(input.checkpoints ?? []),
  };
  if (
    input.trigger === "compaction" &&
    (!input.compactionCheckpointId ||
      !snapshot.checkpoints.some(
        (checkpoint) =>
          checkpoint.checkpointId === input.compactionCheckpointId &&
          checkpoint.throughOrdinal === input.boundaryOrdinal &&
          !checkpoint.bootstrap &&
          validCheckpoint(snapshot, checkpoint),
      ))
  )
    return undefined;
  if (input.trigger !== "compaction" && input.compactionCheckpointId) return undefined;
  return snapshot;
}

function eventMessages(
  events: readonly MemoryEvidenceEvent[],
): ReturnType<typeof memoryConversationMessages> {
  return memoryConversationMessages(
    events.flatMap((event) =>
      event.role === "user" || event.role === "assistant"
        ? [{ role: event.role, content: event.text }]
        : [],
    ),
  );
}

function validCheckpoint(
  snapshot: MemoryExtractionSnapshot,
  checkpoint: MemoryCheckpointBoundary,
): boolean {
  return (
    Boolean(checkpoint.checkpointId) &&
    Number.isSafeInteger(checkpoint.ordinal) &&
    checkpoint.ordinal >= checkpoint.throughOrdinal &&
    Number.isSafeInteger(checkpoint.throughOrdinal) &&
    checkpoint.throughOrdinal > 0 &&
    snapshot.events.some((event) => event.ordinal === checkpoint.throughOrdinal) &&
    (checkpoint.coverageHash === undefined ||
      checkpoint.coverageHash ===
        memoryEvidenceCoverageHash(
          snapshot.events.filter((event) => event.ordinal <= checkpoint.throughOrdinal),
        ))
  );
}

function extractionOperationId(snapshot: MemoryExtractionSnapshot): string {
  return `memory_${snapshot.trigger}_${hash([snapshot.sessionId, snapshot.compactionCheckpointId ?? snapshot.boundaryEventId, snapshot.trigger === "compaction" ? null : snapshot.runId, snapshot.trigger === "compaction" ? null : snapshot.turnId])}`;
}
function hash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
function unavailable(reason: string): AtomicMemoryResult {
  return { status: "unavailable", reason, requestedItems: [] };
}
function temporaryDenial(reason: string): boolean {
  return [
    "unavailable",
    "session_unavailable",
    "draining",
    "provider_unsupported",
    "configuration",
    "aborted",
  ].includes(reason);
}
function blockedModelError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: string; code?: string };
  return (
    ["AbortError", "ConfigurationError", "MemoryProviderUnsupportedError"].includes(
      candidate.name ?? "",
    ) || ["provider_unsupported", "configuration", "persistence"].includes(candidate.code ?? "")
  );
}
