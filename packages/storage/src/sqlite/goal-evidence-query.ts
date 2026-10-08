import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { createHash } from "node:crypto";
import { isForegroundProcessFacts, type RuntimeToolResultStatus } from "@pico/core";
import type {
  GoalEvidenceMessage,
  GoalEvidenceRunAnchor,
  GoalEvidenceRunSlice,
  GoalEvidenceTool,
} from "../goal-evidence-contracts.js";

/** Run-indexed, bounded projection. Full session history and large bodies are never loaded. */
export function readGoalEvidenceRunSlice(
  db: DatabaseSync,
  sessionId: string,
  runId: string,
): GoalEvidenceRunSlice {
  const rows = (sql: string, ...args: SQLInputValue[]) =>
    db.prepare(sql).all(...args) as Record<string, unknown>[];
  const base = "FROM runtime_events WHERE session_id = ? AND run_id = ?";
  const count = (predicate: string) =>
    Number(rows(`SELECT count(*) AS n ${base} AND ${predicate}`, sessionId, runId)[0]?.["n"] ?? 0);
  const throughSequence = Number(
    rows("SELECT max(event_seq) AS n FROM runtime_events WHERE session_id = ?", sessionId)[0]?.[
      "n"
    ] ?? 0,
  );
  const anchor = (kind: string): GoalEvidenceRunAnchor | undefined => {
    const r = rows(
      `SELECT event_id, event_seq, json_extract(payload_json,'$.turnId') AS turn_id, json_extract(payload_json,'$.invocationId') AS invocation_id, json_extract(payload_json,'$.data.status') AS status ${base} AND kind = ? ORDER BY event_seq DESC LIMIT 1`,
      sessionId,
      runId,
      kind,
    )[0];
    return r
      ? {
          eventId: String(r["event_id"]),
          sequence: Number(r["event_seq"]),
          sessionId,
          runId,
          turnId: String(r["turn_id"]),
          invocationId: String(r["invocation_id"]),
          ...(typeof r["status"] === "string" ? { status: r["status"] } : {}),
        }
      : undefined;
  };
  const started = anchor("run.started"),
    terminal = anchor("run.terminal");
  const tools: GoalEvidenceTool[] = rows(
    `SELECT event_id,event_seq, json_extract(payload_json,'$.refs.toolCallId') AS call_id, json_extract(payload_json,'$.data.toolName') AS tool_name, json_extract(payload_json,'$.data.status') AS status, json_extract(payload_json,'$.data.body.sha256') AS sha256, json_extract(payload_json,'$.data.body.sizeBytes') AS size_bytes, substr(json_extract(payload_json,'$.data.body.content'),1,512) AS head, substr(json_extract(payload_json,'$.data.body.content'),-512) AS tail, length(json_extract(payload_json,'$.data.body.content')) AS chars, json_extract(payload_json,'$.data.projection.mode') AS mode, json_extract(payload_json,'$.data.executionFacts') AS facts, json_extract(payload_json,'$.data.recovery.classification') AS recovery ${base} AND kind='tool.result.recorded' ORDER BY event_seq DESC LIMIT 12`,
    sessionId,
    runId,
  )
    .reverse()
    .map((r) => {
      const callId = String(r["call_id"]);
      const start = rows(
        `SELECT event_id,event_seq,substr(json_extract(payload_json,'$.data.argumentsJson'),1,512) AS args, length(CAST(json_extract(payload_json,'$.data.argumentsJson') AS BLOB)) AS bytes ${base} AND kind='tool.started' AND json_extract(payload_json,'$.refs.toolCallId')=? AND event_seq<? ORDER BY event_seq DESC LIMIT 1`,
        sessionId,
        runId,
        callId,
        Number(r["event_seq"]),
      )[0];
      const excerpt =
        Number(r["chars"]) <= 512
          ? String(r["head"] ?? "")
          : `${prefix(String(r["head"] ?? ""), 500)}\n…\n${suffix(String(r["tail"] ?? ""), 500)}`;
      const facts: unknown = typeof r["facts"] === "string" ? JSON.parse(r["facts"]) : undefined;
      return {
        eventId: String(r["event_id"]),
        sequence: Number(r["event_seq"]),
        toolCallId: callId,
        toolName: String(r["tool_name"]),
        status: r["status"] as RuntimeToolResultStatus,
        sha256: String(r["sha256"]),
        sizeBytes: Number(r["size_bytes"]),
        excerpt,
        truncated:
          Number(r["chars"]) > 512 || Buffer.byteLength(excerpt) !== Number(r["size_bytes"]),
        projectionMode: r["mode"] as GoalEvidenceTool["projectionMode"],
        ...(isForegroundProcessFacts(facts) ? { executionFacts: facts } : {}),
        ...(r["recovery"] === "indeterminate" || r["recovery"] === "not_dispatched"
          ? { recoveryClassification: r["recovery"] }
          : {}),
        ...(start
          ? {
              start: {
                eventId: String(start["event_id"]),
                sequence: Number(start["event_seq"]),
                argumentsJson: prefix(String(start["args"] ?? ""), 512),
                argumentsTruncated: Number(start["bytes"]) > 512,
              },
            }
          : {}),
      };
    });
  const messagePredicate =
    "kind='message.committed' AND json_extract(payload_json,'$.data.message.role') IN ('user','assistant') AND json_extract(payload_json,'$.data.message.toolCallId') IS NULL AND coalesce(json_array_length(json_extract(payload_json,'$.data.message.toolCalls')),0)=0 AND coalesce(json_extract(payload_json,'$.data.message.providerData.picoHiddenFromTranscript'),0)!=1";
  const message = (r: Record<string, unknown>): GoalEvidenceMessage => ({
    eventId: String(r["event_id"]),
    sequence: Number(r["event_seq"]),
    role: r["role"] as "user" | "assistant",
    content: prefix(String(r["text"] ?? ""), 1500),
    sha256: String(r["sha256"]),
    sizeBytes: Number(r["size_bytes"]),
    truncated: Buffer.byteLength(prefix(String(r["text"] ?? ""), 1500)) !== Number(r["size_bytes"]),
  });
  // Ordinary messages are point-read to hash canonical text, with a bounded SQL excerpt for delivery.
  const messageRows = rows(
    `SELECT event_id,event_seq, json_extract(payload_json,'$.data.message.role') AS role, substr(json_extract(payload_json,'$.data.message.content'),1,500) AS text, length(CAST(json_extract(payload_json,'$.data.message.content') AS BLOB)) AS size_bytes ${base} AND ${messagePredicate} ORDER BY event_seq DESC LIMIT 6`,
    sessionId,
    runId,
  ).reverse();
  const messages = messageRows.map((r) => {
    const raw = rows(
      "SELECT json_extract(payload_json,'$.data.message.content') AS content FROM runtime_events WHERE session_id=? AND event_id=?",
      sessionId,
      String(r["event_id"]),
    )[0];
    r["sha256"] = createHash("sha256")
      .update(String(raw?.["content"] ?? ""))
      .digest("hex");
    return message(r);
  });
  const mutationPredicate =
    "kind IN ('tool.started','tool.result.recorded') AND lower(json_extract(payload_json,'$.data.toolName')) NOT IN ('read_file','grep','glob','list_files','memory_search','memory_get','search','read_tool_result','read_tool_result_archive')";
  const potentialMutations = rows(
    `SELECT event_id,event_seq,json_extract(payload_json,'$.data.toolName') AS tool_name ${base} AND ${mutationPredicate} ORDER BY event_seq DESC LIMIT 12`,
    sessionId,
    runId,
  )
    .reverse()
    .map((r) => ({
      eventId: String(r["event_id"]),
      sequence: Number(r["event_seq"]),
      toolName: String(r["tool_name"]),
    }));
  const incompleteToolCallCount = Number(
    rows(
      `SELECT count(*) AS n FROM runtime_events s WHERE s.session_id=? AND s.run_id=? AND s.kind='tool.started' AND NOT EXISTS(SELECT 1 FROM runtime_events r WHERE r.session_id=s.session_id AND r.run_id=s.run_id AND r.kind='tool.result.recorded' AND json_extract(r.payload_json,'$.refs.toolCallId')=json_extract(s.payload_json,'$.refs.toolCallId') AND r.event_seq>s.event_seq)`,
      sessionId,
      runId,
    )[0]?.["n"] ?? 0,
  );
  const finalReply = messages.findLast((m) => m.role === "assistant");
  return {
    throughSequence,
    identity: { ...(started ? { started } : {}), ...(terminal ? { terminal } : {}) },
    tools,
    messages,
    ...(finalReply ? { finalReply } : {}),
    toolResultCount: count("kind='tool.result.recorded'"),
    messageCount: count(messagePredicate),
    incompleteToolCallCount,
    potentialMutations,
    potentialMutationCount: count(mutationPredicate),
    ...(potentialMutations.at(-1)
      ? { latestPotentialMutationSequence: potentialMutations.at(-1)!.sequence }
      : {}),
  };
}
function prefix(s: string, maxBytes: number): string {
  let out = "",
    bytes = 0;
  for (const c of s) {
    const n = Buffer.byteLength(c);
    if (bytes + n > maxBytes) break;
    out += c;
    bytes += n;
  }
  return out;
}
function suffix(s: string, maxBytes: number): string {
  return [...prefix([...s].reverse().join(""), maxBytes)].reverse().join("");
}
