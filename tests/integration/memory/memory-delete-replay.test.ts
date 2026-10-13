import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { TestContext } from "node:test";
import type {
  ExecutionLearningCandidate,
  ExperienceUse,
  TaskExperienceCandidate,
} from "@pico/core";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { parseRuntimeResult, RuntimeProtocolError } from "@pico/protocol";
import type { RuntimeNotificationMap, RuntimeParams } from "@pico/protocol";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const source = (eventId: string) => ({
  sessionId: "session",
  runId: "run",
  turnId: "turn",
  eventId,
});
const protocolError = (code: RuntimeProtocolError["code"]) => (error: unknown) =>
  error instanceof RuntimeProtocolError && error.code === code;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "pico-delete-replay-"));
  const workspacePath = join(directory, "workspace"),
    otherWorkspace = join(directory, "other");
  const picoHome = join(directory, "home"),
    path = join(picoHome, "memory.sqlite");
  await Promise.all([mkdir(workspacePath), mkdir(otherWorkspace), mkdir(picoHome)]);
  const workspaceKey = resolvePicoPaths(workspacePath, { picoHome }).workspace.id;
  const notifications: RuntimeNotificationMap["memory.deleted"][] = [];
  const makeService = () =>
    new DesktopAtomicMemoryService({
      picoHome,
      publish: (_workspace, topic, payload) => {
        if (topic === "memory.deleted")
          notifications.push(payload as RuntimeNotificationMap["memory.deleted"]);
      },
    });
  const store = new SqliteMemoryItemStore(path),
    service = makeService();
  t.after(async () => {
    service.close();
    store.close();
    await rm(directory, { recursive: true, force: true });
  });
  return {
    workspacePath,
    otherWorkspace,
    workspaceKey,
    path,
    store,
    service,
    notifications,
    makeService,
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const deleteParams = (
  f: Fixture,
  itemId: string,
  idempotencyKey: string,
): RuntimeParams<"memory.delete"> => ({
  workspacePath: f.workspacePath,
  itemId,
  expectedVersion: 1,
  idempotencyKey,
});

async function seedNative(f: Fixture): Promise<string> {
  const created = await f.store.applyMutations({
    operationId: "seed-native",
    mutations: [
      {
        type: "create",
        item: {
          content: "独立命令已经验收的经验。",
          kind: "failure",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: f.workspaceKey,
          observedAt: 1,
          origin: "agent_extracted",
          keys: [{ key: "独立命令", keyType: "exact", keyOrigin: "deterministic" }],
          sources: [source("failure")],
        },
      },
    ],
  });
  const itemId = created.results[0]!.itemId,
    item = (await f.store.readItem(itemId))!.item;
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
        workspaceKey: f.workspaceKey,
        workDir: f.workspacePath,
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
        label: "独立命令",
        kind: "command",
        command: "node check.js",
        argv: ["node", "check.js"],
        cwd: f.workspacePath,
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
  const db = new DatabaseSync(f.path);
  try {
    db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      "native",
      f.workspaceKey,
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
        targetLabel: "独立命令",
        acceptedAt: 10,
        claimHash: candidate.claim.claimHash,
        scopeHash: candidate.claim.target.scopeHash,
      }),
    );
  } finally {
    db.close();
  }
  assert.equal((await f.store.readItem(itemId))!.sourceType, "execution-validated");
  await recordUse(
    f,
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
  return itemId;
}

async function recordUse(
  f: Fixture,
  itemId: string,
  sourceVersion: ExperienceUse["source"],
  useId: string,
) {
  const item = (await f.store.readItem(itemId))!.item;
  await f.store.experienceLedger.recordExperienceUse({
    useId,
    workspaceKey: f.workspaceKey,
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
    recallSequence: 1,
    delivery: "pending",
    historical: false,
    ...(await f.store.experienceLedger.readExperienceFence(f.workspaceKey)),
    adoption: "unknown",
    validation: "unknown",
    validationScope: "unknown",
    excluded: false,
    deleted: false,
    sources: [],
    createdAt: 10,
    updatedAt: 10,
  });
}

