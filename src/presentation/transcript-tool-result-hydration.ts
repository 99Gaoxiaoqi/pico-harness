import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
import {
  projectTranscriptEvents,
  type DurableTranscriptEvent,
  type TranscriptEvent,
} from "./transcript-event-store.js";

export interface CanonicalTranscriptToolResult {
  readonly sequence: number;
  readonly eventId: string;
  readonly envelope: ToolResultEnvelope;
}

export interface CanonicalTranscriptHydrationInput {
  readonly sessionId: string;
  readonly updatedAt: string;
  readonly transcriptEvents: readonly DurableTranscriptEvent[];
  readonly transcriptEventSequences: readonly number[];
  readonly toolResults: readonly CanonicalTranscriptToolResult[];
  readonly rejectUnmatchedResults?: boolean;
}

/**
 * Rebuilds presentation-only tool completions from durable tool.started events
 * and canonical tool.result.recorded facts. A completion is never a second
 * durable fact.
 */
export function hydrateCanonicalTranscriptEvents(
  input: CanonicalTranscriptHydrationInput,
): TranscriptEvent[] {
  if (input.transcriptEventSequences.length !== input.transcriptEvents.length) {
    throw new Error(
      `Session ${input.sessionId} transcript sequence index is incompatible with structured hydration`,
    );
  }
  const events = input.transcriptEvents.map((event, index) => ({
    event,
    runtimeSequence: input.transcriptEventSequences[index]!,
    ordinal: index,
  }));
  const activeToolCallIds = new Set(
    Object.keys(projectTranscriptEvents(input.transcriptEvents).toolCalls),
  );
  const resultQueues = indexCanonicalToolResults(input.toolResults);
  const synthetic: Array<{
    readonly event: TranscriptEvent;
    readonly runtimeSequence: number;
    readonly ordinal: number;
  }> = [];

  for (const entry of events) {
    if (entry.event.type !== "tool.started" || !activeToolCallIds.has(entry.event.toolCallId)) {
      continue;
    }
    const result = shiftCanonicalResult(resultQueues, entry.event.providerCallId);
    if (!result) continue;
    synthetic.push({
      // Desktop timeline persistence can lag behind the canonical Runtime fact.
      // Reducer order still requires the synthetic completion to follow its start.
      runtimeSequence: Math.max(result.sequence, entry.runtimeSequence),
      ordinal: Number.MAX_SAFE_INTEGER,
      event: {
        eventId: `canonical-tool-result:${result.eventId}`,
        sequence: 1,
        createdAt: hydrationTimestamp(input.updatedAt),
        type: "tool.completed",
        toolCallId: entry.event.toolCallId,
        summary: summarizeTranscriptToolResult(entry.event.name, entry.event.args, result.envelope),
        result: result.envelope,
      },
    });
  }

  const unmatchedResult = [...resultQueues.values()].flat()[0];
  if (input.rejectUnmatchedResults && unmatchedResult) {
    throw new Error(
      `Session ${input.sessionId} canonical ToolResult ${unmatchedResult.envelope.toolCallId} has no structured tool start`,
    );
  }

  return [...events, ...synthetic]
    .toSorted(
      (left, right) => left.runtimeSequence - right.runtimeSequence || left.ordinal - right.ordinal,
    )
    .map(({ event }, index) => ({ ...event, sequence: index + 1 }));
}

/** One summary policy shared by live projection and restart hydration. */
export function summarizeTranscriptToolResult(
  toolName: string,
  args: string,
  envelope: ToolResultEnvelope,
): string {
  const result = envelope.projection.text;
  if (envelope.status !== "succeeded") return formatErrorSummary(result);
  if (isAgentToolName(toolName)) return summarizeAgentResult(toolName, result);

  const target = toolTargetSummary(toolName, args);
  const output = formatOutputPreview(result, 3);
  if (target) return `${target} · ${result.length} 字节 · ${output}`;

  const lines = result.split("\n");
  const head = lines.slice(0, 3).map((line) => line.slice(0, 100));
  const suffix = lines.length > 3 ? ` …(+${lines.length - 3} 行)` : "";
  return `${result.length} 字节 · ${head.join(" ⏎ ").slice(0, 120)}${suffix}`;
}

