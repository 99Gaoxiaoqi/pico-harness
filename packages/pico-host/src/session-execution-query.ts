import type { Usage } from "@pico/core";
import { DatabaseSync } from "node:sqlite";
import { operationalDatabasePath, type PhysicalAttemptRecord } from "@pico/storage";
import { decodeRuntimeEventJson, type RuntimeEvent } from "@pico/storage/runtime-event";
import { RuntimeProtocolError } from "@pico/protocol";
import type {
  RuntimeExecutionAttempt,
  RuntimeExecutionPage,
  RuntimeExecutionRun,
  RuntimeExecutionStep,
  RuntimeExecutionSummary,
} from "@pico/protocol";

const MAX_BYTES = 48 * 1024;
type Cursor = {
  sessionId: string;
  watermark: number;
  before: number;
  anchor: string;
  accounting: number;
};
type Row = { run_id: string; event_seq: number; payload_json: string };

/** Projects existing durable facts in one read-only snapshot; never creates storage. */
export function querySessionExecution(
  storageRoot: string,
  input: { sessionId: string; cursor?: string; runId?: string },
): RuntimeExecutionPage {
  if (!input.sessionId || (input.cursor !== undefined && input.runId !== undefined))
    throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid execution query");
  const db = new DatabaseSync(operationalDatabasePath(storageRoot), { readOnly: true });
  try {
    db.exec("BEGIN");
    if (!db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(input.sessionId))
      throw new RuntimeProtocolError("NOT_FOUND", "Session not found");
    const head = db
      .prepare(
        "SELECT event_seq, event_id FROM runtime_events WHERE session_id = ? ORDER BY event_seq DESC LIMIT 1",
      )
      .get(input.sessionId);
    let cursor: Cursor = {
      sessionId: input.sessionId,
      watermark: Number(head?.event_seq ?? 0),
      before: Number(head?.event_seq ?? 0) + 1,
      anchor: String(head?.event_id ?? ""),
      accounting: accountingVersion(db, input.sessionId),
    };
    if (input.cursor !== undefined) {
      try {
        if (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const parsed = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        ) as Cursor;
        if (
          Object.keys(parsed).sort().join() !== "accounting,anchor,before,sessionId,watermark" ||
          parsed.sessionId !== input.sessionId ||
          parsed.accounting !== cursor.accounting ||
          !Number.isSafeInteger(parsed.watermark) ||
          parsed.watermark < 1 ||
          !Number.isSafeInteger(parsed.before) ||
          parsed.before < 1 ||
          parsed.before > parsed.watermark ||
          typeof parsed.anchor !== "string"
        )
          throw new Error();
        const anchor = db
          .prepare("SELECT event_id FROM runtime_events WHERE session_id = ? AND event_seq = ?")
          .get(input.sessionId, parsed.watermark);
        if (anchor?.event_id !== parsed.anchor) throw new Error();
        const boundary = db
          .prepare(
            "SELECT 1 FROM runtime_events WHERE session_id = ? AND event_seq = ? AND kind = 'run.started'",
          )
          .get(input.sessionId, parsed.before);
        if (!boundary) throw new Error();
        cursor = parsed;
      } catch {
        throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid execution cursor");
      }
    }
    const openings = db
      .prepare(
        `SELECT run_id, event_seq, payload_json FROM runtime_events WHERE session_id = ? AND kind = 'run.started' AND event_seq < ? ${input.runId !== undefined ? "AND run_id = ?" : ""} ORDER BY event_seq DESC LIMIT 17`,
      )
      .all(
        input.sessionId,
        cursor.before,
        ...(input.runId !== undefined ? [input.runId] : []),
      ) as Row[];
    if (input.runId !== undefined && openings.length === 0)
      throw new RuntimeProtocolError("NOT_FOUND", "Run not found in session");
    const runs: RuntimeExecutionRun[] = [];
    const oversizedRunIds: string[] = [],
      missingModelCallRunIds: string[] = [],
      incompleteRunIds: string[] = [];
    const coverage = { value: "missing" as RuntimeExecutionPage["coverage"]["modelAttempts"] };
    const sessionSummary = summary(db, input.sessionId, cursor.watermark, coverage);
    const page: RuntimeExecutionPage = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      runs,
      summary: sessionSummary,
      coverage: {
        oversizedRunIds,
        missingModelCallRunIds,
        incompleteRunIds,
        modelAttempts: coverage.value,
      },
    };
    let consumed = 0;
    let evidenceBytes = 0;
    let evidenceEvents = 0;
    for (const opening of openings.slice(0, 16)) {
      const size = db
        .prepare(
          "SELECT count(*) AS count, sum(length(CAST(payload_json AS BLOB))) AS bytes FROM runtime_events WHERE session_id = ? AND run_id = ? AND event_seq <= ?",
        )
        .get(input.sessionId, opening.run_id, cursor.watermark)!;
      const physicalSize = db
        .prepare(
          `SELECT count(*) AS count, coalesce(sum(length(CAST(record_json AS BLOB))),0) AS bytes FROM (${physicalRowsSql()}) WHERE session_id=? AND run_id=?`,
        )
        .get(input.sessionId, opening.run_id)!;
      const totalCount = Number(size.count) + Number(physicalSize.count);
      const totalBytes = Number(size.bytes) + Number(physicalSize.bytes);
      if (totalCount > 4096 || totalBytes > 512 * 1024 || Number(physicalSize.count) > 128) {
        oversizedRunIds.push(opening.run_id);
        consumed++;
        continue;
      }
      // The evidence budget is shared by the entire request, not multiplied by page size.
      if (evidenceEvents + totalCount > 4096 || evidenceBytes + totalBytes > 512 * 1024) break;
      evidenceEvents += totalCount;
      evidenceBytes += totalBytes;
      const rows = db
        .prepare(
          "SELECT payload_json FROM runtime_events WHERE session_id = ? AND run_id = ? AND event_seq <= ? ORDER BY event_seq",
        )
        .all(input.sessionId, opening.run_id, cursor.watermark);
      const events = rows.map((row) => decodeRuntimeEventJson(String(row.payload_json)));
      const physical = readRunPhysicalAttempts(db, input.sessionId, opening.run_id);
      if (physical.length > 128) {
        oversizedRunIds.push(opening.run_id);
        consumed++;
        continue;
      }
      const run = projectRun(events, decodeRuntimeEventJson(opening.payload_json), physical);
      runs.push(run);
      if (Buffer.byteLength(JSON.stringify(page)) > MAX_BYTES - 4096) {
        runs.pop();
        if (consumed === 0) {
          oversizedRunIds.push(opening.run_id);
          consumed++;
        }
        break;
      }
      consumed++;
      if (run.status === "running" || run.steps.some((step) => step.status === "running"))
        incompleteRunIds.push(run.runId);
      if (
        physical.some((r) => r.status === "prepared" || r.status === "observed") ||
        (physical.length === 0 &&
          events.some((e) => e.kind === "message.committed" && e.data.message.role === "assistant"))
      )
        missingModelCallRunIds.push(run.runId);
    }
    const last = openings[consumed - 1];
    if (input.runId === undefined && last && openings.length > consumed)
      return {
        ...page,
        nextCursor: Buffer.from(JSON.stringify({ ...cursor, before: last.event_seq })).toString(
          "base64url",
        ),
      };
    return page;
  } finally {
    db.close();
  }
}

