import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  COMPACTION_SUMMARY_CLOSE_TAG,
  COMPACTION_SUMMARY_OPEN_TAG,
  type Message,
  type RuntimeEvent,
} from "@pico/core";
import { buildToolResultArchiveRef } from "./tool-result-archive.js";

export const HANDOFF_EVIDENCE_METADATA_KEY = "picoHandoffEvidence";
const MAX_EVIDENCE_REFERENCES = 64;
const HOST_SOURCES_OPEN = "<pico_handoff_sources>";
const HOST_SOURCES_CLOSE = "</pico_handoff_sources>";

/** Host-derived source identity only: never a claim that the summary's conclusion is true. */
export interface CompactionEvidenceReference {
  readonly eventId: string;
  readonly sequence: number;
  readonly kind: "message.committed" | "tool.result.recorded";
  readonly runId: string;
  readonly sourceSha256: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
  readonly status?: string;
  readonly bodySha256?: string;
  readonly sizeBytes?: number;
  readonly archiveRef?: string;
}

export interface CompactionEvidenceMetadata {
  readonly version: 1;
  readonly sessionId: string;
  readonly throughEventId: string;
  readonly previousCheckpointId?: string;
  readonly summarySha256: string;
  readonly references: readonly CompactionEvidenceReference[];
}

export interface CompactionEvidenceResolveRequest {
  readonly sessionId: string;
  readonly throughEventId: string;
  readonly previousCheckpointId?: string;
  /** Used only during validation; metadata stores its hash, never this body. */
  readonly summaryText: string;
  readonly references: readonly string[];
}

export interface CompactionEvidenceSourceEntry {
  readonly sequence: number;
  readonly event: RuntimeEvent;
}

export type CompactionEvidenceResolver = (
  input: CompactionEvidenceResolveRequest,
) => Promise<CompactionEvidenceMetadata | undefined>;

export function compactionSummarySha256(summary: string): string {
  return createHash("sha256").update(summary.trim()).digest("hex");
}

export function unwrapCompactionSummary(content: string): string | undefined {
  const start = content.indexOf(COMPACTION_SUMMARY_OPEN_TAG);
  const end = content.indexOf(COMPACTION_SUMMARY_CLOSE_TAG);
  if (start < 0 || end <= start) return undefined;
  return content.slice(start + COMPACTION_SUMMARY_OPEN_TAG.length, end).trim();
}

/** Encode unusual IDs so a source cannot inject a Markdown delimiter into the reference. */
export function renderCompactionEvidenceReference(eventId: string): string {
  return `[event:${encodeURIComponent(eventId)}]`;
}

/** Evidence references are text anchors, not model-produced metadata or observed labels. */
export function extractCompactionEvidenceReferences(
  summary: string,
): readonly string[] | undefined {
  const body = unwrapCompactionSummary(summary) ?? summary.trim();
  let evidence = false;
  let fence: { family: string; width: number } | undefined;
  const lines: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      const family = marker[1]![0]!;
      const width = marker[1]!.length;
      if (!fence) fence = { family, width };
      else if (fence.family === family && width >= fence.width && line.trim() === marker[1])
        fence = undefined;
      continue;
    }
    if (fence) continue;
    if (/^ {0,3}##(?!#)(?:\s|$)/.test(line)) {
      if (evidence) break;
      evidence = line.trim() === "## Evidence";
      continue;
    }
    if (evidence && line.trim()) lines.push(line);
  }
  if (!evidence || lines.length === 0) return undefined;
  const text = lines.join("\n");
  if (/^\s*(?:-\s*)?\(none\)\s*$/iu.test(text)) return [];
  const references: string[] = [];
  const pattern = /\[event:([^\]\s]+)\]/gu;
  let consumed = text;
  for (const match of text.matchAll(pattern)) {
    let eventId: string;
    try {
      eventId = decodeURIComponent(match[1]!);
    } catch {
      return undefined;
    }
    if (!eventId || encodeURIComponent(eventId) !== match[1]) return undefined;
    if (!references.includes(eventId)) references.push(eventId);
    consumed = consumed.replace(match[0], "");
  }
  return references.length > 0 &&
    references.length <= MAX_EVIDENCE_REFERENCES &&
    !consumed.includes("[event:")
    ? references
    : undefined;
}

/** A bounded Host-generated read hint. No source body or model-generated claim is included. */
export function renderCompactionEvidenceSources(metadata: CompactionEvidenceMetadata): string {
  if (metadata.references.length === 0) return "";
  const lines = metadata.references.slice(0, 8).map((reference) => {
    const identity = `${renderCompactionEvidenceReference(reference.eventId)} sequence=${reference.sequence} ${reference.kind}`;
    const tool = reference.toolName
      ? ` tool=${JSON.stringify(reference.toolName.slice(0, 160))} status=${JSON.stringify(reference.status)}`
      : "";
    const reader = reference.archiveRef
      ? `；原始结果可读：archive_read ${JSON.stringify({ ref: reference.archiveRef, operation: "inspect" })}，或 read_file ${JSON.stringify({ path: reference.archiveRef, offset: 1, limit: 6000 })}`
      : "";
    return `- ${identity}${tool}${reader}`;
  });
  return `${HOST_SOURCES_OPEN}\nHost 来源引用（只读元数据；引用不代表结论已被验证）：\n${lines.join("\n")}\n${HOST_SOURCES_CLOSE}`;
}

