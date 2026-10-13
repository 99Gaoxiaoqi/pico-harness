import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ExperienceUse,
  ExperienceEffect,
  TaskExperienceCandidate,
  TaskExperienceTask,
  ExecutionLearningCandidate,
} from "@pico/core";
import { SqliteMemoryItemStore } from "../../../packages/storage/src/sqlite/sqlite-memory-item-store.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const source = (eventId: string) => ({
  sessionId: "session",
  runId: "run",
  turnId: "turn",
  eventId,
});
async function generic(store: SqliteMemoryItemStore) {
  const task: TaskExperienceTask = {
    taskId: "task",
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "session",
    runId: "run",
    goal: "Excel Sheet1 B2:B4 B列求和",
    goalSource: source("goal"),
    coverage: "complete",
    throughSequence: 20,
    createdAt: 1,
    updatedAt: 1,
  };
  await store.taskExperiences.appendTaskExperienceObservations(task, [
    {
      observationId: "observation",
      taskId: task.taskId,
      taskVersion: 1,
      kind: "tool-result",
      source: source("initial-result"),
      sequence: 2,
      summary: "可信工具结果",
      coverage: "complete",
      status: "succeeded",
      toolName: "document",
      createdAt: 1,
    },
  ]);
  const epoch = await store.executionLearning.advanceExecutionLearningInput("workspace");
  const candidate: TaskExperienceCandidate = {
    candidateId: "lesson",
    kind: "task-lesson",
    taskId: task.taskId,
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "session",
    runId: "run",
    failureKey: "lesson-key",
    inputEpoch: epoch.inputEpoch,
    settingsVersion: 1,
    deletionRevision: 0,
    state: "waiting",
    lifecycleState: "active",
    goal: task.goal,
    content: "",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: [source("initial-result")],
    observationIds: ["observation"],
    createdAt: 1,
    updatedAt: 1,
  };
  await store.taskExperiences.createTaskExperienceCandidate(candidate);
  const job = await store.executionLearning.claimExecutionLearningJob("worker", 10, 1000);
  assert.ok(job);
  const pending = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: 1,
    content: "对当前数值范围做独立工具验证。",
    applicability: {
      taskFamily: "spreadsheet",
      toolNames: ["document"],
      conditions: [],
      spreadsheet: { operation: "sum", header: false, dataKind: "finite-numbers" },
    },
    sources: candidate.sources,
    now: 11,
  });
  assert.ok(pending);
  return store.taskExperiences.reviewTaskExperience({
    workspaceKey: "workspace",
    candidateId: "lesson",
    expectedRecordRevision: pending.recordRevision,
    expectedContentVersion: 1,
    action: "accept",
    operationId: "accept",
    now: 12,
  });
}
async function useFor(
  store: SqliteMemoryItemStore,
  itemId: string,
  sourceVersion: ExperienceUse["source"],
  useId: string,
): Promise<ExperienceUse> {
  const item = (await store.readItem(itemId))!.item;
  return {
    useId,
    workspaceKey: "workspace",
    source: sourceVersion,
    itemId,
    itemVersion: item.version,
    contentHash: item.contentHash,
    taskId: "task",
    taskVersion: 1,
    sessionId: "session",
    runId: "run",
    referenceHash: hash(item.content),
    referenceContent: item.content,
    recallEventId: "recall",
    recallSequence: 3,
    delivery: "pending",
    historical: false,
    ...(await store.experienceLedger.readExperienceFence("workspace")),
    adoption: "unknown",
    validation: "unknown",
    validationScope: "unknown",
    excluded: false,
    deleted: false,
    sources: [],
    createdAt: 13,
    updatedAt: 13,
  };
}
const effectFor = (
  use: ExperienceUse,
  outcomeSequence: number,
  validation: "pass" | "fail" = "pass",
  scope: ExperienceEffect["validationScope"] = "spreadsheet-range",
): ExperienceEffect => ({
  effectId: `${use.useId}-effect-${outcomeSequence}`,
  useId: use.useId,
  preparedEventId: `prepared-${outcomeSequence}`,
  outcomeEventId: `outcome-${outcomeSequence}`,
  preparedSequence: outcomeSequence - 1,
  outcomeSequence,
  adoption: "observed",
  validation,
  validationScope: scope,
  reason: "独立可信校验",
  sources: [source(`outcome-${outcomeSequence}`)],
  trustedContradiction: validation === "fail",
  createdAt: 20 + outcomeSequence,
});
const deliver = (store: SqliteMemoryItemStore, use: ExperienceUse) =>
  store.experienceLedger.deliverExperienceUse({
    useId: use.useId,
    providerCallId: "provider",
    physicalAttemptId: "attempt",
    deliverySequence: 4,
    now: 14,
  });

