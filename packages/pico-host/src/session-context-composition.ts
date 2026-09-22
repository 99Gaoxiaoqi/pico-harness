import { DatabaseSync } from "node:sqlite";
import type { Message } from "@pico/core";
import type {
  RuntimeContextComposition,
  RuntimeContextSection,
  RuntimeLatestContextRequest,
} from "@pico/protocol";
import { operationalDatabasePath } from "@pico/storage";
import { estimateMessageTokens } from "@pico/runtime/context-budget";
import { parsePreparedRequestCapture } from "@pico/runtime/provider-request-diagnostics";

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_TOOLS = 8;

export function createCurrentContextSections(
  messages: readonly Message[],
): RuntimeContextSection[] {
  return [
    {
      id: "system",
      label: "系统指令（尚未装配）",
      state: "unknown",
    },
    {
      id: "tools",
      label: "工具定义（尚未装配）",
      state: "unknown",
    },
    {
      id: "messages",
      label: "模型历史消息小计（估算）",
      tokens: messages.reduce((n, m) => n + estimateMessageTokens(m), 0),
      state: "included",
    },
    {
      id: "other",
      label: messages.some((m) => m.images?.length)
        ? "附件及协议开销（未估算）"
        : "协议及其他开销（未估算）",
      state: "unknown",
    },
  ];
}

/** Counts serialized semantic segments, not HTTP wire bytes and never inferred tokens. */
export function foldContextComposition(
  segments: readonly { kind: string; bytes: number; label?: string }[],
): RuntimeContextComposition | undefined {
  if (!segments.length || segments.some((s) => !Number.isSafeInteger(s.bytes) || s.bytes < 0))
    return undefined;
  const kinds = { system: 0, tools: 0, messages: 0, other: 0 };
  const tools = new Map<string, { bytes: number; count: number }>();
  let unlabelledToolBytes = 0;
  for (const segment of segments) {
    const kind =
      segment.kind === "system_prompt"
        ? "system"
        : segment.kind === "tool_schema"
          ? "tools"
          : segment.kind === "message"
            ? "messages"
            : "other";
    kinds[kind] += segment.bytes;
    if (kind === "tools") {
      if (segment.label && /^[A-Za-z0-9_.:-]{1,128}$/u.test(segment.label)) {
        const prior = tools.get(segment.label);
        tools.set(segment.label, {
          bytes: (prior?.bytes ?? 0) + segment.bytes,
          count: (prior?.count ?? 0) + 1,
        });
      } else unlabelledToolBytes += segment.bytes;
    }
  }
  const totalBytes = Object.values(kinds).reduce((n, bytes) => n + bytes, 0);
  if (!Number.isSafeInteger(totalBytes)) return undefined;
  const ranked = [...tools]
    .map(([label, value]) => ({ label, ...value }))
    .sort((a, b) => b.bytes - a.bytes || a.label.localeCompare(b.label));
  return {
    basis: "semantic_utf8_bytes",
    totalBytes,
    segments: (Object.keys(kinds) as (keyof typeof kinds)[]).map((kind) => ({
      kind,
      bytes: kinds[kind],
    })),
    tools: ranked.slice(0, MAX_TOOLS).map(({ label, bytes }) => ({ label, bytes })),
    remainingTools: ranked
      .slice(MAX_TOOLS)
      .reduce(
        (rest, tool) => ({ count: rest.count + tool.count, bytes: rest.bytes + tool.bytes }),
        { count: 0, bytes: 0 },
      ),
    unlabelledToolBytes,
  };
}

/** Read one bounded metadata row in one SQLite snapshot. Never reads request bodies. */
export function getLatestContextRequest(
  storageRoot: string,
  sessionId: string,
): RuntimeLatestContextRequest {
  const db = new DatabaseSync(operationalDatabasePath(storageRoot), { readOnly: true });
  try {
    db.exec("BEGIN");
    const row = db
      .prepare(
        `SELECT physical_attempt_id, provider_call_id,
        json_extract(record_json,'$.provider') AS provider, json_extract(record_json,'$.model') AS model,
        json_extract(record_json,'$.completedAt') AS completed,
        CASE WHEN length(CAST(json_extract(record_json,'$.usage') AS BLOB))<=8192 THEN json_extract(record_json,'$.usage') END AS usage,
        CASE WHEN length(CAST(json_extract(record_json,'$.requestDiagnostic') AS BLOB))<=? THEN json_extract(record_json,'$.requestDiagnostic') END AS diagnostic
        FROM usage_physical_attempts WHERE session_id=? AND status='succeeded'
          AND json_extract(record_json,'$.accountingSource')='physical' AND json_valid(record_json) AND json_extract(record_json,'$.purpose')='main'
        ORDER BY json_extract(record_json,'$.completedAt') DESC, physical_attempt_id DESC LIMIT 1`,
      )
      .get(MAX_DIAGNOSTIC_BYTES, sessionId);
    return row
      ? requestView(row)
      : { status: "unavailable", source: "none", reason: "尚无成功的主请求记录。" };
  } finally {
    db.close();
  }
}

function requestView(row: Record<string, unknown>): RuntimeLatestContextRequest {
  const capture = parsePreparedRequestCapture(parseJson(row.diagnostic));
  const usage = parseJson(row.usage);
  const fields = isRecord(usage) ? usage.reportedFields : undefined;
  const reported = (field: string) => Array.isArray(fields) && fields.includes(field);
  const completion =
    typeof row.completed === "number" ? row.completed : Date.parse(String(row.completed));
  const identity = {
    source: "physical" as const,
    providerCallId: String(row.provider_call_id),
    ...(typeof row.physical_attempt_id === "string"
      ? { physicalAttemptId: row.physical_attempt_id }
      : {}),
    providerId: String(row.provider),
    modelId: String(row.model),
    ...(Number.isFinite(completion) ? { completedAt: completion } : {}),
  };
  const inputTokens =
    isRecord(usage) && (reported("prompt") || fields === undefined)
      ? usage.promptTokens
      : undefined;
  const cachedInputTokens =
    isRecord(usage) && reported("cacheRead") ? usage.cacheReadTokens : undefined;
  const metering = {
    ...(typeof inputTokens === "number" && Number.isFinite(inputTokens) ? { inputTokens } : {}),
    ...(typeof cachedInputTokens === "number" && Number.isFinite(cachedInputTokens)
      ? { cachedInputTokens }
      : {}),
  };
  if (!capture || capture.model !== row.model)
    return {
      ...identity,
      ...metering,
      status: "unavailable",
      reason: "该请求没有可用的无正文组成记录；未借用其他请求。",
    };
  const composition = foldContextComposition(capture.segments);
  return composition
    ? { ...identity, ...metering, status: "available", composition }
    : { ...identity, ...metering, status: "unavailable", reason: "该请求的组成记录为空或无效。" };
}
function parseJson(value: unknown): unknown {
  try {
    return typeof value === "string" ? JSON.parse(value) : undefined;
  } catch {
    return undefined;
  }
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
