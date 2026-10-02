import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { withWorkspaceSqliteLease } from "./workspace-scopes.js";
import {
  artifactBlobRelativePath,
  artifactIngestRelativePath,
  appendArtifactIngestFile,
  createArtifactIngestFile,
  readArtifactBlobFile,
  readArtifactIngestFile,
  removeArtifactFile,
  writeArtifactBlobFile,
} from "./artifact-file-storage.js";

// Durable Task and Artifact authority is a concrete Storage repository.

export const MAX_ARTIFACT_CHUNK_BYTES = 32 * 1024;
export const SESSION_TASK_STATUSES = [
  "pending",
  "in_progress",
  "blocked",
  "completed",
  "failed",
  "cancelled",
] as const;
export type SessionTaskStatus = (typeof SESSION_TASK_STATUSES)[number];

export class WorkbarConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbarConflictError";
  }
}

export class WorkbarNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbarNotFoundError";
  }
}

export class WorkbarForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkbarForbiddenError";
  }
}

export interface SessionTaskRecord {
  readonly taskId: string;
  readonly title: string;
  readonly detail?: string;
  readonly status: SessionTaskStatus;
  readonly ordinal: number;
  readonly version: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface SessionArtifactRecord {
  readonly artifactId: string;
  readonly title: string;
  readonly mimeType: string;
  readonly digest: string;
  readonly sizeBytes: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

interface RepositoryOptions {
  readonly storageRoot: string;
  readonly now?: () => number;
  readonly createId?: () => string;
}

/** Durable authority for Tasks and generated Artifacts; Trace is queried from runtime_events. */
export class SqliteSessionWorkbarRepository {
  readonly #storageRoot: string;
  readonly #now: () => number;
  readonly #createId: () => string;

  constructor(options: RepositoryOptions) {
    this.#storageRoot = options.storageRoot;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
  }

  queryTasks(input: {
    readonly sessionId: string;
    readonly taskId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly revision?: number;
  }): {
    readonly revision: number;
    readonly tasks: readonly SessionTaskRecord[];
    readonly nextCursor?: string;
  } {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) => {
      requireSession(database, input.sessionId);
      const revision = ledgerRevision(database, "session_task_ledgers", input.sessionId);
      if (input.revision !== undefined && input.revision !== revision) {
        throw new WorkbarConflictError(`任务账本版本已从 ${input.revision} 变为 ${revision}`);
      }
      if (input.taskId) {
        const row = database
          .prepare("SELECT * FROM session_tasks WHERE session_id = ? AND task_id = ?")
          .get(input.sessionId, input.taskId) as TaskRow | undefined;
        if (!row) throw new WorkbarNotFoundError(`任务不存在: ${input.taskId}`);
        return { revision, tasks: [taskFromRow(row)] };
      }
      const limit = boundedLimit(input.limit, 50, 200);
      const offset = decodeCursor(input.cursor, revision);
      const rows = database
        .prepare(
          `SELECT * FROM session_tasks WHERE session_id = ?
           ORDER BY ordinal ASC, task_id ASC LIMIT ? OFFSET ?`,
        )
        .all(input.sessionId, limit + 1, offset) as unknown as TaskRow[];
      const hasMore = rows.length > limit;
      return {
        revision,
        tasks: rows.slice(0, limit).map(taskFromRow),
        ...(hasMore ? { nextCursor: encodeCursor(revision, offset + limit) } : {}),
      };
    });
  }

