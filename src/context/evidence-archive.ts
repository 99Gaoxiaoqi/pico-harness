import { createHash, randomUUID } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import { resolve } from "node:path";
import type { RuntimeEvidenceReference } from "../runtime/runtime-event.js";
import type { Message } from "../schema/message.js";
import {
  assertEvidenceBlobRef,
  EvidenceBlobStore,
  type VerifiedEvidenceDirectory,
  withVerifiedEvidenceDirectory,
  type EvidenceBlobRef,
} from "./evidence-blob-store.js";

const EVIDENCE_ARCHIVE_SCHEMA_VERSION = 1 as const;
const RUNTIME_TOOL_RESULT_EVIDENCE_SCHEMA_VERSION = 2 as const;
export const DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES = 16 * 1024;
export const MAX_EVIDENCE_PAGE_LIMIT_BYTES = 64 * 1024;

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

/** Legacy v1 evidence embedded both raw and model-visible output in the manifest. */
export interface RuntimeToolExchangeEvidenceV1 {
  readonly kind: "tool-exchange";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: string;
  readonly rawOutput: string;
  readonly modelVisibleOutput: string;
  readonly isError: boolean;
}

/** @deprecated Runtime writes use RuntimeToolResultEvidenceV2; retained for v1 readers. */
export type RuntimeToolExchangeEvidence = RuntimeToolExchangeEvidenceV1;

export interface RuntimeToolExchangeEvidenceManifestV1 {
  readonly schemaVersion: typeof EVIDENCE_ARCHIVE_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly archivedAt: string;
  readonly kind: "tool-exchange";
  readonly content: RuntimeToolExchangeEvidenceV1;
}

/** Runtime ToolResult v2 keeps the original body once in the Evidence CAS. */
export interface RuntimeToolResultEvidenceV2 {
  readonly kind: "tool-exchange";
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly arguments: string;
  readonly rawOutput: EvidenceBlobRef;
  readonly isError: boolean;
}

export interface RuntimeToolResultEvidenceManifestV2 {
  readonly schemaVersion: typeof RUNTIME_TOOL_RESULT_EVIDENCE_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly archivedAt: string;
  readonly kind: "tool-exchange";
  readonly content: RuntimeToolResultEvidenceV2;
}

export type RuntimeToolExchangeEvidenceManifest =
  | RuntimeToolExchangeEvidenceManifestV1
  | RuntimeToolResultEvidenceManifestV2;

export interface ArchiveRuntimeToolResultInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawArguments: string;
  readonly rawOutput: string;
  readonly isError: boolean;
}

export interface RuntimeToolOutputPageOptions {
  readonly offsetBytes?: number;
  readonly limitBytes?: number;
}

export interface RuntimeToolOutputPage {
  readonly content: string;
  readonly offsetBytes: number;
  readonly endOffsetBytes: number;
  readonly totalBytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
  readonly nextOffsetBytes?: number;
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
  private readonly blobs: EvidenceBlobStore;

  constructor(options: EvidenceArchiveOptions) {
    this.baseDir = resolve(options.baseDir);
    this.now = options.now ?? (() => new Date());
    this.blobs = new EvidenceBlobStore(this.baseDir);
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
    const created = await writeImmutableJson(
      this.baseDir,
      [sanitizeFilePart(sessionId)],
      `${contentHash}.json`,
      manifest,
    );
    if (!created) await this.read(reference);
    return reference;
  }

  async archiveRuntimeToolExchange(
    sessionId: string,
    toolCallId: string,
    toolName: string,
    rawArguments: string,
    rawOutput: string,
    _modelVisibleOutput: string,
    isError: boolean,
  ): Promise<RuntimeEvidenceReference> {
    return this.archiveRuntimeToolResult({
      sessionId,
      toolCallId,
      toolName,
      rawArguments,
      rawOutput,
      isError,
    });
  }

