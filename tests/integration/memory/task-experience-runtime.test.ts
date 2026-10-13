import type { RuntimeEvent } from "@pico/storage/runtime-event";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import type { RuntimeToolStartedEvent, TaskExperienceStore } from "@pico/core";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { SqliteRuntimeControlStore } from "@pico/storage/sqlite/sqlite-runtime-control-store";
import { AtomicMemoryContextBuilder } from "../../../packages/runtime/src/atomic-memory/context-builder.js";
import {
  TaskExperienceRuntime,
  validateCanonicalTaskExperienceSource,
} from "../../../packages/pico-host/src/task-experience-runtime.js";
import {
  ExperienceFeedbackRuntime,
  type ExperienceFeedbackRuntimeOptions,
} from "../../../packages/pico-host/src/experience-feedback-runtime.js";
import { createExecutionLearningIO } from "../../../packages/pico-host/src/execution-learning-recall.js";
import { taskExperienceRecallTargets } from "../../../packages/pico-host/src/task-experience-recall.js";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { globalSessionManager } from "@pico/pico-host/session";
import { resolvePicoPaths } from "@pico/pico-host";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { createMemoryRecallTrace } from "../../../packages/runtime/src/memory-recall-trace.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

async function recordPendingReference(
  store: SqliteMemoryItemStore,
  events: SqliteRuntimeEventStore,
  ownerFence: Awaited<ReturnType<SqliteRuntimeEventStore["advanceOwnerFence"]>>,
  identity: TaskExperienceRuntime,
  sessionId: string,
  runId: string,
  workspaceKey: string,
  workDir: string,
  result: Awaited<ReturnType<AtomicMemoryContextBuilder["build"]>>,
  verifierOptions?: Pick<
    ExperienceFeedbackRuntimeOptions,
    "effectGate" | "validateReviewed" | "onDiagnostic"
  >,
) {
  const start = (await events.readRun(sessionId, runId)).find(
    (event) => event.kind === "run.started",
  )!;
  const recallEventId = `${runId}-reference-recall`;
  await events.append(
    {
      ...start,
      kind: "memory.recall.recorded",
      eventId: recallEventId,
      visibility: "internal",
      data: result.trace!,
    },
    { ownerFence },
  );
  const feedback = new ExperienceFeedbackRuntime({
    session: { id: sessionId, runtimeEventStore: events },
    workspaceKey,
    workDir,
    picoHome: workDir,
    store,
    currentTask: () => identity.currentTaskSnapshot(),
    referenceGate: async () => ({ allowed: true }),
    effectGate: async () => ({ allowed: true }),
    nativeGate: async () => ({ allowed: true }),
    io: createExecutionLearningIO(workDir),
    validateReviewed: async () => ({ adoption: "unknown", validation: "unknown", sources: [] }),
    ...verifierOptions,
  });
  feedback.admit(runId);
  await feedback.recordReferences(result, recallEventId);
  return feedback;
}

