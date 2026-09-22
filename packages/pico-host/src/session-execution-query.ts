import { DatabaseSync } from "node:sqlite";
import { operationalDatabasePath } from "@pico/storage";
import { decodeRuntimeEventJson, type RuntimeEvent } from "@pico/storage/runtime-event";
import { RuntimeProtocolError } from "@pico/protocol";
import type {
  RuntimeExecutionPage,
  RuntimeExecutionRun,
  RuntimeExecutionStep,
  RuntimeExecutionSummary,
} from "@pico/protocol";

const MAX_BYTES = 48 * 1024;
type Cursor = { sessionId: string; watermark: number; before: number; anchor: string };
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
    };
    if (input.cursor !== undefined) {
      try {
        if (input.cursor.length > 4096 || !/^[A-Za-z0-9_-]+$/.test(input.cursor)) throw new Error();
        const parsed = JSON.parse(
          Buffer.from(input.cursor, "base64url").toString("utf8"),
        ) as Cursor;
        if (
          Object.keys(parsed).sort().join() !== "anchor,before,sessionId,watermark" ||
          parsed.sessionId !== input.sessionId ||
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
    const page: RuntimeExecutionPage = {
      schemaVersion: 1,
      sessionId: input.sessionId,
      runs,
      summary: summary(db, input.sessionId, cursor.watermark),
      coverage: {
        oversizedRunIds,
        missingModelCallRunIds,
        incompleteRunIds,
        modelAttempts: "logical_only",
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
      if (Number(size.count) > 4096 || Number(size.bytes) > 512 * 1024) {
        oversizedRunIds.push(opening.run_id);
        consumed++;
        continue;
      }
      // The evidence budget is shared by the entire request, not multiplied by page size.
      if (
        evidenceEvents + Number(size.count) > 4096 ||
        evidenceBytes + Number(size.bytes) > 512 * 1024
      )
        break;
      evidenceEvents += Number(size.count);
      evidenceBytes += Number(size.bytes);
      const rows = db
        .prepare(
          "SELECT payload_json FROM runtime_events WHERE session_id = ? AND run_id = ? AND event_seq <= ? ORDER BY event_seq",
        )
        .all(input.sessionId, opening.run_id, cursor.watermark);
      const events = rows.map((row) => decodeRuntimeEventJson(String(row.payload_json)));
      const run = projectRun(events, decodeRuntimeEventJson(opening.payload_json));
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
      const starts = new Set(
        events.filter((e) => e.kind === "model.call.started").map((e) => e.data.providerCallId),
      );
      const ends = new Set(
        events.filter((e) => e.kind === "model.call.settled").map((e) => e.data.providerCallId),
      );
      if (
        [...starts].some((id) => !ends.has(id)) ||
        [...ends].some((id) => !starts.has(id)) ||
        (starts.size === 0 &&
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

function summary(db: DatabaseSync, sessionId: string, watermark: number): RuntimeExecutionSummary {
  // One pair per logical call, scoped to its run. Missing values remain NULL.
  const row = db
    .prepare(
      `WITH calls AS (
    SELECT run_id, json_extract(payload_json, '$.data.providerCallId') AS call_id,
      max(CASE WHEN kind = 'model.call.settled' THEN json_extract(payload_json, '$.data.status') END) AS status,
      max(CASE WHEN kind = 'model.call.settled' THEN json_extract(payload_json, '$.data.usage.promptTokens') END) AS input_tokens,
      max(CASE WHEN kind = 'model.call.settled' THEN json_extract(payload_json, '$.data.usage.completionTokens') END) AS output_tokens,
      max(CASE WHEN kind = 'model.call.settled' AND json_extract(payload_json, '$.data.costStatus') IN ('estimated','included') THEN json_extract(payload_json, '$.data.costCNY') END) AS cost,
      max(CASE WHEN kind = 'model.call.settled' THEN json_extract(payload_json, '$.data.latencyMs') END) AS latency
    FROM runtime_events WHERE session_id = ? AND event_seq <= ? AND kind IN ('model.call.started','model.call.settled') GROUP BY run_id, call_id)
    SELECT count(*) AS calls, sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
      count(input_tokens) AS metered, count(*) - count(cost) AS unpriced,
      sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens, sum(cost) AS cost, sum(latency) AS latency FROM calls`,
    )
    .get(sessionId, watermark)!;
  return {
    scope: "session",
    modelCalls: Number(row.calls),
    failedCalls: Number(row.failed ?? 0),
    meteredCalls: Number(row.metered),
    unpricedCalls: Number(row.unpriced),
    ...(row.input_tokens !== null ? { inputTokens: Number(row.input_tokens) } : {}),
    ...(row.output_tokens !== null ? { outputTokens: Number(row.output_tokens) } : {}),
    ...(row.cost !== null ? { costCNY: Number(row.cost) } : {}),
    ...(row.latency !== null ? { latencyMs: Number(row.latency) } : {}),
  };
}

function projectRun(events: RuntimeEvent[], opening: RuntimeEvent): RuntimeExecutionRun {
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
  for (const event of events) {
    switch (event.kind) {
      case "model.call.started": {
        const i = add(
          event,
          "model",
          [event.data.provider, event.data.model].filter(Boolean).join(" / ") || "模型调用",
        );
        models.set(event.data.providerCallId, i);
        update(i, { purpose: event.data.purpose });
        break;
      }
      case "model.call.settled": {
        const i = models.get(event.data.providerCallId) ?? add(event, "model", "模型调用");
        update(i, {
          status: event.data.status === "succeeded" ? "completed" : event.data.status,
          durationMs: event.data.latencyMs,
          ...(event.data.usage
            ? {
                inputTokens: event.data.usage.promptTokens,
                outputTokens: event.data.usage.completionTokens,
              }
            : {}),
          ...(event.data.costCNY !== undefined &&
          (event.data.costStatus === "estimated" || event.data.costStatus === "included")
            ? { costCNY: event.data.costCNY }
            : {}),
          costStatus: event.data.costStatus ?? "unknown",
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
    steps,
  };
}
function preview(value: string): string {
  return value.length > 800 ? `${value.slice(0, 800)}…` : value;
}
function elapsed(start: string, end: string): number {
  return Math.max(0, Date.parse(end) - Date.parse(start));
}