test("统一账本：只有实际交付后的工具效果控制当前通用版本，反馈排除与删除重放不恢复正文", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-feedback-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "memory.sqlite"),
    store = new SqliteMemoryItemStore(path, { now: () => 100 });
  t.after(() => store.close());
  const candidate = await generic(store),
    itemId = candidate.itemId!;
  const use = await useFor(
    store,
    itemId,
    { kind: "reviewed-reference", candidateId: "lesson", contentVersion: 1 },
    "use",
  );
  await store.experienceLedger.recordExperienceUse(use);
  await store.experienceLedger.appendExperienceEffect(effectFor(use, 6, "fail"), {
    allowStateChange: true,
  });
  assert.equal((await store.experienceLedger.listExperienceEffects(use.useId)).length, 0);
  assert.equal((await store.taskExperiences.readTaskExperienceCandidate("lesson"))!.enabled, true);
  await deliver(store, use);
  await store.experienceLedger.appendExperienceEffect(effectFor(use, 6), {
    allowStateChange: true,
  });
  await store.experienceLedger.appendExperienceEffect(
    { ...effectFor(use, 6), effectId: "duplicate-effect" },
    { allowStateChange: true },
  );
  await store.experienceLedger.appendExperienceEffect(effectFor(use, 8), {
    allowStateChange: true,
  });
  assert.equal((await store.experienceLedger.listExperienceEffects(use.useId)).length, 2);
  assert.equal(
    (await store.taskExperiences.readTaskExperienceCandidate("lesson"))!.validation,
    "pass",
  );
  await store.experienceLedger.appendExperienceEffect(effectFor(use, 10, "fail"), {
    allowStateChange: true,
  });
  assert.equal((await store.taskExperiences.readTaskExperienceCandidate("lesson"))!.enabled, false);
  assert.equal((await store.experienceLedger.listExperienceEffects(use.useId)).length, 3);
  const current = (await store.taskExperiences.readTaskExperienceCandidate("lesson"))!;
  const edited = await store.taskExperiences.reviewTaskExperience({
    workspaceKey: "workspace",
    candidateId: "lesson",
    expectedRecordRevision: current.recordRevision,
    expectedContentVersion: 1,
    operationId: "edit",
    action: "edit_accept",
    content: "编辑后的独立检查方法。",
    now: 40,
  });
  await assert.rejects(
    store.experienceLedger.feedbackExperienceUse({
      workspaceKey: "workspace",
      useId: use.useId,
      expectedItemVersion: 1,
      operationId: "old-feedback",
      action: "disable",
      now: 41,
    }),
    /version conflict/u,
  );
  assert.equal(edited.enabled, true);
  const nextUse = await useFor(
    store,
    edited.itemId!,
    { kind: "reviewed-reference", candidateId: "lesson", contentVersion: 2 },
    "current-use",
  );
  await store.experienceLedger.recordExperienceUse(nextUse);
  const feedback = {
    workspaceKey: "workspace",
    useId: nextUse.useId,
    expectedItemVersion: 1,
    operationId: "exclude",
    action: "not_applicable" as const,
    now: 42,
  };
  assert.equal((await store.experienceLedger.feedbackExperienceUse(feedback)).excluded, true);
  assert.equal((await store.taskExperiences.readTaskExperienceCandidate("lesson"))!.enabled, true);
  await assert.rejects(
    store.experienceLedger.recordExperienceUse({ ...nextUse, useId: "excluded-new-use" }),
    /binding/u,
  );
  await assert.rejects(
    store.deleteItem({
      itemId: edited.itemId!,
      expectedVersion: 1,
      operationId: "ordinary-delete",
    }),
    /experience review/u,
  );
  const beforeDelete = await store.readDeletionRevision();
  await store.taskExperiences.reviewTaskExperience({
    workspaceKey: "workspace",
    candidateId: "lesson",
    expectedRecordRevision: edited.recordRevision,
    expectedContentVersion: 2,
    operationId: "delete",
    action: "delete",
    now: 50,
  });
  assert.equal(await store.readDeletionRevision(), beforeDelete + 1);
  assert.equal(
    (await store.experienceLedger.feedbackExperienceUse({ ...feedback, now: 51 })).deleted,
    true,
  );
  assert.equal(
    (await store.experienceLedger.readExperienceUse(use.useId))!.referenceContent,
    undefined,
  );
  assert.equal(
    (
      await store.taskExperiences.reviewTaskExperience({
        workspaceKey: "workspace",
        candidateId: "lesson",
        expectedRecordRevision: candidate.recordRevision - 1,
        expectedContentVersion: 1,
        operationId: "accept",
        action: "accept",
        now: 52,
      })
    ).content,
    "",
  );
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    assert.equal(
      db.prepare("SELECT name FROM sqlite_schema WHERE name='task_experience_reuse'").get(),
      undefined,
    );
    for (const table of [
      "experience_uses",
      "experience_effects",
      "experience_feedback",
      "task_experience_actions",
      "execution_learning_candidates",
    ])
      assert.equal(
        JSON.stringify(db.prepare(`SELECT * FROM ${table}`).all()).includes("独立"),
        false,
        table,
      );
  } finally {
    db.close();
  }
});

