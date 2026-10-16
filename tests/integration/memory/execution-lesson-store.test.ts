import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import type { ExperienceUse } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { LEGACY_LESSON_SCHEMA_SQL, seedLegacyLesson } from "../helpers/legacy-memory-schema.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "pico-retire-lesson-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "memory.sqlite");
  const store = new SqliteMemoryItemStore(path);
  const ids: string[] = [];
  for (const [index, workspaceKey] of [
    "workspace",
    "another",
    "workspace",
    "workspace",
    "workspace",
  ].entries()) {
    const result = await store.applyMutations({
      operationId: `seed-${index}`,
      mutations: [
        {
          type: "create",
          item: {
            content: index === 4 ? "ordinary survives" : "LegacyBodyCanary",
            kind: "note",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: workspaceKey,
            observedAt: 1,
            origin: "user_requested",
            keys: [{ key: "LegacyFamilyCanary", keyType: "concept", keyOrigin: "user" }],
            sources: [],
          },
        },
      ],
    });
    ids.push(result.results[0]!.itemId);
  }
  const fence = await store.readDeletionRevision();
  store.close();
  const db = new DatabaseSync(path);
  db.exec(LEGACY_LESSON_SCHEMA_SQL);
  db.exec("PRAGMA user_version=13");
  seedLegacyLesson(db, { candidateId: "confirmed", itemId: ids[0]! });
  seedLegacyLesson(db, {
    candidateId: "edited",
    itemId: ids[1]!,
    workspaceKey: "another",
    state: "invalidated",
    content: "",
  });
  seedLegacyLesson(db, { candidateId: "receipt-only", itemId: ids[2]!, receiptOnly: true });
  seedLegacyLesson(db, { candidateId: "pending" });
  const item = db.prepare("SELECT * FROM memory_items WHERE item_id=?").get(ids[3]!)!;
  const use: ExperienceUse = {
    useId: "orphan-use",
    workspaceKey: "workspace",
    source: {
      kind: "execution-evidence",
      candidateId: "orphan-candidate",
      candidateVersion: 2,
      contentHash: String(item.content_hash),
    },
    itemId: ids[3]!,
    itemVersion: 1,
    contentHash: String(item.content_hash),
    taskId: "task",
    taskVersion: 1,
    sessionId: "session",
    runId: "run",
    referenceHash: hash("reference"),
    referenceContent: "LegacyBodyCanary reference",
    delivery: "carried",
    deliverySequence: 2,
    providerCallId: "provider",
    historical: false,
    managementRevision: 0,
    settingsVersion: 1,
    deletionRevision: 0,
    adoption: "observed",
    validation: "unknown",
    validationScope: "unknown",
    excluded: false,
    deleted: false,
    sources: [],
    createdAt: 1,
    updatedAt: 2,
  };
  db.prepare("INSERT INTO experience_uses VALUES(?,?,?,?,?,?,?)").run(
    use.useId,
    use.workspaceKey,
    use.sessionId,
    use.itemId,
    use.source.kind,
    use.source.candidateId,
    JSON.stringify(use),
  );
  const effect = {
    effectId: "effect",
    useId: use.useId,
    preparedEventId: "prepared",
    outcomeEventId: "outcome",
    preparedSequence: 3,
    outcomeSequence: 4,
    adoption: "observed",
    validation: "unknown",
    validationScope: "unknown",
    reason: "LegacyBodyCanary effect",
    sources: [],
    trustedContradiction: false,
    createdAt: 4,
  };
  db.prepare("INSERT INTO experience_effects VALUES(?,?,?,?)").run(
    effect.effectId,
    use.useId,
    effect.outcomeEventId,
    JSON.stringify(effect),
  );
  db.prepare(
    "INSERT INTO experience_feedback(operation_id,workspace_key,use_id,request_hash,result_json,created_at) VALUES(?,?,?,?,?,?)",
  ).run(
    "feedback",
    "workspace",
    use.useId,
    hash({
      action: "disable",
      expectedItemVersion: 1,
      operationId: "feedback",
      useId: use.useId,
      workspaceKey: "workspace",
    }),
    JSON.stringify(use),
    4,
  );
  db.prepare("INSERT INTO memory_extraction_receipts VALUES(?,?,?,?,?)").run(
    "seed-0",
    "session",
    "a".repeat(64),
    JSON.stringify({
      status: "remembered",
      requestedItems: [{ itemId: ids[0]!, content: "LegacyBodyCanary receipt" }],
    }),
    1,
  );
  db.close();
  return { path, ids, fence, use };
}

