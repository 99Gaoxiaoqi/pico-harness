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
const BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION = 2 as const;
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

/** Opaque address decoded from a model-visible pico://evidence URI. */
export interface EvidenceUriReference {
  readonly schemaVersion: typeof EVIDENCE_ARCHIVE_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly sessionId: string;
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
  readonly schemaVersion: typeof BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly archivedAt: string;
  readonly kind: "tool-exchange";
  readonly content: RuntimeToolResultEvidenceV2;
}

/** Complete subagent reports share the same immutable Evidence blob CAS. */
export interface SubagentReportEvidenceV2 {
  readonly kind: "subagent-report";
  readonly sessionId: string;
  readonly taskPrompt: string;
  readonly status: "completed" | "partial";
  readonly report: EvidenceBlobRef;
}

export interface SubagentReportEvidenceManifestV2 {
  readonly schemaVersion: typeof BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION;
  readonly contentHash: string;
  readonly archivedAt: string;
  readonly kind: "subagent-report";
  readonly content: SubagentReportEvidenceV2;
}

export interface SubagentReportEvidenceReference extends EvidenceUriReference {
  readonly kind: "subagent-report";
}

export type BlobEvidenceManifest =
  | RuntimeToolResultEvidenceManifestV2
  | SubagentReportEvidenceManifestV2;

export interface ArchiveRuntimeToolResultInput {
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly rawArguments: string;
  readonly rawOutput: string;
  readonly isError: boolean;
}

export interface ArchiveSubagentReportInput {
  readonly sessionId: string;
  readonly taskPrompt: string;
  readonly report: string;
  readonly status: "completed" | "partial";
}

export interface EvidencePageOptions {
  readonly offsetBytes?: number;
  readonly limitBytes?: number;
}

export interface EvidencePage {
  readonly kind: BlobEvidenceManifest["kind"];
  readonly content: string;
  readonly offsetBytes: number;
  readonly endOffsetBytes: number;
  readonly totalBytes: number;
  readonly limitBytes: number;
  readonly truncated: boolean;
  readonly nextOffsetBytes?: number;
}

export type RuntimeToolOutputPageOptions = EvidencePageOptions;
export type RuntimeToolOutputPage = Omit<EvidencePage, "kind">;

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

