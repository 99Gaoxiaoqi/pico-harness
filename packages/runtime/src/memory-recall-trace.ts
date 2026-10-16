import { createHash } from "node:crypto";
import type {
  MemoryRecallTrace,
  MemoryRecallCaseSelectedItem,
  MemoryRecallSelectedItem,
  MemoryRecallDiagnostic,
} from "@pico/core";
import type { MemoryItemRecord, MemoryItemSource } from "@pico/core/atomic-memory-contracts";

export const MEMORY_RECALL_TRACE_MAX_BYTES = 8 * 1024;
export const MEMORY_RECALL_DIAGNOSTIC_SAMPLE_LIMIT = 24;
export const MEMORY_RECALL_SOURCE_LIMIT = 3;

export function memoryRecallTextHash(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export function memoryRecallSelectedItem(input: {
  readonly record: MemoryItemRecord;
  readonly match: MemoryRecallSelectedItem["match"];
  readonly source: MemoryRecallSelectedItem["source"];
  readonly rank: number;
  readonly score: number;
  readonly reference: Pick<MemoryRecallSelectedItem, "range" | "excerpt">;
  readonly renderedLine: string;
}): MemoryRecallSelectedItem {
  const { record, reference } = input;
  return {
    itemId: record.item.itemId,
    itemVersion: record.item.version,
    contentHash: record.item.contentHash,
    referenceHash: memoryRecallTextHash(input.renderedLine),
    range: { ...reference.range },
    excerpt: reference.excerpt,
    match: input.match,
    source: input.source,
    sourceCount: record.sources.length,
    sources: record.sources.slice(0, MEMORY_RECALL_SOURCE_LIMIT).map(sourceMetadata),
    rank: input.rank,
    score: input.score,
  };
}

/** Selection is already complete: only diagnostic detail may be trimmed here. */
export function createMemoryRecallTrace(input: {
  readonly mode: MemoryRecallTrace["mode"];
  readonly workspaceKey: string;
  readonly settingsVersion?: number;
  readonly query?: string;
  readonly queryRef?: MemoryRecallTrace["queryRef"];
  readonly queryPolicyVersion?: number;
  readonly outcome: MemoryRecallTrace["outcome"];
  readonly block?: string;
  readonly stages?: MemoryRecallTrace["stages"];
  readonly budget: MemoryRecallTrace["budget"];
  readonly counts?: MemoryRecallTrace["counts"];
  readonly selected?: readonly MemoryRecallSelectedItem[];
  readonly diagnostics?: readonly MemoryRecallDiagnostic[];
  readonly elapsedMs?: number;
}): MemoryRecallTrace {
  const selected = (input.selected ?? []).map(selectedMetadata);
  if (selected.length > 10) throw new Error("Recall trace exceeds selected identity limit");
  const allDiagnostics = input.diagnostics ?? [];
  const diagnostics = allDiagnostics
    .slice(0, MEMORY_RECALL_DIAGNOSTIC_SAMPLE_LIMIT)
    .map(diagnosticMetadata);
  const counts = input.counts ?? {
    selected: selected.length,
    duplicate: allDiagnostics.filter((item) => item.reason === "duplicate").length,
    budget: allDiagnostics.filter((item) => item.reason === "budget").length,
    item_limit: allDiagnostics.filter((item) => item.reason === "item_limit").length,
  };
  const totalDiagnostics = counts.duplicate + counts.budget + counts.item_limit;
  const queryRef = input.queryRef;
  const trace = {
    version: 1 as const,
    mode: input.mode,
    workspaceKey: input.workspaceKey,
    ...(input.settingsVersion !== undefined ? { settingsVersion: input.settingsVersion } : {}),
    queryHash: memoryRecallTextHash(input.query ?? ""),
    ...(input.queryPolicyVersion !== undefined
      ? { queryPolicyVersion: input.queryPolicyVersion }
      : {}),
    ...(queryRef
      ? {
          queryRef: {
            ...(queryRef.anchorEventId ? { anchorEventId: queryRef.anchorEventId } : {}),
            ...(queryRef.eventId ? { eventId: queryRef.eventId } : {}),
            ...(queryRef.toolCallId ? { toolCallId: queryRef.toolCallId } : {}),
          },
        }
      : {}),
    outcome: input.outcome,
    ...(input.block ? { blockHash: memoryRecallTextHash(input.block) } : {}),
    stages: input.stages
      ? {
          exact: input.stages.exact,
          prefix: input.stages.prefix,
          content: input.stages.content,
          compound: input.stages.compound,
          candidates: input.stages.candidates,
        }
      : { exact: 0, prefix: 0, content: 0, compound: 0, candidates: 0 },
    budget: {
      maxItems: input.budget.maxItems,
      maxTokens: input.budget.maxTokens,
      usedItems: input.budget.usedItems,
      usedTokens: input.budget.usedTokens,
      ...(input.budget.maxItemTokens !== undefined
        ? { maxItemTokens: input.budget.maxItemTokens }
        : {}),
      truncated: input.budget.truncated,
    },
    counts: {
      selected: counts.selected,
      duplicate: counts.duplicate,
      budget: counts.budget,
      item_limit: counts.item_limit,
    },
    selected,
    diagnostics,
    elapsedMs: input.elapsedMs ?? 0,
    traceTruncated: false,
    omittedDiagnosticCount: totalDiagnostics - diagnostics.length,
    omittedSourceCount: selected.reduce(
      (total, item) => total + item.sourceCount - item.sources.length,
      0,
    ),
  };
  trace.traceTruncated = trace.omittedDiagnosticCount > 0 || trace.omittedSourceCount > 0;
  while (Buffer.byteLength(JSON.stringify(trace), "utf8") > MEMORY_RECALL_TRACE_MAX_BYTES) {
    trace.traceTruncated = true;
    if (diagnostics.length) {
      diagnostics.pop();
      trace.omittedDiagnosticCount++;
      continue;
    }
    const withSources = selected.find((item) => item.sources.length);
    if (withSources) {
      withSources.sources.pop();
      trace.omittedSourceCount++;
      continue;
    }
    const withOptional = selected.find(
      (item) => item.rank !== undefined || item.score !== undefined,
    );
    if (withOptional) {
      delete withOptional.rank;
      delete withOptional.score;
      continue;
    }
    // An invalid/unbounded identity is a trace failure; never drop selected identities.
    throw new Error("Recall trace identities exceed metadata budget");
  }
  return trace;
}

function sourceMetadata(source: MemoryItemSource): MemoryItemSource {
  return {
    sessionId: source.sessionId,
    runId: source.runId,
    turnId: source.turnId,
    eventId: source.eventId,
  };
}

function selectedMetadata(item: MemoryRecallSelectedItem) {
  return {
    itemId: item.itemId,
    itemVersion: item.itemVersion,
    contentHash: item.contentHash,
    referenceHash: item.referenceHash,
    range: { start: item.range.start, end: item.range.end, total: item.range.total },
    excerpt: item.excerpt,
    match: item.match,
    source: item.source,
    sourceCount: item.sourceCount,
    sources: item.sources.slice(0, MEMORY_RECALL_SOURCE_LIMIT).map(sourceMetadata),
    ...(item.rank !== undefined ? { rank: item.rank } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
  };
}

function diagnosticMetadata(item: MemoryRecallDiagnostic): MemoryRecallDiagnostic {
  return {
    itemId: item.itemId,
    reason: item.reason,
    match: item.match,
    ...(item.rank !== undefined ? { rank: item.rank } : {}),
    ...(item.score !== undefined ? { score: item.score } : {}),
  };
}

/** The callback accepts the actual rendered case, but only identity/hash metadata is durable. */
export function memoryRecallCaseSelectedItem(input: {
  readonly candidateId: string;
  readonly contentVersion: number;
  readonly recordRevision: number;
  readonly renderedLine: string;
  readonly sources: readonly MemoryItemSource[];
  readonly range: MemoryRecallCaseSelectedItem["range"];
  readonly excerpt: boolean;
}): MemoryRecallCaseSelectedItem {
  return {
    candidateId: input.candidateId,
    contentVersion: input.contentVersion,
    recordRevision: input.recordRevision,
    referenceHash: memoryRecallTextHash(input.renderedLine),
    range: { start: input.range.start, end: input.range.end, total: input.range.total },
    excerpt: input.excerpt,
    sourceCount: input.sources.length,
    sources: input.sources.slice(0, MEMORY_RECALL_SOURCE_LIMIT).map(sourceMetadata),
  };
}

export function createCaseRecallTrace(input: {
  readonly workspaceKey: string;
  readonly query?: string;
  readonly queryRef?: MemoryRecallTrace["queryRef"];
  readonly queryPolicyVersion?: number;
  readonly settingsVersion?: number;
  readonly block?: string;
  readonly selected?: readonly MemoryRecallCaseSelectedItem[];
  readonly summary?: {
    readonly candidates: number;
    readonly matched: number;
    readonly selected: number;
    readonly budget: number;
    readonly itemLimit: number;
    readonly usedTokens: number;
    readonly limited: boolean;
    readonly truncated: boolean;
  };
  readonly outcome?: MemoryRecallTrace["outcome"];
  readonly elapsedMs?: number;
}): MemoryRecallTrace {
  const selected = (input.selected ?? []).map((item) => ({
    candidateId: item.candidateId,
    contentVersion: item.contentVersion,
    recordRevision: item.recordRevision,
    referenceHash: item.referenceHash,
    range: { start: item.range.start, end: item.range.end, total: item.range.total },
    excerpt: item.excerpt,
    sourceCount: item.sourceCount,
    sources: item.sources.slice(0, MEMORY_RECALL_SOURCE_LIMIT).map(sourceMetadata),
  }));
  if (
    selected.length > 3 ||
    (input.summary &&
      (input.summary.selected !== selected.length || input.summary.usedTokens > 1500))
  )
    throw new Error("Case recall selection exceeds budget or differs from rendered selection");
  const summary = input.summary;
  const base = createMemoryRecallTrace({
    ...input,
    mode: "search",
    selected: [],
    outcome:
      input.outcome ??
      (selected.length
        ? "selected"
        : summary?.limited
          ? "limited"
          : summary?.budget
            ? "budget_exhausted"
            : "no_hits"),
    budget: {
      maxItems: 3,
      maxTokens: 1500,
      usedItems: 0,
      usedTokens: summary?.usedTokens ?? 0,
      truncated: summary?.truncated ?? false,
    },
    stages: {
      exact: 0,
      prefix: 0,
      content: summary?.matched ?? 0,
      compound: 0,
      candidates: summary?.candidates ?? 0,
    },
  });
  const trace: MemoryRecallTrace = {
    ...base,
    version: 2,
    recordType: "case",
    caseSelected: selected,
    limited: summary?.limited ?? false,
    budget: { ...base.budget, usedItems: selected.length },
    counts: {
      selected: selected.length,
      duplicate: 0,
      budget: summary?.budget ?? 0,
      item_limit: summary?.itemLimit ?? 0,
    },
    omittedDiagnosticCount: (summary?.budget ?? 0) + (summary?.itemLimit ?? 0),
    omittedSourceCount: selected.reduce((n, item) => n + item.sourceCount - item.sources.length, 0),
  };
  while (Buffer.byteLength(JSON.stringify(trace), "utf8") > MEMORY_RECALL_TRACE_MAX_BYTES) {
    const item = selected.find((item) => item.sources.length);
    if (!item) throw new Error("Case recall identities exceed metadata budget");
    item.sources.pop();
    (trace as { omittedSourceCount: number }).omittedSourceCount++;
  }
  return {
    ...trace,
    traceTruncated: trace.omittedSourceCount > 0 || trace.omittedDiagnosticCount > 0,
  };
}
