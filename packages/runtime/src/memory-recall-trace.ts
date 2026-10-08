import { createHash } from "node:crypto";
import type {
  MemoryRecallTrace,
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
    ...(queryRef
      ? {
          queryRef: {
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