/** Insert before the preserved user anchor; fork can replace hints after rebinding identities. */
export function attachCompactionEvidenceSources(
  content: string,
  metadata: CompactionEvidenceMetadata,
): string {
  const close = content.indexOf(COMPACTION_SUMMARY_CLOSE_TAG);
  if (close < 0) return content;
  let result = content;
  const start = result.indexOf(HOST_SOURCES_OPEN, close);
  if (start >= 0) {
    const end = result.indexOf(HOST_SOURCES_CLOSE, start);
    if (end >= 0)
      result = result.slice(0, start).trimEnd() + result.slice(end + HOST_SOURCES_CLOSE.length);
  }
  const block = renderCompactionEvidenceSources(metadata);
  if (!block) return result;
  const anchor = result
    .slice(close)
    .search(/\n\n(?:当前用户任务（原文）|当前 Host Goal 任务（冻结条件）)：/u);
  const absoluteAnchor = anchor < 0 ? -1 : close + anchor;
  const insertAt = absoluteAnchor >= 0 ? absoluteAnchor : result.length;
  return `${result.slice(0, insertAt).trimEnd()}\n\n${block}${result.slice(insertAt)}`;
}

/** Exact whitelist prevents model-provided claim fields (including observed) from being trusted. */
export function isCompactionEvidenceMetadata(value: unknown): value is CompactionEvidenceMetadata {
  if (
    !isRecord(value) ||
    !onlyKeys(value, [
      "version",
      "sessionId",
      "throughEventId",
      "previousCheckpointId",
      "summarySha256",
      "references",
    ]) ||
    value.version !== 1 ||
    !nonEmpty(value.sessionId) ||
    !nonEmpty(value.throughEventId) ||
    (value.previousCheckpointId !== undefined && !nonEmpty(value.previousCheckpointId)) ||
    !hash(value.summarySha256) ||
    !Array.isArray(value.references) ||
    value.references.length > MAX_EVIDENCE_REFERENCES
  )
    return false;
  const ids = new Set<string>();
  for (const reference of value.references) {
    if (
      !isRecord(reference) ||
      !onlyKeys(reference, [
        "eventId",
        "sequence",
        "kind",
        "runId",
        "sourceSha256",
        "toolCallId",
        "toolName",
        "status",
        "bodySha256",
        "sizeBytes",
        "archiveRef",
      ]) ||
      !nonEmpty(reference.eventId) ||
      ids.has(reference.eventId) ||
      !positiveInteger(reference.sequence) ||
      (reference.kind !== "message.committed" && reference.kind !== "tool.result.recorded") ||
      !nonEmpty(reference.runId) ||
      !hash(reference.sourceSha256)
    )
      return false;
    ids.add(reference.eventId);
    for (const key of ["toolCallId", "toolName", "status", "archiveRef"] as const)
      if (reference[key] !== undefined && !nonEmpty(reference[key])) return false;
    if (reference.bodySha256 !== undefined && !hash(reference.bodySha256)) return false;
    if (reference.sizeBytes !== undefined && !nonNegativeInteger(reference.sizeBytes)) return false;
  }
  return true;
}

/** Resolve only immutable, model-visible sources within the checkpoint's original coverage. */
export function resolveCompactionEvidenceReferences(
  entries: readonly CompactionEvidenceSourceEntry[],
  input: CompactionEvidenceResolveRequest,
): CompactionEvidenceMetadata | undefined {
  const sequenceMap = new Map(entries.map(({ event, sequence }) => [event.eventId, sequence]));
  return resolveEvidence(
    entries.map(({ event }) => event),
    input,
    sequenceMap,
    new Set(),
  );
}

/** Pure replay can check order/hash; only callers retaining real sequences can verify sequences. */
export function validateStoredCompactionEvidence(
  summary: Message,
  events: readonly RuntimeEvent[],
  boundary: {
    readonly sessionId: string;
    readonly throughEventId: string;
    readonly previousCheckpointId?: string;
  },
  sequences?: ReadonlyMap<string, number>,
): boolean {
  const metadata = summary.providerData?.[HANDOFF_EVIDENCE_METADATA_KEY];
  const body = unwrapCompactionSummary(summary.content);
  const references = body === undefined ? undefined : extractCompactionEvidenceReferences(body);
  if (!body || !references || !isCompactionEvidenceMetadata(metadata)) return false;
  const sourceHints = renderCompactionEvidenceSources(metadata);
  if (
    sourceHints &&
    !summary.content
      .slice(summary.content.indexOf(COMPACTION_SUMMARY_CLOSE_TAG))
      .includes(sourceHints)
  )
    return false;
  const input = { ...boundary, summaryText: body, references };
  const expected = resolveEvidence(events, input, sequences, new Set(), metadata);
  return expected !== undefined && isDeepStrictEqual(metadata, expected);
}