test("普通任务按 canonical 用户消息关联纠正并版本化；只有批准引用才记实际引用且采用保持 unknown", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-experience-runtime-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const memoryPath = join(root, "memory.sqlite");
  const store = new SqliteMemoryItemStore(memoryPath);
  const events = new SqliteRuntimeEventStore({ storageRoot: join(root, "events") });
  const sessionId = "ordinary-task";
  const workspaceKey = "fixture-workspace";
  await events.initializeSession({ sessionId, workDir });
  const ownerFence = await events.advanceOwnerFence(sessionId, 0);
  t.after(async () => {
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = (runId: string, eventId: string) => ({
    schemaVersion: 2 as const,
    sessionId,
    runId,
    eventId,
    invocationId: runId,
    turnId: `${runId}-turn`,
    at: new Date().toISOString(),
    partial: false,
    visibility: "model" as const,
  });
  const append = (event: RuntimeEvent) => events.append(event, { ownerFence });
  const start = async (runId: string, content: string) => {
    await append({
      ...base(runId, `${runId}-start`),
      kind: "run.started",
      data: { workDir, agentSwarmAuthorization: "none" },
    });
    await append({
      ...base(runId, `${runId}-input`),
      kind: "message.committed",
      data: { message: { role: "user", content } },
    });
  };
  const terminal = (runId: string) =>
    append({
      ...base(runId, `${runId}-terminal`),
      kind: "run.terminal",
      data: { status: "completed" },
    });
  const runtime = () =>
    new TaskExperienceRuntime({
      session: { id: sessionId, runtimeEventStore: events },
      workspaceKey,
      workDir,
      store,
      gate: async () => ({ allowed: true }),
      worker: { wake() {} },
      modelRoute: {
        providerId: "fixture",
        modelId: "fixture-model",
        configRevision: "fixture-revision",
      },
    });

  await start("first", "求表格 B2:B4 所有数值的总和。");
  const first = runtime();
  await first.admit("first");
  await first.capture();
  const argumentsJson = JSON.stringify({
    artifact_id: "historical-file",
    action: "read",
    range: "B2:B4",
    header: false,
  });
  const toolCallId = "read-table";
  const prepared: RuntimeToolStartedEvent = {
    ...base("first", "read-prepared"),
    kind: "tool.started",
    refs: { toolCallId },
    data: {
      toolName: "document",
      argumentsJson,
      argumentsHash: sha(argumentsJson),
      argumentsRedacted: false,
      recoveryMode: "replay_safe",
    },
  };
  const operation = await events.prepareToolOperation({
    dispatchEvent: prepared,
    toolCallId,
    ownerFence,
  });
  const resultContent = "source result contains only a bounded preview";
  await events.settleToolOperation({
    toolCallId,
    expectedVersion: operation.operation.version,
    ownerFence,
    resultEvent: {
      ...base("first", "read-result"),
      kind: "tool.result.recorded",
      refs: { toolCallId },
      data: {
        toolName: "document",
        status: "succeeded",
        body: {
          storage: "inline",
          content: resultContent,
          sha256: sha(resultContent),
          sizeBytes: Buffer.byteLength(resultContent),
        },
        projection: {
          version: 1,
          mode: "full",
          text: resultContent,
          strategy: "full",
          truncated: false,
        },
      },
    },
  });
  await first.capture();
  await terminal("first");
  await first.completed("first");
  const original = await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId);
  assert.ok(original);
  assert.equal(original.taskVersion, 1);
  assert.equal(original.goalSource.eventId, "first-input");
  assert.deepEqual(
    await store.taskExperiences.queryTaskExperiences(workspaceKey),
    [],
    "成功任务不会固定概率生成候选",
  );
  assert.ok(
    await validateCanonicalTaskExperienceSource(events, original.goalSource, { workDir }),
    "canonical输入ID也是可引用证据",
  );
  assert.equal(
    await validateCanonicalTaskExperienceSource(events, {
      ...original.goalSource,
      turnId: "forged-turn",
    }),
    undefined,
  );
  const firstObservations = await store.taskExperiences.listTaskExperienceObservations(
    original.taskId,
  );
  assert.equal(
    firstObservations.filter((observation) => observation.kind === "tool-result").length,
    1,
  );
  assert.equal(
    firstObservations.find((observation) => observation.kind === "tool-result")?.arguments
      ?.artifact_id,
    undefined,
  );

  await start("correction", "B2也是数据，不是表头，请重算。");
  const correctedRuntime = runtime();
  await correctedRuntime.admit("correction");
  await correctedRuntime.capture();
  await terminal("correction");
  await correctedRuntime.completed("correction");
  const corrected = await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId);
  assert.equal(corrected?.taskId, original.taskId);
  assert.equal(corrected?.taskVersion, 2);
  assert.equal(corrected?.goalSource.eventId, "first-input");
  const candidate = (await store.taskExperiences.queryTaskExperiences(workspaceKey))[0];
  assert.ok(candidate);
  assert.equal(candidate.kind, "task-lesson");
  assert.equal(candidate.taskVersion, 2);
  assert.equal(candidate.content, "");
  assert.equal(candidate.state, "waiting");
  assert.equal(candidate.review, "unneeded");
  assert.equal(candidate.modelRoute?.modelId, "fixture-model");
  assert.ok(candidate.sources.some((source) => source.eventId === "first-input"));
  assert.ok(candidate.sources.some((source) => source.eventId === "correction-input"));

  const job = await store.executionLearning.claimExecutionLearningJob(
    "fixture-worker",
    Date.now(),
    60_000,
  );
  assert.ok(job);
  const pending = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: candidate.recordRevision,
    content: "求和前先明确当前文件和完整范围；只根据实际完整读取结果计算。",
    applicability: { taskFamily: "general", toolNames: ["document"], conditions: [] },
    sources: candidate.sources,
    now: Date.now(),
  });
  assert.ok(pending);
  assert.equal(pending.review, "pending");
  const builder = new AtomicMemoryContextBuilder(store, workspaceKey);
  assert.equal((await builder.build("重新求和")).references.length, 0);
  const approved = await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: pending.candidateId,
    expectedRecordRevision: pending.recordRevision,
    expectedContentVersion: pending.contentVersion,
    operationId: "approve-fixture",
    action: "accept",
    now: Date.now(),
  });
  assert.equal(approved.review, "approved");

  await start("reuse", "对当前文件重新求和。");
  const reuseRuntime = runtime();
  await reuseRuntime.admit("reuse");
  await reuseRuntime.capture();
  const next = await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId);
  assert.notEqual(next?.taskId, original.taskId, "无法证明纠正关联的新任务不得合并");
  assert.equal(next?.previousTaskId, original.taskId);
  const identities = await taskExperienceRecallTargets({
    store: store.taskExperiences,
    workspaceKey,
    workDir,
    query: "重新求和",
    toolAllowed: (name) => name === "document",
  });
  const recalled = await builder.build("重新求和", { reviewedExperiences: identities, trace: {} });
  assert.equal(
    recalled.references.length,
    1,
    JSON.stringify({
      identities,
      records: await store.listItems({ workspaceKey }),
      diagnostics: recalled.diagnostics,
    }),
  );
  assert.equal(recalled.references[0]?.source, "reviewed-reference");
  assert.ok(recalled.tokenCount <= 320);
  const priorToolCallId = "prior-prepared-before-delivery";
  const priorArgumentsJson = JSON.stringify({ artifact_id: "current", action: "inspect" });
  const priorPrepared = await events.prepareToolOperation({
    toolCallId: priorToolCallId,
    ownerFence,
    dispatchEvent: {
      ...base("reuse", "prior-prepared"),
      kind: "tool.started",
      refs: { toolCallId: priorToolCallId },
      data: {
        toolName: "document",
        argumentsJson: priorArgumentsJson,
        argumentsHash: sha(priorArgumentsJson),
        argumentsRedacted: false,
        recoveryMode: "replay_safe",
      },
    },
  });
  const feedback = await recordPendingReference(
    store,
    events,
    ownerFence,
    reuseRuntime,
    sessionId,
    "reuse",
    workspaceKey,
    workDir,
    recalled,
  );
  const receipt = (await store.taskExperiences.listTaskExperienceReuse(workspaceKey, sessionId))[0];
  assert.ok(receipt);
  assert.equal(receipt.referenceHash, recalled.trace?.selected[0]?.referenceHash);
  assert.equal(
    receipt.referenceContent,
    [recalled.references[0]?.applicability, recalled.references[0]?.content]
      .filter(Boolean)
      .join("\n"),
  );
  assert.equal(receipt.itemVersion, recalled.items[0]?.item.version);
  assert.equal(receipt.contentVersion, approved.contentVersion);
  assert.equal(receipt.taskVersion, 1);
  assert.equal(receipt.adoption, "unknown", "引用不等于采用");
  await append({
    ...base("reuse", "reference-delivery-start"),
    kind: "model.call.started",
    data: {
      providerCallId: "reference-provider",
      provider: "openai",
      model: "test",
      purpose: "main",
      recallEventIds: ["reuse-reference-recall"],
    },
  });
  await feedback.dispatched({
    providerCallId: "reference-provider",
    physicalAttemptId: "reference-physical",
    runId: "reuse",
    diagnostic: {
      version: 1,
      coverage: "recorded",
      recalls: [
        {
          recallEventId: "reuse-reference-recall",
          references: [
            { itemId: receipt.itemId, referenceHash: receipt.referenceHash, present: true },
          ],
        },
      ],
    },
  });
  await events.settleToolOperation({
    toolCallId: priorToolCallId,
    ownerFence,
    expectedVersion: priorPrepared.operation.version,
    resultEvent: {
      ...base("reuse", "prior-outcome-after-delivery"),
      kind: "tool.result.recorded",
      refs: { toolCallId: priorToolCallId },
      data: {
        toolName: "document",
        status: "succeeded",
        body: { storage: "inline", content: "inspected", sha256: sha("inspected"), sizeBytes: 9 },
        projection: {
          version: 1,
          mode: "full",
          text: "inspected",
          strategy: "full",
          truncated: false,
        },
      },
    },
  });
  await feedback.committed({
    id: priorToolCallId,
    name: "document",
    arguments: priorArgumentsJson,
  });
  assert.deepEqual(
    await store.experienceLedger.listExperienceEffects(receipt.reuseId),
    [],
    "交付前已准备的工具即使之后结算也不能算采用",
  );

  const currentTask = reuseRuntime.currentTaskIdentity();
  assert.ok(currentTask);
  await store.taskExperiences.feedbackTaskExperience({
    workspaceKey,
    candidateId: approved.candidateId,
    expectedContentVersion: approved.contentVersion,
    operationId: "current-task-not-applicable",
    taskId: currentTask.taskId,
    taskVersion: currentTask.taskVersion,
    action: "not_applicable",
    now: Date.now(),
  });
  const sameTaskTargets = await taskExperienceRecallTargets({
    store: store.taskExperiences,
    workspaceKey,
    workDir,
    query: "重新求和",
    toolAllowed: (name) => name === "document",
    currentTask,
  });
  assert.equal(
    (await builder.build("重新求和", { reviewedExperiences: sameTaskTargets })).references.length,
    0,
    "本次不适用后同task/version不再引用",
  );
  const differentRunTargets = await taskExperienceRecallTargets({
    store: store.taskExperiences,
    workspaceKey,
    workDir,
    query: "重新求和",
    toolAllowed: (name) => name === "document",
    currentTask: { ...currentTask, runId: "next-host-run" },
  });
  assert.equal(
    (await builder.build("重新求和", { reviewedExperiences: differentRunTargets })).references
      .length,
    0,
    "同task/version/session的另一个Host Run仍保留本次不适用排除",
  );
  assert.equal(
    (
      await taskExperienceRecallTargets({
        store: store.taskExperiences,
        workspaceKey,
        workDir,
        query: "重新求和",
        toolAllowed: (name) => name === "document",
      })
    ).length,
    1,
    "无当前Task的管理preview不套旧任务排除",
  );
  await terminal("reuse");
  await start("next-reuse", "为下一份文件重新求和。");
  const nextReuseRuntime = runtime();
  await nextReuseRuntime.admit("next-reuse");
  await nextReuseRuntime.capture();
  const nextTask = nextReuseRuntime.currentTaskIdentity();
  assert.ok(nextTask);
  assert.notEqual(nextTask.taskId, currentTask.taskId);
  const nextTaskTargets = await taskExperienceRecallTargets({
    store: store.taskExperiences,
    workspaceKey,
    workDir,
    query: "重新求和",
    toolAllowed: (name) => name === "document",
    currentTask: nextTask,
  });
  assert.equal(
    (await builder.build("重新求和", { reviewedExperiences: nextTaskTargets })).references.length,
    1,
    "新任务仍可引用同版本",
  );
  assert.equal(
    (
      await taskExperienceRecallTargets({
        store: store.taskExperiences,
        workspaceKey,
        workDir,
        query: "重新求和",
        toolAllowed: () => false,
      })
    ).length,
    0,
  );
  assert.equal(
    (await builder.build("重新求和")).references.length,
    0,
    "没有Host准入不得fallback为用户证据",
  );
  const raw = new DatabaseSync(memoryPath);
  raw
    .prepare("UPDATE execution_learning_items SET metadata_json='{}' WHERE item_id=?")
    .run(approved.itemId!);
  raw.close();
  assert.equal(
    (await builder.build("重新求和", { reviewedExperiences: identities })).references.length,
    0,
    "坏metadata必须fail closed",
  );
  await terminal("next-reuse");
  await nextReuseRuntime.completed("next-reuse");
  await start("remember", "刚才应该先核对完整范围，请长期记住这条规则。");
  const rememberedRuntime = runtime();
  await rememberedRuntime.admit("remember");
  await rememberedRuntime.capture();
  await terminal("remember");
  await rememberedRuntime.completed("remember");
  assert.equal(
    (await store.taskExperiences.queryTaskExperiences(workspaceKey)).some(
      (item) => item.runId === "remember",
    ),
    false,
    "明确长期记忆的纠正沿用用户证据，不重复产生审核建议",
  );
});

