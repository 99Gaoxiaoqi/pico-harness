import type { SessionHydrationSnapshot } from "../engine/session-runtime.js";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
import {
  projectTranscriptEntriesForRendering,
  projectTranscriptEvents,
  type TranscriptEvent,
} from "../presentation/transcript-event-store.js";
import type { TuiEntry, TuiReporter } from "./tui-reporter.js";

/**
 * Runtime owner 在硬切换后提供的 canonical ToolResult 水合队列。
 *
 * 该本地交叉类型让本分支可独立 typecheck；集成时 SessionHydrationSnapshot
 * 会直接声明同一字段。
 */
interface CanonicalHydrationToolResult {
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: ToolResultEnvelope;
}

type CanonicalSessionHydrationSnapshot = SessionHydrationSnapshot & {
  readonly toolResults: readonly CanonicalHydrationToolResult[];
};

/**
 * 恢复/热切换只重放结构化 transcript，并用 canonical tool.result.recorded
 * envelope 覆盖或补齐 completion。旧 Message/providerData 不再是 UI 数据源。
 */
export function hydrateTuiEntries(snapshot: SessionHydrationSnapshot): TuiEntry[] {
  const events = canonicalHydrationEvents(snapshot);
  return projectTranscriptEntriesForRendering(projectTranscriptEvents(events));
}

export function hydrateTuiReporter(
  reporter: Pick<TuiReporter, "hydrateTranscriptEvents" | "replaceTranscriptEvents">,
  snapshot: SessionHydrationSnapshot,
  options: { readonly replace?: boolean } = {},
): void {
  const events = canonicalHydrationEvents(snapshot);
  if (options.replace) {
    reporter.replaceTranscriptEvents(events);
    return;
  }
  if (events.length > 0) reporter.hydrateTranscriptEvents(events);
}

function canonicalHydrationEvents(snapshot: SessionHydrationSnapshot): TranscriptEvent[] {
  const canonical = readCanonicalToolResults(snapshot);
  if (snapshot.transcriptEventSequences.length !== snapshot.transcriptEvents.length) {
    throw new Error(
      `Session ${snapshot.sessionId} transcript sequence index is incompatible with structured hydration`,
    );
  }

  const events = snapshot.transcriptEvents.map((event, index) => ({
    event,
    runtimeSequence: snapshot.transcriptEventSequences[index]!,
    ordinal: index,
  }));
  const completions = new Map<
    string,
    { readonly event: Extract<TranscriptEvent, { type: "tool.completed" }>; readonly index: number }
  >();
  for (const [index, entry] of events.entries()) {
    if (entry.event.type === "tool.completed") {
      completions.set(entry.event.toolCallId, { event: entry.event, index });
    }
  }

  const resultQueues = new Map<string, CanonicalHydrationToolResult[]>();
  for (const result of canonical.toSorted((left, right) => left.sequence - right.sequence)) {
    const queue = resultQueues.get(result.envelope.toolCallId) ?? [];
    queue.push(result);
    resultQueues.set(result.envelope.toolCallId, queue);
  }

  const matchedCompletions = new Set<string>();
  const synthetic: Array<{
    readonly event: TranscriptEvent;
    readonly runtimeSequence: number;
    readonly ordinal: number;
  }> = [];
  for (const entry of events) {
    if (entry.event.type !== "tool.started" || !entry.event.providerCallId) continue;
    const result = shiftCanonicalResult(
      resultQueues,
      entry.event.providerCallId,
      entry.runtimeSequence,
    );
    if (!result) continue;
    const completion = completions.get(entry.event.toolCallId);
    if (completion) {
      events[completion.index] = {
        ...events[completion.index]!,
        event: {
          ...completion.event,
          result: result.envelope,
        },
      };
      matchedCompletions.add(entry.event.toolCallId);
      continue;
    }
    synthetic.push({
      runtimeSequence: result.sequence,
      ordinal: Number.MAX_SAFE_INTEGER,
      event: {
        eventId: `canonical-tool-result:${result.eventId}`,
        sequence: 1,
        createdAt: hydrationTimestamp(snapshot.updatedAt),
        type: "tool.completed",
        toolCallId: entry.event.toolCallId,
        status: transcriptStatus(result.envelope),
        summary: toolResultSummary(result.envelope),
        result: result.envelope,
      },
    });
  }

  const unmatchedCompletion = [...completions.keys()].find(
    (toolCallId) => !matchedCompletions.has(toolCallId),
  );
  if (unmatchedCompletion) {
    throw new Error(
      `Session ${snapshot.sessionId} tool completion ${unmatchedCompletion} has no canonical ToolResult`,
    );
  }

  return [...events, ...synthetic]
    .toSorted(
      (left, right) => left.runtimeSequence - right.runtimeSequence || left.ordinal - right.ordinal,
    )
    .map(({ event }, index) => ({ ...event, sequence: index + 1 }));
}

function readCanonicalToolResults(
  snapshot: SessionHydrationSnapshot,
): readonly CanonicalHydrationToolResult[] {
  const value = (snapshot as Partial<CanonicalSessionHydrationSnapshot>).toolResults;
  if (!Array.isArray(value)) {
    throw new Error(
      `Session ${snapshot.sessionId} does not contain canonical ToolResult hydration data`,
    );
  }
  return value;
}

function shiftCanonicalResult(
  queues: Map<string, CanonicalHydrationToolResult[]>,
  toolCallId: string,
  startedSequence: number,
): CanonicalHydrationToolResult | undefined {
  const queue = queues.get(toolCallId);
  if (!queue || queue.length === 0) return undefined;
  const index = queue.findIndex((result) => result.sequence >= startedSequence);
  const selectedIndex = index >= 0 ? index : 0;
  const [result] = queue.splice(selectedIndex, 1);
  if (queue.length === 0) queues.delete(toolCallId);
  return result;
}

function transcriptStatus(envelope: ToolResultEnvelope): "success" | "error" | "denied" {
  if (envelope.status === "succeeded") return "success";
  if (envelope.status === "rejected") return "denied";
  return "error";
}

function toolResultSummary(envelope: ToolResultEnvelope): string {
  const outcome = envelope.status === "succeeded" ? "Tool completed" : "Tool failed";
  return `${outcome} · ${envelope.rawSizeBytes} bytes`;
}

function hydrationTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}
