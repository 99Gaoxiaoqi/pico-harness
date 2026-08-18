import type { CliSessionSummary, SessionSummaryFold } from "../engine/session-summary.js";

/**
 * 会话目录（session catalog）：工作区级、每会话一行的预计算摘要清单。
 *
 * 定位与不变量（对齐 manifest 投影的"可丢弃派生"原则）：
 * - canonical 事实永远在 sessions/<digest>/session.jsonl；catalog 丢失/损坏/
 *   版本不符时从 ledger 全量重建，重建结果必须与逐会话现算完全一致。
 * - 写入与 ledger 追加同一个 commitFileTransactionSync，正常路径下不可能
 *   滞后于 ledger；残余漂移（deleteSession 崩溃窗口、手工篡改）由读取侧
 *   的 statSync 水位校验兜底。
 * - 发布���定的 journal 部分不落 catalog（StorageOperationJournal 的状态可
 *   在无新事件时变化），读取时补查。
 * - 行内持久化折叠状态（fold）：写路径增量维护只折叠新增事件，全量口径
 *   与增量口径共用同一折叠器（构造性等价）。
 */

export const SESSION_CATALOG_SCHEMA_VERSION = 2;
export const SESSION_CATALOG_RELATIVE_PATH = "control/session-catalog.json";

export interface SessionCatalogRow {
  readonly summary: CliSessionSummary;
  /** Watermark: ledger byte length at the time this row was written. */
  readonly ledgerByteLength: number;
  /** 增量维护的折叠状态：继续折叠后续事件的起点。 */
  readonly fold: SessionSummaryFold;
}

export interface SessionCatalog {
  readonly schemaVersion: typeof SESSION_CATALOG_SCHEMA_VERSION;
  readonly rows: ReadonlyMap<string, SessionCatalogRow>;
}

/** 写路径内部形态：decode 与 rebuild 实际构造的都是真 Map。 */
export type MutableSessionCatalog = {
  readonly schemaVersion: typeof SESSION_CATALOG_SCHEMA_VERSION;
  readonly rows: Map<string, SessionCatalogRow>;
};

export class SessionCatalogIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionCatalogIntegrityError";
  }
}

export function encodeSessionCatalog(catalog: SessionCatalog): string {
  const sessions: Record<string, unknown> = {};
  for (const [sessionId, row] of catalog.rows) {
    sessions[sessionId] = {
      summary: serializeSummary(row.summary),
      ledgerByteLength: row.ledgerByteLength,
      fold: serializeFold(row.fold),
    };
  }
  return `${JSON.stringify({ schemaVersion: SESSION_CATALOG_SCHEMA_VERSION, sessions }, null, 2)}\n`;
}

export function decodeSessionCatalog(text: string, source: string): SessionCatalog {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (error) {
    throw new SessionCatalogIntegrityError(`Session catalog ${source} is not valid JSON`, {
      cause: error,
    });
  }
  if (!isRecord(value) || value["schemaVersion"] !== SESSION_CATALOG_SCHEMA_VERSION) {
    throw new SessionCatalogIntegrityError(
      `Session catalog ${source} has an unsupported schemaVersion`,
    );
  }
  const sessions = value["sessions"];
  if (!isRecord(sessions)) {
    throw new SessionCatalogIntegrityError(`Session catalog ${source} has no sessions map`);
  }
  const rows = new Map<string, SessionCatalogRow>();
  for (const [sessionId, row] of Object.entries(sessions)) {
    if (!isRecord(row)) {
      throw new SessionCatalogIntegrityError(`Session catalog ${source} row ${sessionId} is invalid`);
    }
    const decoded = decodeRow(row, sessionId, source);
    if (decoded.summary.id !== sessionId) {
      throw new SessionCatalogIntegrityError(
        `Session catalog ${source} row key ${sessionId} does not match summary id ${decoded.summary.id}`,
      );
    }
    rows.set(sessionId, decoded);
  }
  return { schemaVersion: SESSION_CATALOG_SCHEMA_VERSION, rows };
}