function resolveEvidence(
  events: readonly RuntimeEvent[],
  input: CompactionEvidenceResolveRequest,
  sequences: ReadonlyMap<string, number> | undefined,
  visiting: Set<string>,
  stored?: CompactionEvidenceMetadata,
): CompactionEvidenceMetadata | undefined {
  const references = extractCompactionEvidenceReferences(input.summaryText);
  if (!references || !isDeepStrictEqual(references, input.references)) return undefined;
  const directBoundary = events.findIndex((event) => event.eventId === input.throughEventId);
  if (directBoundary < 0 || events[directBoundary]!.sessionId !== input.sessionId) return undefined;
  const boundary = originalBoundaryIndex(events, input.throughEventId, input.sessionId);
  if (boundary === undefined) return undefined;
  if (input.previousCheckpointId) {
    const previousIndex = events.findIndex(
      (event) =>
        event.kind === "context.checkpoint.recorded" &&
        event.data.checkpointId === input.previousCheckpointId &&
        event.sessionId === input.sessionId,
    );
    const previous = events[previousIndex];
    if (
      previousIndex < 0 ||
      previousIndex > directBoundary ||
      previous?.kind !== "context.checkpoint.recorded" ||
      visiting.has(previous.eventId)
    )
      return undefined;
    if (previous.data.summary.providerData?.picoSummaryFormat === "sections_v2") {
      const previousMetadata = previous.data.summary.providerData[HANDOFF_EVIDENCE_METADATA_KEY];
      const previousBody = unwrapCompactionSummary(previous.data.summary.content);
      const previousReferences = previousBody && extractCompactionEvidenceReferences(previousBody);
      if (!previousBody || !previousReferences || !isCompactionEvidenceMetadata(previousMetadata))
        return undefined;
      visiting.add(previous.eventId);
      const expected = resolveEvidence(
        events.slice(0, previousIndex),
        {
          sessionId: input.sessionId,
          throughEventId: previous.data.throughEventId,
          ...(previous.data.previousCheckpointId
            ? { previousCheckpointId: previous.data.previousCheckpointId }
            : {}),
          summaryText: previousBody,
          references: previousReferences,
        },
        sequences,
        visiting,
        previousMetadata,
      );
      visiting.delete(previous.eventId);
      if (!expected || !isDeepStrictEqual(previousMetadata, expected)) return undefined;
    }
  }
  const resolved: CompactionEvidenceReference[] = [];
  for (const eventId of references) {
    const index = events.findIndex((event) => event.eventId === eventId);
    const source = events[index];
    if (
      index < 0 ||
      index > boundary ||
      !source ||
      source.sessionId !== input.sessionId ||
      source.partial ||
      source.visibility !== "model" ||
      (source.kind !== "message.committed" && source.kind !== "tool.result.recorded")
    )
      return undefined;
    const sequence = sequences
      ? sequences.get(eventId)
      : stored?.references.find((ref) => ref.eventId === eventId)?.sequence;
    if (sequence === undefined || !positiveInteger(sequence)) return undefined;
    const reference: CompactionEvidenceReference = {
      eventId,
      sequence,
      kind: source.kind,
      runId: source.runId,
      sourceSha256: createHash("sha256").update(JSON.stringify(source)).digest("hex"),
      ...(source.kind === "tool.result.recorded"
        ? {
            toolCallId: source.refs.toolCallId,
            toolName: source.data.toolName,
            status: source.data.status,
            bodySha256: source.data.body.sha256,
            sizeBytes: source.data.body.sizeBytes,
            ...(source.data.body.storage === "inline" && source.data.body.sizeBytes > 0
              ? {
                  archiveRef: buildToolResultArchiveRef({
                    sessionId: input.sessionId,
                    eventId,
                    sha256: source.data.body.sha256,
                    sizeBytes: source.data.body.sizeBytes,
                  }),
                }
              : {}),
          }
        : {}),
    };
    resolved.push(reference);
  }
  return {
    version: 1,
    sessionId: input.sessionId,
    throughEventId: input.throughEventId,
    ...(input.previousCheckpointId ? { previousCheckpointId: input.previousCheckpointId } : {}),
    summarySha256: compactionSummarySha256(input.summaryText),
    references: resolved,
  };
}

function originalBoundaryIndex(
  events: readonly RuntimeEvent[],
  throughEventId: string,
  sessionId: string,
): number | undefined {
  const visited = new Set<string>();
  let current = throughEventId;
  for (;;) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const index = events.findIndex((event) => event.eventId === current);
    const event = events[index];
    if (index < 0 || !event || event.sessionId !== sessionId) return undefined;
    if (event.kind !== "context.checkpoint.recorded") return index;
    const next = events.findIndex((candidate) => candidate.eventId === event.data.throughEventId);
    if (next < 0 || next >= index) return undefined;
    current = event.data.throughEventId;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function onlyKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}
function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}
function hash(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}
