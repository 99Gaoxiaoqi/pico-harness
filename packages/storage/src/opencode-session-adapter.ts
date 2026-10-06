import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { Message } from "@pico/core";
import {
  ExternalSessionLimitError,
  ExternalSessionNotFoundError,
  ExternalSessionUnreadableError,
  createExternalSessionCatalogCache,
  isRecord,
  normalizeTimestamp,
  paginateExternalSessions,
  titleText,
  type ExternalSessionAdapter,
  type ExternalSessionPage,
  type ExternalSessionPageQuery,
  type ExternalSessionSnapshot,
  type ExternalSessionSummary,
} from "./external-sessions.js";

const SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const MAX_CANDIDATES = 10_000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const MAX_TRANSCRIPT_ROWS = 100_000;

interface SqlDatabase {
  prepare(sql: string): {
    all(...params: unknown[]): unknown[];
    get(...params: unknown[]): unknown;
  };
  exec(sql: string): void;
  close(): void;
}

export class OpenCodeSessionAdapter implements ExternalSessionAdapter {
  readonly id = "opencode" as const;
  readonly name = "OpenCode";
  private readonly databasePath: string;
  private readonly cachedSessions = createExternalSessionCatalogCache();

  constructor(databasePath = defaultDatabasePath()) {
    this.databasePath = resolve(databasePath);
  }

  async detect(): Promise<boolean> {
    return existsSync(this.databasePath);
  }

  async listSessions(text?: string): Promise<readonly ExternalSessionSummary[]> {
    if (!(await this.detect())) return [];
    return this.withDatabase((db) => {
      requireSchema(db);
      const rows = db
        .prepare(
          "SELECT id, title, directory, time_created, time_updated, time_archived, parent_id FROM session WHERE parent_id IS NULL OR parent_id = '' ORDER BY coalesce(time_updated, time_created, 0) DESC, id DESC LIMIT ?",
        )
        .all(MAX_CANDIDATES + 1);
      if (rows.length > MAX_CANDIDATES) throw new ExternalSessionLimitError(MAX_CANDIDATES);
      const summaries = rows.flatMap((value) => {
        const summary = toSummary(value);
        return summary &&
          (!text ||
            `${summary.title} ${summary.cwd} ${summary.id}`
              .toLocaleLowerCase()
              .includes(text.trim().toLocaleLowerCase()))
          ? [summary]
          : [];
      });
      return summaries;
    });
  }

  async listPage(query: ExternalSessionPageQuery): Promise<ExternalSessionPage> {
    return paginateExternalSessions(this.id, query, () =>
      this.cachedSessions(() => this.listSessions()),
    );
  }

  async readSession(sessionId: string): Promise<ExternalSessionSnapshot> {
    if (!SESSION_ID.test(sessionId)) throw new ExternalSessionNotFoundError();
    return this.withDatabase((db) => {
      return withReadSnapshot(db, () => {
        requireSchema(db);
        const row = db
          .prepare(
            "SELECT id, title, directory, time_created, time_updated, time_archived, parent_id FROM session WHERE id = ?",
          )
          .get(sessionId);
        const summary = toSummary(row);
        if (!summary) throw new ExternalSessionNotFoundError();
        const dataRow = asRecord(row);
        if (typeof dataRow?.["parent_id"] === "string" && dataRow["parent_id"]) {
          throw new ExternalSessionUnreadableError("OpenCode 子会话暂不支持导入");
        }
        const counts = asRecord(
          db
            .prepare(
              `SELECT count(*) AS rows, coalesce(sum(raw_bytes), 0) AS raw_bytes
             FROM (
               SELECT length(CAST(id AS BLOB)) + length(CAST(data AS BLOB)) AS raw_bytes FROM message WHERE session_id = ?
               UNION ALL
               SELECT length(CAST(id AS BLOB)) + length(CAST(message_id AS BLOB)) + length(CAST(data AS BLOB)) AS raw_bytes FROM part WHERE session_id = ?
             )`,
            )
            .get(sessionId, sessionId),
        );
        const rowCount = numeric(counts?.["rows"]);
        const rawBytes = numeric(counts?.["raw_bytes"]);
        if (rowCount > MAX_TRANSCRIPT_ROWS)
          throw new ExternalSessionLimitError(MAX_TRANSCRIPT_ROWS);
        if (rawBytes > MAX_TRANSCRIPT_BYTES)
          throw new ExternalSessionLimitError(MAX_TRANSCRIPT_BYTES);

        const messages = db
          .prepare(
            "SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id",
          )
          .all(sessionId)
          .map((value) => requireJsonRecord(value, "OpenCode message"));
        const parts = db
          .prepare(
            "SELECT message_id, data FROM part WHERE session_id = ? ORDER BY time_created, id",
          )
          .all(sessionId)
          .map((value) => requireJsonRecord(value, "OpenCode part"));
        const partsByMessage = new Map<string, Record<string, unknown>[]>();
        for (const part of parts) {
          const messageId = stringValue(part["message_id"]);
          const data = parseJsonObject(part["data"], "OpenCode part data");
          if (!messageId || !data) continue;
          const group = partsByMessage.get(messageId) ?? [];
          group.push(data);
          partsByMessage.set(messageId, group);
        }

        const imported: Message[] = [];
        for (const message of messages) {
          const id = stringValue(message["id"]);
          const data = parseJsonObject(message["data"], "OpenCode message data");
          const role = data?.["role"];
          if (!id || (role !== "user" && role !== "assistant")) continue;
          const content = (partsByMessage.get(id) ?? [])
            .filter((part) => part["type"] === "text" && part["synthetic"] !== true)
            .map((part) => (typeof part["text"] === "string" ? part["text"].trim() : ""))
            .filter(Boolean)
            .join("\n\n");
          if (!content) continue;
          imported.push({ role, content });
          if (imported.length > 20_000) throw new ExternalSessionLimitError(20_000);
        }
        if (imported.length === 0)
          throw new ExternalSessionUnreadableError("OpenCode 会话中没有可导入的对话文本");
        return { summary, messages: imported };
      });
    });
  }