/** Summary stays available even when a run is too large or cannot be projected. */
export function querySessionExecutionSummary(
  storageRoot: string,
  input: { sessionId: string },
): RuntimeExecutionSummary {
  if (!input.sessionId) throw new RuntimeProtocolError("INVALID_PARAMS", "Invalid execution query");
  const db = new DatabaseSync(operationalDatabasePath(storageRoot), { readOnly: true });
  try {
    db.exec("BEGIN");
    if (!db.prepare("SELECT 1 FROM sessions WHERE session_id = ?").get(input.sessionId))
      throw new RuntimeProtocolError("NOT_FOUND", "Session not found");
    return summary(db, input.sessionId, Number.MAX_SAFE_INTEGER);
  } finally {
    db.close();
  }
}

function summary(
  db: DatabaseSync,
  sessionId: string,
  watermark: number,
  coverage?: { value: RuntimeExecutionPage["coverage"]["modelAttempts"] },
): RuntimeExecutionSummary {
  // All expansion and aggregation happens in SQLite: no unbounded ledger reads into JS.
  const row = db
    .prepare(
      `WITH physical AS (${physicalRowsSql()}), events AS (
    SELECT run_id, kind, json_extract(payload_json, '$.data') AS data,
      coalesce(json_extract(payload_json, '$.refs.toolCallId'), event_id) AS tool_id,
      json_extract(payload_json, '$.at') AS at
    FROM runtime_events WHERE session_id = ? AND event_seq <= ? AND json_valid(payload_json)
      AND kind IN ('tool.started','tool.result.recorded')
  ), calls AS MATERIALIZED (
    SELECT coalesce(run_id,'') AS run_id, provider_call_id AS call_id,
      max(json_extract(record_json,'$.retryAttempt')) AS retry_attempt,
      json_object('attempts', json_group_array(json(record_json)),
        'attemptCoverage', CASE WHEN min(coalesce(json_extract(record_json,'$.attemptCoverage'),'complete') != 'partial') THEN 'complete' ELSE 'partial' END,
        'status', CASE WHEN max(json_extract(record_json,'$.status')='succeeded') THEN 'succeeded' WHEN max(json_extract(record_json,'$.status')='cancelled') THEN 'cancelled' WHEN max(json_extract(record_json,'$.status') IN ('prepared','observed')) THEN 'running' ELSE 'failed' END,
        'latencyMs', sum(json_extract(record_json,'$.latencyMs'))) AS settled
    FROM physical WHERE session_id=? GROUP BY run_id,provider_call_id
  ), measurements AS (
    SELECT coalesce(run_id,'') AS run_id, provider_call_id AS call_id, record_json AS data FROM physical WHERE session_id=?
  ), measured AS MATERIALIZED (
    SELECT run_id, call_id,
      CASE WHEN json_type(data,'$.usage.reportedFields') IS NULL OR EXISTS
        (SELECT 1 FROM json_each(data,'$.usage.reportedFields') WHERE value='prompt')
        THEN json_extract(data,'$.usage.promptTokens') END AS input_tokens,
      CASE WHEN json_type(data,'$.usage.reportedFields') IS NULL OR EXISTS
        (SELECT 1 FROM json_each(data,'$.usage.reportedFields') WHERE value='completion')
        THEN json_extract(data,'$.usage.completionTokens') END AS output_tokens,
      CASE WHEN json_type(data,'$.usage.reportedFields') IS NULL OR EXISTS
        (SELECT 1 FROM json_each(data,'$.usage.reportedFields') WHERE value='cacheRead')
        THEN json_extract(data,'$.usage.cacheReadTokens') END AS cached_tokens,
      CASE WHEN json_type(data,'$.usage.reportedFields') IS NULL OR EXISTS
        (SELECT 1 FROM json_each(data,'$.usage.reportedFields') WHERE value='reasoning')
        THEN json_extract(data,'$.usage.reasoningTokens') END AS reasoning_tokens,
      CASE WHEN json_extract(data,'$.costStatus') IN ('estimated','included')
        THEN json_extract(data,'$.costCNY') END AS cost
    FROM measurements
  ), call_metrics AS (
    SELECT run_id, call_id, min(input_tokens IS NOT NULL AND output_tokens IS NOT NULL) AS metered,
      min(cost IS NOT NULL) AS priced FROM measured GROUP BY run_id,call_id
  ), tools AS (
    SELECT run_id, tool_id,
      min(CASE WHEN kind='tool.started' THEN at END) AS started,
      max(CASE WHEN kind='tool.result.recorded' THEN at END) AS ended
    FROM events WHERE kind IN ('tool.started','tool.result.recorded') GROUP BY run_id,tool_id
  ) SELECT
    (SELECT count(*) FROM calls) AS calls,
    (SELECT count(*) FROM calls WHERE json_type(settled,'$.attempts')='array') AS physical_calls,
    (SELECT count(*) FROM calls WHERE json_type(settled,'$.attempts')='array' AND json_extract(settled,'$.attemptCoverage')='complete') AS complete_physical_calls,
    (SELECT count(*) FROM calls WHERE json_extract(settled,'$.status')='failed') AS failed,
    (SELECT sum(CASE WHEN coalesce(json_extract(c.settled,'$.attemptCoverage'),'complete')='complete' THEN coalesce(m.metered,0) ELSE 0 END) FROM calls c LEFT JOIN call_metrics m USING(run_id,call_id)) AS metered,
    (SELECT sum(CASE WHEN json_extract(c.settled,'$.attemptCoverage')='partial' THEN 1 ELSE 1-coalesce(m.priced,0) END) FROM calls c LEFT JOIN call_metrics m USING(run_id,call_id)) AS unpriced,
    sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
    sum(cached_tokens) AS cached_tokens, sum(reasoning_tokens) AS reasoning_tokens, sum(cost) AS cost,
    count(cached_tokens) AS cache_known, count(*) AS measurement_count,
    sum(CASE WHEN cached_tokens IS NOT NULL AND input_tokens IS NOT NULL AND cached_tokens<=input_tokens THEN 1 ELSE 0 END) AS cache_comparable,
    (SELECT count(*) FROM calls WHERE json_extract(settled,'$.attemptCoverage')='partial') AS partial_calls,
    (SELECT sum(json_extract(settled,'$.latencyMs')) FROM calls) AS latency,
    (SELECT sum(json_array_length(settled,'$.attempts')) FROM calls) AS physical_attempts,
    (SELECT sum(CASE WHEN retry_attempt IS NOT NULL OR json_type(settled,'$.attempts')='array'
      THEN max(0,coalesce(json_array_length(settled,'$.attempts'),0)-1)
      + CASE WHEN retry_attempt>0 THEN 1 ELSE 0 END END) FROM calls) AS retries,
    (SELECT count(*) FROM tools) AS tool_calls,
    (SELECT sum(CASE WHEN started IS NOT NULL AND ended IS NOT NULL
      THEN max(0,round((julianday(ended)-julianday(started))*86400000)) END) FROM tools) AS tool_duration
    FROM measured`,
    )
    .get(sessionId, watermark, sessionId, sessionId)!;
  if (coverage)
    coverage.value = !Number(row.physical_calls)
      ? "missing"
      : Number(row.complete_physical_calls) === Number(row.calls)
        ? "physical"
        : "partial";
  const optional = (key: string, value: unknown) =>
    value === null ? {} : { [key]: Number(value) };
  return {
    scope: "session",
    modelCalls: Number(row.calls),
    failedCalls: Number(row.failed),
    meteredCalls: Number(row.metered ?? 0),
    unpricedCalls: Number(row.unpriced ?? 0),
    ...optional("inputTokens", row.input_tokens),
    ...optional("outputTokens", row.output_tokens),
    ...optional("costCNY", row.cost),
    ...optional("latencyMs", row.latency),
    ...optional("cachedInputTokens", row.cached_tokens),
    ...optional("reasoningTokens", row.reasoning_tokens),
    ...optional("physicalAttempts", row.physical_attempts),
    ...optional("retries", row.retries),
    toolCalls: Number(row.tool_calls),
    ...optional("toolDurationMs", row.tool_duration),
    cacheCoverage:
      Number(row.cache_known) === 0
        ? "missing"
        : Number(row.cache_comparable) === Number(row.measurement_count) &&
            Number(row.partial_calls) === 0
          ? "complete"
          : "partial",
  };
}

