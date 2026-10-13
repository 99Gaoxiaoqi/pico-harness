import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceTask,
} from "@pico/core";
import { DesktopAtomicMemoryService } from "@pico/pico-host/desktop-atomic-memory-service";
import { resolvePicoPaths } from "@pico/pico-host/pico-paths";
import { parseRuntimeResult, RUNTIME_ERROR_CODES, RuntimeProtocolError } from "@pico/protocol";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const content = "处理文档任务时，先核对来源与用户更正，再整理结论，并明确尚未确认的部分。";

async function seedPendingExperience(
  store: SqliteMemoryItemStore,
  workspacePath: string,
  workspaceKey: string,
): Promise<TaskExperienceCandidate> {
  const settings = await store.readSettings(workspaceKey);
  const input = await store.executionLearning.advanceExecutionLearningInput(workspaceKey);
  const source = {
    sessionId: "source-session",
    runId: "source-run",
    turnId: "source-turn",
    eventId: "task-goal-event",
  };
  const task: TaskExperienceTask = {
    taskId: "document-task",
    taskVersion: 1,
    workspaceKey,
    workDir: workspacePath,
    sessionId: source.sessionId,
    runId: source.runId,
    goal: "结合用户更正整理项目文档任务的结论",
    goalSource: source,
    coverage: "complete",
    throughSequence: 2,
    createdAt: 100,
    updatedAt: 100,
  };
  const observations: readonly TaskExperienceObservation[] = [
    {
      observationId: "user-correction",
      taskId: task.taskId,
      taskVersion: task.taskVersion,
      kind: "user-input",
      source,
      sequence: 1,
      summary: "用户纠正文档中的旧结论，要求先核对来源。",
      correction: true,
      coverage: "complete",
      createdAt: 100,
    },
    {
      observationId: "document-result",
      taskId: task.taskId,
      taskVersion: task.taskVersion,
      kind: "tool-result",
      source: { ...source, eventId: "document-result-event" },
      sequence: 2,
      summary: "工具完整返回项目文档内容。",
      status: "succeeded",
      toolName: "document.query",
      coverage: "complete",
      createdAt: 100,
    },
  ];
  await store.taskExperiences.appendTaskExperienceObservations(task, observations);
  const initial: TaskExperienceCandidate = {
    candidateId: "document-lesson",
    kind: "task-lesson",
    lifecycleState: "active",
    taskId: task.taskId,
    taskVersion: task.taskVersion,
    workspaceKey,
    workDir: workspacePath,
    sessionId: task.sessionId,
    runId: task.runId,
    failureKey: "document-task-lesson",
    inputEpoch: input.inputEpoch,
    settingsVersion: settings.version,
    deletionRevision: await store.readDeletionRevision(),
    state: "waiting",
    goal: task.goal,
    content: "",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: observations.map((observation) => observation.source),
    observationIds: observations.map((observation) => observation.observationId),
    createdAt: 100,
    updatedAt: 100,
  };
  await store.taskExperiences.createTaskExperienceCandidate(initial);
  const job = await store.executionLearning.claimExecutionLearningJob(
    "service-fixture",
    200,
    90_000,
  );
  assert.ok(job);
  assert.equal(job.candidateId, initial.candidateId);
  const pending = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: initial.recordRevision,
    content,
    applicability: {
      taskFamily: "general",
      toolNames: [],
      conditions: ["当用户明确纠正了旧结论时，先核对来源与上下文"],
    },
    sources: initial.sources,
    now: 300,
  });
  assert.ok(pending);
  assert.equal(pending.review, "pending");
  assert.equal(pending.enabled, false);
  assert.equal(pending.validation, "unknown");
  return pending;
}

const protocolError = (code: RuntimeProtocolError["code"]) => (error: unknown) =>
  error instanceof RuntimeProtocolError && error.code === code;

