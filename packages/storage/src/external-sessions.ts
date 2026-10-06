import type { Message } from "@pico/core";

export const EXTERNAL_SESSION_ADAPTER_IDS = ["codex", "claude-code", "opencode"] as const;
export type ExternalSessionAdapterId = (typeof EXTERNAL_SESSION_ADAPTER_IDS)[number];

export interface ExternalSessionSummary {
  readonly id: string;
  readonly title: string;
  readonly cwd: string;
  readonly updatedAt: number;
  readonly archived?: boolean;
}

export interface ExternalSessionSnapshot {
  readonly summary: ExternalSessionSummary;
  readonly messages: readonly Message[];
}

export interface ExternalSessionPageQuery {
  readonly text?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ExternalSessionPage {
  readonly sessions: readonly ExternalSessionSummary[];
  readonly nextCursor: string | null;
}

export interface ExternalSessionAdapter {
  readonly id: ExternalSessionAdapterId;
  readonly name: string;
  detect(): Promise<boolean>;
  listSessions(text?: string): Promise<readonly ExternalSessionSummary[]>;
  listPage(query: ExternalSessionPageQuery): Promise<ExternalSessionPage>;
  readSession(sessionId: string): Promise<ExternalSessionSnapshot>;
}

export function createExternalSessionCatalogCache(ttlMs = 15_000) {
  let sessions: readonly ExternalSessionSummary[] | undefined;
  let expiresAt = 0;
  let pending: Promise<readonly ExternalSessionSummary[]> | undefined;

  return async (load: () => Promise<readonly ExternalSessionSummary[]>) => {
    if (sessions && Date.now() < expiresAt) return sessions;
    if (pending) return pending;

    const request = load();
    pending = request;
    try {
      sessions = await request;
      expiresAt = Date.now() + ttlMs;
      return sessions;
    } finally {
      if (pending === request) pending = undefined;
    }
  };
}

export class ExternalSessionLimitError extends Error {
  constructor(readonly max: number) {
    super(`外部会话数量超过可扫描上限 ${max}`);
    this.name = "ExternalSessionLimitError";
  }
}

export class ExternalSessionNotFoundError extends Error {
  constructor() {
    super("找不到所选的外部会话");
    this.name = "ExternalSessionNotFoundError";
  }
}

export class ExternalSessionUnreadableError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExternalSessionUnreadableError";
  }
}

export function titleText(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  return normalized.slice(0, 160) || fallback;
}

export function textFromContent(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (!Array.isArray(value)) return "";
  return value
    .flatMap((part) => {
      if (!isRecord(part)) return [];
      const type = typeof part["type"] === "string" ? part["type"].toLowerCase() : "";
      if (type !== "text" && type !== "input_text" && type !== "output_text") return [];
      return typeof part["text"] === "string" ? [part["text"]] : [];
    })
    .join("\n")
    .trim();
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export async function paginateExternalSessions(
  adapterId: ExternalSessionAdapterId,
  query: ExternalSessionPageQuery,
  list: () => Promise<readonly ExternalSessionSummary[]>,
): Promise<ExternalSessionPage> {
  const limit = query.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) {
    throw new Error("每页外部会话数量必须介于 1 和 100 之间");
  }
  const text = (query.text ?? "").trim().toLocaleLowerCase();
  const offset = decodeExternalSessionCursor(query.cursor, adapterId, text);
  const sessions = (await list()).filter((item) =>
    `${item.title} ${item.cwd} ${item.id}`.toLocaleLowerCase().includes(text),
  );
  const page = sessions.slice(offset, offset + limit + 1);
  const hasMore = page.length > limit;
  const delivered = hasMore ? page.slice(0, limit) : page;
  return {
    sessions: delivered,
    nextCursor: hasMore
      ? encodeExternalSessionCursor(adapterId, text, offset + delivered.length)
      : null,
  };
}

function encodeExternalSessionCursor(
  adapterId: ExternalSessionAdapterId,
  text: string,
  offset: number,
): string {
  return Buffer.from(JSON.stringify({ v: 1, adapterId, text, offset }), "utf8").toString(
    "base64url",
  );
}

function decodeExternalSessionCursor(
  cursor: string | undefined,
  adapterId: ExternalSessionAdapterId,
  text: string,
): number {
  if (cursor === undefined) return 0;
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      isRecord(value) &&
      value["v"] === 1 &&
      value["adapterId"] === adapterId &&
      value["text"] === text &&
      Number.isSafeInteger(value["offset"]) &&
      (value["offset"] as number) >= 0
    )
      return value["offset"] as number;
  } catch {
    // The cursor is opaque at the API boundary; invalid cursors fail closed.
  }
  throw new Error("外部会话分页游标无效或不属于当前搜索");
}

export function normalizeTimestamp(value: unknown, fallback = Date.now()): number {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) {
    return value < 1_000_000_000_000 ? value * 1000 : value;
  }
  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) return normalizeTimestamp(numeric, fallback);
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}