async function seedReviewed(f: Fixture) {
  const settings = await f.store.readSettings(f.workspaceKey);
  const input = await f.store.executionLearning.advanceExecutionLearningInput(f.workspaceKey);
  const task = {
    taskId: "reviewed-task",
    taskVersion: 1,
    workspaceKey: f.workspaceKey,
    workDir: f.workspacePath,
    sessionId: "session",
    runId: "run",
    goal: "检查当前任务",
    goalSource: source("goal"),
    coverage: "complete" as const,
    throughSequence: 2,
    createdAt: 100,
    updatedAt: 100,
  };
  const observation = {
    observationId: "observation",
    taskId: task.taskId,
    taskVersion: 1,
    kind: "tool-result" as const,
    source: source("result"),
    sequence: 2,
    summary: "检查成功",
    coverage: "complete" as const,
    status: "succeeded" as const,
    toolName: "bash",
    createdAt: 100,
  };
  await f.store.taskExperiences.appendTaskExperienceObservations(task, [observation]);
  const candidate: TaskExperienceCandidate = {
    candidateId: "reviewed",
    kind: "task-lesson",
    lifecycleState: "active",
    taskId: task.taskId,
    taskVersion: 1,
    workspaceKey: f.workspaceKey,
    workDir: f.workspacePath,
    sessionId: "session",
    runId: "run",
    failureKey: "reviewed-key",
    inputEpoch: input.inputEpoch,
    settingsVersion: settings.version,
    deletionRevision: await f.store.readDeletionRevision(),
    state: "waiting",
    goal: task.goal,
    content: "",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: [observation.source],
    observationIds: [observation.observationId],
    createdAt: 100,
    updatedAt: 100,
  };
  await f.store.taskExperiences.createTaskExperienceCandidate(candidate);
  const job = await f.store.executionLearning.claimExecutionLearningJob("worker", 200, 90_000);
  assert.ok(job);
  const pending = await f.store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: 1,
    content: "先核对当前检查入口，再读取工具结果。",
    applicability: candidate.applicability,
    sources: candidate.sources,
    now: 300,
  });
  assert.ok(pending);
  return (
    await f.service.reviewExperience(f.workspacePath, {
      workspacePath: f.workspacePath,
      candidateId: "reviewed",
      expectedRecordRevision: pending.recordRevision,
      expectedContentVersion: 1,
      operationId: "accept-reviewed",
      action: "accept",
    })
  ).candidate;
}

test("原生执行经验删除的即时及冷重放成功，回执和删除代次不重复且正文不恢复", async (t) => {
  const f = await fixture(t),
    nativeId = await seedNative(f);
  for (const [itemId, useId] of [[nativeId, "native-use"]] as const) {
    const params = deleteParams(f, itemId, `delete-${useId}`);
    const before = await f.store.readDeletionRevision();
    for (let index = 0; index < 2; index++)
      assert.deepEqual(
        parseRuntimeResult("memory.delete", await f.service.delete(f.workspacePath, params)),
        { itemId, deleted: true },
      );
    const reopened = f.makeService();
    try {
      assert.deepEqual(await reopened.delete(f.workspacePath, params), { itemId, deleted: true });
    } finally {
      reopened.close();
    }
    assert.equal(await f.store.readDeletionRevision(), before + 1);
    assert.equal(await f.store.readItem(itemId), undefined);
    const use = await f.store.experienceLedger.readExperienceUse(useId);
    assert.equal(use?.deleted, true);
    assert.equal(use?.referenceContent, undefined);
    assert.ok(
      f.notifications
        .filter((event) => event.itemId === itemId)
        .every((event) => event.version === 2),
    );
  }
  const db = new DatabaseSync(f.path, { readOnly: true });
  try {
    assert.equal(
      db
        .prepare("SELECT count(*) n FROM memory_write_operations WHERE operation_type='delete'")
        .get()!.n,
      1,
    );
  } finally {
    db.close();
  }
});

