import { type MemoryRecallTrace, type Usage } from "@pico/core";
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
  options?: { memoryDatabasePath: string; workspaceKey: string },
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
      const goalRows = db
        .prepare(
          `SELECT payload_json FROM runtime_events WHERE session_id=? AND kind='session.state.committed' AND event_seq<=? AND json_extract(payload_json,'$.data.patch.goal.currentGoal.lastEvaluation.evidenceTrace.sourceRunId')=? AND event_seq IN (SELECT max(event_seq) FROM runtime_events WHERE session_id=? AND kind='session.state.committed' AND event_seq<=? GROUP BY json_extract(payload_json,'$.data.patch.goal.currentGoal.lastEvaluation.evidenceTrace.traceId')) ORDER BY event_seq LIMIT 32`,
        )
        .all(input.sessionId, cursor.watermark, opening.run_id, input.sessionId, cursor.watermark);
      const goalBytes = goalRows.reduce(
        (n, row) => n + Buffer.byteLength(String(row.payload_json)),
        0,
      );
      const totalCount = Number(size.count) + Number(physicalSize.count) + goalRows.length;
      const totalBytes = Number(size.bytes) + Number(physicalSize.bytes) + goalBytes;
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
      const events = [...rows, ...goalRows].map((row) =>
        decodeRuntimeEventJson(String(row.payload_json)),
      );
      const physical = readRunPhysicalAttempts(db, input.sessionId, opening.run_id);
      if (physical.length > 128) {
        oversizedRunIds.push(opening.run_id);
        consumed++;
        continue;
      }
      let run = projectRun(events, decodeRuntimeEventJson(opening.payload_json), physical);
      run = {
        ...run,
        steps: run.steps.map((step) =>
          step.memory ? { ...step, memory: resolveRecallState(step.memory, db, options) } : step,
        ),
      };
      run = trimRunDetails(run, MAX_BYTES - Buffer.byteLength(JSON.stringify(page)) - 4096);
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
      `WITH physical AS MATERIALIZED (
    SELECT provider_call_id, run_id, json_set(json_remove(record_json,'$.requestDiagnostic'),'$.requestDiagnostic',json_object('memoryRecall',json_extract(record_json,'$.requestDiagnostic.memoryRecall'))) AS record_json,
      CASE WHEN json_extract(record_json,'$.status') IN ('prepared','observed')
        THEN 'pending' ELSE json_extract(record_json,'$.usageBasis') END AS usage_state
    FROM usage_physical_attempts
    WHERE session_id = ? AND json_extract(record_json,'$.accountingSource')='physical'
  ), events AS (
    SELECT run_id, kind, json_extract(payload_json, '$.data') AS data,
      coalesce(json_extract(payload_json, '$.refs.toolCallId'), event_id) AS tool_id,
      json_extract(payload_json, '$.at') AS at
    FROM runtime_events WHERE session_id = ? AND event_seq <= ? AND json_valid(payload_json)
      AND kind IN ('tool.started','tool.result.recorded','model.call.started','model.call.settled')
  ), runtime_calls AS (
    SELECT DISTINCT run_id, json_extract(data,'$.providerCallId') AS call_id FROM events
    WHERE kind IN ('model.call.started','model.call.settled')
      AND json_type(data,'$.providerCallId')='text'
      AND length(trim(json_extract(data,'$.providerCallId')))>0
  ), calls AS MATERIALIZED (
    SELECT coalesce(run_id,'') AS run_id, provider_call_id AS call_id,
      max(json_extract(record_json,'$.retryAttempt')) AS retry_attempt,
      count(*) AS attempt_count,
      CASE WHEN min(coalesce(json_extract(record_json,'$.attemptCoverage'),'complete') != 'partial') THEN 'complete' ELSE 'partial' END AS attempt_coverage,
      CASE WHEN max(json_extract(record_json,'$.status')='succeeded') THEN 'succeeded' WHEN max(json_extract(record_json,'$.status')='cancelled') THEN 'cancelled' WHEN max(json_extract(record_json,'$.status') IN ('prepared','observed')) THEN 'running' ELSE 'failed' END AS status,
      sum(json_extract(record_json,'$.latencyMs')) AS latency_ms
    FROM physical GROUP BY run_id,provider_call_id
  ), measurements AS (
    SELECT coalesce(run_id,'') AS run_id, provider_call_id AS call_id, record_json AS data FROM physical
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
    (SELECT count(*) FROM calls) AS physical_calls,
    (SELECT count(*) FROM calls WHERE attempt_coverage='complete') AS complete_physical_calls,
    (SELECT count(*) FROM calls WHERE status='failed') AS failed,
    (SELECT sum(CASE WHEN c.attempt_coverage='complete' THEN coalesce(m.metered,0) ELSE 0 END) FROM calls c LEFT JOIN call_metrics m USING(run_id,call_id)) AS metered,
    (SELECT sum(CASE WHEN c.attempt_coverage='partial' THEN 1 ELSE 1-coalesce(m.priced,0) END) FROM calls c LEFT JOIN call_metrics m USING(run_id,call_id)) AS unpriced,
    sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
    sum(cached_tokens) AS cached_tokens, sum(reasoning_tokens) AS reasoning_tokens, sum(cost) AS cost,
    count(cached_tokens) AS cache_known, count(*) AS measurement_count,
    sum(CASE WHEN cached_tokens IS NOT NULL AND input_tokens IS NOT NULL AND cached_tokens<=input_tokens THEN 1 ELSE 0 END) AS cache_comparable,
    (SELECT count(*) FROM calls WHERE attempt_coverage='partial') AS partial_calls,
    (SELECT count(*) FROM physical WHERE usage_state='reported') AS reported_attempts,
    (SELECT count(*) FROM physical WHERE usage_state='partial') AS partial_attempts,
    (SELECT count(*) FROM physical WHERE usage_state='missing') AS missing_attempts,
    (SELECT count(*) FROM physical WHERE usage_state='pending') AS pending_attempts,
    (SELECT count(*) FROM runtime_calls r WHERE NOT EXISTS (
      SELECT 1 FROM physical p WHERE p.provider_call_id=r.call_id
        AND (p.run_id=r.run_id OR p.run_id IS NULL OR r.run_id IS NULL)
    )) AS runtime_only_calls,
    (SELECT sum(latency_ms) FROM calls) AS latency,
    (SELECT sum(attempt_count) FROM calls) AS physical_attempts,
    (SELECT sum(CASE WHEN retry_attempt IS NOT NULL OR attempt_count > 0
      THEN max(0,attempt_count-1)
      + CASE WHEN retry_attempt>0 THEN 1 ELSE 0 END END) FROM calls) AS retries,
    (SELECT count(*) FROM tools) AS tool_calls,
    (SELECT sum(CASE WHEN started IS NOT NULL AND ended IS NOT NULL
      THEN max(0,round((julianday(ended)-julianday(started))*86400000)) END) FROM tools) AS tool_duration
    FROM measured`,
    )
    .get(sessionId, sessionId, watermark)!;
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
    provenance: {
      source: "physical_attempts",
      reportedAttempts: Number(row.reported_attempts),
      partialAttempts: Number(row.partial_attempts),
      missingAttempts: Number(row.missing_attempts),
      pendingAttempts: Number(row.pending_attempts),
      partialCoverageCalls: Number(row.partial_calls),
      runtimeOnlyCalls: Number(row.runtime_only_calls),
    },
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
          ...(event.data.error ? { error: errorPreview(event.data.error) } : {}),
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
          ...(event.data.executionFacts ? { executionFacts: event.data.executionFacts } : {}),
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
      case "memory.recall.recorded": {
        const i = add(
          event,
          "memory",
          event.data.mode === "automatic" ? "自动记忆召回" : "主动记忆搜索",
          "completed",
        );
        const requests = physical.flatMap((record) => {
          const recalls = record.contextFacts?.memoryRecall?.recalls ?? [];
          if (!recalls.some((r) => r.recallEventId === event.eventId)) return [];
          const raw = record.requestDiagnostic as
            | {
                memoryRecall?: {
                  recalls?: {
                    recallEventId: string;
                    blockPresent?: boolean;
                    references: { present: boolean }[];
                  }[];
                };
              }
            | undefined;
          const assembly = raw?.memoryRecall?.recalls?.find(
            (r) => r.recallEventId === event.eventId,
          );
          const observed =
            record.httpStatus !== undefined ||
            record.status === "succeeded" ||
            record.status === "observed";
          return [
            {
              attemptId: record.physicalAttemptId,
              providerCallId: record.providerCallId,
              evidenceLevel: assembly
                ? observed
                  ? ("response_observed" as const)
                  : ("prepared" as const)
                : ("assembly_unrecorded" as const),
              ...(assembly?.blockPresent !== undefined
                ? { blockPresent: assembly.blockPresent }
                : {}),
              referenceCount: event.data.selected.length,
              referencePresentCount: assembly?.references.filter((r) => r.present).length ?? 0,
            },
          ];
        });
        update(i, {
          detail: event.data.outcome,
          memory: {
            trace: event.data,
            items: event.data.selected.map((item) => ({
              itemId: item.itemId,
              state: "unknown" as const,
              linkAvailable: false,
            })),
            sources: [],
            requests,
          },
        });
        break;
      }
      case "session.state.committed": {
        const goal = event.data.patch.goal?.currentGoal;
        const evaluation = goal?.lastEvaluation;
        const trace = evaluation?.evidenceTrace;
        if (
          !goal ||
          !evaluation ||
          !trace ||
          trace.sourceRunId !== opening.runId ||
          steps.some((s) => s.id === trace.traceId)
        )
          break;
        const i = add(
          event,
          "goal_evaluation",
          "Goal 证据验收",
          evaluation.evaluatorFailed ? "failed" : "completed",
        );
        update(i, {
          id: trace.traceId,
          turnId: trace.identity.turnId,
          goalEvaluation: {
            goalId: goal.id,
            settlement: "settled",
            condition: goal.condition,
            reason: evaluation.reason,
            ...(evaluation.met !== undefined ? { met: evaluation.met } : {}),
            ...(evaluation.evaluatorFailed !== undefined
              ? { evaluatorFailed: evaluation.evaluatorFailed }
              : {}),
            evidenceTrace: trace,
          },
        });
        break;
      }
      case "context.checkpoint.recorded": {
        const i = add(event, "compaction", "上下文压缩", "completed");
        update(i, {
          output: preview(event.data.summary.content),
          compaction: {
            format: String(event.data.summary.providerData?.["picoSummaryFormat"] ?? "未记录"),
            taskAnchor: event.data.summary.content.includes("当前用户任务（原文）："),
            evidenceStatus:
              event.data.summary.providerData?.["picoSummaryFormat"] === "sections_v2"
                ? event.data.summary.providerData?.["picoHandoffEvidence"]
                  ? "verified"
                  : "unavailable"
                : "unknown",
            evidenceIds: handoffEvidenceIds(
              event.data.summary.providerData?.["picoHandoffEvidence"],
            ),
          },
          truncated: event.data.summary.content.length > 800,
        });
        break;
      }
      case "run.terminal":
        if (event.data.status === "failed") {
          const i = add(event, "error", "执行失败", "failed");
          if (event.data.reason) update(i, { error: errorPreview(event.data.reason) });
        }
        break;
    }
  }
  const unsettledGoalCalls = new Map<string, PhysicalAttemptRecord>();
  for (const record of physical) {
    if (record.purpose !== "goal_evaluation" || !record.goalId) continue;
    const current = unsettledGoalCalls.get(record.providerCallId);
    if (
      !current ||
      record.attempt > current.attempt ||
      (record.attempt === current.attempt && record.startedAt > current.startedAt)
    )
      unsettledGoalCalls.set(record.providerCallId, record);
  }
  for (const record of unsettledGoalCalls.values()) {
    if (steps.some((s) => s.goalEvaluation?.goalId === record.goalId)) continue;
    steps.push({
      id: `goal-evaluation:${record.providerCallId}`,
      eventId: record.physicalAttemptId,
      turnId: record.turnId ?? opening.turnId,
      kind: "goal_evaluation",
      title: "Goal 验收未结算",
      at: record.startedAt,
      status:
        record.status === "cancelled"
          ? "cancelled"
          : record.status === "failed"
            ? "failed"
            : record.status === "interrupted"
              ? "interrupted"
              : record.status === "prepared" || record.status === "observed"
                ? "running"
                : "completed",
      goalEvaluation: {
        goalId: record.goalId!,
        settlement: "unsettled",
        condition: "目标条件未记录",
        reason:
          record.status === "cancelled"
            ? "验收请求已取消，未保存结算结果"
            : "未记录目标结算结果；物理响应不等于 Goal 达成",
      },
    });
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
      ...(record.error !== undefined ? { error: errorPreview(record.error) } : {}),
      ...(record.errorClass !== undefined ? { errorClass: record.errorClass } : {}),
      ...(record.errorCategory !== undefined ? { errorCategory: record.errorCategory } : {}),
      ...(record.transportCode !== undefined ? { transportCode: record.transportCode } : {}),
      ...(record.retryable !== undefined ? { retryable: record.retryable } : {}),
      ...(record.diagnosticId !== undefined ? { diagnosticId: record.diagnosticId } : {}),
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
      ? { reason: errorPreview(terminal.data.reason) }
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
  return "SELECT provider_call_id, session_id, run_id, json_set(json_remove(record_json,'$.requestDiagnostic'),'$.requestDiagnostic',json_object('memoryRecall',json_extract(record_json,'$.requestDiagnostic.memoryRecall'))) AS record_json FROM usage_physical_attempts WHERE json_extract(record_json,'$.accountingSource')='physical'";
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

/** Provider summaries are already bounded; clipping their JSON envelope loses the entire detail. */
function errorPreview(value: string): string {
  if (
    value.length <= 20_000 &&
    /^(?:ModelCommunicationError category=[a-z_]+ diagnosticId=[A-Za-z0-9_-]+|LLMStatusError status=[1-5]\d\d); detail omitted\nProvider detail: /.test(
      value,
    )
  )
    return value;
  return preview(value);
}

function handoffEvidenceIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const references = (value as { references?: unknown }).references;
  return Array.isArray(references)
    ? references
        .flatMap((r) =>
          r && typeof r === "object" && typeof r.eventId === "string" ? [r.eventId] : [],
        )
        .slice(0, 64)
    : [];
}
function resolveRecallState(
  memory: NonNullable<RuntimeExecutionStep["memory"]>,
  db: DatabaseSync,
  options?: { memoryDatabasePath: string; workspaceKey: string },
): NonNullable<RuntimeExecutionStep["memory"]> {
  let memoryDb: DatabaseSync | undefined;
  try {
    if (options) memoryDb = new DatabaseSync(options.memoryDatabasePath, { readOnly: true });
    const items = memory.trace.selected.map((item) => {
      let state: NonNullable<RuntimeExecutionStep["memory"]>["items"][number]["state"] = "unknown",
        linkAvailable = false;
      if (memoryDb && options) {
        const row = memoryDb
          .prepare(
            "SELECT version,content_hash,lifecycle_state,scope_type,scope_key FROM memory_items WHERE item_id=?",
          )
          .get(item.itemId);
        if (!row) state = "deleted";
        else if (row.scope_type === "global" || row.scope_key === options.workspaceKey) {
          state =
            row.lifecycle_state === "archived"
              ? "archived"
              : row.version !== item.itemVersion || row.content_hash !== item.contentHash
                ? "changed"
                : "unchanged";
          linkAvailable = true;
        }
      }
      return { itemId: item.itemId, state, linkAvailable };
    });
    const sources = memory.trace.selected.flatMap((item) =>
      item.sources.map((source) => ({
        eventId: source.eventId,
        sessionId: source.sessionId,
        available: !!db
          .prepare(
            "SELECT 1 FROM runtime_events WHERE session_id=? AND event_id=? AND run_id=? AND json_extract(payload_json,'$.turnId')=?",
          )
          .get(source.sessionId, source.eventId, source.runId, source.turnId),
      })),
    );
    return { ...memory, items, sources };
  } catch {
    return memory;
  } finally {
    memoryDb?.close();
  }
}
function trimRunDetails(run: RuntimeExecutionRun, budget: number): RuntimeExecutionRun {
  if (Buffer.byteLength(JSON.stringify(run)) <= budget) return run;
  const steps = run.steps.map((step) => {
    if (!step.memory) return step;
    const original = step.memory.trace;
    const trace: MemoryRecallTrace = {
      ...original,
      selected: original.selected.map((i) => ({ ...i, sources: [] })),
      diagnostics: [],
      omittedDiagnosticCount: original.omittedDiagnosticCount + original.diagnostics.length,
      omittedSourceCount:
        original.omittedSourceCount + original.selected.reduce((n, i) => n + i.sources.length, 0),
      traceTruncated: true,
    };
    return {
      ...step,
      truncated: true,
      memory: { ...step.memory, trace, sources: [], requests: step.memory.requests.slice(0, 8) },
    };
  });
  if (Buffer.byteLength(JSON.stringify({ ...run, steps })) <= budget) return { ...run, steps };
  return {
    ...run,
    steps: steps.map((step) => ({
      ...step,
      ...(step.output ? { output: step.output.slice(0, 200), truncated: true } : {}),
      ...(step.input ? { input: step.input.slice(0, 200), truncated: true } : {}),
    })),
  };
}
