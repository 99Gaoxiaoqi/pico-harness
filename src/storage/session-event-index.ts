import { createHash } from "node:crypto";
import type { RuntimeEvent } from "./runtime-event.js";

/**
 * 每会话事件索引边车（sessions/<digest>/events.index.jsonl）：每个追加事务
 * 一行，记录本批事件的 (sequence, eventId, at, payload 哈希) 及 plan/graph
 * 操作身份。可丢弃投影：缺失/损坏时从 ledger 全量重建。
 *
 * 用途：appendBatch 的去重（同 eventId 重放幂等、同 id 不同载荷 fail-closed）
 * 与 planOperation 查重不再需要全量加载 ledger；payload 等价性由哈希承载
 * （canonicalizeRuntimeEvent 输出的序列化是确定性的）。
 */

export const SESSION_EVENT_INDEX_FILE_NAME = "events.index.jsonl";
export const SESSION_EVENT_INDEX_BATCH_TYPE = "event-index";
export const SESSION_EVENT_INDEX_SCHEMA_VERSION = 1;

export interface SessionEventIndexEntry {
  readonly sequence: number;
  readonly eventId: string;
  readonly eventAt: string;
  readonly hash: string;
  readonly operationId?: string;
  readonly fingerprint?: string;
}

export interface SessionEventIndexBatch {
  readonly txId: string;
  readonly entries: readonly SessionEventIndexEntry[];
}

export class SessionEventIndexIntegrityError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "SessionEventIndexIntegrityError";
  }
}

export function eventPayloadHash(event: RuntimeEvent): string {
  // 与 ledger 批行内嵌的事件对象同一序列化路径；canonicalizeRuntimeEvent
  // 的输出形状确定，哈希在写入与校验两侧自洽。
  return `sha256:${createHash("sha256").update(JSON.stringify(event), "utf8").digest("hex")}`;
}

export function sessionEventIndexEntryFromEvent(
  sequence: number,
  event: RuntimeEvent,
  hash: string,
): SessionEventIndexEntry {
  const data = event.data as Record<string, unknown>;
  const hasOperation =
    (event.kind.startsWith("plan.") || event.kind.startsWith("graph.")) &&
    "operationId" in data &&
    typeof data["operationId"] === "string";
  return {
    sequence,
    eventId: event.eventId,
    eventAt: event.at,
    hash,
    ...(hasOperation ? { operationId: data["operationId"] as string } : {}),
    ...(hasOperation && typeof data["fingerprint"] === "string"
      ? { fingerprint: data["fingerprint"] as string }
      : {}),
  };
}

export function encodeSessionEventIndexBatch(batch: SessionEventIndexBatch): string {
  return `${JSON.stringify(
    {
      type: SESSION_EVENT_INDEX_BATCH_TYPE,
      schemaVersion: SESSION_EVENT_INDEX_SCHEMA_VERSION,
      txId: batch.txId,
      entries: batch.entries,
    },
  )}\n`;
}

export function decodeSessionEventIndexBatch(
  value: unknown,
  source: string,
  lineNumber: number,
): SessionEventIndexBatch {
  if (!isRecord(value) || value["type"] !== SESSION_EVENT_INDEX_BATCH_TYPE) {
    throw new SessionEventIndexIntegrityError(
      `Session event index ${source} line ${lineNumber} has an invalid record type`,
    );
  }
  const txId = value["txId"];
  const entries = value["entries"];
  if (typeof txId !== "string" || !txId || !Array.isArray(entries)) {
    throw new SessionEventIndexIntegrityError(
      `Session event index ${source} line ${lineNumber} is structurally invalid`,
    );
  }
  const decoded: SessionEventIndexEntry[] = [];
  for (const entry of entries) {
    if (!isRecord(entry)) {
      throw new SessionEventIndexIntegrityError(
        `Session event index ${source} line ${lineNumber} has an invalid entry`,
      );
    }
    const sequence = entry["sequence"];
    const eventId = entry["eventId"];
    const eventAt = entry["eventAt"];
    const hash = entry["hash"];
    if (
      typeof sequence !== "number" ||
      !Number.isSafeInteger(sequence) ||
      sequence <= 0 ||
      typeof eventId !== "string" ||
      !eventId ||
      typeof eventAt !== "string" ||
      !eventAt ||
      typeof hash !== "string" ||
      !/^sha256:[a-f0-9]{64}$/u.test(hash)
    ) {
      throw new SessionEventIndexIntegrityError(
        `Session event index ${source} line ${lineNumber} entry is invalid`,
      );
    }
    const operationId = entry["operationId"];
    const fingerprint = entry["fingerprint"];
    if (
      (operationId !== undefined && typeof operationId !== "string") ||
      (fingerprint !== undefined && typeof fingerprint !== "string")
    ) {
      throw new SessionEventIndexIntegrityError(
        `Session event index ${source} line ${lineNumber} operation identity is invalid`,
      );
    }
    decoded.push({
      sequence,
      eventId,
      eventAt,
      hash,
      ...(operationId !== undefined ? { operationId } : {}),
      ...(fingerprint !== undefined ? { fingerprint } : {}),
    });
  }
  return { txId, entries: decoded };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
