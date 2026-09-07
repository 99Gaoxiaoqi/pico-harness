import { createHash } from "node:crypto";
import { redactSensitiveText } from "../../mcp/redact.js";
import { isMessageHiddenFromTranscript, type Message } from "../../schema/message.js";
import type { MemoryItemSource } from "./contracts.js";
import type { MemoryEvidenceEvent } from "./runtime-contracts.js";

export interface AtomicMemoryEvidence {
  readonly sourceRef: string;
  readonly event: MemoryEvidenceEvent;
  readonly texts: readonly string[];
}

export function normalizeEvidenceText(text: string): string {
  return text.normalize("NFC").replaceAll(/\s+/gu, " ").trim();
}

export function evidenceSource(sessionId: string, event: MemoryEvidenceEvent): MemoryItemSource {
  return { sessionId, eventId: event.eventId, runId: event.runId, turnId: event.turnId };
}

/** Only plain text survives: tool observations disguised as user messages remain excluded. */
export function memoryConversationMessages(messages: readonly Message[]): Message[] {
  return messages.flatMap((message) => {
    if (
      message.toolCallId !== undefined ||
      isMessageHiddenFromTranscript(message) ||
      !message.content ||
      (message.role !== "user" && message.role !== "assistant")
    )
      return [];
    return [{ role: message.role, content: message.content }];
  });
}

export function memoryEvidenceCoverageHash(events: readonly MemoryEvidenceEvent[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        events.map((event) => ({
          ordinal: event.ordinal,
          eventId: event.eventId,
          runId: event.runId,
          turnId: event.turnId,
          observedAt: event.observedAt,
          role: event.role,
          text: event.text,
        })),
      ),
    )
    .digest("hex");
}

export function projectAtomicMemoryEvidence(
  events: readonly MemoryEvidenceEvent[],
  sourceMessages?: readonly Message[],
): AtomicMemoryEvidence[] {
  const visible =
    sourceMessages === undefined
      ? undefined
      : memoryConversationMessages(sourceMessages)
          .filter((message) => message.role === "user")
          .map((message) => normalizeEvidenceText(message.content));
  return events.flatMap((event) => {
    if (event.role !== "user") return [];
    const text = normalizeEvidenceText(event.text);
    if (!text || isMessageHiddenFromTranscript({ role: "user", content: event.text })) return [];
    // Without event-to-message indexes, require exact containment in both authorities.
    // Never expose a hidden part of the ledger in a provider-prefix extraction request.
    const texts =
      visible === undefined
        ? [text]
        : visible.flatMap((message) =>
            message.includes(text) ? [text] : text.includes(message) && message ? [message] : [],
          );
    return texts.length
      ? [{ sourceRef: `event:${event.eventId}`, event, texts: [...new Set(texts)] }]
      : [];
  });
}

/** Keep every evidence identity in the payload. A range that cannot fit must not advance. */
export function fitAtomicMemoryEvidence(
  evidence: readonly AtomicMemoryEvidence[],
): AtomicMemoryEvidence[] | undefined {
  for (let cap = 4_000; cap >= 32; cap = Math.floor(cap / 2)) {
    const fitted = evidence.map((entry) => ({
      ...entry,
      texts: entry.texts.map((text) => Array.from(text).slice(0, cap).join("")),
    }));
    if (JSON.stringify(renderAtomicMemoryEvidence(fitted)).length <= 12_000) return fitted;
  }
  return undefined;
}

export function renderAtomicMemoryEvidence(evidence: readonly AtomicMemoryEvidence[]): unknown {
  return evidence.map(({ sourceRef, event, texts }) => ({
    sourceRef,
    observedAt: event.observedAt,
    texts,
  }));
}

export function memoryTextContainsSecret(text: string): boolean {
  return (
    redactSensitiveText(text) !== text ||
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----/iu.test(text) ||
    /\b(?:sk-[A-Za-z0-9_-]{16,}|ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[A-Z0-9]{16}|xox[baprs]-[A-Za-z0-9-]{10,})\b/u.test(
      text,
    ) ||
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/u.test(text)
  );
}

export function localizeAtomicMemoryHistory(
  events: readonly MemoryEvidenceEvent[],
  search: { readonly terms: readonly string[]; readonly roles?: readonly string[] },
): MemoryEvidenceEvent[] {
  const turns: MemoryEvidenceEvent[][] = [];
  for (const event of events) {
    if (event.role !== "user" && event.role !== "assistant") continue;
    const previous = turns.at(-1)?.[0];
    if (previous?.runId === event.runId && previous.turnId === event.turnId)
      turns.at(-1)!.push(event);
    else turns.push([event]);
  }
  const terms = search.terms
    .map((term) => normalizeEvidenceText(term).toLowerCase())
    .filter(Boolean);
  const hits = turns
    .map((turn, index) => ({
      index,
      score: terms.filter((term) =>
        turn.some(
          (event) =>
            (!search.roles || search.roles.includes(event.role)) &&
            normalizeEvidenceText(event.text).toLowerCase().includes(term),
        ),
      ).length,
    }))
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || b.index - a.index);
  const selected = new Set<number>();
  for (const hit of hits) {
    for (const index of [hit.index, hit.index - 1, hit.index + 1]) {
      if (selected.size >= 3) break;
      if (index >= 0 && index < turns.length) selected.add(index);
    }
  }
  return [...selected].sort((a, b) => a - b).flatMap((index) => turns[index]!);
}

export function memoryInterpretationContext(events: readonly MemoryEvidenceEvent[]): string {
  return JSON.stringify(
    events.map((event) => ({
      role: event.role,
      text: Array.from(event.text).slice(0, 1_000).join(""),
    })),
  ).slice(0, 6_000);
}
