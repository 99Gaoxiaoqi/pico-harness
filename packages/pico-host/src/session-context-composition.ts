import { DatabaseSync } from "node:sqlite";
import type { Message, ToolDefinition } from "@pico/core";
import type {
  RuntimeContextComposition,
  RuntimeContextSection,
  RuntimeLatestContextRequest,
} from "@pico/protocol";
import { operationalDatabasePath } from "@pico/storage";
import { estimateMessageTokens, estimateToolDefinitionsTokens } from "@pico/runtime/context-budget";
import { parsePreparedRequestCapture } from "@pico/runtime/provider-request-diagnostics";

const MAX_DIAGNOSTIC_BYTES = 256 * 1024;
const MAX_TOOLS = 8;

export function createCurrentContextSections(
  messages: readonly Message[],
  tools?: readonly ToolDefinition[],
): RuntimeContextSection[] {
  return [
    {
      id: "system",
      label: "系统指令（估算）",
      tokens: messages
        .filter((m) => m.role === "system")
        .reduce((n, m) => n + estimateMessageTokens(m), 0),
      state: "included",
    },
    {
      id: "tools",
      label: tools ? "工具定义（估算）" : "工具定义（当前不可用）",
      ...(tools ? { tokens: estimateToolDefinitionsTokens(tools) } : {}),
      state: tools ? "included" : "unknown",
    },
    {
      id: "messages",
      label: "会话消息（估算）",
      tokens: messages
        .filter((m) => m.role !== "system")
        .reduce((n, m) => n + estimateMessageTokens(m), 0),
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

/** Read at most two bounded metadata rows in one SQLite snapshot. Never reads request bodies. */
export function getLatestContextRequest(
  storageRoot: string,
  sessionId: string,
): RuntimeLatestContextRequest {
  const db = new DatabaseSync(operationalDatabasePath(storageRoot), { readOnly: true });
  try {
    db.exec("BEGIN");
    const physical = Boolean(
      db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_physical_attempts'",
        )
        .get(),
    );
    const legacy = Boolean(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='usage_provider_calls'")
        .get(),
    );
    const candidates: RuntimeLatestContextRequest[] = [];
    if (physical) {
      const row = db
        .prepare(
          `SELECT physical_attempt_id, provider_call_id,
        json_extract(record_json,'$.provider') AS provider, json_extract(record_json,'$.model') AS model,
        json_extract(record_json,'$.completedAt') AS completed,
        CASE WHEN length(CAST(json_extract(record_json,'$.usage') AS BLOB))<=8192 THEN json_extract(record_json,'$.usage') END AS usage,
        CASE WHEN length(CAST(json_extract(record_json,'$.requestDiagnostic') AS BLOB))<=? THEN json_extract(record_json,'$.requestDiagnostic') END AS diagnostic
        FROM usage_physical_attempts WHERE session_id=? AND status='succeeded'
          AND json_valid(record_json) AND json_extract(record_json,'$.purpose')='main'
        ORDER BY json_extract(record_json,'$.completedAt') DESC, physical_attempt_id DESC LIMIT 1`,
        )
        .get(MAX_DIAGNOSTIC_BYTES, sessionId);
      if (row) candidates.push(requestView(row, "physical"));
    }
    if (legacy) {
      const row = db
        .prepare(
          `SELECT call_id AS provider_call_id, provider, model, created_at AS completed,
        input_tokens, cache_read_tokens, cache_write_tokens,
        json_extract(reported_json,'$.usageMetadata') AS usage_metadata,
        json_extract(reported_json,'$.reportedFields') AS reported_fields,
        CASE WHEN length(CAST(json_extract(reported_json,'$.requestDiagnostic') AS BLOB))<=? THEN json_extract(reported_json,'$.requestDiagnostic') END AS diagnostic
        FROM usage_provider_calls c WHERE session_id=? AND status='succeeded' AND purpose='main'
          AND (reported_json IS NULL OR json_valid(reported_json))
          ${physical ? "AND NOT EXISTS (SELECT 1 FROM usage_physical_attempts p WHERE p.provider_call_id=c.call_id)" : ""}
        ORDER BY created_at DESC, call_id DESC LIMIT 1`,
        )
        .get(MAX_DIAGNOSTIC_BYTES, sessionId);
      if (row) candidates.push(requestView(row, "legacy_call"));
    }
    return (
      candidates.sort((a, b) => (b.completedAt ?? 0) - (a.completedAt ?? 0))[0] ?? {
        status: "unavailable",
        source: "none",
        reason: "尚无成功的主请求记录。",
      }
    );
  } finally {
    db.close();
  }
}

function requestView(
  row: Record<string, unknown>,
  source: "physical" | "legacy_call",
): RuntimeLatestContextRequest {
  const capture = parsePreparedRequestCapture(parseJson(row.diagnostic));
  const usage = parseJson(row.usage);
  const fields =
    source === "physical" && isRecord(usage)
      ? usage.reportedFields
      : parseJson(row.reported_fields);
  const reported = (field: string) => Array.isArray(fields) && fields.includes(field);
  const completion =
    typeof row.completed === "number" ? row.completed : Date.parse(String(row.completed));
  const identity = {
    source,
    providerCallId: String(row.provider_call_id),
    ...(typeof row.physical_attempt_id === "string"
      ? { physicalAttemptId: row.physical_attempt_id }
      : {}),
    providerId: String(row.provider),
    modelId: String(row.model),
    ...(Number.isFinite(completion) ? { completedAt: completion } : {}),
  };
  const inputTokens =
    source === "physical" && isRecord(usage)
      ? reported("prompt") || fields === undefined
        ? usage.promptTokens
        : undefined
      : row.usage_metadata === "reported" && reported("prompt")
        ? Number(row.input_tokens) + Number(row.cache_read_tokens) + Number(row.cache_write_tokens)
        : undefined;
  const cachedInputTokens =
    source === "physical" && isRecord(usage)
      ? reported("cacheRead")
        ? usage.cacheReadTokens
        : undefined
      : row.usage_metadata === "reported" && reported("cacheRead")
        ? row.cache_read_tokens
        : undefined;
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