function decodeRow(row: Record<string, unknown>, sessionId: string, source: string): SessionCatalogRow {
  const summary = row["summary"];
  if (!isRecord(summary)) {
    throw new SessionCatalogIntegrityError(`Session catalog ${source} row ${sessionId} has no summary`);
  }
  const fold = row["fold"];
  if (!isRecord(fold)) {
    throw new SessionCatalogIntegrityError(`Session catalog ${source} row ${sessionId} has no fold`);
  }
  const createdAt = decodeDate(summary["createdAt"], `${source} row ${sessionId} createdAt`);
  const updatedAt = decodeDate(summary["updatedAt"], `${source} row ${sessionId} updatedAt`);
  const pendingForkRuns = fold["pendingForkRuns"];
  if (
    !Array.isArray(pendingForkRuns) ||
    !pendingForkRuns.every((runId) => typeof runId === "string" && runId)
  ) {
    throw new SessionCatalogIntegrityError(
      `Session catalog ${source} row ${sessionId} pendingForkRuns is invalid`,
    );
  }
  return {
    summary: {
      id: requireString(summary["id"], `${source} row ${sessionId} id`),
      cwd: requireString(summary["cwd"], `${source} row ${sessionId} cwd`),
      createdAt,
      updatedAt,
      ...optionalNumber(summary["messageCount"], "messageCount"),
      ...optionalString(summary["title"], "title"),
      ...optionalString(summary["firstMessage"], "firstMessage"),
      ...optionalString(summary["lastMessage"], "lastMessage"),
      ...optionalString(summary["historySource"], "historySource"),
      ...optionalString(summary["forkFrom"], "forkFrom"),
      ...optionalString(summary["logId"], "logId"),
      ...optionalString(summary["parentLogId"], "parentLogId"),
      ...optionalString(summary["forkEventId"], "forkEventId"),
    },
    ledgerByteLength: requireNonNegativeInteger(
      row["ledgerByteLength"],
      `${source} row ${sessionId} ledgerByteLength`,
    ),
    fold: {
      messageCount: requireNonNegativeInteger(
        fold["messageCount"],
        `${source} row ${sessionId} fold.messageCount`,
      ),
      ...optionalString(fold["firstMessage"], "firstMessage"),
      ...optionalString(fold["lastMessage"], "lastMessage"),
      ...optionalString(fold["settingsTitle"], "settingsTitle"),
      ...optionalString(fold["settingsForkFrom"], "settingsForkFrom"),
      ...optionalString(fold["forkEventParent"], "forkEventParent"),
      ...optionalString(fold["forkEventId"], "forkEventId"),
      hasForkFacts: requireBoolean(fold["hasForkFacts"], `${source} row ${sessionId} fold.hasForkFacts`),
      completedBootstrap: requireBoolean(
        fold["completedBootstrap"],
        `${source} row ${sessionId} fold.completedBootstrap`,
      ),
      pendingForkRuns: pendingForkRuns as readonly string[],
      ...optionalString(fold["lastEventAt"], "lastEventAt"),
      headSequence: requireNonNegativeInteger(
        fold["headSequence"],
        `${source} row ${sessionId} fold.headSequence`,
      ),
    },
  };
}

function serializeFold(fold: SessionSummaryFold): Record<string, unknown> {
  return {
    messageCount: fold.messageCount,
    ...(fold.firstMessage !== undefined ? { firstMessage: fold.firstMessage } : {}),
    ...(fold.lastMessage !== undefined ? { lastMessage: fold.lastMessage } : {}),
    ...(fold.settingsTitle !== undefined ? { settingsTitle: fold.settingsTitle } : {}),
    ...(fold.settingsForkFrom !== undefined ? { settingsForkFrom: fold.settingsForkFrom } : {}),
    ...(fold.forkEventParent !== undefined ? { forkEventParent: fold.forkEventParent } : {}),
    ...(fold.forkEventId !== undefined ? { forkEventId: fold.forkEventId } : {}),
    hasForkFacts: fold.hasForkFacts,
    completedBootstrap: fold.completedBootstrap,
    pendingForkRuns: fold.pendingForkRuns,
    ...(fold.lastEventAt !== undefined ? { lastEventAt: fold.lastEventAt } : {}),
    headSequence: fold.headSequence,
  };
}

function serializeSummary(summary: CliSessionSummary): Record<string, unknown> {
  return {
    id: summary.id,
    cwd: summary.cwd,
    createdAt: summary.createdAt.toISOString(),
    updatedAt: summary.updatedAt.toISOString(),
    ...(summary.messageCount !== undefined ? { messageCount: summary.messageCount } : {}),
    ...(summary.title !== undefined ? { title: summary.title } : {}),
    ...(summary.firstMessage !== undefined ? { firstMessage: summary.firstMessage } : {}),
    ...(summary.lastMessage !== undefined ? { lastMessage: summary.lastMessage } : {}),
    ...(summary.historySource !== undefined ? { historySource: summary.historySource } : {}),
    ...(summary.forkFrom !== undefined ? { forkFrom: summary.forkFrom } : {}),
    ...(summary.logId !== undefined ? { logId: summary.logId } : {}),
    ...(summary.parentLogId !== undefined ? { parentLogId: summary.parentLogId } : {}),
    ...(summary.forkEventId !== undefined ? { forkEventId: summary.forkEventId } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SessionCatalogIntegrityError(`Session catalog field ${label} must be a non-empty string`);
  }
  return value;
}

function decodeDate(value: unknown, label: string): Date {
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new SessionCatalogIntegrityError(`Session catalog field ${label} must be an ISO date`);
  }
  return new Date(value as string);
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SessionCatalogIntegrityError(`Session catalog field ${label} must be a non-negative integer`);
  }
  return value as number;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw new SessionCatalogIntegrityError(`Session catalog field ${label} must be a boolean`);
  }
  return value;
}

function optionalString(value: unknown, key: string): Record<string, string> {
  return typeof value === "string" ? { [key]: value } : {};
}

function optionalNumber(value: unknown, key: string): Record<string, number> {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? { [key]: value }
    : {};
}
