import { createHash, randomUUID } from "node:crypto";
import { basename, extname } from "node:path";
import { MAX_ARTIFACT_CHUNK_BYTES, type SqliteSessionWorkbarRepository } from "@pico/storage";
import { logger } from "./logger.js";

export interface BoundSessionArtifactAuthority {
  readonly repository: SqliteSessionWorkbarRepository;
  readonly sessionId: string;
  readonly onChanged?: (revision: number) => void;
}

/** Publish the bytes supplied to a successful write, never re-read an arbitrary path. */
export function publishWrittenArtifact(
  authority: BoundSessionArtifactAuthority,
  path: string,
  content: string,
): string {
  const { repository, sessionId } = authority;
  const bytes = Buffer.from(content, "utf8");
  const key = randomUUID();
  const { ingestId } = repository.beginArtifact({
    sessionId,
    title: basename(path),
    mimeType: artifactMimeType(path),
    expectedRevision: repository.queryArtifacts({ sessionId, limit: 1 }).revision,
    idempotencyKey: `${key}:begin`,
  });
  let result: ReturnType<SqliteSessionWorkbarRepository["commitArtifact"]>;
  try {
    for (let offset = 0; offset < bytes.byteLength; offset += MAX_ARTIFACT_CHUNK_BYTES) {
      repository.appendArtifactChunk({
        sessionId,
        ingestId,
        offsetBytes: offset,
        content: bytes.subarray(offset, offset + MAX_ARTIFACT_CHUNK_BYTES),
      });
    }
    result = repository.commitArtifact({
      sessionId,
      ingestId,
      expectedRevision: repository.queryArtifacts({ sessionId, limit: 1 }).revision,
      idempotencyKey: `${key}:commit`,
      expectedDigest: createHash("sha256").update(bytes).digest("hex"),
      expectedSizeBytes: bytes.byteLength,
    });
  } catch (error) {
    try {
      repository.abortArtifact({ sessionId, ingestId });
    } catch {
      /* Preserve the original publication failure. */
    }
    throw error;
  }
  try {
    authority.onChanged?.(result.revision);
  } catch (error) {
    logger.warn({ sessionId, error: String(error) }, "[Artifacts] resource_changed 通知失败");
  }
  return result.artifact.artifactId;
}

function artifactMimeType(path: string): string {
  const types: Record<string, string> = {
    ".md": "text/markdown",
    ".html": "text/html",
    ".htm": "text/html",
    ".csv": "text/csv",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".xml": "application/xml",
    ".css": "text/css",
    ".js": "application/javascript",
  };
  return `${types[extname(path).toLowerCase()] ?? "text/plain"}; charset=utf-8`;
}