  async archiveRuntimeToolResult(
    input: ArchiveRuntimeToolResultInput,
  ): Promise<RuntimeEvidenceReference> {
    assertRuntimeToolResultInput(input);
    await withVerifiedEvidenceDirectory(
      this.baseDir,
      [sanitizeFilePart(input.sessionId)],
      { create: true },
      async () => undefined,
    );
    const rawOutput = (await this.blobs.putUtf8(input.rawOutput)).ref;
    const content: RuntimeToolResultEvidenceV2 = {
      kind: "tool-exchange",
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      arguments: input.rawArguments,
      rawOutput,
      isError: input.isError,
    };
    const contentHash = hashContent(content);
    const reference: RuntimeEvidenceReference = {
      schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
      contentHash,
      sessionId: input.sessionId,
      kind: "tool-exchange",
    };
    try {
      await this.readRuntimeToolExchange(reference);
      return reference;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }

    const manifest: RuntimeToolResultEvidenceManifestV2 = {
      schemaVersion: RUNTIME_TOOL_RESULT_EVIDENCE_SCHEMA_VERSION,
      contentHash,
      archivedAt: this.now().toISOString(),
      kind: "tool-exchange",
      content,
    };
    const created = await writeImmutableJson(
      this.baseDir,
      [sanitizeFilePart(input.sessionId)],
      `${contentHash}.json`,
      manifest,
    );
    if (!created) await this.readRuntimeToolExchange(reference);
    return reference;
  }

  async readRuntimeToolOutput(reference: RuntimeEvidenceReference): Promise<string> {
    const manifest = await this.readRuntimeToolExchange(reference);
    if (manifest.schemaVersion === EVIDENCE_ARCHIVE_SCHEMA_VERSION) {
      return manifest.content.rawOutput;
    }
    return (await this.blobs.read(manifest.content.rawOutput)).toString("utf8");
  }

  async readRuntimeToolOutputPage(
    reference: RuntimeEvidenceReference,
    options: RuntimeToolOutputPageOptions = {},
  ): Promise<RuntimeToolOutputPage> {
    const offsetBytes = pageInteger(
      options.offsetBytes,
      "offsetBytes",
      0,
      0,
      Number.MAX_SAFE_INTEGER,
    );
    const limitBytes = pageInteger(
      options.limitBytes,
      "limitBytes",
      DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES,
      1,
      MAX_EVIDENCE_PAGE_LIMIT_BYTES,
    );
    const manifest = await this.readRuntimeToolExchange(reference);
    if (manifest.schemaVersion === EVIDENCE_ARCHIVE_SCHEMA_VERSION) {
      return buildRuntimeToolOutputPage(
        Buffer.from(manifest.content.rawOutput, "utf8"),
        offsetBytes,
        limitBytes,
      );
    }
    const page = await this.blobs.readPage(manifest.content.rawOutput, offsetBytes, limitBytes);
    return {
      content: page.bytes.toString("utf8"),
      offsetBytes: page.offsetBytes,
      endOffsetBytes: page.endOffsetBytes,
      totalBytes: page.totalBytes,
      limitBytes,
      truncated: page.endOffsetBytes < page.totalBytes,
      ...(page.endOffsetBytes < page.totalBytes ? { nextOffsetBytes: page.endOffsetBytes } : {}),
    };
  }