function indexCanonicalToolResults(
  toolResults: readonly CanonicalTranscriptToolResult[],
): Map<string, CanonicalTranscriptToolResult[]> {
  const queues = new Map<string, CanonicalTranscriptToolResult[]>();
  for (const result of toolResults.toSorted((left, right) => left.sequence - right.sequence)) {
    const queue = queues.get(result.envelope.toolCallId) ?? [];
    queue.push(result);
    queues.set(result.envelope.toolCallId, queue);
  }
  return queues;
}

function shiftCanonicalResult(
  queues: Map<string, CanonicalTranscriptToolResult[]>,
  toolCallId: string,
): CanonicalTranscriptToolResult | undefined {
  const queue = queues.get(toolCallId);
  if (!queue || queue.length === 0) return undefined;
  const result = queue.shift();
  if (queue.length === 0) queues.delete(toolCallId);
  return result;
}

function hydrationTimestamp(value: string): number {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function isAgentToolName(toolName: string): boolean {
  return (
    toolName === "spawn_subagent" ||
    toolName === "delegate_task" ||
    toolName === "delegate_status" ||
    toolName.startsWith("[Subagent]")
  );
}

function toolTargetSummary(toolName: string, args: string): string | undefined {
  if (!["edit_file", "write_file", "bash"].includes(toolName)) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  const value = toolName === "bash" ? parsed["command"] : parsed["path"];
  if (typeof value !== "string" || !value.trim()) return undefined;
  return compactText(value.trim(), 64);
}

function formatErrorSummary(error: string): string {
  const firstUsefulLine = error
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return `可复制错误: ${compactText(firstUsefulLine ?? error, 166)}`;
}

function summarizeAgentResult(toolName: string, result: string): string {
  const parsed = parseJsonObject(result);
  if (!parsed) return summarizePlainAgentResult(toolName, result);

  const topLevelError = stringField(parsed, "error");
  if (topLevelError) return formatErrorSummary(topLevelError);

  const status = stringField(parsed, "status");
  const delegationId = stringField(parsed, "delegationId") ?? stringField(parsed, "delegation_id");
  const batch = extractDelegationBatch(parsed);
  if (batch) return summarizeDelegationBatch(batch);
  if (status) {
    const idPart = delegationId ? ` · ${compactText(delegationId, 48)}` : "";
    return `${status}${idPart}`;
  }
  return summarizePlainAgentResult(toolName, result);
}

function summarizePlainAgentResult(toolName: string, result: string): string {
  const label = toolName.startsWith("[Subagent]") ? "Subagent" : "Agent";
  return `${label} · ${formatOutputPreview(result, 3)}`;
}

function extractDelegationBatch(
  value: Record<string, unknown>,
): { results: Record<string, unknown>[] } | undefined {
  const direct = value["results"];
  if (Array.isArray(direct)) return { results: direct.filter(isRecord) };
  const nestedResult = value["result"];
  if (!isRecord(nestedResult)) return undefined;
  const nested = nestedResult["results"];
  return Array.isArray(nested) ? { results: nested.filter(isRecord) } : undefined;
}

function summarizeDelegationBatch(batch: { results: Record<string, unknown>[] }): string {
  const total = batch.results.length;
  const completed = batch.results.filter(
    (item) => stringField(item, "status") === "completed",
  ).length;
  const failed = batch.results.filter((item) => stringField(item, "status") === "error").length;
  const parts = [`${completed}/${total} completed`];
  if (failed > 0) parts.push(`${failed} failed`);

  const success = batch.results.find((item) => stringField(item, "status") === "completed");
  const failure = batch.results.find((item) => stringField(item, "status") === "error");
  const successSummary = success ? stringField(success, "summary") : undefined;
  const failureSummary = failure
    ? (stringField(failure, "error") ?? stringField(failure, "summary"))
    : undefined;
  if (successSummary) parts.push(`ok: ${compactText(successSummary, 72)}`);
  if (failureSummary) parts.push(`failed: ${compactText(failureSummary, 88)}`);
  return compactText(parts.join(" · "), 220);
}

function formatOutputPreview(output: string, maxLines: number): string {
  const lines = output.split("\n");
  const visible = lines.slice(0, maxLines);
  const hidden = lines.length - visible.length;
  if (hidden > 0) visible.push(`... 已截断 ${hidden} 行`);
  return visible.join("\n");
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const raw = value[key];
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
}

function compactText(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}