test("反馈与重放保持未确认携带投影，用户排除不会改写历史证据", async (t) => {
  const f = await fixture(t);
  const itemId = await seedNative(f);
  await f.store.experienceLedger.deliverExperienceUse({
    useId: "native-use",
    providerCallId: "missing-call",
    physicalAttemptId: "missing-attempt",
    deliverySequence: 2,
    now: 20,
  });
  assert.equal(
    (await f.store.experienceLedger.readExperienceUse("native-use"))?.delivery,
    "carried",
  );
  assert.equal(
    (
      await f.service.queryExperienceUses(f.workspacePath, {
        workspacePath: f.workspacePath,
        itemId,
      })
    ).uses[0]?.delivery,
    "unknown",
  );
  assert.equal(
    (await f.service.detailExperienceUse(f.workspacePath, "native-use")).use.delivery,
    "unknown",
  );
  const params: RuntimeParams<"memory.experience.feedback"> = {
    workspacePath: f.workspacePath,
    useId: "native-use",
    expectedItemVersion: 1,
    operationId: "exclude-unconfirmed",
    action: "not_applicable",
  };
  for (let index = 0; index < 2; index++) {
    const response = parseRuntimeResult(
      "memory.experience.feedback",
      await f.service.feedbackExperienceUse(f.workspacePath, params),
    );
    assert.equal(response.use.delivery, "unknown");
    assert.equal(response.use.excluded, true);
  }
  const canonical = await f.store.experienceLedger.readExperienceUse("native-use");
  assert.equal(canonical?.delivery, "carried");
  assert.equal(canonical?.excluded, true);
});

test("删除重放核对参数与操作类型，拒绝跨工作区、无回执和审核经验普通删除", async (t) => {
  const f = await fixture(t);
  const first = (await f.service.create(f.workspacePath, "第一个本地记忆。")).item;
  const other = (await f.service.create(f.workspacePath, "第二个本地记忆。")).item;
  const params = deleteParams(f, first.itemId, "delete-key");
  await assert.rejects(
    f.service.delete(f.otherWorkspace, { ...params, workspacePath: f.otherWorkspace }),
    protocolError("NOT_FOUND"),
  );
  await f.service.delete(f.workspacePath, params);
  await assert.rejects(
    f.service.delete(f.workspacePath, { ...params, expectedVersion: 2 }),
    protocolError("CONFLICT"),
  );
  await assert.rejects(
    f.service.delete(f.workspacePath, { ...params, itemId: other.itemId }),
    protocolError("CONFLICT"),
  );
  await assert.rejects(
    f.service.delete(f.otherWorkspace, { ...params, workspacePath: f.otherWorkspace }),
    protocolError("NOT_FOUND"),
  );
  await assert.rejects(
    f.service.delete(f.workspacePath, { ...params, idempotencyKey: "no-receipt" }),
    protocolError("NOT_FOUND"),
  );
  await f.service.update(f.workspacePath, {
    ...deleteParams(f, other.itemId, "update-key"),
    content: "第二个本地记忆已更正。",
  });
  await assert.rejects(
    f.service.delete(f.workspacePath, {
      ...deleteParams(f, other.itemId, "update-key"),
      expectedVersion: 2,
    }),
    protocolError("CONFLICT"),
  );
  assert.ok(await f.store.readItem(other.itemId));
  const reviewed = await seedReviewed(f);
  await assert.rejects(
    f.service.delete(f.workspacePath, deleteParams(f, reviewed.itemId!, "ordinary-reviewed")),
    /经验管理中删除/u,
  );
  const reviewDelete = {
    workspacePath: f.workspacePath,
    candidateId: reviewed.candidateId,
    expectedRecordRevision: reviewed.recordRevision,
    expectedContentVersion: reviewed.contentVersion,
    operationId: "review-delete",
    action: "delete" as const,
  };
  await f.service.reviewExperience(f.workspacePath, reviewDelete);
  assert.equal(
    (await f.service.reviewExperience(f.workspacePath, reviewDelete)).candidate.state,
    "discarded",
  );
  await assert.rejects(
    f.service.delete(f.workspacePath, deleteParams(f, reviewed.itemId!, "ordinary-reviewed")),
    protocolError("NOT_FOUND"),
  );
});

