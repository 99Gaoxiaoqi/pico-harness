import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { RuntimeEvidenceReference } from "../engine/tool-result-contract.js";
import { withWorkspaceSqliteLease } from "../storage/sqlite/workspace-scopes.js";
import {
  assertEvidenceBlobRef,
  EvidenceBlobStore,
  type EvidenceBlobRef,
} from "./evidence-blob-store.js";

const EVIDENCE_URI_REFERENCE_SCHEMA_VERSION = 2 as const;
const BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const DEFAULT_EVIDENCE_PAGE_LIMIT_BYTES = 16 * 1024;
export const MAX_EVIDENCE_PAGE_LIMIT_BYTES = 64 * 1024;

/** Opaque address decoded from a model-visible pico://evidence URI. */
export interface EvidenceUriReference {
  readonly schemaVersion: typeof EVIDENCE_URI_REFERENCE_SCHEMA_VERSION;
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

export interface EvidenceArchiveOptions {
  readonly baseDir: string;
  /**
   * 清单索引(evidence_records/evidence_blobs)所在的 workspace 存储根。
   * 省略时取 baseDir 的父目录——pico-paths 布局里 evidence 根恒为
   * `<storageRoot>/evidence`,三个装配点与测试夹具都符合该布局。
   */
  readonly storageRoot?: string;
  readonly now?: () => Date;
}

export class EvidenceArchiveIntegrityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EvidenceArchiveIntegrityError";
  }
}

/** Immutable, content-addressed evidence for ToolResults and subagent reports. */
export class EvidenceArchive {
  private readonly baseDir: string;
  private readonly storageRoot: string;
  private readonly now: () => Date;
  private readonly blobs: EvidenceBlobStore;

  constructor(options: EvidenceArchiveOptions) {
    this.baseDir = resolve(options.baseDir);
    // blob CAS 留在 baseDir;清单行进 workspace pico.sqlite(票 08,ADR §4.6)。
    this.storageRoot = resolve(options.storageRoot ?? dirname(this.baseDir));
    this.now = options.now ?? (() => new Date());
    this.blobs = new EvidenceBlobStore(this.baseDir);
  }

  async archiveRuntimeToolResult(
    input: ArchiveRuntimeToolResultInput,
  ): Promise<RuntimeEvidenceReference> {
    assertRuntimeToolResultInput(input);
    // 先确保 storageRoot + pico.sqlite 就绪:evidence 根(<storageRoot>/evidence)
    // 的自举创建语义保持,之后 blob 目录才能在其下 mkdir。
    this.prepareStorage();
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
      schemaVersion: EVIDENCE_URI_REFERENCE_SCHEMA_VERSION,
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
    await this.publishEvidenceRecord(manifest, rawOutput);
    return reference;
  }

  async archiveSubagentReport(
    input: ArchiveSubagentReportInput,
  ): Promise<SubagentReportEvidenceReference> {
    assertSubagentReportInput(input);
    this.prepareStorage();
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
      schemaVersion: EVIDENCE_URI_REFERENCE_SCHEMA_VERSION,
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
    await this.publishEvidenceRecord(manifest, report);
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
    const record = withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("read", () =>
        lease.database
          .prepare(
            `SELECT kind, archived_at, content_json FROM evidence_records
             WHERE session_id = ? AND content_hash = ?`,
          )
          .get(reference.sessionId, reference.contentHash),
      ),
    ) as { kind: unknown; archived_at: unknown; content_json: unknown } | undefined;
    if (record === undefined || typeof record.content_json !== "string") {
      throw missingEvidenceError(reference);
    }
    let content: unknown;
    try {
      content = JSON.parse(record.content_json) as unknown;
    } catch (error) {
      throw new EvidenceArchiveIntegrityError(
        `Evidence manifest content is invalid JSON: ${errorMessage(error)}`,
      );
    }
    // 重建 manifest 信封后走既有 decode 全量校验(含 blobRef 形状)。
    const manifest = decodeBlobEvidenceManifest({
      schemaVersion: BLOB_EVIDENCE_MANIFEST_SCHEMA_VERSION,
      contentHash: reference.contentHash,
      archivedAt: typeof record.archived_at === "string" ? record.archived_at : "",
      kind: record.kind,
      content,
    });
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

  /** 幂等确保 storageRoot 与库 schema 就绪(空操作只为 prepare 副作用)。 */
  private prepareStorage(): void {
    withWorkspaceSqliteLease(this.storageRoot, () => undefined);
  }

  /**
   * 清单发布:evidence_records 单事务 UPSERT。并发/重复写(同
   * <sessionId,contentHash>)保留既有行的 archived_at 并回读校验——与旧
   * tmp+fsync+link 独占发布的幂等语义等价(immutable 内容由 contentHash 锚定)。
   */
  private async publishEvidenceRecord(
    manifest: BlobEvidenceManifest,
    blob: EvidenceBlobRef,
  ): Promise<void> {
    const contentJson = JSON.stringify(manifest.content);
    const existing = withWorkspaceSqliteLease(this.storageRoot, (lease) =>
      lease.transaction("write", () => {
        lease.database
          .prepare(
            `INSERT INTO evidence_records (session_id, content_hash, kind, archived_at, content_json)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (session_id, content_hash) DO NOTHING`,
          )
          .run(
            manifest.content.sessionId,
            manifest.contentHash,
            manifest.kind,
            manifest.archivedAt,
            contentJson,
          );
        // FS blob 索引行(evidence_blobs):本体仍在 blobs/sha256/<xx>/<digest>。
        lease.database
          .prepare(
            `INSERT INTO evidence_blobs (digest, size_bytes, created_at)
             VALUES (?, ?, ?)
             ON CONFLICT (digest) DO NOTHING`,
          )
          .run(blob.digest, blob.sizeBytes, manifest.archivedAt);
        return lease.database
          .prepare(
            `SELECT kind, archived_at, content_json FROM evidence_records
             WHERE session_id = ? AND content_hash = ?`,
          )
          .get(manifest.content.sessionId, manifest.contentHash) as
          | { kind: unknown; archived_at: unknown; content_json: unknown }
          | undefined;
      }),
    );
    if (existing === undefined || typeof existing.content_json !== "string") {
      throw new EvidenceArchiveIntegrityError(
        "Evidence manifest row disappeared right after publication",
      );
    }
    if (existing.content_json !== contentJson) {
      throw new EvidenceArchiveIntegrityError("Evidence manifest conflict");
    }
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
    schemaVersion: EVIDENCE_URI_REFERENCE_SCHEMA_VERSION,
    contentHash: match[2]!,
    sessionId,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isContentHash(value: string): boolean {
  return /^[a-f0-9]{64}$/u.test(value);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function assertRuntimeEvidenceReference(reference: RuntimeEvidenceReference): void {
  if (!isValidEvidenceUriReference(reference) || reference.kind !== "tool-exchange") {
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
    reference.schemaVersion === EVIDENCE_URI_REFERENCE_SCHEMA_VERSION &&
    isContentHash(reference.contentHash) &&
    isNonEmptyString(reference.sessionId)
  );
}

/** 清单行缺失时保持 JSONL 纪元的 ENOENT 错误形状(调用方按 code 判定幂等)。 */
function missingEvidenceError(reference: EvidenceUriReference): NodeJS.ErrnoException {
  const error = new Error(
    `Evidence manifest is missing: ${reference.sessionId}/${reference.contentHash}`,
  ) as NodeJS.ErrnoException;
  error.code = "ENOENT";
  return error;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