function usageMetrics(
  usage?: Usage,
): Pick<
  RuntimeExecutionAttempt,
  "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens"
> {
  if (!usage) return {};
  const has = (field: NonNullable<Usage["reportedFields"]>[number]) =>
    usage.reportedFields === undefined || usage.reportedFields.includes(field);
  return {
    ...(has("prompt") ? { inputTokens: usage.promptTokens } : {}),
    ...(has("completion") ? { outputTokens: usage.completionTokens } : {}),
    ...(has("cacheRead") && usage.cacheReadTokens !== undefined
      ? { cachedInputTokens: usage.cacheReadTokens }
      : {}),
    ...(has("reasoning") && usage.reasoningTokens !== undefined
      ? { reasoningTokens: usage.reasoningTokens }
      : {}),
  };
}

function attemptMetrics(
  attempts: RuntimeExecutionAttempt[],
  retryAttempt = 0,
  coverage = "complete",
): Partial<RuntimeExecutionStep> {
  const totals: Partial<
    Record<
      "inputTokens" | "outputTokens" | "cachedInputTokens" | "reasoningTokens" | "costCNY",
      number
    >
  > = {};
  for (const attempt of attempts)
    for (const key of [
      "inputTokens",
      "outputTokens",
      "cachedInputTokens",
      "reasoningTokens",
      "costCNY",
    ] as const) {
      if (attempt[key] !== undefined) totals[key] = (totals[key] ?? 0) + attempt[key];
    }
  const firstToken = attempts.find((a) => a.timeToFirstTokenMs !== undefined);
  const unknownReasons = [
    ...new Set(
      attempts.flatMap((attempt) =>
        attempt.costStatus === "unknown" && attempt.costUnknownReason
          ? [attempt.costUnknownReason]
          : [],
      ),
    ),
  ];
  return {
    ...totals,
    attempts,
    ...(unknownReasons.length ? { costUnknownReason: unknownReasons.join("；") } : {}),
    retries: retryAttempt + Math.max(0, attempts.length - 1),
    ...(firstToken
      ? {
          firstTokenLatencyMs:
            elapsed(attempts[0]!.startedAt, firstToken.startedAt) + firstToken.timeToFirstTokenMs!,
        }
      : {}),
    costStatus:
      attempts.length === 0 ||
      coverage === "partial" ||
      attempts.some((a) => a.costCNY === undefined)
        ? "unknown"
        : attempts.every((a) => a.costStatus === "included")
          ? "included"
          : "estimated",
  };
}