test("首次Task尚未写入且临时input身份丢失时，冷恢复从durable Host绑定关联canonical执行", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-cold-task-host-binding-"));
  const workDir = join(root, "workspace"),
    workspaceKey = "cold-workspace",
    sessionId = "cold-session",
    inputRun = "input-run",
    engineRun = "engine-run",
    hostRun = "host-run";
  await mkdir(workDir);
  const memoryPath = join(root, "memory.sqlite");
  let store = new SqliteMemoryItemStore(memoryPath);
  const events = new SqliteRuntimeEventStore({ storageRoot: join(root, "events") });
  await events.initializeSession({ sessionId, workDir });
  const ownerFence = await events.advanceOwnerFence(sessionId, 0);
  t.after(async () => {
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = (runId: string, eventId: string) => ({
    schemaVersion: 2 as const,
    sessionId,
    runId,
    eventId,
    invocationId: runId,
    turnId: `${runId}-turn`,
    at: new Date().toISOString(),
    partial: false,
    visibility: "model" as const,
  });
  const append = (event: RuntimeEvent) => events.append(event, { ownerFence });
  await append({
    ...base(inputRun, "input-start"),
    kind: "run.started",
    data: { workDir, agentSwarmAuthorization: "none" },
  });
  await append({
    ...base(inputRun, "cold-input"),
    kind: "message.committed",
    data: {
      message: {
        role: "user",
        content: "读取当前文档。\n\n附件文件：\n错误值、这条经验不对、不要保存该经验仅为附件正文。",
        providerData: { picoKind: "desktop_user_input" },
      },
    },
  });
  await append({
    ...base(inputRun, "input-terminal"),
    kind: "run.terminal",
    data: { status: "completed" },
  });
  await append({
    ...base(engineRun, "engine-start"),
    kind: "run.started",
    data: { workDir, agentSwarmAuthorization: "none" },
  });
  const first = new TaskExperienceRuntime({
    session: { id: sessionId, runtimeEventStore: events },
    workspaceKey,
    workDir,
    hostRunId: hostRun,
    store,
    gate: async () => ({ allowed: true }),
    worker: { wake() {} },
  });
  await first.admit(engineRun);
  const binding = await store.taskExperiences.readTaskExperienceRunBinding(
    workspaceKey,
    sessionId,
    engineRun,
  );
  assert.equal(binding?.hostRunId, hostRun);
  assert.equal(
    await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId),
    undefined,
  );
  await first.admit(engineRun);
  assert.deepEqual(
    await store.taskExperiences.readTaskExperienceRunBinding(workspaceKey, sessionId, engineRun),
    binding,
    "admit重复不得改immutable createdAt",
  );
  await append({
    ...base(engineRun, "input-recall-binding"),
    visibility: "internal",
    kind: "memory.recall.recorded",
    data: createMemoryRecallTrace({
      mode: "automatic",
      workspaceKey,
      query: "读取当前文档。",
      queryRef: { eventId: "cold-input" },
      outcome: "no_hits",
      budget: { maxItems: 3, maxTokens: 320, usedItems: 0, usedTokens: 0, truncated: false },
    }),
  });
  const argumentsJson = JSON.stringify({ artifact_id: "current-file", action: "inspect" });
  const prepared = await events.prepareToolOperation({
    ownerFence,
    toolCallId: "missing-file",
    dispatchEvent: {
      ...base(engineRun, "prepared"),
      kind: "tool.started",
      refs: { toolCallId: "missing-file" },
      data: {
        toolName: "document",
        argumentsJson,
        argumentsHash: sha(argumentsJson),
        argumentsRedacted: false,
        recoveryMode: "replay_safe",
      },
    },
  });
  const content = "当前附件不可用。";
  await events.settleToolOperation({
    ownerFence,
    toolCallId: "missing-file",
    expectedVersion: prepared.operation.version,
    resultEvent: {
      ...base(engineRun, "tool-failure"),
      kind: "tool.result.recorded",
      refs: { toolCallId: "missing-file" },
      data: {
        toolName: "document",
        status: "failed",
        body: {
          storage: "inline",
          content,
          sha256: sha(content),
          sizeBytes: Buffer.byteLength(content),
        },
        projection: { version: 1, mode: "full", text: content, strategy: "full", truncated: false },
      },
    },
  });
  await append({
    ...base(engineRun, "engine-terminal"),
    kind: "run.terminal",
    data: { status: "completed" },
  });
  store.close();
  store = new SqliteMemoryItemStore(memoryPath);
  const restarted = new TaskExperienceRuntime({
    session: { id: sessionId, runtimeEventStore: events },
    workspaceKey,
    workDir,
    store,
    gate: async () => ({ allowed: true }),
    worker: { wake() {} },
  });
  await restarted.admit(engineRun);
  await restarted.capture();
  const task = await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId);
  assert.ok(task);
  assert.equal(task.runId, hostRun);
  assert.equal(task.executionRunId, engineRun);
  assert.equal(task.goalSource.runId, inputRun);
  assert.equal(task.goal, "读取当前文档。");
  const observations = await store.taskExperiences.listTaskExperienceObservations(task.taskId);
  assert.equal(
    observations.some((observation) => observation.correction),
    false,
  );
  assert.deepEqual(
    observations
      .filter((observation) => observation.kind === "terminal")
      .map((observation) => observation.source.runId),
    [engineRun],
  );
  const candidate = (await store.taskExperiences.queryTaskExperiences(workspaceKey))[0];
  assert.ok(candidate);
  assert.equal(candidate.runId, hostRun);
  assert.ok(candidate.sources.some((source) => source.eventId === "tool-failure"));
});

