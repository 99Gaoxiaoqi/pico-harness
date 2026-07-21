import type { Message, ToolDefinition } from "../schema/message.js";
import { MEMORY_KINDS, type MemoryKind } from "./domain.js";
import type { RawMemoryProposalCandidate } from "./proposal-contracts.js";

const TOOL_NAME = "submit_memory_proposals";
const MAX_CANDIDATES = 8;
const MAX_TITLE_LENGTH = 160;
const MAX_CONTENT_LENGTH = 1_000;
const MAX_REASON_LENGTH = 600;

export const MEMORY_PROPOSAL_TOOL: ToolDefinition = Object.freeze({
  name: TOOL_NAME,
  description:
    "Submit only stable, user-supported workspace memory proposals. Return an empty array when nothing is durable.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    properties: {
      proposals: {
        type: "array",
        maxItems: MAX_CANDIDATES,
        items: {
          type: "object",
          additionalProperties: false,
          properties: {
            kind: {
              type: "string",
              enum: [...MEMORY_KINDS],
              description:
                "Use preference for stable response/style choices, correction for explicit corrections, project_fact for repository rules or commands, and reference for durable pointers such as paths, documents, URLs, or named branches.",
            },
            title: { type: "string", minLength: 1, maxLength: MAX_TITLE_LENGTH },
            content: { type: "string", minLength: 1, maxLength: MAX_CONTENT_LENGTH },
            reason: { type: "string", minLength: 1, maxLength: MAX_REASON_LENGTH },
            confidence: { type: "number", minimum: 0, maximum: 1 },
            evidenceEventIds: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 },
            },
          },
          required: ["kind", "title", "content", "reason", "confidence", "evidenceEventIds"],
        },
      },
    },
    required: ["proposals"],
  },
});

export class MemoryProposalParseError extends Error {
  constructor(readonly code: string) {
    super(`Memory proposal response is invalid: ${code}`);
    this.name = "MemoryProposalParseError";
  }
}

/** Accepts one exact tool call only. Text/Markdown JSON fallbacks are intentionally rejected. */
export function parseMemoryProposalResponse(
  response: Message,
  allowedEvidenceEventIds: readonly string[],
): RawMemoryProposalCandidate[] {
  if (response.role !== "assistant") throw new MemoryProposalParseError("response_role");
  if (!response.toolCalls || response.toolCalls.length !== 1) {
    throw new MemoryProposalParseError("tool_call_count");
  }
  const call = response.toolCalls[0]!;
  if (call.name !== TOOL_NAME) throw new MemoryProposalParseError("tool_name");
  let value: unknown;
  try {
    value = JSON.parse(call.arguments) as unknown;
  } catch {
    throw new MemoryProposalParseError("malformed_json");
  }
  const root = requireExactRecord(value, ["proposals"], "root_shape");
  const proposals = root["proposals"];
  if (!Array.isArray(proposals) || proposals.length > MAX_CANDIDATES) {
    throw new MemoryProposalParseError("proposal_count");
  }
  const allowed = new Set(allowedEvidenceEventIds);
  return proposals.map((candidate, index) => parseCandidate(candidate, index, allowed));
}

function parseCandidate(
  value: unknown,
  index: number,
  allowedEvidenceEventIds: ReadonlySet<string>,
): RawMemoryProposalCandidate {
  const field = (suffix: string): string => `proposal_${index}_${suffix}`;
  const record = requireExactRecord(
    value,
    ["kind", "title", "content", "reason", "confidence", "evidenceEventIds"],
    field("shape"),
  );
  const kind = record["kind"];
  if (typeof kind !== "string" || !MEMORY_KINDS.includes(kind as MemoryKind)) {
    throw new MemoryProposalParseError(field("kind"));
  }
  const title = requireBoundedText(record["title"], MAX_TITLE_LENGTH, field("title"));
  const content = requireBoundedText(record["content"], MAX_CONTENT_LENGTH, field("content"));
  const reason = requireBoundedText(record["reason"], MAX_REASON_LENGTH, field("reason"));
  const confidence = record["confidence"];
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    throw new MemoryProposalParseError(field("confidence"));
  }
  const evidence = record["evidenceEventIds"];
  if (!Array.isArray(evidence) || evidence.length === 0) {
    throw new MemoryProposalParseError(field("evidence"));
  }
  const eventIds: string[] = [];
  for (const eventId of evidence) {
    if (typeof eventId !== "string" || !allowedEvidenceEventIds.has(eventId)) {
      throw new MemoryProposalParseError(field("evidence"));
    }
    if (!eventIds.includes(eventId)) eventIds.push(eventId);
  }
  return {
    kind: kind as MemoryKind,
    title,
    content,
    reason,
    confidence,
    evidenceEventIds: eventIds,
  };
}

function requireExactRecord(
  value: unknown,
  expectedKeys: readonly string[],
  code: string,
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new MemoryProposalParseError(code);
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record).sort();
  const expected = [...expectedKeys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
    throw new MemoryProposalParseError(code);
  }
  return record;
}

function requireBoundedText(value: unknown, maxLength: number, code: string): string {
  if (typeof value !== "string") throw new MemoryProposalParseError(code);
  const normalized = value.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new MemoryProposalParseError(code);
  }
  return normalized;
}