  async read(reference: EvidenceArchiveReference): Promise<EvidenceArchiveManifest>;
  async read(reference: RuntimeEvidenceReference): Promise<RuntimeToolExchangeEvidenceManifest>;
  async read(
    reference: EvidenceArchiveReference | RuntimeEvidenceReference,
  ): Promise<EvidenceArchiveManifest | RuntimeToolExchangeEvidenceManifest> {
    if (hasRuntimeEvidenceKind(reference)) return this.readRuntimeToolExchange(reference);
    assertEvidenceArchiveReference(reference);
    const manifest = await readImmutableJson(
      this.baseDir,
      [sanitizeFilePart(reference.sessionId)],
      `${reference.contentHash}.json`,
      decodeManifest,
      "Evidence archive manifest",
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

  async readRuntimeToolExchange(
    reference: RuntimeEvidenceReference,
  ): Promise<RuntimeToolExchangeEvidenceManifest> {
    assertRuntimeEvidenceReference(reference);
    const manifest = await readImmutableJson(
      this.baseDir,
      [sanitizeFilePart(reference.sessionId)],
      `${reference.contentHash}.json`,
      decodeRuntimeToolExchangeManifest,
      "Runtime tool-exchange evidence manifest",
    );
    if (
      manifest.contentHash !== reference.contentHash ||
      manifest.kind !== reference.kind ||
      manifest.content.kind !== reference.kind ||
      manifest.content.sessionId !== reference.sessionId
    ) {
      throw new EvidenceArchiveIntegrityError(
        "Runtime tool-exchange evidence reference does not match manifest",
      );
    }
    if (hashContent(manifest.content) !== manifest.contentHash) {
      throw new EvidenceArchiveIntegrityError(
        "Runtime tool-exchange evidence content hash mismatch",
      );
    }
    return manifest;
  }
}

export function formatRuntimeEvidenceUri(reference: RuntimeEvidenceReference): string {
  assertRuntimeEvidenceReference(reference);
  return `pico://evidence/${encodeURIComponent(reference.sessionId)}/${reference.contentHash}`;
}

export function parseRuntimeEvidenceUri(value: string): RuntimeEvidenceReference {
  const match = /^pico:\/\/evidence\/([^/]+)\/([a-f0-9]{64})$/u.exec(value);
  if (!match) {
    throw new EvidenceArchiveIntegrityError("Runtime evidence ref is invalid");
  }
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch (error) {
    throw new EvidenceArchiveIntegrityError(
      `Runtime evidence ref has invalid session encoding: ${errorMessage(error)}`,
    );
  }
  if (!isNonEmptyString(sessionId) || encodeURIComponent(sessionId) !== match[1]) {
    throw new EvidenceArchiveIntegrityError("Runtime evidence ref has a non-canonical session");
  }
  return {
    schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
    contentHash: match[2]!,
    sessionId,
    kind: "tool-exchange",
  };
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

function decodeRuntimeToolExchangeManifest(value: unknown): RuntimeToolExchangeEvidenceManifest {
  if (
    !isRecord(value) ||
    (value["schemaVersion"] !== EVIDENCE_ARCHIVE_SCHEMA_VERSION &&
      value["schemaVersion"] !== RUNTIME_TOOL_RESULT_EVIDENCE_SCHEMA_VERSION)
  ) {
    throw new EvidenceArchiveIntegrityError(
      "Runtime tool-exchange evidence has an invalid schema version",
    );
  }
  if (
    !isNonEmptyString(value["contentHash"]) ||
    !isNonEmptyString(value["archivedAt"]) ||
    value["kind"] !== "tool-exchange"
  ) {
    throw new EvidenceArchiveIntegrityError(
      "Runtime tool-exchange evidence has an invalid envelope",
    );
  }
  if (value["schemaVersion"] === EVIDENCE_ARCHIVE_SCHEMA_VERSION) {
    return {
      schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
      contentHash: value["contentHash"],
      archivedAt: value["archivedAt"],
      kind: "tool-exchange",
      content: decodeRuntimeToolExchangeEvidenceV1(value["content"]),
    };
  }
  return {
    schemaVersion: RUNTIME_TOOL_RESULT_EVIDENCE_SCHEMA_VERSION,
    contentHash: value["contentHash"],
    archivedAt: value["archivedAt"],
    kind: "tool-exchange",
    content: decodeRuntimeToolResultEvidenceV2(value["content"]),
  };
}

function assertRuntimeToolResultInput(
  input: ArchiveRuntimeToolResultInput,
): asserts input is ArchiveRuntimeToolResultInput {
  if (!isNonEmptyString(input.sessionId)) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange session ID must be non-empty");
  }
  if (!isNonEmptyString(input.toolCallId)) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange call ID must be non-empty");
  }
  if (!isNonEmptyString(input.toolName)) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange tool name must be non-empty");
  }
  if (
    typeof input.rawArguments !== "string" ||
    typeof input.rawOutput !== "string" ||
    typeof input.isError !== "boolean"
  ) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange payload is invalid");
  }
}