test(
  "document-only生产工具范围仍从真实结算采集失败候选，不依赖memory_learn工具",
  { timeout: 15_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "pico-task-document-only-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home"),
      sessionId = "document-only";
    await mkdir(workDir);
    await mkdir(picoHome);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    t.after(async () => {
      await closeExecutionLearningWorker(picoHome);
      await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    });
    let step = 0;
    await executeAgentRuntime(
      {
        prompt: "读取上传表格。",
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "fixture/model",
        permissionMode: "full-access",
        allowedTools: ["document"],
      },
      {
        picoHome,
        memoryTrustStore: trust,
        reporter: new SilentReporter(),
        executionLearningWorkerOptions: { idleMs: 60_000 },
        provider: {
          generate: async () =>
            step++ === 0
              ? {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    {
                      id: "unavailable-file",
                      name: "document",
                      arguments: JSON.stringify({
                        artifact_id: "missing-current-file",
                        action: "inspect",
                      }),
                    },
                  ],
                }
              : { role: "assistant", content: "附件读取失败。" },
        },
      },
    );
    const workspaceKey = resolvePicoPaths(workDir, { picoHome }).workspace.id;
    const candidate = (
      await store.taskExperiences.queryTaskExperiences(workspaceKey, { sessionId })
    )[0];
    assert.ok(candidate);
    assert.equal(candidate.kind, "task-lesson");
    assert.equal(candidate.state, "waiting");
    assert.equal(candidate.content, "");
    const observations = await store.taskExperiences.listTaskExperienceObservations(
      candidate.taskId,
    );
    assert.ok(
      observations.some(
        (observation) => observation.toolName === "document" && observation.status === "failed",
      ),
    );
    assert.equal(
      (await store.executionLearning.listAdmissions()).length,
      0,
      "未暴露native学习工具时不创建Node admission",
    );
  },
);