test("统一账本：native权威反例归档，legacy保留unknown；fence/分页作用域与三类删除清理", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-feedback-native-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "memory.sqlite"),
    store = new SqliteMemoryItemStore(path, { now: () => 100 });
  t.after(() => store.close());
  const created = await store.applyMutations({
    operationId: "native-item",
    mutations: [
      {
        type: "create",
        item: {
          content: "固定命令验收支持的方法。",
          kind: "failure",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: "workspace",
          observedAt: 1,
          origin: "agent_extracted",
          keys: [{ key: "固定命令", keyType: "exact", keyOrigin: "deterministic" }],
          sources: [source("failure")],
        },
      },
    ],
  });
  const itemId = created.results[0]!.itemId,
    item = (await store.readItem(itemId))!.item;
  const candidate: ExecutionLearningCandidate = {
    state: "saved",
    itemId,
    updatedAt: 10,
    claim: {
      candidateId: "native",
      revision: 1,
      failureKey: "native-key",
      predicateId: "command-conditions.v1",
      admission: {
        admissionId: "admission",
        workspaceKey: "workspace",
        workDir: "/fixture",
        sessionId: "session",
        runId: "run",
        inputEpoch: 1,
        managementRevision: 0,
        settingsVersion: 1,
        deletionRevision: 0,
        createdAt: 1,
      },
      target: {
        targetId: "target",
        label: "固定命令",
        kind: "command",
        command: "node check.js",
        argv: ["node", "check.js"],
        cwd: "/fixture",
        scopeHash: hash("scope"),
        entryFiles: [],
      },
      claimHash: hash("claim"),
      conditions: [],
      recipe: [],
      failedTestIds: [],
      failure: source("failure"),
      createdAt: 1,
    },
  };
  const db = new DatabaseSync(path);
  try {
    db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      "native",
      "workspace",
      "session",
      "run",
      "native-key",
      "saved",
      1,
      itemId,
      10,
      JSON.stringify(candidate),
    );
    db.prepare("INSERT INTO execution_learning_items VALUES(?,?,?,'execution-validated',?)").run(
      itemId,
      "native",
      item.contentHash,
      JSON.stringify({
        candidateId: "native",
        predicateId: candidate.claim.predicateId,
        targetId: "target",
        targetLabel: "固定命令",
        acceptedAt: 10,
        claimHash: candidate.claim.claimHash,
        scopeHash: candidate.claim.target.scopeHash,
      }),
    );
  } finally {
    db.close();
  }
  const nativeUse = await useFor(
    store,
    itemId,
    {
      kind: "execution-validated",
      candidateId: "native",
      claimRevision: 1,
      claimHash: candidate.claim.claimHash,
      scopeHash: candidate.claim.target.scopeHash,
    },
    "native-use",
  );
  await store.experienceLedger.recordExperienceUse(nativeUse);
  await deliver(store, nativeUse);
  await store.experienceLedger.appendExperienceEffect(effectFor(nativeUse, 6, "fail", "unknown"), {
    allowStateChange: true,
  });
  assert.equal((await store.readItem(itemId))!.item.lifecycleState, "active");
  await store.experienceLedger.appendExperienceEffect(
    effectFor(nativeUse, 8, "fail", "native-claim"),
    { allowStateChange: true },
  );
  assert.equal((await store.readItem(itemId))!.item.lifecycleState, "archived");
  await store.deleteItem({ itemId, expectedVersion: 2, operationId: "delete-native" });
  assert.equal((await store.experienceLedger.readExperienceUse("native-use"))!.deleted, true);
  assert.equal(
    (await store.executionLearning.readExecutionLearningCandidate("native"))!.claim.target.command,
    "",
  );
  const settings = await store.readSettings("workspace");
  const legacy = await store.createExecutionLesson({
    candidateId: "legacy",
    workspaceKey: "workspace",
    sessionId: "session",
    content: "旧验证路径经验。",
    taskFamily: "检查",
    commandHash: hash("command"),
    evidenceBoundary: 1,
    failure: source("legacy-fail"),
    observedAt: 1,
    settingsVersion: settings.version,
    deletionRevision: await store.readDeletionRevision(),
  });
  const confirmed = await store.verifyExecutionLesson({
    candidateId: "legacy",
    workspaceKey: "workspace",
    sessionId: "session",
    expectedVersion: legacy.version,
    verifications: [source("success1"), source("success2"), source("success3")],
    observedAt: 1,
  });
  assert.equal(confirmed.state, "confirmed");
  const legacyUse = await useFor(
    store,
    confirmed.itemId!,
    {
      kind: "execution-evidence",
      candidateId: "legacy",
      candidateVersion: confirmed.version,
      contentHash: confirmed.itemContentHash!,
    },
    "legacy-use",
  );
  await store.experienceLedger.recordExperienceUse(legacyUse);
  await deliver(store, legacyUse);
  await store.experienceLedger.appendExperienceEffect(
    effectFor(legacyUse, 6, "fail", "native-claim"),
    { allowStateChange: true },
  );
  assert.equal(
    (await store.experienceLedger.readExperienceUse(legacyUse.useId))!.validation,
    "unknown",
  );
  assert.equal((await store.readItem(confirmed.itemId!))!.item.lifecycleState, "active");
  for (let index = 0; index < 3; index++)
    await store.experienceLedger.recordExperienceUse({ ...legacyUse, useId: `page-${index}` });
  const page = await store.experienceLedger.queryExperienceUses("workspace", { limit: 2 });
  assert.equal(page.uses.length, 2);
  assert.ok(page.nextCursor);
  await assert.rejects(
    store.experienceLedger.queryExperienceUses("workspace", {
      sessionId: "other",
      cursor: page.nextCursor,
    }),
    /cursor scope/u,
  );
  assert.equal(
    (
      await store.experienceLedger.queryExperienceUses("workspace", {
        cursor: page.nextCursor,
        limit: 1000,
      })
    ).uses.length,
    3,
  );
  await store.updateSettings({
    workspaceKey: "workspace",
    expectedVersion: settings.version,
    recallEnabled: false,
  });
  await assert.rejects(
    store.experienceLedger.recordExperienceUse({ ...legacyUse, useId: "old-fence" }),
    /policy changed/u,
  );
  const feedback = {
    workspaceKey: "workspace",
    useId: legacyUse.useId,
    expectedItemVersion: 1,
    operationId: "disable-legacy",
    action: "disable" as const,
    now: 80,
  };
  await store.experienceLedger.feedbackExperienceUse(feedback);
  assert.equal((await store.readItem(confirmed.itemId!))!.item.lifecycleState, "archived");
  await store.deleteItem({
    itemId: confirmed.itemId!,
    expectedVersion: 2,
    operationId: "delete-legacy",
  });
  assert.equal(
    (await store.experienceLedger.feedbackExperienceUse({ ...feedback, now: 90 })).referenceContent,
    undefined,
  );
  assert.equal((await store.readExecutionLesson("legacy"))!.content, "");
});

