import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import type { Message } from "../schema/message.js";
import { readVersionedJson, writeJsonAtomic } from "../storage/atomic-json.js";

const EVIDENCE_ARCHIVE_SCHEMA_VERSION = 1 as const;

export interface EvidenceToolExchange {
  /** Zero-based position of the assistant tool-call message in the compacted prefix. */
  readonly historyIndex: number;
  readonly assistant: Message;
  readonly results: readonly Message[];
}

interface EvidenceArchiveContent {
  readonly sessionId: string;
  readonly exchanges: readonly EvidenceToolExchange[];
}

export interface EvidenceArchiveManifest {
  readonly schemaVersion: typeof EVIDENCE_ARCHIVE_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly archivedAt: string;
  readonly content: EvidenceArchiveContent;
}

/** Stored on the compaction summary, never injected into model-visible message content. */
export interface EvidenceArchiveReference {
  readonly schemaVersion: typeof EVIDENCE_ARCHIVE_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly sessionId: string;
  readonly exchangeCount: number;
}

export interface EvidenceArchiveOptions {
  readonly baseDir: string;
  readonly now?: () => Date;
}

export class EvidenceArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceArchiveIntegrityError";
  }
}

/**
 * Immutable, content-addressed evidence for raw tool exchanges removed by full compaction.
 * This store is intentionally separate from short-lived tool-result artifacts: the latter
 * optimize a live turn, while this preserves the source material behind a durable summary.
 */
export class EvidenceArchive {
  private readonly baseDir: string;
  private readonly now: () => Date;

  constructor(options: EvidenceArchiveOptions) {
    this.baseDir = resolve(options.baseDir);
    this.now = options.now ?? (() => new Date());
  }