  private async withDatabase<T>(read: (db: SqlDatabase) => T): Promise<T> {
    const sqlite = await import("node:sqlite");
    let db: SqlDatabase;
    try {
      db = new sqlite.DatabaseSync(this.databasePath, { readOnly: true }) as unknown as SqlDatabase;
    } catch (cause) {
      throw new ExternalSessionUnreadableError("无法以只读方式打开 OpenCode 数据库", { cause });
    }
    try {
      return read(db);
    } finally {
      try {
        db.close();
      } catch {
        /* Preserve the read result. */
      }
    }
  }
}

function defaultDatabasePath(): string {
  if (process.env["OPENCODE_DB_PATH"]) return process.env["OPENCODE_DB_PATH"]!;
  let home: string;
  if (process.platform === "darwin")
    home = join(homedir(), "Library", "Application Support", "opencode");
  else if (process.platform === "win32")
    home = join(process.env["APPDATA"] ?? join(homedir(), "AppData", "Roaming"), "opencode");
  else home = join(process.env["XDG_DATA_HOME"] ?? join(homedir(), ".local", "share"), "opencode");
  return join(home, "opencode.db");
}

function requireSchema(db: SqlDatabase): void {
  const required: Readonly<Record<string, readonly string[]>> = {
    session: ["id", "title", "directory", "parent_id"],
    message: ["id", "session_id", "time_created", "data"],
    part: ["id", "message_id", "session_id", "time_created", "data"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name?: unknown }[];
    const actual = new Set(
      rows.map((column) => column.name).filter((name): name is string => typeof name === "string"),
    );
    if (columns.some((column) => !actual.has(column))) {
      throw new ExternalSessionUnreadableError(`OpenCode 数据库表 ${table} 结构不受支持`);
    }
  }
}

function toSummary(value: unknown): ExternalSessionSummary | undefined {
  const row = asRecord(value);
  if (!row) return undefined;
  const id = stringValue(row["id"]);
  if (!id || !SESSION_ID.test(id)) return undefined;
  const created = normalizeTimestamp(row["time_created"], 0);
  const updated = normalizeTimestamp(row["time_updated"], created);
  const archived = row["time_archived"] !== null && row["time_archived"] !== undefined;
  return {
    id,
    title: titleText(row["title"], id),
    cwd: stringValue(row["directory"]) ?? "",
    updatedAt: updated,
    ...(archived ? { archived: true } : {}),
  };
}

function requireJsonRecord(value: unknown, label: string): Record<string, unknown> {
  const record = asRecord(value);
  if (!record) throw new ExternalSessionUnreadableError(`${label} 行格式无效`);
  return record;
}

function parseJsonObject(value: unknown, label: string): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) ? parsed : undefined;
  } catch (cause) {
    throw new ExternalSessionUnreadableError(`${label} 无法解析`, { cause });
  }
}

function withReadSnapshot<T>(db: SqlDatabase, read: () => T): T {
  db.exec("BEGIN DEFERRED");
  try {
    const result = read();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* Preserve the source read error. */
    }
    throw error;
  }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return isRecord(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numeric(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : Number(value ?? 0) || 0;
}