function projectRun(
  events: RuntimeEvent[],
  opening: RuntimeEvent,
  physical: PhysicalAttemptRecord[],
): RuntimeExecutionRun {
  const steps: RuntimeExecutionStep[] = [];
  const models = new Map<string, number>(),
    tools = new Map<string, number>(),
    permissions = new Map<string, number>();
  const add = (
    event: RuntimeEvent,
    kind: RuntimeExecutionStep["kind"],
    title: string,
    status: RuntimeExecutionStep["status"] = "running",
  ) => {
    steps.push({
      id: event.eventId,
      eventId: event.eventId,
      turnId: event.turnId,
      kind,
      title: preview(title),
      at: event.at,
      status,
    });
    return steps.length - 1;
  };
  const update = (index: number, fields: Partial<RuntimeExecutionStep>) => {
    steps[index] = { ...steps[index]!, ...fields };
  };
  for (const record of physical) {
    if (models.has(record.providerCallId)) continue;
    models.set(record.providerCallId, steps.length);
    steps.push({
      id: record.physicalAttemptId,
      eventId: record.physicalAttemptId,
      turnId: record.turnId ?? opening.turnId,
      kind: "model",
      title: preview(`${record.provider} / ${record.model}`),
      at: record.startedAt,
      status: "running",
      purpose: record.purpose,
      providerId: preview(record.provider),
      modelId: preview(record.model),
    });
  }
  for (const event of events) {
    switch (event.kind) {
      case "model.call.started": {
        const i = models.get(event.data.providerCallId);
        if (i === undefined) break;
        update(i, {
          purpose: preview(event.data.purpose),
          ...(event.data.provider ? { providerId: preview(event.data.provider) } : {}),
          ...(event.data.model ? { modelId: preview(event.data.model) } : {}),
          ...(event.data.retryAttempt !== undefined ? { retries: event.data.retryAttempt } : {}),
        });
        break;
      }
      case "model.call.settled": {
        const i = models.get(event.data.providerCallId);
        if (i === undefined) break;
        update(i, {
          status: event.data.status === "succeeded" ? "completed" : event.data.status,
          ...(event.data.error ? { error: preview(event.data.error) } : {}),
        });
        break;
      }
      case "message.committed": {
        const m = event.data.message;
        // Message order does not prove which model request produced it (auxiliary calls
        // can interleave). Show response content only with an explicit durable link.
        const modelIndex = event.refs?.providerCallId
          ? models.get(event.refs.providerCallId)
          : undefined;
        if (m.role === "assistant" && modelIndex !== undefined) {
          const text = [m.reasoning ? `思考：${m.reasoning}` : "", m.content]
            .filter(Boolean)
            .join("\n\n");
          update(modelIndex, {
            output: preview(text),
            truncated: !!steps[modelIndex]!.truncated || text.length > 800,
          });
        }
        break;
      }
      case "tool.started": {
        const i = add(event, "tool", event.data.toolName);
        tools.set(event.refs?.toolCallId ?? event.eventId, i);
        update(i, {
          input: preview(event.data.argumentsJson),
          truncated: event.data.argumentsJson.length > 800 || event.data.argumentsRedacted,
          detail: event.data.recoveryMode,
        });
        break;
      }
      case "tool.result.recorded": {
        const i = tools.get(event.refs.toolCallId) ?? add(event, "tool", event.data.toolName);
        const output =
          event.data.body.storage === "inline"
            ? event.data.body.content
            : event.data.projection.text;
        update(i, {
          status:
            event.data.status === "succeeded"
              ? "completed"
              : event.data.status === "rejected"
                ? "failed"
                : event.data.status,
          durationMs: elapsed(steps[i]!.at, event.at),
          output: preview(output),
          truncated:
            !!steps[i]!.truncated ||
            output.length > 800 ||
            event.data.body.storage === "evidence" ||
            event.data.projection.truncated,
        });
        break;
      }
      case "approval.requested":
        permissions.set(event.data.approvalId, add(event, "permission", event.data.toolName));
        break;
      case "approval.settled": {
        const i = permissions.get(event.data.approvalId) ?? add(event, "permission", "权限确认");
        update(i, {
          status: event.data.decision === "approved" ? "completed" : "failed",
          detail: event.data.decision,
          permissionDecision: event.data.decision,
        });
        break;
      }
      case "context.checkpoint.recorded": {
        const i = add(event, "compaction", "上下文压缩", "completed");
        update(i, {
          output: preview(event.data.summary.content),
          truncated: event.data.summary.content.length > 800,
        });
        break;
      }
      case "run.terminal":
        if (event.data.status === "failed") {
          const i = add(event, "error", "执行失败", "failed");
          if (event.data.reason) update(i, { error: preview(event.data.reason) });
        }
        break;
    }
  }
  for (const [callId, index] of models) {
    const records = physical.filter((record) => record.providerCallId === callId);
    if (records.length === 0) continue;
    const attempts: RuntimeExecutionAttempt[] = records.map((record) => ({
      attemptId: record.physicalAttemptId,
      attempt: record.attempt,
      provider: preview(record.provider),
      model: preview(record.model),
      startedAt: record.startedAt,
      status: record.status,
      usageBasis: record.usageBasis,
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      ...(record.latencyMs !== undefined ? { latencyMs: record.latencyMs } : {}),
      ...(record.timeToFirstTokenMs !== undefined
        ? { timeToFirstTokenMs: record.timeToFirstTokenMs }
        : {}),
      ...(record.httpStatus !== undefined ? { httpStatus: record.httpStatus } : {}),
      ...(record.finishReason !== undefined ? { finishReason: preview(record.finishReason) } : {}),
      ...(record.error !== undefined ? { error: preview(record.error) } : {}),
      ...usageMetrics(record.usage),
      costStatus: record.costStatus,
      ...(record.costStatus === "unknown" && record.costUnknownReason
        ? { costUnknownReason: preview(record.costUnknownReason) }
        : {}),
      ...(record.costStatus !== "unknown" && record.costCNY !== undefined
        ? { costCNY: record.costCNY }
        : {}),
    }));
    const step = steps[index]!;
    const last = records.at(-1)!;
    steps[index] = {
      ...step,
      ...(records.some((r) => r.latencyMs !== undefined)
        ? { durationMs: records.reduce((n, r) => n + (r.latencyMs ?? 0), 0) }
        : {}),
      ...attemptMetrics(
        attempts,
        last.retryAttempt,
        records.some((r) => r.attemptCoverage === "partial") ? "partial" : "complete",
      ),
      ...(step.status === "running" && last.status !== "prepared" && last.status !== "observed"
        ? { status: last.status === "succeeded" ? "completed" : last.status }
        : {}),
    };
  }
  const terminal = events.find((e) => e.kind === "run.terminal");
  return {
    runId: opening.runId,
    invocationId: opening.invocationId,
    at: opening.at,
    status: terminal?.kind === "run.terminal" ? terminal.data.status : "running",
    ...(terminal ? { durationMs: elapsed(opening.at, terminal.at) } : {}),
    ...(terminal?.kind === "run.terminal" && terminal.data.reason
      ? { reason: preview(terminal.data.reason) }
      : {}),
    ...(opening.refs?.parentRunId ? { parentRunId: opening.refs.parentRunId } : {}),
    steps: steps.sort((a, b) => Date.parse(a.at) - Date.parse(b.at)),
  };
}
function preview(value: string): string {
  return value.length > 800 ? `${value.slice(0, 800)}…` : value;
}
function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}

function physicalRowsSql(): string {
  return "SELECT provider_call_id, session_id, run_id, json_remove(record_json,'$.requestDiagnostic') AS record_json FROM usage_physical_attempts WHERE json_extract(record_json,'$.accountingSource')='physical'";
}
function readRunPhysicalAttempts(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): PhysicalAttemptRecord[] {
  const rows = db
    .prepare(
      `SELECT record_json FROM (${physicalRowsSql()}) WHERE session_id=? AND run_id=? ORDER BY json_extract(record_json,'$.startedAt'), json_extract(record_json,'$.attempt') LIMIT 129`,
    )
    .all(sessionId, runId);
  // The outer page budget rejects an overlarge projection instead of silently dropping attempts.
  return rows.map((row) => JSON.parse(String(row.record_json)) as PhysicalAttemptRecord);
}

function accountingVersion(db: DatabaseSync, sessionId: string): number {
  return Number(
    db.prepare("SELECT revision FROM usage_accounting_versions WHERE session_id=?").get(sessionId)
      ?.revision ?? 0,
  );
}