/** Immutable, content-addressed evidence for compaction, ToolResults, and subagent reports. */
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
      schemaVersion: BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION,
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

  async archiveSubagentReport(
    input: ArchiveSubagentReportInput,
  ): Promise<SubagentReportEvidenceReference> {
    assertSubagentReportInput(input);
    await withVerifiedEvidenceDirectory(
      this.baseDir,
      [sanitizeFilePart(input.sessionId)],
      { create: true },
      async () => undefined,
    );
    const report = (await this.blobs.putUtf8(input.report)).ref;
    const content: SubagentReportEvidenceV2 = {
      kind: "subagent-report",
      sessionId: input.sessionId,
      taskPrompt: input.taskPrompt,
      status: input.status,
      report,
    };
    const contentHash = hashContent(content);
    const reference: SubagentReportEvidenceReference = {
      schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
      contentHash,
      sessionId: input.sessionId,
      kind: "subagent-report",
    };
    try {
      await this.readSubagentReportEvidence(reference);
      return reference;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    const manifest: SubagentReportEvidenceManifestV2 = {
      schemaVersion: BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION,
      contentHash,
      archivedAt: this.now().toISOString(),
      kind: "subagent-report",
      content,
    };
    const created = await writeImmutableJson(
      this.baseDir,
      [sanitizeFilePart(input.sessionId)],
      `${contentHash}.json`,
      manifest,
    );
    if (!created) await this.readSubagentReportEvidence(reference);
    return reference;
  }

  async readRuntimeToolOutput(reference: RuntimeEvidenceReference): Promise<string> {
    const manifest = await this.readRuntimeToolExchange(reference);
    return (await this.blobs.read(manifest.content.rawOutput)).toString("utf8");
  }

  async readSubagentReport(reference: SubagentReportEvidenceReference): Promise<string> {
    const manifest = await this.readSubagentReportEvidence(reference);
    return (await this.blobs.read(manifest.content.report)).toString("utf8");
  }

  async readRuntimeToolOutputPage(
    reference: RuntimeEvidenceReference,
    options: RuntimeToolOutputPageOptions = {},
  ): Promise<RuntimeToolOutputPage> {
    const page = await this.readEvidencePage(reference, options);
    if (page.kind !== "tool-exchange") {
      throw new EvidenceArchiveIntegrityError("Evidence kind is not tool-exchange");
    }
    return {
      content: page.content,
      offsetBytes: page.offsetBytes,
      endOffsetBytes: page.endOffsetBytes,
      totalBytes: page.totalBytes,
      limitBytes: page.limitBytes,
      truncated: page.truncated,
      ...(page.nextOffsetBytes === undefined
        ? {}
        : { nextOffsetBytes: page.nextOffsetBytes }),
    };
  }

  async readEvidencePage(
    reference: EvidenceUriReference,
    options: EvidencePageOptions = {},
  ): Promise<EvidencePage> {
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
    const manifest = await this.readBlobEvidenceManifest(reference);
    const blob =
      manifest.kind === "tool-exchange" ? manifest.content.rawOutput : manifest.content.report;
    const page = await this.blobs.readPage(blob, offsetBytes, limitBytes);
    return {
      kind: manifest.kind,
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
  async read(reference: RuntimeEvidenceReference): Promise<RuntimeToolResultEvidenceManifestV2>;
  async read(
    reference: EvidenceArchiveReference | RuntimeEvidenceReference,
  ): Promise<EvidenceArchiveManifest | RuntimeToolResultEvidenceManifestV2> {
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
  ): Promise<RuntimeToolResultEvidenceManifestV2> {
    assertRuntimeEvidenceReference(reference);
    const manifest = await this.readBlobEvidenceManifest(reference);
    if (manifest.kind !== "tool-exchange") {
      throw new EvidenceArchiveIntegrityError("Evidence kind is not tool-exchange");
    }
    return manifest;
  }

  async readSubagentReportEvidence(
    reference: SubagentReportEvidenceReference,
  ): Promise<SubagentReportEvidenceManifestV2> {
    assertSubagentReportReference(reference);
    const manifest = await this.readBlobEvidenceManifest(reference);
    if (manifest.kind !== "subagent-report") {
      throw new EvidenceArchiveIntegrityError("Evidence kind is not subagent-report");
    }
    return manifest;
  }

  private async readBlobEvidenceManifest(
    reference: EvidenceUriReference,
  ): Promise<BlobEvidenceManifest> {
    assertEvidenceUriReference(reference);
    const manifest = await readImmutableJson(
      this.baseDir,
      [sanitizeFilePart(reference.sessionId)],
      `${reference.contentHash}.json`,
      decodeBlobEvidenceManifest,
      "Evidence blob manifest",
    );
    if (
      manifest.contentHash !== reference.contentHash ||
      manifest.content.sessionId !== reference.sessionId ||
      manifest.content.kind !== manifest.kind
    ) {
      throw new EvidenceArchiveIntegrityError("Evidence reference does not match manifest");
    }
    if (hashContent(manifest.content) !== manifest.contentHash) {
      throw new EvidenceArchiveIntegrityError("Evidence content hash mismatch");
    }
    return manifest;
  }
}

export function formatEvidenceUri(reference: EvidenceUriReference): string {
  assertEvidenceUriReference(reference);
  return `pico://evidence/${encodeURIComponent(reference.sessionId)}/${reference.contentHash}`;
}

export function parseEvidenceUri(value: string): EvidenceUriReference {
  const match = /^pico:\/\/evidence\/([^/]+)\/([a-f0-9]{64})$/u.exec(value);
  if (!match) {
    throw new EvidenceArchiveIntegrityError("Evidence ref is invalid");
  }
  let sessionId: string;
  try {
    sessionId = decodeURIComponent(match[1]!);
  } catch (error) {
    throw new EvidenceArchiveIntegrityError(
      `Evidence ref has invalid session encoding: ${errorMessage(error)}`,
    );
  }
  if (!isNonEmptyString(sessionId) || encodeURIComponent(sessionId) !== match[1]) {
    throw new EvidenceArchiveIntegrityError("Evidence ref has a non-canonical session");
  }
  return {
    schemaVersion: EVIDENCE_ARCHIVE_SCHEMA_VERSION,
    contentHash: match[2]!,
    sessionId,
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

function decodeBlobEvidenceManifest(value: unknown): BlobEvidenceManifest {
  if (!isRecord(value) || value["schemaVersion"] !== BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION) {
    throw new EvidenceArchiveIntegrityError("Evidence blob manifest has an invalid schema version");
  }
  if (
    !isNonEmptyString(value["contentHash"]) ||
    !isNonEmptyString(value["archivedAt"]) ||
    (value["kind"] !== "tool-exchange" && value["kind"] !== "subagent-report")
  ) {
    throw new EvidenceArchiveIntegrityError("Evidence blob manifest has an invalid envelope");
  }
  if (value["kind"] === "tool-exchange") {
    return {
      schemaVersion: BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION,
      contentHash: value["contentHash"],
      archivedAt: value["archivedAt"],
      kind: "tool-exchange",
      content: decodeRuntimeToolResultEvidenceV2(value["content"]),
    };
  }
  return {
    schemaVersion: BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION,
    contentHash: value["contentHash"],
    archivedAt: value["archivedAt"],
    kind: "subagent-report",
    content: decodeSubagentReportEvidenceV2(value["content"]),
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

function assertSubagentReportInput(
  input: ArchiveSubagentReportInput,
): asserts input is ArchiveSubagentReportInput {
  if (
    !isNonEmptyString(input.sessionId) ||
    typeof input.taskPrompt !== "string" ||
    typeof input.report !== "string" ||
    (input.status !== "completed" && input.status !== "partial")
  ) {
    throw new EvidenceArchiveIntegrityError("Subagent report evidence payload is invalid");
  }
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

function decodeSubagentReportEvidenceV2(value: unknown): SubagentReportEvidenceV2 {
  if (
    !isRecord(value) ||
    value["kind"] !== "subagent-report" ||
    !isNonEmptyString(value["sessionId"]) ||
    typeof value["taskPrompt"] !== "string" ||
    (value["status"] !== "completed" && value["status"] !== "partial")
  ) {
    throw new EvidenceArchiveIntegrityError("Subagent report evidence has invalid content");
  }
  try {
    assertEvidenceBlobRef(value["report"]);
  } catch (error) {
    throw new EvidenceArchiveIntegrityError(
      `Subagent report evidence has invalid blob reference: ${errorMessage(error)}`,
    );
  }
  return {
    kind: "subagent-report",
    sessionId: value["sessionId"],
    taskPrompt: value["taskPrompt"],
    status: value["status"],
    report: value["report"],
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
    !isValidEvidenceUriReference(reference) ||
    reference.kind !== "tool-exchange"
  ) {
    throw new EvidenceArchiveIntegrityError("Runtime tool-exchange evidence reference is invalid");
  }
}

function assertSubagentReportReference(reference: SubagentReportEvidenceReference): void {
  if (!isValidEvidenceUriReference(reference) || reference.kind !== "subagent-report") {
    throw new EvidenceArchiveIntegrityError("Subagent report evidence reference is invalid");
  }
}

function assertEvidenceUriReference(reference: EvidenceUriReference): void {
  if (!isValidEvidenceUriReference(reference)) {
    throw new EvidenceArchiveIntegrityError("Evidence URI reference is invalid");
  }
}

function isValidEvidenceUriReference(reference: EvidenceUriReference): boolean {
  return (
    reference.schemaVersion === EVIDENCE_ARCHIVE_SCHEMA_VERSION &&
    isContentHash(reference.contentHash) &&
    isNonEmptyString(reference.sessionId)
  );
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