test("旧删除残留仅凭匹配的删除回执修复，缺Item而无删除证据不猜测；冷恢复修复只做一次", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-feedback-repair-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const proven of [true, false]) {
    const path = join(root, `${proven}.sqlite`);
    let store = new SqliteMemoryItemStore(path, { now: () => 100 });
    const candidate = await generic(store);
    const use = await useFor(
      store,
      candidate.itemId!,
      { kind: "reviewed-reference", candidateId: "lesson", contentVersion: 1 },
      "historical-use",
    );
    await store.experienceLedger.recordExperienceUse(use);
    store.close();
    const db = new DatabaseSync(path);
    try {
      db.prepare("DELETE FROM memory_items WHERE item_id=?").run(candidate.itemId!);
      if (proven)
        db.prepare("INSERT INTO memory_write_operations VALUES(?,'delete',?,'[]',?)").run(
          "old-delete",
          hash(JSON.stringify({ itemId: candidate.itemId, expectedVersion: 1 })),
          100,
        );
    } finally {
      db.close();
    }
    store = new SqliteMemoryItemStore(path);
    try {
      const current = (await store.taskExperiences.readTaskExperienceCandidate("lesson"))!;
      assert.equal(current.content === "", proven);
      assert.equal((await store.experienceLedger.readExperienceUse(use.useId))!.deleted, proven);
      const fence = await store.experienceLedger.readExperienceFence("workspace");
      store.close();
      store = new SqliteMemoryItemStore(path);
      assert.deepEqual(await store.experienceLedger.readExperienceFence("workspace"), fence);
    } finally {
      store.close();
    }
  }
});