test("并发删除覆盖回执查询与Item授权间竞态，提交后失去响应可重放并补发同版本通知", async (t) => {
  const f = await fixture(t);
  const item = (await f.service.create(f.workspacePath, "并发删除的本地经验。")).item;
  const params = deleteParams(f, item.itemId, "concurrent-delete");
  const operationId = `desktop:${hash(JSON.stringify([f.workspaceKey, params.idempotencyKey]))}`;
  const originalReadOperation = SqliteMemoryItemStore.prototype.readOperation;
  let interleaved = false;
  SqliteMemoryItemStore.prototype.readOperation = async function (id) {
    const receipt = await originalReadOperation.call(this, id);
    if (id === operationId && !receipt && !interleaved) {
      interleaved = true;
      assert.deepEqual(await f.service.delete(f.workspacePath, params), {
        itemId: item.itemId,
        deleted: true,
      });
    }
    return receipt;
  };
  try {
    assert.deepEqual(await f.service.delete(f.workspacePath, params), {
      itemId: item.itemId,
      deleted: true,
    });
  } finally {
    SqliteMemoryItemStore.prototype.readOperation = originalReadOperation;
  }
  assert.equal(interleaved, true);
  assert.equal(await f.store.readDeletionRevision(), 1);
  assert.equal(await f.store.readItem(item.itemId), undefined);

  const simultaneous = (await f.service.create(f.workspacePath, "两请求同时读取的经验。")).item;
  const simultaneousParams = deleteParams(f, simultaneous.itemId, "simultaneous");
  const results = await Promise.all([
    f.service.delete(f.workspacePath, simultaneousParams),
    f.service.delete(f.workspacePath, simultaneousParams),
  ]);
  assert.deepEqual(results, [
    { itemId: simultaneous.itemId, deleted: true },
    { itemId: simultaneous.itemId, deleted: true },
  ]);
  assert.equal(await f.store.readDeletionRevision(), 2);

  const interrupted = (await f.service.create(f.workspacePath, "提交后失去响应的经验。")).item;
  const interruptedParams = deleteParams(f, interrupted.itemId, "after-commit");
  const originalDelete = SqliteMemoryItemStore.prototype.deleteItem;
  let interruptOnce = true;
  SqliteMemoryItemStore.prototype.deleteItem = async function (input) {
    await originalDelete.call(this, input);
    if (input.itemId === interrupted.itemId && interruptOnce) {
      interruptOnce = false;
      throw new Error("Simulated response loss after committed delete");
    }
  };
  try {
    await assert.rejects(
      f.service.delete(f.workspacePath, interruptedParams),
      protocolError("INTERNAL_ERROR"),
    );
  } finally {
    SqliteMemoryItemStore.prototype.deleteItem = originalDelete;
  }
  assert.equal(await f.store.readItem(interrupted.itemId), undefined);
  assert.equal(
    f.notifications.some((event) => event.itemId === interrupted.itemId),
    false,
  );
  const reopened = f.makeService();
  try {
    assert.deepEqual(await reopened.delete(f.workspacePath, interruptedParams), {
      itemId: interrupted.itemId,
      deleted: true,
    });
  } finally {
    reopened.close();
  }
  assert.equal(await f.store.readDeletionRevision(), 3);
  assert.ok(
    f.notifications.some((event) => event.itemId === interrupted.itemId && event.version === 2),
  );
});