  async archiveToolExchanges(
    sessionId: string,
    messages: readonly Message[],
  ): Promise<EvidenceArchiveReference | undefined> {
    if (!isNonEmptyString(sessionId)) {
      throw new EvidenceArchiveIntegrityError("Evidence archive session ID must be non-empty");
    }
    const exchanges = extractCompletedToolExchanges(messages);
    if (exchanges.length === 0) return undefined;

    const content: EvidenceArchiveContent = {
      sessionId,
      exchanges: jsonRoundTrip(exchanges) as EvidenceToolExchange[],
    };
    const contentHash = hashContent(content);
    const reference: EvidenceArchiveReference = {
      schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
      contentHash,
      sessionId,
      exchangeCount: exchanges.length,
    };
    try {
      await this.read(reference);
      return reference;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const manifest: EvidenceArchiveManifest = {
      schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
      contentHash,
      archivedAt: this.now().toISOString(),
      content,
    };
    await writeJsonAtomic(this.pathFor(sessionId, contentHash), manifest, {
      directoryMode: 0o700,
      fileMode: 0o600,
    });
    return reference;
  }

  async read(reference: EvidenceArchiveReference): Promise<EvidenceArchiveManifest> {
    const manifest = await readVersionedJson(
      this.pathFor(reference.sessionId, reference.contentHash),
      decodeManifest,
    );
    if (
      manifest.contentHash !== reference.contentHash ||
      manifest.content.sessionId !== reference.sessionId ||
      manifest.content.exchanges.length !== reference.exchangeCount
    ) {
      throw new EvidenceArchiveIntegrityError("Evidence archive reference does not match manifest");
    }
    if (hashContent(manifest.content) !== manifest.contentHash) {
      throw new EvidenceArchiveIntegrityError("Evidence archive content hash mismatch");
    }
    return manifest;
  }

  private pathFor(sessionId: string, contentHash: string): string {
    if (!isContentHash(contentHash)) {
      throw new EvidenceArchiveIntegrityError("Evidence archive content hash is invalid");
    }
    return join(this.baseDir, sanitizeFilePart(sessionId), `${contentHash}.json`);
  }
}

export function extractCompletedToolExchanges(
  messages: readonly Message[],
): EvidenceToolExchange[] {
  const exchanges: EvidenceToolExchange[] = [];
  for (let index = 0; index < messages.length; index++) {
    const assistant = messages[index]!;
    if (
      assistant.role !== "assistant" ||
      !assistant.toolCalls ||
      assistant.toolCalls.length === 0
    ) {
      continue;
    }

    const expected = new Map(assistant.toolCalls.map((call) => [call.id, call]));
    if (expected.size !== assistant.toolCalls.length) {
      throw new EvidenceArchiveIntegrityError(
        "Assistant tool-call batch contains duplicate call IDs",
      );
    }
    const results: Message[] = [];
    let cursor = index + 1;
    while (cursor < messages.length) {
      const result = messages[cursor]!;
      if (result.role !== "user" || result.toolCallId === undefined) break;
      if (
        !expected.has(result.toolCallId) ||
        results.some((item) => item.toolCallId === result.toolCallId)
      ) {
        throw new EvidenceArchiveIntegrityError(
          "Tool result does not match its preceding tool-call batch",
        );
      }
      results.push(result);
      cursor++;
    }
    if (results.length !== expected.size) {
      throw new EvidenceArchiveIntegrityError(
        "Compacted tool-call batch is missing one or more results",
      );
    }
    exchanges.push({ historyIndex: index, assistant, results });
    index = cursor - 1;
  }
  return exchanges;
}

function decodeManifest(value: unknown): EvidenceArchiveManifest {
  if (!isRecord(value) || value["schemaVersion"] !== EVIDENCE_ARCHIVE_SCHEMA_VERSION) {
    throw new EvidenceArchiveIntegrityError("Evidence archive has an invalid schema version");
  }
  if (!isNonEmptyString(value["contentHash"]) || !isNonEmptyString(value["archivedAt"])) {
    throw new EvidenceArchiveIntegrityError("Evidence archive has an invalid envelope");
  }
  const content = value["content"];
  if (
    !isRecord(content) ||
    !isNonEmptyString(content["sessionId"]) ||
    !Array.isArray(content["exchanges"])
  ) {
    throw new EvidenceArchiveIntegrityError("Evidence archive has invalid content");
  }
  const exchanges = content["exchanges"].map(decodeExchange);
  return {
    schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
    contentHash: value["contentHash"],
    archivedAt: value["archivedAt"],
    content: { sessionId: content["sessionId"], exchanges },
  };
}

function decodeExchange(value: unknown): EvidenceToolExchange {
  if (!isRecord(value) || !isNonNegativeInteger(value["historyIndex"])) {
    throw new EvidenceArchiveIntegrityError("Evidence archive exchange has an invalid index");
  }
  const assistant = decodeMessage(value["assistant"]);
  if (assistant.role !== "assistant" || !assistant.toolCalls || assistant.toolCalls.length === 0) {
    throw new EvidenceArchiveIntegrityError(
      "Evidence archive exchange has no assistant tool-call batch",
    );
  }
  if (!Array.isArray(value["results"])) {
    throw new EvidenceArchiveIntegrityError("Evidence archive exchange has invalid results");
  }
  const results = value["results"].map(decodeMessage);
  const expected = new Set(assistant.toolCalls.map((call) => call.id));
  if (
    expected.size !== assistant.toolCalls.length ||
    results.length !== expected.size ||
    results.some(
      (result) =>
        result.role !== "user" ||
        result.toolCallId === undefined ||
        !expected.delete(result.toolCallId),
    )
  ) {
    throw new EvidenceArchiveIntegrityError(
      "Evidence archive exchange violates tool-call/result pairing",
    );
  }
  return { historyIndex: value["historyIndex"], assistant, results };
}

function decodeMessage(value: unknown): Message {
  if (!isRecord(value) || !isMessageRole(value["role"]) || typeof value["content"] !== "string") {
    throw new EvidenceArchiveIntegrityError("Evidence archive contains an invalid message");
  }
  if (value["toolCallId"] !== undefined && !isNonEmptyString(value["toolCallId"])) {
    throw new EvidenceArchiveIntegrityError("Evidence archive message has invalid toolCallId");
  }
  if (value["toolCalls"] !== undefined) {
    if (!Array.isArray(value["toolCalls"]) || !value["toolCalls"].every(isToolCall)) {
      throw new EvidenceArchiveIntegrityError("Evidence archive message has invalid toolCalls");
    }
  }
  return jsonRoundTrip(value) as Message;
}

function isToolCall(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNonEmptyString(value["id"]) &&
    isNonEmptyString(value["name"]) &&
    typeof value["arguments"] === "string"
  );
}

function hashContent(content: EvidenceArchiveContent): string {
  return createHash("sha256").update(stableJson(content)).digest("hex");
}

function stableJson(value: unknown): string {
  if (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  throw new EvidenceArchiveIntegrityError("Evidence archive content must be JSON serializable");
}

function jsonRoundTrip(value: unknown): unknown {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new EvidenceArchiveIntegrityError("Evidence archive content must be JSON serializable");
  }
  return JSON.parse(serialized) as unknown;
}

function sanitizeFilePart(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/gu, "_");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isMessageRole(value: unknown): value is Message["role"] {
  return value === "system" || value === "user" || value === "assistant";
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}