test("Host 验证附件不泄漏到既有审核协议，也不向用户暴露内部证据候选", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-internal-experience-evidence-"));
  const workspacePath = join(root, "workspace"), picoHome = join(root, "home");
  await mkdir(workspacePath);
  const workspaceKey = resolvePicoPaths(workspacePath, { picoHome }).workspace.id;
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"), { now: () => 1000 });
  const service = new DesktopAtomicMemoryService({ picoHome, now: () => 1000, publish: () => {} });
  t.after(async () => { service.close(); store.close(); await rm(root, { recursive: true, force: true }); });
  const pending = await seedPendingExperience(store, workspacePath, workspaceKey);
  // Simulate a persisted Host-only attachment. No model or public review input can supply it.
  const db = new DatabaseSync(join(picoHome, "memory.sqlite"));
  try {
    db.prepare("UPDATE execution_learning_candidates SET record_json=json_set(record_json,'$.nativeEvidence',json(?)) WHERE candidate_id=?")
      .run(JSON.stringify({ candidateId: "internal-proof", claimRevision: 1, claimHash: "a".repeat(64), scopeHash: "b".repeat(64) }), pending.candidateId);
  } finally { db.close(); }
  assert.ok((await store.taskExperiences.readTaskExperienceCandidate(pending.candidateId))?.nativeEvidence);
  const query = await service.queryExperiences(workspacePath, { workspacePath });
  parseRuntimeResult("memory.learning.query", query);
  assert.equal("nativeEvidence" in query.items[0]!, false);
  const detail = await service.detailExperience(workspacePath, pending.candidateId);
  parseRuntimeResult("memory.learning.detail", detail);
  assert.equal("nativeEvidence" in detail.candidate, false);
  const review = await service.reviewExperience(workspacePath, {
    workspacePath, candidateId: pending.candidateId, expectedRecordRevision: pending.recordRevision,
    expectedContentVersion: pending.contentVersion, operationId: "disable-internal-evidence", action: "disable",
  });
  parseRuntimeResult("memory.learning.review", review);
  assert.equal("nativeEvidence" in review.candidate, false);
  assert.deepEqual((await service.listLearning(workspacePath)).items, []);
  await assert.rejects(service.inspectLearning(workspacePath, "internal-proof"), protocolError(RUNTIME_ERROR_CODES.NOT_FOUND));
  await assert.rejects(service.discardLearning(workspacePath, "internal-proof", 1), protocolError(RUNTIME_ERROR_CODES.NOT_FOUND));
});