test("非Excel通用建议的自然语言条件经审核后可低信任引用，采用与验证保持unknown", async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-general-conditions-")));
  const workDir = join(root, "workspace"),
    sessionId = "general-session";
  await mkdir(workDir);
  const paths = resolvePicoPaths(workDir, { picoHome: workDir });
  const workspaceKey = paths.workspace.id;
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const physicalStore = new SqliteRuntimeControlStore({ storageRoot: paths.workspace.root });
  await events.initializeSession({ sessionId, workDir });
  const ownerFence = await events.advanceOwnerFence(sessionId, 0);
  t.after(async () => {
    physicalStore.close();
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const appendRun = async (runId: string, prompt: string, terminal = false) => {
    const base = (eventId: string) => ({
      schemaVersion: 2 as const,
      sessionId,
      runId,
      eventId,
      invocationId: runId,
      turnId: `${runId}-turn`,
      at: new Date().toISOString(),
      partial: false,
      visibility: "model" as const,
    });
    await events.append(
      {
        ...base(`${runId}-start`),
        kind: "run.started",
        data: { workDir, agentSwarmAuthorization: "none" },
      },
      { ownerFence },
    );
    await events.append(
      {
        ...base(`${runId}-input`),
        kind: "message.committed",
        data: { message: { role: "user", content: prompt } },
      },
      { ownerFence },
    );
    if (terminal)
      await events.append(
        {
          ...base(`${runId}-terminal`),
          kind: "run.terminal",
          data: { status: "failed", reason: "configuration_loader_failure" },
        },
        { ownerFence },
      );
  };
  const runtime = () =>
    new TaskExperienceRuntime({
      session: { id: sessionId, runtimeEventStore: events },
      workspaceKey,
      workDir,
      store,
      gate: async () => ({ allowed: true }),
      worker: { wake() {} },
    });
  await appendRun("source", "修复 parser.ts 的配置加载代码。", true);
  const source = runtime();
  await source.admit("source");
  await source.completed("source");
  const candidate = (await store.taskExperiences.queryTaskExperiences(workspaceKey))[0];
  assert.ok(candidate);
  const job = await store.executionLearning.claimExecutionLearningJob(
    "general-worker",
    Date.now(),
    60_000,
  );
  assert.ok(job);
  const condition = "修改现有配置加载逻辑时";
  const pending = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: candidate.recordRevision,
    content: "修复代码前先读取现有实现，完成后运行相关检查。",
    applicability: { taskFamily: "coding", toolNames: ["read_file"], conditions: [condition] },
    sources: candidate.sources,
    now: Date.now(),
  });
  assert.ok(pending);
  const approved = await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: pending.candidateId,
    expectedRecordRevision: pending.recordRevision,
    expectedContentVersion: pending.contentVersion,
    operationId: "general-approve",
    action: "accept",
    now: Date.now(),
  });
  await appendRun("reuse", "继续修复 parser.ts 的代码。");
  const reuse = runtime();
  await reuse.admit("reuse");
  await reuse.capture();
  const options = {
    store: store.taskExperiences,
    workspaceKey,
    workDir,
    query: "修复代码",
    toolAllowed: (name: string) => name === "read_file",
    conditionMatches: async () => "unknown" as const,
  };
  const identities = await taskExperienceRecallTargets(options);
  assert.equal(identities.length, 1);
  assert.equal(
    (await taskExperienceRecallTargets({ ...options, conditionMatches: async () => false })).length,
    0,
    "Host已证明不匹配仍排除",
  );
  assert.equal(
    (await taskExperienceRecallTargets({ ...options, workspaceKey: "other-workspace" })).length,
    0,
  );
  const recalled = await new AtomicMemoryContextBuilder(store, workspaceKey).build("修复代码", {
    reviewedExperiences: identities,
    trace: {},
  });
  assert.equal(recalled.references[0]?.source, "reviewed-reference");
  assert.match(recalled.block, /trust="low"/);
  assert.ok(recalled.block.includes(condition));
  assert.ok(recalled.block.includes("当前任务需核对适用性"));
  assert.ok(recalled.block.includes("引用不代表采用或验证"));
  assert.ok(recalled.tokenCount <= 320);
  await recordPendingReference(
    store,
    events,
    ownerFence,
    reuse,
    sessionId,
    "reuse",
    workspaceKey,
    workDir,
    recalled,
  );
  const receipt = (await store.taskExperiences.listTaskExperienceReuse(workspaceKey, sessionId))[0];
  assert.equal(receipt?.candidateId, approved.candidateId);
  assert.equal(receipt?.adoption, "unknown");
  assert.equal(receipt?.validation, "unknown");
  assert.ok(receipt?.referenceContent?.includes(condition));
  await store.applyMutations({
    operationId: "ordinary-recall-survives-experience-denial",
    mutations: [
      {
        type: "create",
        item: {
          content: "修复代码时使用 pnpm check。",
          kind: "knowledge",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: workspaceKey,
          observedAt: Date.now(),
          origin: "user_requested",
          keys: [{ key: "修复代码", keyType: "concept", keyOrigin: "user" }],
          sources: [],
        },
      },
    ],
  });
  const denied = await new AtomicMemoryContextBuilder(store, workspaceKey).build("修复代码", {
    reviewedExperiences: identities,
    trace: {},
    experienceAllowed: async () => {
      throw new Error("Host exclusion read unavailable");
    },
  });
  assert.ok(denied.references.length);
  assert.ok(denied.references.every((reference) => reference.source !== "reviewed-reference"));
  assert.ok(denied.block.includes("pnpm check"), "经验准入异常不影响普通记忆");
  assert.ok(denied.trace?.selected.every((selected) => selected.source !== "reviewed-reference"));
  const sheetSeed = await store.taskExperiences.createTaskExperienceCandidate({
    ...candidate,
    candidateId: "gate-sheet-candidate",
    failureKey: "gate-sheet-failure",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  await store.executionLearning.enqueueExecutionLearningJob({
    ...job,
    jobId: "gate-sheet-job",
    candidateId: sheetSeed.candidateId,
    state: "ready",
    fencingToken: 0,
    leaseUntil: 0,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  });
  const sheetJob = await store.executionLearning.claimExecutionLearningJob(
    "gate-sheet-worker",
    Date.now(),
    60_000,
  );
  assert.ok(sheetJob);
  const sheetPending = await store.taskExperiences.completeTaskExperienceJob({
    job: sheetJob,
    expectedRecordRevision: sheetSeed.recordRevision,
    content: "Excel 求和需使用完整范围。",
    applicability: {
      taskFamily: "spreadsheet",
      toolNames: ["document"],
      conditions: [],
      spreadsheet: { operation: "sum", header: false, dataKind: "finite-numbers" },
    },
    sources: sheetSeed.sources,
    now: Date.now(),
  });
  assert.ok(sheetPending);
  const sheetCandidate = await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: sheetPending.candidateId,
    expectedRecordRevision: sheetPending.recordRevision,
    expectedContentVersion: sheetPending.contentVersion,
    operationId: "gate-sheet-approve",
    action: "accept",
    now: Date.now(),
  });
  await appendRun(
    "gate-revoke",
    "求 Sheet1!B2:B3 的 B 列总和。 [附件](pico://artifact/current-sheet)",
  );
  const identity = runtime();
  await identity.admit("gate-revoke");
  await identity.capture();
  const selected = await new AtomicMemoryContextBuilder(store, workspaceKey).build("Excel 求和", {
    reviewedExperiences: [
      {
        candidateId: sheetCandidate.candidateId,
        contentVersion: sheetCandidate.contentVersion,
        recordRevision: sheetCandidate.recordRevision,
      },
    ],
    trace: {},
  });
  const trust = new WorkspaceTrustStore({ userStateDirectory: join(root, "gate-trust") });
  const canonicalDir = await trust.canonicalize(workDir);
  await trust.trust(canonicalDir);
  let revoke = true,
    validationCalls = 0;
  const gateDiagnostics: unknown[] = [];
  const feedback = await recordPendingReference(
    store,
    events,
    ownerFence,
    identity,
    sessionId,
    "gate-revoke",
    workspaceKey,
    workDir,
    selected,
    {
      onDiagnostic: (diagnostic) => {
        gateDiagnostics.push(diagnostic);
      },
      effectGate: async () => ({ allowed: await trust.isTrusted(canonicalDir) }),
      validateReviewed: async ({ observation }) => {
        validationCalls++;
        await delay(1);
        if (revoke) await trust.setTrusted(canonicalDir, false);
        return { adoption: "observed", validation: "fail", sources: [observation.source] };
      },
    },
  );
  const runStart = (await events.readRun(sessionId, "gate-revoke")).find(
    (event) => event.kind === "run.started",
  )!;
  await events.append(
    {
      ...runStart,
      kind: "model.call.started",
      eventId: "gate-provider-start",
      data: {
        providerCallId: "gate-provider",
        provider: "openai",
        model: "test",
        purpose: "main",
        recallEventIds: ["gate-revoke-reference-recall"],
      },
    },
    { ownerFence },
  );
  const diagnostic = {
    version: 1 as const,
    coverage: "recorded" as const,
    recalls: [
      {
        recallEventId: "gate-revoke-reference-recall",
        references: [
          {
            itemId: selected.items[0]!.item.itemId,
            referenceHash: selected.trace!.selected[0]!.referenceHash,
            present: true,
          },
        ],
      },
    ],
  };
  // This deterministic gate fixture models an observed 2xx request, not a prepared admission.
  const physical: Parameters<SqliteRuntimeControlStore["recordPhysicalAttempt"]>[0] = {
    physicalAttemptId: "gate-physical",
    providerCallId: "gate-provider",
    logicalCallId: "gate-provider",
    sessionId,
    runId: "gate-revoke",
    provider: "openai",
    model: "test",
    purpose: "main",
    accountingVersion: 1,
    accountingSource: "physical",
    ownerId: physicalStore.beginPhysicalAttemptOwner(),
    revision: 1,
    attempt: 0,
    retryAttempt: 0,
    startedAt: new Date().toISOString(),
    status: "observed",
    httpStatus: 200,
    usageBasis: "missing",
    costStatus: "unknown",
    pricingVersion: "fixture",
    requestDiagnostic: { memoryRecall: diagnostic },
  };
  physicalStore.recordPhysicalAttempt({
    ...physical,
    status: "prepared",
    revision: 0,
    httpStatus: undefined,
  });
  physicalStore.recordPhysicalAttempt(physical);
  await feedback.dispatched({
    providerCallId: "gate-provider",
    physicalAttemptId: "gate-physical",
    runId: "gate-revoke",
    diagnostic,
  });
  const args = JSON.stringify({
    artifact_id: "current-sheet",
    action: "analyze",
    operation: "sum",
    sheet: "Sheet1",
    range: "B2:B3",
    column: "B",
    header: false,
  });
  const prepared = await events.prepareToolOperation({
    toolCallId: "gate-tool",
    ownerFence,
    dispatchEvent: {
      ...runStart,
      kind: "tool.started",
      eventId: "gate-prepared",
      refs: { toolCallId: "gate-tool" },
      data: {
        toolName: "document",
        argumentsJson: args,
        argumentsHash: sha(args),
        argumentsRedacted: false,
        recoveryMode: "replay_safe",
      },
    },
  });
  await events.settleToolOperation({
    toolCallId: "gate-tool",
    ownerFence,
    expectedVersion: prepared.operation.version,
    resultEvent: {
      ...runStart,
      kind: "tool.result.recorded",
      eventId: "gate-outcome",
      refs: { toolCallId: "gate-tool" },
      data: {
        toolName: "document",
        status: "succeeded",
        body: { storage: "inline", content: "fixture", sha256: sha("fixture"), sizeBytes: 7 },
        projection: {
          version: 1,
          mode: "full",
          text: "fixture",
          strategy: "full",
          truncated: false,
        },
      },
    },
  });
  const invoke = () => feedback.committed({ id: "gate-tool", name: "document", arguments: args });
  const use = (
    await store.experienceLedger.queryExperienceUses(workspaceKey, { sessionId })
  ).uses.find((use) => use.runId === "gate-revoke")!;
  await invoke();
  assert.equal(
    validationCalls,
    1,
    JSON.stringify({
      message: "撤销发生在异步验证期间",
      gateDiagnostics,
      use,
      task: identity.currentTaskSnapshot(),
    }),
  );
  assert.deepEqual(
    await store.experienceLedger.listExperienceEffects(use.useId),
    [],
    "提交前重查trust，撤销后不追加效果或控制当前经验",
  );
  assert.equal((await store.readItem(sheetCandidate.itemId!))?.item.lifecycleState, "active");
  await trust.trust(canonicalDir);
  revoke = false;
  await store.updateSettings({
    workspaceKey,
    expectedVersion: (await store.readSettings(workspaceKey)).version,
    recallEnabled: false,
  });
  await invoke();
  assert.equal(
    (await store.experienceLedger.listExperienceEffects(use.useId)).length,
    1,
    "关闭召回后既有carried引用仍能结算自然结果",
  );
});

