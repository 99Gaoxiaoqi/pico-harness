import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { scrubExperienceLedger } from "./experience-feedback-store.js";

type RecordValue = Record<string, unknown>;
const RETIREMENT_OPERATION = "memory-learn-retirement:v14";
const CHECKPOINT_OPERATION = `${RETIREMENT_OPERATION}:checkpoint`;
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

function invalid(): never {
  // Never expose persisted prose in migration diagnostics.
  throw new Error(
    "Cannot retire memory_learn: invalid legacy identity or receipt; migration rolled back",
  );
}
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  return value as RecordValue;
}
function json(value: unknown): RecordValue {
  try {
    return record(JSON.parse(String(value)));
  } catch {
    return invalid();
  }
}
function identifier(value: unknown): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > 512 ||
    /[\u0000-\u001f]/u.test(value)
  )
    return invalid();
  return value;
}

/** v13 -> v14, called only inside the schema initialization transaction. */
export function retireExecutionLessons(db: DatabaseSync, now = Date.now()): boolean {
  if (db.prepare("PRAGMA foreign_key_check").get()) invalid();
  const candidates = new Set<string>();
  const items = new Set<string>();
  const candidateItems = new Map<string, string>();
  const registerItem = (candidateId: string, itemId: string) => {
    const existingItemId = candidateItems.get(candidateId);
    if (existingItemId !== undefined && existingItemId !== itemId) invalid();
    candidateItems.set(candidateId, itemId);
    candidates.add(candidateId);
    items.add(itemId);
  };
  for (const row of db.prepare("SELECT * FROM execution_lesson_candidates").all()) {
    const candidate = json(row.record_json);
    const candidateId = identifier(row.candidate_id);
    if (
      candidate.candidateId !== candidateId ||
      candidate.workspaceKey !== row.workspace_key ||
      candidate.sessionId !== row.session_id ||
      candidate.state !== row.state ||
      candidate.itemId !== row.item_id ||
      !Number.isSafeInteger(candidate.version) ||
      Number(candidate.version) < 1 ||
      typeof candidate.content !== "string" ||
      typeof candidate.taskFamily !== "string" ||
      !Array.isArray(candidate.verifications)
    )
      invalid();
    identifier(candidate.workspaceKey);
    identifier(candidate.sessionId);
    candidates.add(candidateId);
    if (candidate.itemId !== null) registerItem(candidateId, identifier(candidate.itemId));
  }
  // Manual edits clear candidate.itemId. The original immutable create receipt is
  // still authoritative ownership evidence, including for an edited ordinary fact.
  for (const row of db
    .prepare(
      "SELECT * FROM memory_write_operations WHERE substr(operation_id,1,17)='execution-lesson:'",
    )
    .all()) {
    const candidateId = identifier(String(row.operation_id).slice(17));
    if (row.operation_type !== "create") invalid();
    let results: unknown;
    try {
      results = JSON.parse(String(row.result_json));
    } catch {
      invalid();
    }
    if (!Array.isArray(results) || results.length !== 1) invalid();
    const result = record(results[0]);
    if (
      result.mutationType !== "create" ||
      !Number.isSafeInteger(result.version) ||
      Number(result.version) < 1
    )
      invalid();
    registerItem(candidateId, identifier(result.itemId));
  }
  const legacyUses = db
    .prepare("SELECT * FROM experience_uses WHERE source_kind='execution-evidence'")
    .all();
  for (const row of legacyUses) {
    const use = json(row.record_json),
      source = record(use.source);
    if (
      use.useId !== row.use_id ||
      use.itemId !== row.item_id ||
      use.workspaceKey !== row.workspace_key ||
      use.sessionId !== row.session_id ||
      source.kind !== "execution-evidence" ||
      source.candidateId !== row.candidate_id
    )
      invalid();
    identifier(use.useId);
    identifier(use.workspaceKey);
    identifier(use.sessionId);
    registerItem(identifier(source.candidateId), identifier(use.itemId));
  }
  // A feedback replay can retain an old result even after a damaged/missing use row.
  // Its frozen source identity is sufficient; unrelated content is never guessed.
  const feedback = db.prepare("SELECT * FROM experience_feedback").all();
  for (const row of feedback) {
    const use = json(row.result_json),
      source = record(use.source);
    if (source.kind !== "execution-evidence") continue;
    if (use.useId !== row.use_id || use.workspaceKey !== row.workspace_key) invalid();
    registerItem(identifier(source.candidateId), identifier(use.itemId));
  }
  for (const itemId of items) {
    // Conflicting ownership is corruption, never permission to erase a new source.
    if (db.prepare("SELECT 1 FROM execution_learning_items WHERE item_id=?").get(itemId)) invalid();
    for (const row of db.prepare("SELECT * FROM experience_uses WHERE item_id=?").all(itemId)) {
      const use = json(row.record_json),
        source = record(use.source);
      if (
        row.source_kind !== "execution-evidence" ||
        source.kind !== "execution-evidence" ||
        use.useId !== row.use_id ||
        use.itemId !== itemId ||
        source.candidateId !== row.candidate_id
      )
        invalid();
      for (const effectRow of db
        .prepare("SELECT * FROM experience_effects WHERE use_id=?")
        .all(String(row.use_id))) {
        const effect = json(effectRow.record_json);
        if (
          effect.effectId !== effectRow.effect_id ||
          effect.useId !== row.use_id ||
          effect.outcomeEventId !== effectRow.outcome_event_id
        )
          invalid();
      }
    }
  }
  if (items.size) {
    for (const row of db
      .prepare("SELECT operation_id,result_json FROM memory_extraction_receipts")
      .all()) {
      const receipt = json(row.result_json);
      if (!Array.isArray(receipt.requestedItems)) invalid();
      const requestedItems = receipt.requestedItems.filter(
        (value) => !items.has(identifier(record(value).itemId)),
      );
      if (requestedItems.length === receipt.requestedItems.length) continue;
      db.prepare("UPDATE memory_extraction_receipts SET result_json=? WHERE operation_id=?").run(
        JSON.stringify({
          ...receipt,
          requestedItems,
          status:
            receipt.status === "remembered" && !requestedItems.length
              ? "not_applicable"
              : receipt.status,
        }),
        String(row.operation_id),
      );
    }
  }
  const insertAudit = (operationId: string, identity: unknown) => {
    // A conflicting operation must abort instead of silently bypassing the fence.
    db.prepare("INSERT INTO memory_write_operations VALUES(?,'delete',?,'[]',?)").run(
      operationId,
      hash(identity),
      now,
    );
  };
  for (const candidateId of [...candidates].sort())
    insertAudit(`retire-memory-learn:${candidateId}`, { candidateId });
  for (const itemId of [...items].sort()) {
    const item = db
      .prepare("SELECT version,scope_type,scope_key FROM memory_items WHERE item_id=?")
      .get(itemId);
    if (item)
      insertAudit(
        `retire-execution-lesson:v14:item:${hash([item.scope_type, item.scope_key, itemId])}`,
        { itemId, expectedVersion: item.version },
      );
    scrubExperienceLedger(db, { itemId }, now);
    db.prepare("DELETE FROM memory_items WHERE item_id=?").run(itemId);
  }
  // Scrub orphan replay results too; identities, hashes and timestamps are audit.
  for (const row of feedback) {
    const use = json(row.result_json),
      source = record(use.source);
    if (source.kind !== "execution-evidence") continue;
    const { referenceContent: _body, ...withoutBody } = use;
    db.prepare("UPDATE experience_feedback SET result_json=? WHERE operation_id=?").run(
      JSON.stringify({ ...withoutBody, deleted: true, sources: [], updatedAt: now }),
      String(row.operation_id),
    );
  }
  db.exec("DROP TABLE execution_lesson_candidates");
  const changed = candidates.size > 0 || items.size > 0;
  if (changed) {
    insertAudit(RETIREMENT_OPERATION, { version: 14 });
    db.exec(
      "INSERT INTO execution_learning_control(scope,management_revision,resource_revision) VALUES('*',1,1) ON CONFLICT(scope) DO UPDATE SET management_revision=management_revision+1,resource_revision=resource_revision+1",
    );
  }
  return changed;
}

/** Retry on each open after retirement; a busy reader must never hide a committed delete. */
export function checkpointRetiredExecutionLessons(db: DatabaseSync): void {
  if (
    !db
      .prepare(
        "SELECT 1 FROM memory_write_operations WHERE operation_id=? AND operation_type='delete'",
      )
      .get(RETIREMENT_OPERATION)
  )
    return;
  if (
    db
      .prepare("SELECT 1 FROM memory_write_operations WHERE operation_id=?")
      .get(CHECKPOINT_OPERATION)
  )
    return;
  try {
    const result = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    if (result?.busy !== 0) throw new Error("busy");
    // Persist successful physical cleanup without changing the deletion generation.
    // This final WAL write contains only an empty audit receipt, never old prose.
    db.prepare("INSERT OR IGNORE INTO memory_write_operations VALUES(?,'batch',?,'[]',?)").run(
      CHECKPOINT_OPERATION,
      hash({ version: 14, checkpoint: "complete" }),
      Date.now(),
    );
  } catch {
    process.emitWarning(
      "Legacy memory retirement committed; WAL checkpoint pending until readers close",
      {
        code: "PICO_MEMORY_RETIREMENT_CHECKPOINT_PENDING",
      },
    );
  }
}