function decodeRuntimeToolExchangeEvidenceV1(value: unknown): RuntimeToolExchangeEvidenceV1 {
  if (
    !isRecord(value) ||
    value["kind"] !== "tool-exchange" ||
    !isNonEmptyString(value["sessionId"]) ||
    !isNonEmptyString(value["toolCallId"]) ||
    !isNonEmptyString(value["toolName"]) ||
    typeof value["arguments"] !== "string" ||
    typeof value["rawOutput"] !== "string" ||
    typeof value["modelVisibleOutput"] !== "string" ||
    typeof value["isError"] !== "boolean"
  ) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange evidence has invalid content");
  }
  return {
    kind: "tool-exchange",
    sessionId: value["sessionId"],
    toolCallId: value["toolCallId"],
    toolName: value["toolName"],
    arguments: value["arguments"],
    rawOutput: value["rawOutput"],
    modelVisibleOutput: value["modelVisibleOutput"],
    isError: value["isError"],
  };
}

function decodeRuntimeToolResultEvidenceV2(value: unknown): RuntimeToolResultEvidenceV2 {
  if (
    !isRecord(value) ||
    value["kind"] !== "tool-exchange" ||
    !isNonEmptyString(value["sessionId"]) ||
    !isNonEmptyString(value["toolCallId"]) ||
    !isNonEmptyString(value["toolName"]) ||
    typeof value["arguments"] !== "string" ||
    typeof value["isError"] !== "boolean"
  ) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange evidence has invalid content");
  }
  try {
    assertEvidenceBlobRef(value["rawOutput"]);
  } catch (error) {
    throw new EvidenceArchiveIntegrityError(
      `Runtime tool-exchange evidence has invalid blob reference: ${errorMessage(error)}`,
    );
  }
  return {
    kind: "tool-exchange",
    sessionId: value["sessionId"],
    toolCallId: value["toolCallId"],
    toolName: value["toolName"],
    arguments: value["arguments"],
    rawOutput: value["rawOutput"],
    isError: value["isError"],
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

function hashContent(content: unknown): string {
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

function hasRuntimeEvidenceKind(
  reference: EvidenceArchiveReference | RuntimeEvidenceReference,
): reference is RuntimeEvidenceReference {
  return "kind" in reference;
}

function assertEvidenceArchiveReference(reference: EvidenceArchiveReference): void {
  if (
    reference.schemaVersion !== EVIDENCE_ARCHIVE_SCHEMA_VERSION ||
    !isNonEmptyString(reference.sessionId) ||
    !isNonNegativeInteger(reference.exchangeCount)
  ) {
    throw new EvidenceArchiveIntegrityError("Evidence archive reference is invalid");
  }
}

function assertRuntimeEvidenceReference(reference: RuntimeEvidenceReference): void {
  if (
    reference.schemaVersion !== EVIDENCE_ARCHIVE_SCHEMA_VERSION ||
    !isContentHash(reference.contentHash) ||
    !isNonEmptyString(reference.sessionId) ||
    reference.kind !== "tool-exchange"
  ) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange evidence reference is invalid");
  }
}

async function readImmutableJson<T>(
  baseDir: string,
  directoryParts: readonly string[],
  fileName: string,
  decoder: (value: unknown) => T,
  label: string,
): Promise<T> {
  let raw: Buffer;
  try {
    raw = await withVerifiedEvidenceDirectory(
      baseDir,
      directoryParts,
      { create: false },
      (directory) => directory.readRegularFile(fileName, label),
    );
  } catch (error) {
    if (isMissing(error)) throw error;
    throw new EvidenceArchiveIntegrityError(`${label} is unreadable: ${errorMessage(error)}`);
  }
  let value: unknown;
  try {
    value = JSON.parse(raw.toString("utf8")) as unknown;
  } catch (error) {
    throw new EvidenceArchiveIntegrityError(`${label} is invalid JSON: ${errorMessage(error)}`);
  }
  return decoder(value);
}

function pageInteger(
  value: number | undefined,
  field: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new EvidenceArchiveIntegrityError(
      `${field} must be an integer between ${minimum} and ${maximum}`,
    );
  }
  return value;
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function buildRuntimeToolOutputPage(
  bytes: Buffer,
  offsetBytes: number,
  limitBytes: number,
): RuntimeToolOutputPage {
  if (offsetBytes > bytes.byteLength) {
    throw new EvidenceArchiveIntegrityError(
      `Evidence offsetBytes ${offsetBytes} exceeds output size ${bytes.byteLength}`,
    );
  }
  if (offsetBytes < bytes.byteLength && isUtf8ContinuationByte(bytes[offsetBytes]!)) {
    throw new EvidenceArchiveIntegrityError(
      `Evidence offsetBytes ${offsetBytes} is not a UTF-8 code point boundary`,
    );
  }

  let endOffsetBytes = Math.min(bytes.byteLength, offsetBytes + limitBytes);
  if (endOffsetBytes < bytes.byteLength) {
    while (endOffsetBytes > offsetBytes && isUtf8ContinuationByte(bytes[endOffsetBytes]!)) {
      endOffsetBytes--;
    }
  }
  if (endOffsetBytes === offsetBytes && offsetBytes < bytes.byteLength) {
    throw new EvidenceArchiveIntegrityError(
      `Evidence limitBytes ${limitBytes} cannot contain the next complete UTF-8 code point`,
    );
  }
  return {
    content: bytes.subarray(offsetBytes, endOffsetBytes).toString("utf8"),
    offsetBytes,
    endOffsetBytes,
    totalBytes: bytes.byteLength,
    limitBytes,
    truncated: endOffsetBytes < bytes.byteLength,
    ...(endOffsetBytes < bytes.byteLength ? { nextOffsetBytes: endOffsetBytes } : {}),
  };
}

async function writeImmutableJson(
  baseDir: string,
  directoryParts: readonly string[],
  fileName: string,
  value: unknown,
): Promise<boolean> {
  return withVerifiedEvidenceDirectory(
    baseDir,
    directoryParts,
    { create: true },
    async (directory) => writeImmutableJsonInDirectory(directory, fileName, value),
  );
}

async function writeImmutableJsonInDirectory(
  directory: VerifiedEvidenceDirectory,
  fileName: string,
  value: unknown,
): Promise<boolean> {
  const temporaryName = `.${fileName}.${process.pid}.${Date.now()}.${randomUUID()}.tmp`;
  let handle: FileHandle | undefined;
  try {
    handle = await directory.createExclusiveFile(temporaryName, 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    const temporaryIdentity = await handle.stat({ bigint: true });
    try {
      await directory.linkFile(temporaryName, fileName);
    } catch (error) {
      if (isAlreadyExists(error)) return false;
      throw error;
    }

    let finalHandle: FileHandle | undefined;
    try {
      finalHandle = await directory.openRegularFile(fileName, "Evidence archive manifest");
      const finalIdentity = await finalHandle.stat({ bigint: true });
      if (
        temporaryIdentity.dev !== finalIdentity.dev ||
        temporaryIdentity.ino !== finalIdentity.ino
      ) {
        await directory.unlinkFile(fileName).catch(() => undefined);
        throw new EvidenceArchiveIntegrityError(
          "Evidence archive manifest changed while it was published",
        );
      }
    } finally {
      await finalHandle?.close().catch(() => undefined);
    }
    await directory.sync();
    return true;
  } finally {
    await handle?.close().catch(() => undefined);
    await directory.unlinkFile(temporaryName).catch(() => undefined);
  }
}

function isAlreadyExists(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "EEXIST";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