test("100ms超时及终态提交后的中断都从persisted cursor恢复，新无关输入不会丢掉旧候选", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-cursor-recovery-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const memoryPath = join(root, "memory.sqlite");
  let store = new SqliteMemoryItemStore(memoryPath);
  const events = new SqliteRuntimeEventStore({ storageRoot: join(root, "events") });
  const sessionId = "cursor-session",
    runId = "cursor-run",
    workspaceKey = "cursor-workspace";
  await events.initializeSession({ sessionId, workDir });
  const ownerFence = await events.advanceOwnerFence(sessionId, 0);
  t.after(async () => {
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  const base = (eventId: string) => ({
    schemaVersion: 2 as const,
    sessionId,
    runId,
    eventId,
    invocationId: runId,
    turnId: "turn",
    at: new Date().toISOString(),
    partial: false,
    visibility: "model" as const,
  });
  await events.append(
    { ...base("start"), kind: "run.started", data: { workDir, agentSwarmAuthorization: "none" } },
    { ownerFence },
  );
  await events.append(
    {
      ...base("input"),
      kind: "message.committed",
      data: { message: { role: "user", content: "检查任务是否完成。" } },
    },
    { ownerFence },
  );
  let slow = true;
  const crashBeforeCandidate = new Proxy(store.taskExperiences, {
    get(target, property) {
      if (property === "createTaskExperienceCandidate")
        return async (
          _candidate: Parameters<TaskExperienceStore["createTaskExperienceCandidate"]>[0],
        ) => {
          throw new Error("simulated_candidate_crash");
        };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const diagnostics: string[] = [];
  const runtime = new TaskExperienceRuntime({
    session: {
      id: sessionId,
      runtimeEventStore: {
        readSessionEntriesPage: async (...args) => {
          if (slow) {
            slow = false;
            await delay(130);
          }
          return events.readSessionEntriesPage(...args);
        },
        readSessionEvent: (...args) => events.readSessionEvent(...args),
        readToolOperation: (...args) => events.readToolOperation(...args),
        readRun: (...args) => events.readRun(...args),
      },
    },
    workspaceKey,
    workDir,
    store: {
      readSettings: (workspace) => store.readSettings(workspace),
      readDeletionRevision: () => store.readDeletionRevision(),
      executionLearning: store.executionLearning,
      taskExperiences: crashBeforeCandidate,
    },
    gate: async () => ({ allowed: true }),
    worker: { wake() {} },
    onDiagnostic: (diagnostic) => diagnostics.push(diagnostic.reason),
  });
  await runtime.admit(runId);
  await runtime.capture();
  assert.deepEqual(diagnostics, ["collection_deadline"]);
  assert.equal(
    await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId),
    undefined,
  );
  await runtime.capture();
  const task = await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId);
  assert.ok(task);
  assert.equal(task.throughSequence, 2);
  await delay(40);
  assert.equal(
    (await store.taskExperiences.listTaskExperienceObservations(task.taskId)).length,
    1,
    "超时旧writer不能重复提交",
  );
  await events.append(
    {
      ...base("terminal"),
      kind: "run.terminal",
      data: { status: "failed", reason: "deterministic_fixture_failure" },
    },
    { ownerFence },
  );
  await runtime.completed(runId);
  const observations = await store.taskExperiences.listTaskExperienceObservations(task.taskId);
  assert.equal(
    observations.find((observation) => observation.kind === "terminal")?.status,
    "failed",
  );
  const committed = await store.taskExperiences.readTaskExperienceTask(task.taskId);
  assert.equal(committed?.throughSequence, 3);
  assert.equal((await store.taskExperiences.queryTaskExperiences(workspaceKey)).length, 0);
  assert.ok(diagnostics.includes("task_experience_collection_unavailable"));
  assert.ok(!diagnostics.includes("simulated_candidate_crash"), "持久诊断只返回稳定code");
  assert.equal(
    (await events.readSessionEntriesPage(sessionId, { afterSequence: committed!.throughSequence }))
      .length,
    0,
    "cursor之后没有新journal事件",
  );
  store.close();
  store = new SqliteMemoryItemStore(memoryPath);
  const nextRunId = "new-unrelated-run";
  const nextBase = (eventId: string) => ({
    ...base(eventId),
    runId: nextRunId,
    invocationId: nextRunId,
    turnId: "new-turn",
  });
  await events.append(
    {
      ...nextBase("next-start"),
      kind: "run.started",
      data: { workDir, agentSwarmAuthorization: "none" },
    },
    { ownerFence },
  );
  await events.append(
    {
      ...nextBase("next-input"),
      kind: "message.committed",
      data: { message: { role: "user", content: "写一个关于月亮的笑话。" } },
    },
    { ownerFence },
  );
  const restarted = new TaskExperienceRuntime({
    session: { id: sessionId, runtimeEventStore: events },
    workspaceKey,
    workDir,
    store,
    gate: async () => ({ allowed: true }),
    worker: { wake() {} },
  });
  await restarted.admit(nextRunId);
  await restarted.capture();
  await restarted.capture();
  const candidate = (await store.taskExperiences.queryTaskExperiences(workspaceKey))[0];
  assert.ok(candidate);
  assert.equal(candidate.taskId, task.taskId, "新用户消息消费前必须恢复旧终态任务的候选");
  assert.equal(candidate.runId, runId);
  assert.equal(candidate.content, "");
  assert.equal(candidate.state, "waiting");
  const current = await store.taskExperiences.latestTaskExperienceTask(workspaceKey, sessionId);
  assert.notEqual(current?.taskId, task.taskId);
  assert.equal(current?.runId, nextRunId);
  assert.equal(current?.throughSequence, 5);
  assert.equal(current?.previousTaskId, task.taskId);
  assert.equal(
    (await store.taskExperiences.queryTaskExperiences(workspaceKey)).length,
    1,
    "重复恢复不复制候选",
  );
  const job = await store.executionLearning.claimExecutionLearningJob(
    "restart-worker",
    Date.now(),
    60_000,
  );
  assert.equal(job?.candidateId, candidate.candidateId);
  assert.equal(
    await store.executionLearning.claimExecutionLearningJob("second-worker", Date.now(), 60_000),
    undefined,
    "重复恢复不复制job",
  );
});
