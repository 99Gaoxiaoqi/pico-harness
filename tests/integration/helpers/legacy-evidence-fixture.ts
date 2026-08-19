import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { EvidenceBlobStore } from "../../../src/context/evidence-blob-store.js";
import type { SubagentReportEvidenceReference } from "../../../src/context/evidence-archive.js";
import type { RuntimeEvidenceReference } from "../../../src/engine/tool-result-contract.js";
import { withWorkspaceSqliteLease } from "../../../src/storage/sqlite/workspace-scopes.js";

/**
 * 票 E3(ADR 26 §2.4)退役了 EvidenceArchive 的写入 API,生产代码不再产生
 * evidence_records/evidence_blobs 行。本 helper 在测试侧复刻旧写入形态
 * (blob CAS + 清单行),供存量读路径(IntegrityError 校验、分页回读、TUI
 * Inspector、attachments scope 表行为)的测试夹具使用。
 *
 * 清单哈希与 src/context/evidence-archive.ts 的 stableJson 口径一致——
 * readBlobEvidenceManifest 会重算并比对,漂移会 fail-closed。
 */

const LEGACY_SCHEMA_VERSION = 2;

interface SeedEvidenceBase {
  readonly evidenceRoot: string;
  /** 清单索引所在 workspace 存储根;缺省取 evidenceRoot 的父目录(pico-paths 布局)。 */
  readonly storageRoot?: string;
  readonly archivedAt?: string;
}

export async function seedRuntimeToolExchange(
  options: SeedEvidenceBase & {
    readonly sessionId: string;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly rawArguments: string;
    readonly rawOutput: string;
    readonly isError: boolean;
  },
): Promise<RuntimeEvidenceReference> {
  bootstrapStorage(options);
  const blobRef = (await new EvidenceBlobStore(options.evidenceRoot).putUtf8(options.rawOutput))
    .ref;
  const content = {
    kind: "tool-exchange" as const,
    sessionId: options.sessionId,
    toolCallId: options.toolCallId,
    toolName: options.toolName,
    arguments: options.rawArguments,
    rawOutput: blobRef,
    isError: options.isError,
  };
  const contentHash = hashContent(content);
  publishManifestRow(options, {
    contentHash,
    kind: content.kind,
    content,
    blob: blobRef,
  });
  return {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    contentHash,
    sessionId: options.sessionId,
    kind: "tool-exchange",
  };
}

export async function seedSubagentReportEvidence(
  options: SeedEvidenceBase & {
    readonly sessionId: string;
    readonly taskPrompt: string;
    readonly report: string;
    readonly status: "completed" | "partial";
  },
): Promise<SubagentReportEvidenceReference> {
  bootstrapStorage(options);
  const blobRef = (await new EvidenceBlobStore(options.evidenceRoot).putUtf8(options.report)).ref;
  const content = {
    kind: "subagent-report" as const,
    sessionId: options.sessionId,
    taskPrompt: options.taskPrompt,
    status: options.status,
    report: blobRef,
  };
  const contentHash = hashContent(content);
  publishManifestRow(options, {
    contentHash,
    kind: content.kind,
    content,
    blob: blobRef,
  });
  return {
    schemaVersion: LEGACY_SCHEMA_VERSION,
    contentHash,
    sessionId: options.sessionId,
    kind: "subagent-report",
  };
}

interface ManifestRowInput {
  readonly contentHash: string;
  readonly kind: "tool-exchange" | "subagent-report";
  readonly content: Record<string, unknown>;
  readonly blob: { readonly digest: string; readonly sizeBytes: number };
}

/** 自举 storageRoot + pico.sqlite(复刻旧 prepareStorage 语义),blob 目录才能创建。 */
function bootstrapStorage(base: SeedEvidenceBase): string {
  const storageRoot = base.storageRoot ?? dirname(base.evidenceRoot);
  withWorkspaceSqliteLease(storageRoot, () => undefined);
  return storageRoot;
}

function publishManifestRow(base: SeedEvidenceBase, manifest: ManifestRowInput): void {
  const storageRoot = base.storageRoot ?? dirname(base.evidenceRoot);
  const archivedAt = base.archivedAt ?? "2026-07-28T00:00:00.000Z";
  withWorkspaceSqliteLease(storageRoot, (lease) =>
    lease.transaction("write", () => {
      lease.database
        .prepare(
          `INSERT INTO evidence_records (session_id, content_hash, kind, archived_at, content_json)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (session_id, content_hash) DO NOTHING`,
        )
        .run(
          manifest.content.sessionId as string,
          manifest.contentHash,
          manifest.kind,
          archivedAt,
          JSON.stringify(manifest.content),
        );
      lease.database
        .prepare(
          `INSERT INTO evidence_blobs (digest, size_bytes, created_at)
           VALUES (?, ?, ?)
           ON CONFLICT (digest) DO NOTHING`,
        )
        .run(manifest.blob.digest, manifest.blob.sizeBytes, archivedAt);
    }),
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
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  throw new Error("legacy evidence fixture content must be JSON serializable");
}