test("真实 SQLite 与 Desktop v2 审核闭环隔离旧视图、保留未验证参考并支持关闭自动学习后管理", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-experience-service-"));
  const workspacePath = join(root, "workspace");
  const picoHome = join(root, "home");
  await mkdir(workspacePath);
  const workspaceKey = resolvePicoPaths(workspacePath, { picoHome }).workspace.id;
  const notifications: string[] = [];
  const service = new DesktopAtomicMemoryService({
    picoHome,
    now: () => 1000,
    publish: (_workspacePath, topic) => notifications.push(topic),
  });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"), { now: () => 1000 });
  try {
    const manual = await service.create(workspacePath, "项目文档位于 docs 目录。");
    const pending = await seedPendingExperience(store, workspacePath, workspaceKey);
    const params = { workspacePath, query: "处理项目文档任务" };
    const pendingPreview = parseRuntimeResult(
      "memory.context.preview",
      await service.previewContext(workspacePath, { ...params, learningVersion: 2 }),
    );
    assert.equal(
      pendingPreview.items.some((item) => item.taskExperience),
      false,
    );
    assert.equal((pendingPreview.block ?? "").includes(content), false);

    const query = parseRuntimeResult(
      "memory.learning.query",
      await service.queryExperiences(workspacePath, { workspacePath, review: "pending" }),
    );
    assert.equal(query.learningVersion, 2);
    assert.equal(query.workspaceKey, workspaceKey);
    assert.equal(query.items[0]?.candidateId, pending.candidateId);
    const detail = parseRuntimeResult(
      "memory.learning.detail",
      await service.detailExperience(workspacePath, pending.candidateId),
    );
    assert.equal(detail.observations.length, 2);
    assert.equal(
      detail.observations.some((observation) => observation.correction),
      true,
    );
    const accepted = parseRuntimeResult(
      "memory.learning.review",
      await service.reviewExperience(workspacePath, {
        workspacePath,
        candidateId: pending.candidateId,
        expectedRecordRevision: pending.recordRevision,
        expectedContentVersion: pending.contentVersion,
        operationId: "accept-document-lesson",
        action: "accept",
      }),
    ).candidate;
    assert.equal(accepted.review, "approved");
    assert.equal(accepted.validation, "unknown");
    assert.equal(accepted.enabled, true);
    const itemId = accepted.itemId;
    assert.ok(itemId);

    const legacy = parseRuntimeResult(
      "memory.list",
      await service.list(workspacePath, { workspacePath }),
    );
    assert.deepEqual(
      legacy.items.map((item) => item.itemId),
      [manual.item.itemId],
    );
    const legacyPage = parseRuntimeResult(
      "memory.list",
      await service.list(workspacePath, { workspacePath, paged: true }),
    );
    assert.deepEqual(
      legacyPage.items.map((item) => item.itemId),
      [manual.item.itemId],
    );
    assert.ok(legacyPage.pageInfo);
    assert.deepEqual(legacyPage.pageInfo.counts, { active: 1, archived: 0, total: 1 });
    await assert.rejects(
      service.get(workspacePath, itemId),
      protocolError(RUNTIME_ERROR_CODES.NOT_FOUND),
    );
    const legacyPreview = parseRuntimeResult(
      "memory.context.preview",
      await service.previewContext(workspacePath, params),
    );
    assert.equal(
      legacyPreview.items.some((item) => item.itemId === itemId),
      false,
    );
    assert.equal(
      legacyPreview.references?.some((reference) => reference.source === "reviewed-reference"),
      false,
    );
    assert.equal((legacyPreview.block ?? "").includes(content), false);

    const v2Item = parseRuntimeResult("memory.get", await service.get(workspacePath, itemId, 2));
    assert.equal(v2Item.learningVersion, 2);
    assert.equal(v2Item.item.sourceType, "reviewed-reference");
    assert.equal(v2Item.item.taskExperience?.review, "approved");
    assert.equal(v2Item.item.taskExperience?.validation, "unknown");
    assert.equal(v2Item.item.taskAcceptance, undefined);
    const v2List = parseRuntimeResult(
      "memory.list",
      await service.list(workspacePath, { workspacePath, learningVersion: 2 }),
    );
    assert.equal(v2List.learningVersion, 2);
    assert.equal(
      v2List.items.some(
        (item) => item.itemId === itemId && item.sourceType === "reviewed-reference",
      ),
      true,
    );
    const v2Page = parseRuntimeResult(
      "memory.list",
      await service.list(workspacePath, { workspacePath, paged: true, learningVersion: 2 }),
    );
    assert.ok(v2Page.pageInfo);
    assert.equal(v2Page.pageInfo.counts.total, 2);
    assert.equal(
      v2Page.items.some(
        (item) =>
          item.itemId === itemId && item.taskExperience?.candidateId === accepted.candidateId,
      ),
      true,
    );

    const beforeReuse = await store.taskExperiences.listTaskExperienceReuse(workspaceKey);
    const preview = parseRuntimeResult(
      "memory.context.preview",
      await service.previewContext(workspacePath, { ...params, learningVersion: 2 }),
    );
    assert.equal(preview.learningVersion, 2);
    assert.equal(
      preview.references?.some(
        (reference) => reference.itemId === itemId && reference.source === "reviewed-reference",
      ),
      true,
    );
    const block = preview.block;
    assert.ok(block);
    assert.equal(block.includes(content), true);
    assert.equal(block.includes(accepted.applicability.conditions[0]!), true);
    assert.match(block, /引用不代表采用或验证/);
    assert.deepEqual(
      await store.taskExperiences.listTaskExperienceReuse(workspaceKey),
      beforeReuse,
      "管理预览不生成采用或验证回执",
    );
    assert.equal(
      (await store.taskExperiences.readTaskExperienceCandidate(accepted.candidateId))?.validation,
      "unknown",
    );

    await assert.rejects(
      service.reviewExperience(workspacePath, {
        workspacePath,
        candidateId: accepted.candidateId,
        expectedRecordRevision: pending.recordRevision,
        expectedContentVersion: pending.contentVersion,
        operationId: "stale-disable-document-lesson",
        action: "disable",
      }),
      protocolError(RUNTIME_ERROR_CODES.CONFLICT),
    );
    assert.equal(
      (await store.taskExperiences.readTaskExperienceCandidate(accepted.candidateId))?.enabled,
      true,
    );

    const settings = (await service.getSettings(workspacePath)).settings;
    await service.updateSettings(workspacePath, {
      workspacePath,
      expectedVersion: settings.version,
      idempotencyKey: "disable-auto-extraction",
      autoExtract: false,
    });
    assert.equal((await service.getSettings(workspacePath)).settings.autoExtract, false);
    const historicalQuery = parseRuntimeResult(
      "memory.learning.query",
      await service.queryExperiences(workspacePath, { workspacePath }),
    );
    assert.equal(
      historicalQuery.items.some((item) => item.candidateId === accepted.candidateId),
      true,
    );
    const historicalDetail = parseRuntimeResult(
      "memory.learning.detail",
      await service.detailExperience(workspacePath, accepted.candidateId),
    );
    const disabled = parseRuntimeResult(
      "memory.learning.review",
      await service.reviewExperience(workspacePath, {
        workspacePath,
        candidateId: accepted.candidateId,
        expectedRecordRevision: historicalDetail.candidate.recordRevision,
        expectedContentVersion: historicalDetail.candidate.contentVersion,
        operationId: "disable-after-auto-extraction-off",
        action: "disable",
      }),
    ).candidate;
    assert.equal(disabled.enabled, false);
    const restored = parseRuntimeResult(
      "memory.learning.review",
      await service.reviewExperience(workspacePath, {
        workspacePath,
        candidateId: disabled.candidateId,
        expectedRecordRevision: disabled.recordRevision,
        expectedContentVersion: disabled.contentVersion,
        operationId: "restore-after-auto-extraction-off",
        action: "restore",
      }),
    ).candidate;
    assert.equal(restored.review, "approved");
    assert.equal(restored.enabled, true);
    assert.equal(restored.contentVersion, accepted.contentVersion);
    assert.equal(notifications.includes("memory.learning.changed"), true);
  } finally {
    store.close();
    service.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("shared experience RPC projects history, enforces deletion route, and replays feedback without resurrecting prose", async t => {
  const root = await mkdtemp(join(tmpdir(), "pico-experience-rpc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspacePath = join(root, "workspace"), picoHome = join(root, "home");
  await mkdir(workspacePath); await mkdir(picoHome);
  const workspaceKey = resolvePicoPaths(workspacePath, {picoHome}).workspace.id;
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"), {now:()=>1000});
  const service = new DesktopAtomicMemoryService({picoHome,now:()=>1000,publish:()=>{}});
  t.after(()=>{service.close();store.close();});
  const pending=await seedPendingExperience(store,workspacePath,workspaceKey);
  const accepted=(await service.reviewExperience(workspacePath,{workspacePath,candidateId:pending.candidateId,expectedContentVersion:pending.contentVersion,expectedRecordRevision:pending.recordRevision,operationId:'rpc-accept',action:'accept'})).candidate;
  const itemId=accepted.itemId!;
  await store.taskExperiences.recordTaskExperienceReuse({reuseId:'historical-rpc-use',workspaceKey,candidateId:accepted.candidateId,contentVersion:accepted.contentVersion,itemId,itemVersion:1,taskId:accepted.taskId,taskVersion:accepted.taskVersion,sessionId:accepted.sessionId,runId:accepted.runId,referenceHash:'a'.repeat(64),referenceContent:content,adoption:'unknown',validation:'unknown',excluded:false,sources:[],createdAt:500,updatedAt:500});
  await store.experienceLedger.recordExperienceDiagnostic({diagnosticId:'rpc-diagnostic',workspaceKey,sessionId:accepted.sessionId,runId:accepted.runId,phase:'effect',reason:'experience_validation_unavailable',createdAt:600});
  await assert.rejects(store.experienceLedger.recordExperienceDiagnostic({diagnosticId:'bad-diagnostic',workspaceKey,sessionId:accepted.sessionId,runId:accepted.runId,phase:'effect',reason:'private /home/path or raw error',createdAt:601}));
  const query=parseRuntimeResult('memory.experience.query',await service.queryExperienceUses(workspacePath,{workspacePath,sessionId:accepted.sessionId}));
  assert.equal(query.diagnostics.length,1);
  assert.equal(query.diagnostics[0]!.reason,'experience_validation_unavailable');
  assert.equal(query.uses.length,1);assert.equal(query.uses[0]!.source.kind,'reviewed-reference');assert.equal(query.uses[0]!.historical,true);assert.equal(query.uses[0]!.delivery,'unknown');
  parseRuntimeResult('memory.experience.detail',await service.detailExperienceUse(workspacePath,'historical-rpc-use'));
  await assert.rejects(service.delete(workspacePath,{workspacePath,itemId,expectedVersion:1,idempotencyKey:'wrong-route'}),/经验管理中删除/u);
  assert.ok(await store.readItem(itemId));
  const feedback={workspacePath,useId:'historical-rpc-use',expectedItemVersion:1,operationId:'rpc-disable',action:'disable' as const};
  parseRuntimeResult('memory.experience.feedback',await service.feedbackExperienceUse(workspacePath,feedback));
  assert.equal((await store.taskExperiences.readTaskExperienceCandidate(accepted.candidateId))?.enabled,false);
  const current=(await store.taskExperiences.readTaskExperienceCandidate(accepted.candidateId))!;
  await service.reviewExperience(workspacePath,{workspacePath,candidateId:current.candidateId,expectedContentVersion:current.contentVersion,expectedRecordRevision:current.recordRevision,operationId:'rpc-delete',action:'delete'});
  const replay=parseRuntimeResult('memory.experience.feedback',await service.feedbackExperienceUse(workspacePath,feedback));
  assert.equal(replay.use.deleted,true);assert.equal(replay.use.referenceContent,undefined);
  await assert.rejects(service.detailExperienceUse(join(root,'another-workspace'),'historical-rpc-use'),/当前工作区没有/u);
});
