import {
  LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS,
  normalizeLongTermMemoryContent,
  type MemoryItemWrite,
} from "@pico/core/atomic-memory-contracts";
import type { MemoryExtractionSnapshot } from "@pico/core/atomic-memory-runtime-contracts";
import { sanitizeMemoryContent } from "@pico/runtime/atomic-memory/content-safety";

/** Persisted in every part so the quotation remains identifiable after its source session is gone. */
export const REFERENCE_NOTE_LABEL = "用户要求保留的助手笔记（未经独立核实）";
const MAX_PARTS = 32;
const MAX_PART_CODE_POINTS = 1_800;

export type RequestedReferenceNoteResult =
  | { readonly status: "not_requested" }
  | {
      readonly status: "unresolved";
      readonly reason:
        | "reference_ambiguous"
        | "reference_unavailable"
        | "sensitive_information"
        | "reference_too_large"
        | "invalid_reference_content";
    }
  | {
      readonly status: "resolved";
      readonly items: readonly MemoryItemWrite[];
      readonly authorizationEventId: string;
      readonly targetEventId: string;
    };

/**
 * The Host supplies committed, human-authored User events and completion authority.
 * Neither an LLM tool argument nor a model-authored "authorization" can select a body.
 */
export function resolveRequestedReferenceNote(
  snapshot: MemoryExtractionSnapshot,
  context: { readonly completedRunIds: ReadonlySet<string> },
): RequestedReferenceNoteResult {
  if (snapshot.trigger !== "remember") return { status: "not_requested" };
  const events = snapshot.events
    .filter((event) => event.ordinal <= snapshot.boundaryOrdinal)
    .toSorted((a, b) => a.ordinal - b.ordinal);
  const authorization = events.findLast(
    (event) =>
      event.role === "user" && event.runId === snapshot.runId && event.turnId === snapshot.turnId,
  );
  if (!authorization) return { status: "not_requested" };
  const intent = referenceIntent(authorization.text);
  if (intent === "none") return { status: "not_requested" };
  if (intent === "ambiguous") return { status: "unresolved", reason: "reference_ambiguous" };

  // Bind to the immediately preceding visible reply; never skip a failed run or a User
  // message to find an older Assistant response that happens to be easier to save.
  const target = events.findLast(
    (event) => event.ordinal < authorization.ordinal && event.role !== "other",
  );
  if (
    !target ||
    target.role !== "assistant" ||
    target.runId === authorization.runId ||
    !context.completedRunIds.has(target.runId) ||
    !target.text.trim()
  ) {
    return { status: "unresolved", reason: "reference_unavailable" };
  }
  if (Array.from(target.text).length > MAX_PARTS * MAX_PART_CODE_POINTS) {
    return { status: "unresolved", reason: "reference_too_large" };
  }
  // Scan the entire source before splitting: a credential must not escape detection
  // by crossing a part boundary. PII quarantine is rejected just like manual notes.
  const safety = sanitizeMemoryContent({
    title: REFERENCE_NOTE_LABEL,
    // The content contract removes these characters before persistence. Apply the
    // same removal before scanning so it cannot assemble a hidden token afterward.
    content: target.text.replaceAll(/[\u200b-\u200d\ufeff]/gu, ""),
    reason: "用户明确要求保存上一条助手回复",
  });
  if (safety.disposition !== "allow") {
    return { status: "unresolved", reason: "sensitive_information" };
  }
  const parts = splitReferenceText(target.text);
  if (!parts.length || parts.length > MAX_PARTS) {
    return { status: "unresolved", reason: "reference_too_large" };
  }
  const sources = [authorization, target].map((event) => ({
    sessionId: snapshot.sessionId,
    runId: event.runId,
    turnId: event.turnId,
    eventId: event.eventId,
  }));
  const items: MemoryItemWrite[] = [];
  for (const [index, part] of parts.entries()) {
    const normalized = normalizeLongTermMemoryContent(
      `${REFERENCE_NOTE_LABEL} [${index + 1}/${parts.length}]：${part}`,
    );
    if (
      !normalized.ok ||
      Array.from(normalized.value).length > LONG_TERM_MEMORY_CONTENT_MAX_CODE_POINTS
    ) {
      return { status: "unresolved", reason: "invalid_reference_content" };
    }
    items.push({
      content: normalized.value,
      kind: "note",
      statementType: "fact",
      temporalType: "undated",
      scopeType: "workspace",
      scopeKey: snapshot.workspaceKey,
      observedAt: authorization.observedAt,
      origin: "user_requested",
      keys: referenceKeys(part),
      sources,
    });
  }
  return {
    status: "resolved",
    items,
    authorizationEventId: authorization.eventId,
    targetEventId: target.eventId,
  };
}

function referenceIntent(text: string): "nearest" | "ambiguous" | "none" {
  const directive = text
    .normalize("NFKC")
    .trim()
    .replaceAll(/\s+/gu, "")
    .replace(/[。.!！?？]+$/u, "")
    .replace(/(?:[,，]?(?:谢谢|多谢))$/u, "")
    .replace(/吧$/u, "")
    .replace(/^(?:请帮我|麻烦你帮我|麻烦帮我|帮我|请你|麻烦你|麻烦|请)/u, "");
  const verb = "(?:记一下|记住|记下来|记录下来|保存一下|保存下来)";
  const nearest =
    "(?:这个|这条(?:回答|回复)?|这段(?:内容)?|刚才(?:的)?(?:回答|回复|方案|内容)|上一条(?:回答|回复)?|上面(?:的)?(?:回答|回复|方案|内容))";
  if (new RegExp(`^(?:${verb}(?:${nearest})?|(?:把|将)?${nearest}${verb})$`, "u").test(directive))
    return "nearest";
  const ambiguous =
    "(?:第[一二三四五六七八九十0-9]+个|之前(?:的)?(?:那个|那条)|前面(?:的)?(?:那个|那条)|那个|那条)";
  return new RegExp(`^(?:${verb}${ambiguous}|(?:把|将)?${ambiguous}${verb})$`, "u").test(directive)
    ? "ambiguous"
    : "none";
}

function splitReferenceText(text: string): string[] {
  const parts: string[] = [];
  let pending = "";
  for (const paragraph of text.trim().split(/\n\s*\n/u)) {
    const points = Array.from(paragraph.trim());
    if (!points.length) continue;
    if (pending && Array.from(pending).length + points.length + 2 <= MAX_PART_CODE_POINTS) {
      pending += `\n\n${paragraph.trim()}`;
      continue;
    }
    if (pending) parts.push(pending);
    pending = "";
    while (points.length > MAX_PART_CODE_POINTS) {
      parts.push(points.splice(0, MAX_PART_CODE_POINTS).join(""));
    }
    pending = points.join("");
  }
  if (pending) parts.push(pending);
  return parts;
}

function referenceKeys(text: string): MemoryItemWrite["keys"] {
  const normalized = text.normalize("NFKC").toLocaleLowerCase("en-US");
  const terms = new Set(normalized.match(/[\p{L}\p{N}_./-]{2,256}/gu) ?? []);
  for (const run of normalized.match(/\p{Script=Han}+/gu) ?? []) {
    const points = Array.from(run);
    for (let index = 0; index + 1 < points.length; index++) {
      terms.add(`${points[index]}${points[index + 1]}`);
    }
  }
  if (!terms.size) terms.add(Array.from(normalized).slice(0, 256).join(""));
  return [...terms].slice(0, 32).map((key) => ({
    key,
    keyType: "concept",
    keyOrigin: "deterministic",
  }));
}