test("v14 retires all workspaces, edited and orphan-owned lessons atomically; audit stays readable without old tables", async (t) => {
  const { path, ids, fence, use } = await fixture(t);
  let store = new SqliteMemoryItemStore(path);
  assert.equal(store.schemaVersion(), 20);
  assert.equal("createExecutionLesson" in store, false);
  for (const itemId of ids.slice(0, 4)) assert.equal(await store.readItem(itemId), undefined);
  assert.equal((await store.readItem(ids[4]!))!.item.content, "ordinary survives");
  const retired = await store.experienceLedger.readExperienceUse(use.useId);
  assert.equal(retired!.deleted, true);
  assert.equal(retired!.referenceContent, undefined);
  assert.equal((await store.experienceLedger.listExperienceEffects(use.useId))[0]!.reason, "");
  assert.ok(
    await store.readOperation(
      `retire-execution-lesson:v14:item:${hash(["workspace", "workspace", ids[0]])}`,
    ),
  );
  assert.equal(
    await store.readOperation(
      `retire-execution-lesson:v14:item:${hash(["workspace", "another", ids[0]])}`,
    ),
    undefined,
  );
  const revision = await store.readDeletionRevision();
  assert.ok(revision > fence);
  const {
    deliverySequence: _sequence,
    providerCallId: _provider,
    referenceContent: _content,
    ...replayedUse
  } = use;
  await assert.rejects(
    store.experienceLedger.recordExperienceUse({
      ...replayedUse,
      useId: "replay",
      delivery: "pending",
      adoption: "unknown",
      recallEventId: "recall",
      recallSequence: 1,
    }),
    /policy changed/,
  );
  assert.equal(
    (
      await store.experienceLedger.feedbackExperienceUse({
        workspaceKey: "workspace",
        useId: use.useId,
        expectedItemVersion: 1,
        operationId: "feedback",
        action: "disable",
        now: 100,
      })
    ).referenceContent,
    undefined,
  );
  await assert.rejects(
    store.commitExtraction({
      operationId: "late-extract",
      sessionId: "session",
      expectedDeletionRevision: fence,
      expectedCursorOrdinal: 0,
      nextCursorOrdinal: 1,
      coverageHash: "a".repeat(64),
      items: [],
      requestedItemIndexes: [],
      trigger: "extract",
    }),
    /deleted after/,
  );
  assert.equal(await store.readOperation("late-extract"), undefined);
  const before = await store.listItems({ workspaceKey: "workspace" });
  store.close();
  store = new SqliteMemoryItemStore(path);
  assert.equal(await store.readDeletionRevision(), revision);
  assert.deepEqual(await store.listItems({ workspaceKey: "workspace" }), before);
  store.close();
  const db = new DatabaseSync(path);
  try {
    assert.equal(
      db.prepare("SELECT 1 FROM sqlite_schema WHERE name='execution_lesson_candidates'").get(),
      undefined,
    );
    assert.throws(
      () => db.prepare("INSERT INTO execution_lesson_candidates VALUES(?,?,?,?,?,?)"),
      /no such table/,
    );
    for (const [table, column] of [
      ["experience_uses", "record_json"],
      ["experience_effects", "record_json"],
      ["experience_feedback", "result_json"],
      ["memory_extraction_receipts", "result_json"],
      ["memory_write_operations", "result_json"],
    ])
      assert.equal(
        db
          .prepare(`SELECT ${column} FROM ${table}`)
          .all()
          .some((row) => String(row[column!]).includes("LegacyBodyCanary")),
        false,
      );
    assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
    assert.equal(db.prepare("PRAGMA integrity_check").get()!.integrity_check, "ok");
  } finally {
    db.close();
  }
});

test("corrupt legacy evidence or conflicting new ownership fails closed and rolls all v14 changes back", async (t) => {
  for (const corruption of [
    "candidate",
    "receipt",
    "use",
    "effect",
    "ownership",
    "receipt-identity",
    "use-identity",
    "feedback-identity",
  ] as const) {
    const f = await fixture(t),
      db = new DatabaseSync(f.path);
    if (corruption === "candidate")
      db.exec("UPDATE execution_lesson_candidates SET record_json='broken'");
    if (corruption === "receipt")
      db.exec(
        "UPDATE memory_write_operations SET result_json='[]' WHERE operation_id='execution-lesson:confirmed'",
      );
    if (corruption === "receipt-identity")
      db.prepare(
        "UPDATE memory_write_operations SET result_json=json_set(result_json,'$[0].itemId',?) WHERE operation_id='execution-lesson:confirmed'",
      ).run(f.ids[4]!);
    if (corruption === "use-identity")
      db.exec(
        "UPDATE experience_uses SET candidate_id='confirmed',record_json=json_set(record_json,'$.source.candidateId','confirmed')",
      );
    if (corruption === "feedback-identity")
      db.exec(
        "UPDATE experience_feedback SET result_json=json_set(result_json,'$.source.candidateId','confirmed')",
      );
    if (corruption === "use") db.exec("UPDATE experience_uses SET record_json='broken'");
    if (corruption === "effect") db.exec("UPDATE experience_effects SET record_json='broken'");
    if (corruption === "ownership")
      db.prepare(
        "INSERT INTO execution_learning_items VALUES(?,?,?,'reviewed-reference',NULL)",
      ).run(f.ids[0]!, "new-candidate", "a".repeat(64));
    db.close();
    assert.throws(() => new SqliteMemoryItemStore(f.path), /Cannot retire memory_learn/);
    const check = new DatabaseSync(f.path);
    try {
      assert.equal(check.prepare("PRAGMA user_version").get()!.user_version, 13);
      assert.equal(check.prepare("SELECT count(*) n FROM memory_items").get()!.n, 5);
      assert.equal(check.prepare("SELECT count(*) n FROM execution_lesson_candidates").get()!.n, 3);
      assert.equal(
        check.prepare("SELECT 1 FROM memory_write_operations WHERE operation_type='delete'").get(),
        undefined,
      );
    } finally {
      check.close();
    }
  }
});

test("busy WAL checkpoint reports pending cleanup without rolling back retirement and retries on reopen", async (t) => {
  const { path } = await fixture(t);
  const reader = new DatabaseSync(path);
  reader.exec("BEGIN");
  reader.prepare("SELECT * FROM execution_lesson_candidates").all();
  const warnings = t.mock.method(process, "emitWarning", () => {});
  const store = new SqliteMemoryItemStore(path);
  assert.equal(store.schemaVersion(), 20);
  assert.equal(warnings.mock.callCount(), 1);
  assert.equal(
    (warnings.mock.calls[0]!.arguments[1] as { code: string }).code,
    "PICO_MEMORY_RETIREMENT_CHECKPOINT_PENDING",
  );
  reader.exec("ROLLBACK");
  reader.close();
  store.close();
  const reopened = new SqliteMemoryItemStore(path);
  reopened.close();
  assert.equal(warnings.mock.callCount(), 1);
});