  createTask(input: {
    readonly sessionId: string;
    readonly title: string;
    readonly detail?: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly taskId?: string;
  }): { readonly revision: number; readonly task: SessionTaskRecord } {
    return this.#taskCommand("create", input, (database, revision) => {
      const now = this.#now();
      const taskId = input.taskId ?? this.#createId();
      const ordinalRow = database
        .prepare(
          "SELECT COALESCE(MAX(ordinal), -1) + 1 AS ordinal FROM session_tasks WHERE session_id = ?",
        )
        .get(input.sessionId) as { ordinal: number };
      database
        .prepare(
          `INSERT INTO session_tasks
           (task_id, session_id, title, detail, status, ordinal, version, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'pending', ?, 1, ?, ?)`,
        )
        .run(
          taskId,
          input.sessionId,
          input.title,
          input.detail ?? null,
          ordinalRow.ordinal,
          now,
          now,
        );
      const nextRevision = revision + 1;
      writeLedgerRevision(database, "session_task_ledgers", input.sessionId, nextRevision, now);
      const task = this.#requireTask(database, input.sessionId, taskId);
      return { revision: nextRevision, task };
    });
  }

  updateTask(input: {
    readonly sessionId: string;
    readonly taskId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly title?: string;
    readonly detail?: string | null;
    readonly status?: SessionTaskStatus;
  }): { readonly revision: number; readonly task: SessionTaskRecord } {
    return this.#taskCommand("update", input, (database, revision) => {
      const current = this.#requireTask(database, input.sessionId, input.taskId);
      const now = this.#now();
      database
        .prepare(
          `UPDATE session_tasks SET title = ?, detail = ?, status = ?, version = version + 1, updated_at = ?
           WHERE session_id = ? AND task_id = ?`,
        )
        .run(
          input.title ?? current.title,
          input.detail === undefined ? (current.detail ?? null) : input.detail,
          input.status ?? current.status,
          now,
          input.sessionId,
          input.taskId,
        );
      const nextRevision = revision + 1;
      writeLedgerRevision(database, "session_task_ledgers", input.sessionId, nextRevision, now);
      return {
        revision: nextRevision,
        task: this.#requireTask(database, input.sessionId, input.taskId),
      };
    });
  }

  beginArtifact(input: {
    readonly sessionId: string;
    readonly title: string;
    readonly mimeType: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly artifactId?: string;
  }): { readonly revision: number; readonly ingestId: string; readonly artifactId: string } {
    return this.#artifactCommand("begin", input, (database, revision) => {
      const now = this.#now();
      const artifactId = input.artifactId ?? this.#createId();
      const ingestId = this.#createId();
      const relativePath = createArtifactIngestFile(database, ingestId);
      database
        .prepare(
          `INSERT INTO session_artifact_ingests
           (ingest_id, artifact_id, session_id, title, mime_type, relative_path, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`,
        )
        .run(
          ingestId,
          artifactId,
          input.sessionId,
          input.title,
          input.mimeType,
          relativePath,
          now,
          now,
        );
      return { revision, ingestId, artifactId };
    });
  }

  appendArtifactChunk(input: {
    readonly sessionId: string;
    readonly ingestId: string;
    readonly offsetBytes: number;
    readonly content: Buffer;
  }): { readonly acceptedBytes: number; readonly nextOffsetBytes: number } {
    if (input.content.byteLength > MAX_ARTIFACT_CHUNK_BYTES) {
      throw new WorkbarConflictError(`单个 Artifact 分片不能超过 ${MAX_ARTIFACT_CHUNK_BYTES} 字节`);
    }
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      transaction(database, () => {
        assertMutableSession(database, input.sessionId);
        const row = database
          .prepare(
            "SELECT size_bytes, relative_path FROM session_artifact_ingests WHERE session_id = ? AND ingest_id = ?",
          )
          .get(input.sessionId, input.ingestId) as
          | { size_bytes: number; relative_path: string }
          | undefined;
        if (!row) throw new WorkbarNotFoundError(`Artifact ingest 不存在: ${input.ingestId}`);
        if (
          !Number.isSafeInteger(input.offsetBytes) ||
          input.offsetBytes < 0 ||
          input.offsetBytes > row.size_bytes
        )
          throw new WorkbarConflictError(
            `Artifact ingest offset 冲突: expected ${row.size_bytes}, received ${input.offsetBytes}`,
          );
        let sizeBytes: number;
        try {
          sizeBytes = appendArtifactIngestFile(
            database,
            input.ingestId,
            row.relative_path,
            row.size_bytes,
            input.offsetBytes,
            input.content,
          );
        } catch (error) {
          if (error instanceof Error && error.message.includes("offset conflict"))
            throw new WorkbarConflictError(error.message);
          throw error;
        }
        database
          .prepare(
            "UPDATE session_artifact_ingests SET size_bytes = ?, updated_at = ? WHERE ingest_id = ?",
          )
          .run(sizeBytes, this.#now(), input.ingestId);
        return {
          acceptedBytes: input.content.byteLength,
          nextOffsetBytes: input.offsetBytes + input.content.byteLength,
        };
      }),
    );
  }

  commitArtifact(input: {
    readonly sessionId: string;
    readonly ingestId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
    readonly expectedDigest?: string;
    readonly expectedSizeBytes?: number;
  }): { readonly revision: number; readonly artifact: SessionArtifactRecord } {
    const result = this.#artifactCommand("commit", input, (database, revision) => {
      const row = database
        .prepare("SELECT * FROM session_artifact_ingests WHERE session_id = ? AND ingest_id = ?")
        .get(input.sessionId, input.ingestId) as ArtifactIngestRow | undefined;
      if (!row) throw new WorkbarNotFoundError(`Artifact ingest 不存在: ${input.ingestId}`);
      const content = readArtifactIngestFile(
        database,
        input.ingestId,
        row.relative_path,
        row.size_bytes,
      );
      const digest = createHash("sha256").update(content).digest("hex");
      if (input.expectedDigest !== undefined && input.expectedDigest !== digest) {
        throw new WorkbarConflictError("Artifact digest 校验失败");
      }
      if (input.expectedSizeBytes !== undefined && input.expectedSizeBytes !== content.byteLength) {
        throw new WorkbarConflictError("Artifact size 校验失败");
      }
      const now = this.#now();
      const relativePath = writeArtifactBlobFile(database, digest, content);
      database
        .prepare(
          "INSERT OR IGNORE INTO artifact_blobs (digest, size_bytes, relative_path, created_at) VALUES (?, ?, ?, ?)",
        )
        .run(digest, content.byteLength, relativePath, now);
      const existingBlob = database
        .prepare("SELECT size_bytes FROM artifact_blobs WHERE digest = ?")
        .get(digest) as { size_bytes: number };
      if (existingBlob.size_bytes !== content.byteLength) {
        throw new WorkbarConflictError("Artifact CAS digest 与已有 blob 不一致");
      }
      database
        .prepare(
          `INSERT INTO session_artifacts
           (artifact_id, session_id, title, mime_type, digest, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.artifact_id,
          input.sessionId,
          row.title,
          row.mime_type,
          digest,
          content.byteLength,
          row.created_at,
          now,
        );
      database
        .prepare("DELETE FROM session_artifact_ingests WHERE ingest_id = ?")
        .run(input.ingestId);
      const nextRevision = revision + 1;
      writeLedgerRevision(database, "session_artifact_ledgers", input.sessionId, nextRevision, now);
      return {
        revision: nextRevision,
        artifact: this.#requireArtifact(database, input.sessionId, row.artifact_id),
      };
    });
    withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      removeArtifactFile(database, artifactIngestRelativePath(input.ingestId)),
    );
    return result;
  }

  /** Host-owned, bounded immutable binary snapshot. Avoid repeated ingest rewrites. */
  publishArtifactSnapshot(input: {
    readonly sessionId: string;
    readonly artifactId: string;
    readonly title: string;
    readonly mimeType: string;
    readonly content: Uint8Array;
  }): SessionArtifactRecord {
    if (input.content.byteLength > 16 * 1024 * 1024) {
      throw new WorkbarConflictError("媒体快照超过 16 MiB 上限");
    }
    const digest = createHash("sha256").update(input.content).digest("hex");
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      transaction(database, () => {
        assertMutableSession(database, input.sessionId);
        return publishArtifactSnapshotLocked(database, input, digest, this.#now());
      }),
    );
  }

  abortArtifact(input: { readonly sessionId: string; readonly ingestId: string }): {
    readonly aborted: true;
  } {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) => {
      const removed = transaction(database, () => {
        assertMutableSession(database, input.sessionId);
        const result = database
          .prepare("DELETE FROM session_artifact_ingests WHERE session_id = ? AND ingest_id = ?")
          .run(input.sessionId, input.ingestId);
        return Number(result.changes) > 0;
      });
      if (removed) removeArtifactFile(database, artifactIngestRelativePath(input.ingestId));
      return { aborted: true as const };
    });
  }

  deleteArtifact(input: {
    readonly sessionId: string;
    readonly artifactId: string;
    readonly expectedRevision: number;
    readonly idempotencyKey: string;
  }): { readonly revision: number; readonly artifactId: string; readonly deleted: true } {
    const result = this.#artifactCommand("delete", input, (database, revision) => {
      this.#requireArtifact(database, input.sessionId, input.artifactId);
      database
        .prepare("DELETE FROM session_artifacts WHERE session_id = ? AND artifact_id = ?")
        .run(input.sessionId, input.artifactId);
      const nextRevision = revision + 1;
      writeLedgerRevision(
        database,
        "session_artifact_ledgers",
        input.sessionId,
        nextRevision,
        this.#now(),
      );
      return { revision: nextRevision, artifactId: input.artifactId, deleted: true as const };
    });
    this.purgeOrphanArtifactBlobs();
    return result;
  }

  queryArtifacts(input: {
    readonly sessionId: string;
    readonly artifactId?: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly revision?: number;
  }): {
    readonly revision: number;
    readonly artifacts: readonly SessionArtifactRecord[];
    readonly nextCursor?: string;
  } {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) => {
      requireSession(database, input.sessionId);
      const revision = ledgerRevision(database, "session_artifact_ledgers", input.sessionId);
      if (input.revision !== undefined && input.revision !== revision) {
        throw new WorkbarConflictError(`Artifact 账本版本已从 ${input.revision} 变为 ${revision}`);
      }
      if (input.artifactId) {
        return {
          revision,
          artifacts: [this.#requireArtifact(database, input.sessionId, input.artifactId)],
        };
      }
      const limit = boundedLimit(input.limit, 50, 200);
      const offset = decodeCursor(input.cursor, revision);
      const rows = database
        .prepare(
          `SELECT * FROM session_artifacts WHERE session_id = ?
           ORDER BY created_at ASC, artifact_id ASC LIMIT ? OFFSET ?`,
        )
        .all(input.sessionId, limit + 1, offset) as unknown as ArtifactRow[];
      const hasMore = rows.length > limit;
      return {
        revision,
        artifacts: rows.slice(0, limit).map(artifactFromRow),
        ...(hasMore ? { nextCursor: encodeCursor(revision, offset + limit) } : {}),
      };
    });
  }

  readArtifactChunk(input: {
    readonly sessionId: string;
    readonly artifactId: string;
    readonly offsetBytes?: number;
    readonly limitBytes?: number;
  }): {
    readonly artifact: SessionArtifactRecord;
    readonly contentBase64: string;
    readonly offsetBytes: number;
    readonly endOffsetBytes: number;
    readonly totalBytes: number;
    readonly truncated: boolean;
    readonly nextOffsetBytes?: number;
  } {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) => {
      requireSession(database, input.sessionId);
      const artifact = this.#requireArtifact(database, input.sessionId, input.artifactId);
      const offsetBytes = Math.min(input.offsetBytes ?? 0, artifact.sizeBytes);
      const limitBytes = boundedLimit(
        input.limitBytes,
        MAX_ARTIFACT_CHUNK_BYTES,
        MAX_ARTIFACT_CHUNK_BYTES,
      );
      const row = database
        .prepare("SELECT relative_path FROM artifact_blobs WHERE digest = ?")
        .get(artifact.digest) as { relative_path: string } | undefined;
      if (!row) throw new WorkbarNotFoundError(`Artifact file 不存在: ${artifact.digest}`);
      const chunk = readArtifactBlobFile(
        database,
        artifact.digest,
        row.relative_path,
        artifact.sizeBytes,
        offsetBytes,
        limitBytes,
      );
      const endOffsetBytes = offsetBytes + chunk.byteLength;
      return {
        artifact,
        contentBase64: chunk.toString("base64"),
        offsetBytes,
        endOffsetBytes,
        totalBytes: artifact.sizeBytes,
        truncated: endOffsetBytes < artifact.sizeBytes,
        ...(endOffsetBytes < artifact.sizeBytes ? { nextOffsetBytes: endOffsetBytes } : {}),
      };
    });
  }

  queryTrace(input: {
    readonly sessionId: string;
    readonly throughSequence?: number;
    readonly afterSequence?: number;
    readonly limit?: number;
  }): {
    readonly throughSequence: number;
    readonly events: readonly Record<string, unknown>[];
    readonly nextAfterSequence?: number;
  } {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) => {
      const session = requireSession(database, input.sessionId);
      const throughSequence = input.throughSequence ?? session.last_event_seq;
      if (throughSequence > session.last_event_seq) {
        throw new WorkbarConflictError("Trace watermark 超过当前 Session 水位");
      }
      const afterSequence = input.afterSequence ?? 0;
      const limit = boundedLimit(input.limit, 100, 250);
      const rows = database
        .prepare(
          `SELECT event_seq, event_id, kind, visibility, partial, at, payload_json
           FROM runtime_events
           WHERE session_id = ? AND event_seq > ? AND event_seq <= ?
             AND kind NOT IN ('session.state.committed', 'transcript.event.recorded')
           ORDER BY event_seq ASC LIMIT ?`,
        )
        .all(input.sessionId, afterSequence, throughSequence, limit + 1) as unknown as TraceRow[];
      const visible = rows.slice(0, limit);
      return {
        throughSequence,
        events: visible.map((row) => ({
          sequence: row.event_seq,
          eventId: row.event_id,
          kind: row.kind,
          visibility: row.visibility,
          partial: row.partial === 1,
          at: row.at,
          event: JSON.parse(row.payload_json) as Record<string, unknown>,
        })),
        ...(rows.length > limit && visible.at(-1)
          ? { nextAfterSequence: visible.at(-1)!.event_seq }
          : {}),
      };
    });
  }

  forkSessionData(sourceSessionId: string, targetSessionId: string): void {
    withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      transaction(database, () => {
        requireSession(database, sourceSessionId);
        assertMutableSession(database, targetSessionId);
        const now = this.#now();
        const sourceTaskRevision = ledgerRevision(
          database,
          "session_task_ledgers",
          sourceSessionId,
        );
        if (sourceTaskRevision > 0) {
          database
            .prepare(
              "INSERT INTO session_task_ledgers (session_id, revision, updated_at) VALUES (?, ?, ?)",
            )
            .run(targetSessionId, sourceTaskRevision, now);
          const tasks = database
            .prepare("SELECT * FROM session_tasks WHERE session_id = ? ORDER BY ordinal ASC")
            .all(sourceSessionId) as unknown as TaskRow[];
          for (const row of tasks) {
            database
              .prepare(
                `INSERT INTO session_tasks
                 (task_id, session_id, title, detail, status, ordinal, version, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
              )
              .run(
                this.#createId(),
                targetSessionId,
                row.title,
                row.detail,
                row.status === "in_progress" || row.status === "blocked" ? "pending" : row.status,
                row.ordinal,
                now,
                now,
              );
          }
        }
        const sourceArtifactRevision = ledgerRevision(
          database,
          "session_artifact_ledgers",
          sourceSessionId,
        );
        if (sourceArtifactRevision > 0) {
          database
            .prepare(
              "INSERT OR IGNORE INTO session_artifact_ledgers (session_id, revision, updated_at) VALUES (?, ?, ?)",
            )
            .run(targetSessionId, sourceArtifactRevision, now);
          const artifacts = database
            .prepare("SELECT * FROM session_artifacts WHERE session_id = ? ORDER BY created_at ASC")
            .all(sourceSessionId) as unknown as ArtifactRow[];
          for (const row of artifacts) {
            // The transcript projector already binds inherited media to the fork.
            if (
              database
                .prepare("SELECT 1 FROM session_artifacts WHERE session_id = ? AND artifact_id = ?")
                .get(targetSessionId, inheritedMediaArtifactId(targetSessionId, row.artifact_id))
            )
              continue;
            database
              .prepare(
                `INSERT INTO session_artifacts
                 (artifact_id, session_id, title, mime_type, digest, size_bytes, created_at, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
              )
              .run(
                this.#createId(),
                targetSessionId,
                row.title,
                row.mime_type,
                row.digest,
                row.size_bytes,
                now,
                now,
              );
          }
        }
      }),
    );
  }

  purgeOrphanArtifactBlobs(): number {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      transaction(database, () => purgeOrphanArtifactBlobs(database)),
    );
  }

  #taskCommand<Result extends Record<string, unknown>>(
    kind: string,
    input: {
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
    },
    execute: (database: DatabaseSync, revision: number) => Result,
  ): Result {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      transaction(database, () => {
        assertMutableSession(database, input.sessionId);
        const fingerprint = commandHash(kind, input);
        const replay = readCommand<Result>(
          database,
          "session_task_commands",
          input.sessionId,
          input.idempotencyKey,
          fingerprint,
        );
        if (replay) return replay;
        const revision = ledgerRevision(database, "session_task_ledgers", input.sessionId);
        if (revision !== input.expectedRevision) {
          throw new WorkbarConflictError(
            `任务账本版本冲突: expected ${input.expectedRevision}, actual ${revision}`,
          );
        }
        const result = execute(database, revision);
        writeCommand(
          database,
          "session_task_commands",
          input.sessionId,
          input.idempotencyKey,
          fingerprint,
          result,
          this.#now(),
        );
        return result;
      }),
    );
  }

  #artifactCommand<Result extends Record<string, unknown>>(
    kind: string,
    input: {
      readonly sessionId: string;
      readonly expectedRevision: number;
      readonly idempotencyKey: string;
    },
    execute: (database: DatabaseSync, revision: number) => Result,
  ): Result {
    return withWorkspaceSqliteLease(this.#storageRoot, ({ database }) =>
      transaction(database, () => {
        assertMutableSession(database, input.sessionId);
        const fingerprint = commandHash(kind, input);
        const replay = readCommand<Result>(
          database,
          "session_artifact_commands",
          input.sessionId,
          input.idempotencyKey,
          fingerprint,
        );
        if (replay) return replay;
        const revision = ledgerRevision(database, "session_artifact_ledgers", input.sessionId);
        if (revision !== input.expectedRevision) {
          throw new WorkbarConflictError(
            `Artifact 账本版本冲突: expected ${input.expectedRevision}, actual ${revision}`,
          );
        }
        const result = execute(database, revision);
        writeCommand(
          database,
          "session_artifact_commands",
          input.sessionId,
          input.idempotencyKey,
          fingerprint,
          result,
          this.#now(),
        );
        return result;
      }),
    );
  }

  #requireTask(database: DatabaseSync, sessionId: string, taskId: string): SessionTaskRecord {
    const row = database
      .prepare("SELECT * FROM session_tasks WHERE session_id = ? AND task_id = ?")
      .get(sessionId, taskId) as TaskRow | undefined;
    if (!row) throw new WorkbarNotFoundError(`任务不存在: ${taskId}`);
    return taskFromRow(row);
  }

  #requireArtifact(
    database: DatabaseSync,
    sessionId: string,
    artifactId: string,
  ): SessionArtifactRecord {
    const row = database
      .prepare("SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ?")
      .get(sessionId, artifactId) as ArtifactRow | undefined;
    if (!row) throw new WorkbarNotFoundError(`Artifact 不存在: ${artifactId}`);
    return artifactFromRow(row);
  }
}

interface SessionRow {
  readonly archived_at: number | null;
  readonly last_event_seq: number;
}
interface TaskRow {
  readonly task_id: string;
  readonly title: string;
  readonly detail: string | null;
  readonly status: SessionTaskStatus;
  readonly ordinal: number;
  readonly version: number;
  readonly created_at: number;
  readonly updated_at: number;
}
interface ArtifactRow {
  readonly session_id: string;
  readonly artifact_id: string;
  readonly title: string;
  readonly mime_type: string;
  readonly digest: string;
  readonly size_bytes: number;
  readonly created_at: number;
  readonly updated_at: number;
}
interface ArtifactIngestRow {
  readonly ingest_id: string;
  readonly artifact_id: string;
  readonly title: string;
  readonly mime_type: string;
  readonly relative_path: string;
  readonly size_bytes: number;
  readonly created_at: number;
}
interface TraceRow {
  readonly event_seq: number;
  readonly event_id: string;
  readonly kind: string;
  readonly visibility: string;
  readonly partial: number;
  readonly at: string;
  readonly payload_json: string;
}

function requireSession(database: DatabaseSync, sessionId: string): SessionRow {
  const row = database
    .prepare("SELECT archived_at, last_event_seq FROM sessions WHERE session_id = ?")
    .get(sessionId) as SessionRow | undefined;
  if (!row) throw new WorkbarNotFoundError(`Session 不存在: ${sessionId}`);
  return row;
}

function assertMutableSession(database: DatabaseSync, sessionId: string): void {
  const row = requireSession(database, sessionId);
  if (row.archived_at !== null) throw new WorkbarForbiddenError("归档 Session 只读");
}

function ledgerRevision(database: DatabaseSync, table: string, sessionId: string): number {
  const row = database
    .prepare(`SELECT revision FROM ${table} WHERE session_id = ?`)
    .get(sessionId) as { revision: number } | undefined;
  return row?.revision ?? 0;
}

function writeLedgerRevision(
  database: DatabaseSync,
  table: string,
  sessionId: string,
  revision: number,
  now: number,
): void {
  database
    .prepare(
      `INSERT INTO ${table} (session_id, revision, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET revision = excluded.revision, updated_at = excluded.updated_at`,
    )
    .run(sessionId, revision, now);
}

function transaction<T>(database: DatabaseSync, operation: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      database.exec("ROLLBACK");
    } catch {
      /* preserve original error */
    }
    throw error;
  }
}

function commandHash(kind: string, input: object): string {
  return createHash("sha256").update(JSON.stringify({ kind, input })).digest("hex");
}

function readCommand<Result>(
  database: DatabaseSync,
  table: string,
  sessionId: string,
  key: string,
  fingerprint: string,
): Result | undefined {
  const row = database
    .prepare(
      `SELECT request_hash, result_json FROM ${table} WHERE session_id = ? AND idempotency_key = ?`,
    )
    .get(sessionId, key) as { request_hash: string; result_json: string } | undefined;
  if (!row) return undefined;
  if (row.request_hash !== fingerprint)
    throw new WorkbarConflictError(`幂等键 ${key} 已用于不同请求`);
  return JSON.parse(row.result_json) as Result;
}

function writeCommand(
  database: DatabaseSync,
  table: string,
  sessionId: string,
  key: string,
  fingerprint: string,
  result: object,
  now: number,
): void {
  database
    .prepare(
      `INSERT INTO ${table} (session_id, idempotency_key, request_hash, result_json, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(sessionId, key, fingerprint, JSON.stringify(result), now);
}

export function inheritedMediaArtifactId(sessionId: string, artifactId: string): string {
  return `media:fork:${createHash("sha256").update(`${sessionId}\0${artifactId}`).digest("hex")}`;
}

/** Pure database projection: only frozen fork bootstrap facts may inherit an ancestor blob. */
export function projectSessionMedia(
  database: DatabaseSync,
  sessionId: string,
  value: unknown,
  forkBootstrap: boolean,
): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  const result: Record<string, unknown>[] = [];
  for (const raw of value.slice(0, 16)) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const ref = raw as Record<string, unknown>;
    if (
      typeof ref.artifactId !== "string" ||
      ref.artifactId.length > 256 ||
      typeof ref.alt !== "string" ||
      ref.alt.length > 2048 ||
      typeof ref.mimeType !== "string" ||
      (ref.source !== undefined && (typeof ref.source !== "string" || ref.source.length > 4096)) ||
      typeof ref.digest !== "string" ||
      !/^[a-f0-9]{64}$/u.test(ref.digest) ||
      typeof ref.sizeBytes !== "number" ||
      !Number.isSafeInteger(ref.sizeBytes) ||
      ref.sizeBytes <= 0 ||
      !(ref.kind === "image"
        ? ["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(
            String(ref.mimeType),
          ) && ref.sizeBytes <= 2 * 1024 * 1024
        : ref.kind === "video" &&
          ["video/mp4", "video/webm"].includes(String(ref.mimeType)) &&
          ref.sizeBytes <= 16 * 1024 * 1024)
    )
      continue;
    const matches = (row: ArtifactRow | undefined) =>
      row &&
      row.digest === ref.digest &&
      row.mime_type === ref.mimeType &&
      row.size_bytes === ref.sizeBytes;
    let row = database
      .prepare("SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ?")
      .get(sessionId, ref.artifactId) as ArtifactRow | undefined;
    if (!matches(row) && forkBootstrap) {
      const inheritedId = inheritedMediaArtifactId(sessionId, ref.artifactId);
      row = database
        .prepare("SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ?")
        .get(sessionId, inheritedId) as ArtifactRow | undefined;
      if (!matches(row)) {
        // Existing session-owned clones remain valid when an ancestor is later deleted.
        row = database
          .prepare(
            "SELECT * FROM session_artifacts WHERE session_id = ? AND digest = ? AND mime_type = ? LIMIT 1",
          )
          .get(sessionId, ref.digest, ref.mimeType) as ArtifactRow | undefined;
      }
      if (!matches(row)) {
        const source = database
          .prepare("SELECT * FROM session_artifacts WHERE artifact_id = ?")
          .get(ref.artifactId) as ArtifactRow | undefined;
        if (!matches(source)) continue;
        const visited = new Set<string>([sessionId]);
        let parent: string | null = sessionId;
        let inherited = false;
        while (parent && !inherited) {
          const ancestor = database
            .prepare("SELECT fork_parent_session_id FROM sessions WHERE session_id = ?")
            .get(parent) as { fork_parent_session_id: string | null } | undefined;
          parent = ancestor?.fork_parent_session_id ?? null;
          if (parent && visited.has(parent)) break;
          if (parent) visited.add(parent);
          inherited = parent === source!.session_id;
        }
        if (!inherited) continue;
        // Reuse a previous workbar clone if one already owns these exact bytes.
        row = database
          .prepare(
            "SELECT * FROM session_artifacts WHERE session_id = ? AND digest = ? AND mime_type = ? LIMIT 1",
          )
          .get(sessionId, ref.digest, ref.mimeType) as ArtifactRow | undefined;
        if (!matches(row)) {
          const now = Date.now();
          database
            .prepare(
              `INSERT OR IGNORE INTO session_artifacts
            (artifact_id, session_id, title, mime_type, digest, size_bytes, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            )
            .run(
              inheritedId,
              sessionId,
              source!.title,
              ref.mimeType as string,
              ref.digest,
              ref.sizeBytes,
              now,
              now,
            );
          const revision = ledgerRevision(database, "session_artifact_ledgers", sessionId);
          writeLedgerRevision(database, "session_artifact_ledgers", sessionId, revision + 1, now);
          row = database
            .prepare("SELECT * FROM session_artifacts WHERE session_id = ? AND artifact_id = ?")
            .get(sessionId, inheritedId) as ArtifactRow | undefined;
        }
      }
    }
    if (!matches(row)) continue;
    result.push({
      artifactId: row!.artifact_id,
      kind: ref.kind,
      alt: ref.alt,
      mimeType: ref.mimeType,
      sizeBytes: ref.sizeBytes,
      digest: ref.digest,
      ...(ref.source !== undefined ? { source: ref.source } : {}),
    });
  }
  return result;
}

function purgeOrphanArtifactBlobs(database: DatabaseSync): number {
  const rows = database
    .prepare(
      `SELECT digest, relative_path FROM artifact_blobs
    WHERE NOT EXISTS (SELECT 1 FROM session_artifacts WHERE session_artifacts.digest = artifact_blobs.digest)
    AND NOT EXISTS (SELECT 1 FROM agent_graph_resource_refs WHERE kind = 'artifact' AND content_digest = artifact_blobs.digest)`,
    )
    .all() as { digest: string; relative_path: string }[];
  for (const row of rows) {
    if (row.relative_path !== artifactBlobRelativePath(row.digest))
      throw new WorkbarConflictError("Artifact content path mismatch");
    removeArtifactFile(database, row.relative_path);
    database.prepare("DELETE FROM artifact_blobs WHERE digest = ?").run(row.digest);
  }
  return rows.length;
}

function taskFromRow(row: TaskRow): SessionTaskRecord {
  return {
    taskId: row.task_id,
    title: row.title,
    ...(row.detail === null ? {} : { detail: row.detail }),
    status: row.status,
    ordinal: row.ordinal,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function artifactFromRow(row: ArtifactRow): SessionArtifactRecord {
  return {
    artifactId: row.artifact_id,
    title: row.title,
    mimeType: row.mime_type,
    digest: row.digest,
    sizeBytes: row.size_bytes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function boundedLimit(value: number | undefined, fallback: number, maximum: number): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < 1 || normalized > maximum) {
    throw new WorkbarConflictError(`limit 必须在 1..${maximum} 之间`);
  }
  return normalized;
}

function encodeCursor(revision: number, offset: number): string {
  return Buffer.from(JSON.stringify({ revision, offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor: string | undefined, revision: number): number {
  if (!cursor) return 0;
  try {
    const decoded = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      decoded["revision"] !== revision ||
      !Number.isSafeInteger(decoded["offset"]) ||
      (decoded["offset"] as number) < 0
    ) {
      throw new Error("invalid cursor");
    }
    return decoded["offset"] as number;
  } catch {
    throw new WorkbarConflictError("分页 cursor 已过期或无效");
  }
}

/** Caller owns the workspace transaction, including projection recovery. */
export function publishArtifactSnapshotLocked(
  database: DatabaseSync,
  input: {
    sessionId: string;
    artifactId: string;
    title: string;
    mimeType: string;
    content: Uint8Array;
  },
  digest: string,
  now: number,
): SessionArtifactRecord {
  const existing = database
    .prepare("SELECT * FROM session_artifacts WHERE artifact_id = ?")
    .get(input.artifactId) as ArtifactRow | undefined;
  if (existing) {
    if (
      existing.session_id !== input.sessionId ||
      existing.digest !== digest ||
      existing.mime_type !== input.mimeType ||
      existing.size_bytes !== input.content.byteLength
    ) {
      throw new WorkbarConflictError("媒体快照身份冲突");
    }
    return artifactFromRow(existing);
  }
  const relativePath = writeArtifactBlobFile(database, digest, input.content);
  database
    .prepare(
      "INSERT OR IGNORE INTO artifact_blobs (digest, size_bytes, relative_path, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(digest, input.content.byteLength, relativePath, now);
  database
    .prepare(
      `INSERT INTO session_artifacts
           (artifact_id, session_id, title, mime_type, digest, size_bytes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.artifactId,
      input.sessionId,
      input.title,
      input.mimeType,
      digest,
      input.content.byteLength,
      now,
      now,
    );
  const revision = ledgerRevision(database, "session_artifact_ledgers", input.sessionId);
  writeLedgerRevision(database, "session_artifact_ledgers", input.sessionId, revision + 1, now);
  const row = database
    .prepare("SELECT * FROM session_artifacts WHERE artifact_id = ?")
    .get(input.artifactId) as ArtifactRow | undefined;
  return artifactFromRow(row!);
}
