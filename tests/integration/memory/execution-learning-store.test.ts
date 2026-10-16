import { removeFutureRecallSchemaForLegacyFixture } from "../helpers/future-memory-schema.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ExecutionAcceptanceClaim,
  ExecutionLearningAdmission,
  ExecutionLearningJob,
  ExecutionVerificationResult,
  ExecutionVerificationTicket,
} from "@pico/core";
import { LEGACY_LESSON_SCHEMA_SQL, seedLegacyLesson } from "../helpers/legacy-memory-schema.js";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { SqliteMemoryItemStore } from "../../../packages/storage/src/sqlite/sqlite-memory-item-store.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const workspaceKey = "execution-store-workspace";
const source = (eventId: string) => ({
  sessionId: "session",
  runId: "run",
  turnId: "turn",
  eventId,
});

async function createUserItem(store: SqliteMemoryItemStore, operationId = "user-item") {
  const receipt = await store.applyMutations({
    operationId,
    mutations: [
      {
        type: "create",
        item: {
          content: "Legacy configuration documentation",
          kind: "note",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: workspaceKey,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "Legacy configuration", keyType: "exact", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  return receipt.results[0]!.itemId;
}

/** Historical fixture: production can no longer publish execution-validated items. */
async function seedSavedNative(
  store: SqliteMemoryItemStore,
  path: string,
  claim: ExecutionAcceptanceClaim,
) {
  const itemId = await createUserItem(store, `historical-${claim.candidateId}`);
  const item = (await store.readItem(itemId))!.item;
  const saved = { claim, state: "saved" as const, itemId, updatedAt: 603 };
  const db = new DatabaseSync(path);
  try {
    db.prepare(
      "UPDATE execution_learning_candidates SET state='saved',item_id=?,record_json=? WHERE candidate_id=?",
    ).run(itemId, JSON.stringify(saved), claim.candidateId);
    db.prepare("INSERT INTO execution_learning_items VALUES(?,?,?,'execution-validated',?)").run(
      itemId,
      claim.candidateId,
      item.contentHash,
      JSON.stringify({
        candidateId: claim.candidateId,
        predicateId: claim.predicateId,
        targetId: claim.target.targetId,
        targetLabel: claim.target.label,
        acceptedAt: 603,
        claimHash: claim.claimHash,
        scopeHash: claim.target.scopeHash,
      }),
    );
  } finally {
    db.close();
  }
  return saved;
}

async function admittedClaim(
  store: SqliteMemoryItemStore,
  suffix: string,
): Promise<ExecutionAcceptanceClaim> {
  const settings = await store.readSettings(workspaceKey);
  const generation = await store.executionLearning.advanceExecutionLearningInput(workspaceKey);
  const admission: ExecutionLearningAdmission = {
    admissionId: `admission-${suffix}`,
    workspaceKey,
    sessionId: "session",
    runId: `run-${suffix}`,
    workDir: "/fixture",
    settingsVersion: settings.version,
    deletionRevision: await store.readDeletionRevision(),
    managementRevision: generation.managementRevision,
    inputEpoch: generation.inputEpoch,
    createdAt: 100,
  };
  await store.executionLearning.admitExecutionLearning(admission);
  const claim: ExecutionAcceptanceClaim = {
    candidateId: `candidate-${suffix}`,
    revision: 1,
    failureKey: `failure-${suffix}`,
    predicateId: "command-conditions.v1",
    admission,
    target: {
      targetId: `target-${suffix}`,
      label: "BuildCheck",
      kind: "command",
      command: "node check.cjs",
      argv: ["node", "check.cjs"],
      cwd: "/fixture",
      scopeHash: hash("static-source"),
      entryFiles: [{ path: "/fixture/check.cjs", hash: hash("source") }],
    },
    claimHash: hash(`claim-${suffix}`),
    conditions: [{ kind: "file", path: "/fixture/ready.flag", hash: hash("ready") }],
    recipe: [
      {
        kind: "file",
        path: "/fixture/ready.flag",
        beforeHash: null,
        afterHash: hash("ready"),
        content: "ready",
        source: source(`native-write-${suffix}`),
      },
    ],
    failedTestIds: [],
    failure: source(`native-failure-${suffix}`),
    createdAt: 200,
  };
  await store.executionLearning.saveExecutionLearningClaim(claim);
  return claim;
}

async function receiptAndJob(
  store: SqliteMemoryItemStore,
  claim: ExecutionAcceptanceClaim,
  options: { settle?: boolean; enqueue?: boolean } = {},
) {
  const observation = {
    complete: true,
    matches: true,
    fingerprint: hash("stable-file-observation"),
    facts: [{ path: "/fixture/ready.flag", hash: hash("ready") }],
  };
  const ticket: ExecutionVerificationTicket = {
    ticketId: `ticket-${claim.candidateId}`,
    candidateId: claim.candidateId,
    claimRevision: claim.revision,
    claimHash: claim.claimHash,
    admissionId: claim.admission.admissionId,
    sessionId: claim.admission.sessionId,
    runId: claim.admission.runId,
    toolCallId: "native-check",
    preparedEventId: "native-T1",
    argumentsHash: hash("native-arguments"),
    inputEpoch: claim.admission.inputEpoch,
    before: observation,
    createdAt: 300,
  };
  await store.executionLearning.registerExecutionVerification(ticket);
  const result: ExecutionVerificationResult = {
    ticketId: ticket.ticketId,
    source: { ...source("native-success"), runId: ticket.runId },
    after: observation,
    complete: true,
    exitCode: 0,
    settledAt: 400,
  };
  if (options.settle !== false) await store.executionLearning.settleExecutionVerification(result);
  const job: ExecutionLearningJob = {
    jobId: `job-${claim.candidateId}`,
    workspaceKey,
    sessionId: ticket.sessionId,
    runId: ticket.runId,
    candidateId: claim.candidateId,
    ticketId: ticket.ticketId,
    kind: "verify",
    state: "ready",
    inputEpoch: claim.admission.inputEpoch,
    createdAt: 500,
    updatedAt: 500,
    leaseUntil: 0,
    fencingToken: 0,
  };
  if (options.enqueue !== false) await store.executionLearning.enqueueExecutionLearningJob(job);
  return { ticket, result, job };
}

test("v9, v10 and v11 memory databases upgrade to v16 preserving facts and retiring pending old lessons", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-migration-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const version of [9, 10, 11]) {
    const path = join(root, `memory-v${version}.sqlite`);
    let store = new SqliteMemoryItemStore(path);
    const itemId = await createUserItem(store);
    const before = await store.readItem(itemId);
    const existingNative =
      version === 11 ? await admittedClaim(store, "existing-native") : undefined;
    const nativeBefore = existingNative
      ? await store.executionLearning.readExecutionLearningCandidate(existingNative.candidateId)
      : undefined;
    store.close();
    const old = new DatabaseSync(path);
    removeFutureRecallSchemaForLegacyFixture(old);
    if (version !== 9) {
      old.exec(LEGACY_LESSON_SCHEMA_SQL);
      seedLegacyLesson(old, { candidateId: "legacy-pending", workspaceKey });
    }
    for (const row of old
      .prepare(
        `SELECT name FROM sqlite_schema WHERE type='table' AND (name LIKE 'memory_consolidation_%' OR name LIKE 'experience_%' OR name LIKE 'task_experience_%' OR (name LIKE 'execution_learning_%' AND ${version} != 11))`,
      )
      .all()) {
      old.exec(`DROP TABLE "${String(row.name).replaceAll('"', '""')}"`);
    }
    old.exec(`PRAGMA user_version=${version}`);
    old.close();
    store = new SqliteMemoryItemStore(path);
    try {
      assert.equal(store.schemaVersion(), 20);
      assert.deepEqual(await store.readItem(itemId), before);
      if (existingNative)
        assert.deepEqual(
          await store.executionLearning.readExecutionLearningCandidate(existingNative.candidateId),
          nativeBefore,
        );
      const claim = await admittedClaim(store, `migration-${version}`);
      assert.equal(
        (await store.executionLearning.readExecutionLearningCandidate(claim.candidateId))?.state,
        "waiting",
      );
      const db = new DatabaseSync(path, { readOnly: true });
      try {
        assert.ok(
          db
            .prepare("SELECT name FROM sqlite_schema WHERE name='execution_learning_native_facts'")
            .get(),
        );
      } finally {
        db.close();
      }
    } finally {
      store.close();
    }
  }
});

test("restart preserves internal receipts without native enqueue; retired jobs cannot publish and preserve historical saved state", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-commit-gap-")),
    path = join(root, "memory.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = new SqliteMemoryItemStore(path);
  t.after(() => store.close());
  const settled = await admittedClaim(store, "settled-gap");
  const { ticket, result, job } = await receiptAndJob(store, settled, { enqueue: false });
  const pendingSeed = await admittedClaim(store, "pending-gap");
  const pending = {
    ...pendingSeed,
    revision: 2,
    claimHash: hash("pending-gap-revision"),
    conditions: [{ kind: "file" as const, path: join(root, "ready.flag"), hash: hash("ready") }],
  };
  await store.executionLearning.saveExecutionLearningClaim(pending);
  const pendingReceipt = await receiptAndJob(store, pending, { settle: false, enqueue: false });
  await writeFile(join(root, "ready.flag"), "ready");
  store.close();
  store = new SqliteMemoryItemStore(path);
  await store.executionLearning.recoverSettledExecutionLearningJobs(600);
  await store.executionLearning.recoverSettledExecutionLearningJobs(601);
  assert.deepEqual(await store.executionLearning.readExecutionVerification(ticket.ticketId), {
    ticket,
    result,
  });
  assert.equal(
    (await store.executionLearning.readExecutionVerification(pendingReceipt.ticket.ticketId))
      ?.result,
    undefined,
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT count(*) AS count FROM execution_learning_jobs").get()?.count,
      0,
    );
  } finally {
    db.close();
  }
  await store.executionLearning.enqueueExecutionLearningJob(job); // Simulate an already queued pre-retirement job.
  const lease = await store.executionLearning.claimExecutionLearningJob(
    "recovered-worker",
    602,
    1000,
  );
  assert.equal(lease?.ticketId, ticket.ticketId);
  assert.ok(lease);
  const skipped = await store.executionLearning.completeExecutionLearningJob({
    jobId: lease.jobId,
    fencingToken: lease.fencingToken,
    candidateRevision: settled.revision,
    content: "BuildCheck 已通过完整验收，ready.flag 的内容保持 ready。",
    now: 603,
  });
  assert.equal(skipped.itemId, undefined);
  assert.equal((await store.listItems({ workspaceKey })).length, 0);
  const saved = await seedSavedNative(store, path, settled);
  const { ticketId: _ticketId, ...reflectionBase } = job;
  await store.executionLearning.enqueueExecutionLearningJob({
    ...reflectionBase,
    jobId: "late-reflection",
    kind: "reflect",
    createdAt: 604,
    updatedAt: 604,
  });
  const reflection = await store.executionLearning.claimExecutionLearningJob(
    "late-worker",
    605,
    1000,
  );
  assert.equal(reflection?.kind, "reflect");
  assert.ok(reflection);
  const unchanged = await store.executionLearning.completeExecutionLearningJob({
    jobId: reflection.jobId,
    fencingToken: reflection.fencingToken,
    candidateRevision: settled.revision,
    reason: "late unsupported hypothesis",
    hypothesis: "unverified",
    now: 606,
  });
  assert.equal(unchanged.state, "saved");
  assert.equal(unchanged.itemId, saved.itemId);
  assert.equal((await store.listItems({ workspaceKey })).length, 1);
});

test("verification receipts and fences survive restart; retired jobs cannot publish and historical damaged acceptance cannot fall back to recall", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-persistence-")),
    path = join(root, "memory.sqlite");
  t.after(() => rm(root, { recursive: true, force: true }));
  let store = new SqliteMemoryItemStore(path);
  t.after(() => store.close());
  const claim = await admittedClaim(store, "persist");
  const { ticket, result, job } = await receiptAndJob(store, claim);
  const first = await store.executionLearning.claimExecutionLearningJob("worker-old", 600, 100);
  assert.ok(first);
  store.close();
  store = new SqliteMemoryItemStore(path);
  assert.deepEqual(await store.executionLearning.readExecutionVerification(ticket.ticketId), {
    ticket,
    result,
  });
  assert.equal(
    await store.executionLearning.claimExecutionLearningJob("worker-new", 650, 100),
    undefined,
  );
  const replacement = await store.executionLearning.claimExecutionLearningJob(
    "worker-new",
    701,
    100,
  );
  assert.ok(replacement);
  assert.equal(replacement.fencingToken, first.fencingToken + 1);
  await assert.rejects(
    store.executionLearning.completeExecutionLearningJob({
      jobId: job.jobId,
      fencingToken: first.fencingToken,
      candidateRevision: claim.revision,
      content: "stale publication",
      now: 702,
    }),
    /Stale execution learning fence/,
  );
  assert.equal((await store.listItems({ workspaceKey })).length, 0);
  const skipped = await store.executionLearning.completeExecutionLearningJob({
    jobId: job.jobId,
    fencingToken: replacement.fencingToken,
    candidateRevision: claim.revision,
    content:
      "BuildCheck 已验证：准备 ready.flag 内容为 ready 后，同一静态命令完整退出 0，条件前后稳定。",
    hypothesis: "旧模型不能再发布假设",
    now: 9999,
  });
  assert.equal(skipped.itemId, undefined);
  assert.equal(skipped.hypothesis, undefined);
  const saved = await seedSavedNative(store, path, claim);
  assert.ok(saved.itemId);
  assert.equal((await store.readItem(saved.itemId))?.sourceType, "execution-validated");
  assert.equal((await store.readItem(saved.itemId))?.taskAcceptance?.claimHash, claim.claimHash);
  await store.executionLearning.completeExecutionLearningJob({
    jobId: job.jobId,
    fencingToken: replacement.fencingToken,
    candidateRevision: claim.revision,
    content: "duplicate",
    now: 703,
  });
  assert.equal((await store.listItems({ workspaceKey })).length, 1);
  const targets = [{ targetId: claim.target.targetId, scopeHash: claim.target.scopeHash }];
  const recall = await new AtomicMemoryContextBuilder(store, workspaceKey).build(
    "Legacy configuration",
    {
      executionTargets: targets,
    },
  );
  assert.equal(recall.items.length, 1);
  store.close();
  const damaged = new DatabaseSync(path);
  damaged
    .prepare("UPDATE execution_learning_items SET item_content_hash=? WHERE item_id=?")
    .run(hash("damaged"), saved.itemId);
  damaged.close();
  store = new SqliteMemoryItemStore(path);
  const record = await store.readItem(saved.itemId);
  assert.equal(record?.sourceType, "execution-validated");
  assert.equal(record?.taskAcceptance, undefined);

  assert.equal(
    (
      await new AtomicMemoryContextBuilder(store, workspaceKey).build("Legacy configuration", {
        executionTargets: targets,
      })
    ).items.length,
    0,
  );
  const corrected = await store.applyMutations({
    operationId: "explicit-manual-correction",
    mutations: [
      {
        type: "update",
        itemId: saved.itemId,
        expectedVersion: record!.item.version,
        item: {
          content: "ManualCorrectionConfig",
          kind: "note",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: workspaceKey,
          observedAt: 1,
          origin: "user_requested",
          keys: [{ key: "ManualCorrectionConfig", keyType: "exact", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  const manual = await store.readItem(corrected.results[0]!.itemId);
  assert.equal(manual?.sourceType, undefined);
  assert.equal(manual?.taskAcceptance, undefined);
  assert.equal(manual?.item.origin, "user_requested");
  assert.equal(
    (await new AtomicMemoryContextBuilder(store, workspaceKey).build("ManualCorrectionConfig"))
      .references[0]?.source,
    "manual",
  );
});

test("discard and a deletion during an active verification lease prevent publication after restart", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-invalidation-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const reason of ["discard", "delete"] as const) {
    const path = join(root, `${reason}.sqlite`);
    let store = new SqliteMemoryItemStore(path);
    const userItem = reason === "delete" ? await createUserItem(store) : undefined;
    const claim = await admittedClaim(store, reason),
      { job } = await receiptAndJob(store, claim);
    const lease = await store.executionLearning.claimExecutionLearningJob("worker", 600, 1000);
    assert.ok(lease);
    if (reason === "discard")
      await store.executionLearning.discardExecutionLearning(
        claim.candidateId,
        workspaceKey,
        claim.revision,
      );
    else
      await store.deleteItem({
        itemId: userItem!,
        expectedVersion: 1,
        operationId: "delete-user-memory",
      });
    store.close();
    store = new SqliteMemoryItemStore(path);
    try {
      const completed = await store.executionLearning.completeExecutionLearningJob({
        jobId: job.jobId,
        fencingToken: lease.fencingToken,
        candidateRevision: claim.revision,
        content: "不得发布的过时验收",
        now: 700,
      });
      assert.equal(completed.state, reason === "discard" ? "discarded" : "waiting");
      assert.equal((await store.listItems({ workspaceKey })).length, 0);
      await assert.rejects(
        store.executionLearning.saveExecutionLearningClaim(claim),
        /discarded|policy changed/,
      );
      if (reason === "discard") {
        assert.equal(
          await store.executionLearning.readExecutionVerification(`ticket-${claim.candidateId}`),
          undefined,
        );
        assert.deepEqual(completed.claim.recipe, []);
      }
    } finally {
      store.close();
    }
  }
});
