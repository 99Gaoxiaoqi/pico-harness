import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ExecutionAcceptanceClaim,
  ExecutionLearningJob,
  TaskExperienceCandidate,
  TaskExperienceTask,
  TaskExperienceObservation,
} from "@pico/core";
import { MemoryItemStoreConflictError } from "@pico/core";
import { createReadOnlyPermissionProfile } from "@pico/core/permission-profile";
import { SqliteMemoryItemStore } from "../../../packages/storage/src/sqlite/sqlite-memory-item-store.js";
import { ExecutionLearningWorker } from "../../../packages/pico-host/src/execution-learning-worker.js";
import { executionLearningPathAuthorizer } from "../../../packages/pico-host/src/execution-learning-host.js";
import { Session } from "../../../packages/pico-host/src/session.js";
import {
  createDefaultSessionSettings,
  snapshotSessionSettings,
} from "../../../packages/pico-host/src/input/session-settings.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const source = (eventId: string, runId = "run") => ({
  sessionId: "session",
  runId,
  turnId: "turn",
  eventId,
});
async function seed(
  store: SqliteMemoryItemStore,
  id = "lesson",
  taskId = "task",
  goal = "整理检查方法",
  observationFixture: Partial<
    Pick<TaskExperienceObservation, "observationId" | "summary" | "toolName" | "arguments">
  > = {},
) {
  const settings = await store.readSettings("workspace");
  const epoch = await store.executionLearning.advanceExecutionLearningInput("workspace");
  const task: TaskExperienceTask = {
    taskId,
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "session",
    runId: "run",
    goal,
    goalSource: source(`${id}-goal`),
    coverage: "complete",
    throughSequence: 2,
    createdAt: 100,
    updatedAt: 100,
  };
  const observation = {
    observationId: `${id}-observation`,
    taskId,
    taskVersion: 1,
    kind: "tool-result" as const,
    source: source(`${id}-result`),
    sequence: 2,
    summary: "检查成功",
    coverage: "complete" as const,
    status: "succeeded" as const,
    toolName: "bash",
    createdAt: 100,
    ...observationFixture,
  };
  await store.taskExperiences.appendTaskExperienceObservations(task, [observation]);
  const candidate: TaskExperienceCandidate = {
    candidateId: id,
    kind: "task-lesson",
    taskId,
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "session",
    runId: "run",
    failureKey: `${id}-key`,
    inputEpoch: epoch.inputEpoch,
    settingsVersion: settings.version,
    deletionRevision: await store.readDeletionRevision(),
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
    sources: [observation.source],
    observationIds: [observation.observationId],
    createdAt: 100,
    updatedAt: 100,
  };
  await store.taskExperiences.createTaskExperienceCandidate(candidate);
  const job: ExecutionLearningJob = {
    jobId: `task-experience-job:${hash(JSON.stringify([id, 1]))}`,
    workspaceKey: "workspace",
    candidateId: id,
    sessionId: "session",
    runId: "run",
    kind: "reflect",
    state: "ready",
    inputEpoch: epoch.inputEpoch,
    createdAt: 100,
    updatedAt: 100,
    leaseUntil: 0,
    fencingToken: 0,
  };
  await store.executionLearning.enqueueExecutionLearningJob(job);
  return { candidate, job, task, observation };
}

test("通用经验同队列反思、审阅原子发布、旧视图隔离、CAS与复用纠正优先于后台", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-experience-"));
  const path = join(root, "memory.sqlite");
  const store = new SqliteMemoryItemStore(path, { now: () => 1000 });
  try {
    const initial = await seed(store);
    assert.equal(await store.executionLearning.readExecutionLearningCandidate("lesson"), undefined);
    assert.deepEqual(
      await store.executionLearning.listExecutionLearningCandidates("workspace"),
      [],
    );
    const job = await store.executionLearning.claimExecutionLearningJob("worker", 200, 90000);
    assert.ok(job);
    const pending = await store.taskExperiences.completeTaskExperienceJob({
      job,
      expectedRecordRevision: 1,
      content: "运行当前检查入口并读取可信工具结果。",
      applicability: { taskFamily: "general", toolNames: ["bash"], conditions: [] },
      sources: initial.candidate.sources,
      now: 300,
    });
    assert.ok(pending);
    assert.equal(pending.review, "pending");
    assert.equal(pending.validation, "unknown");
    assert.equal(pending.enabled, false);
    const request = {
      workspaceKey: "workspace",
      candidateId: "lesson",
      expectedRecordRevision: pending.recordRevision,
      expectedContentVersion: 1,
      operationId: "accept-lesson",
      action: "accept" as const,
      now: 400,
    };
    const accepted = await store.taskExperiences.reviewTaskExperience(request);
    assert.ok(accepted.itemId);
    assert.deepEqual(
      await store.taskExperiences.reviewTaskExperience({ ...request, now: 401 }),
      accepted,
    );
    await assert.rejects(
      store.taskExperiences.reviewTaskExperience({ ...request, operationId: "stale-accept" }),
      /conflict/,
    );
    assert.equal((await store.listItems({ workspaceKey: "workspace" })).length, 0);
    assert.equal(
      (await store.listItemsPage({ workspaceKey: "workspace" })).pageInfo.counts.total,
      0,
    );
    const records = await store.listItems({ workspaceKey: "workspace", learningVersion: 2 });
    assert.equal(records.length, 1);
    assert.equal(records[0]!.sourceType, "reviewed-reference");
    assert.equal(records[0]!.taskExperience?.review, "approved");
    await assert.rejects(
      store.applyMutations({
        operationId: "old-edit",
        mutations: [
          {
            type: "update",
            itemId: accepted.itemId,
            expectedVersion: 1,
            item: {
              content: "伪装普通用户记忆",
              kind: "note",
              statementType: "fact",
              temporalType: "undated",
              scopeType: "workspace",
              scopeKey: "workspace",
              observedAt: 400,
              origin: "user_requested",
              keys: [{ key: "用户记忆", keyType: "exact", keyOrigin: "user" }],
              sources: [],
            },
          },
        ],
      }),
      /experience review/,
    );
    const laterTask = {
      ...initial.task,
      taskId: "later-task",
      runId: "later-run",
      goalSource: source("later-goal", "later-run"),
      throughSequence: 3,
      updatedAt: 500,
    };
    const laterObservation = {
      ...initial.observation,
      observationId: "later-result",
      taskId: laterTask.taskId,
      source: source("later-result", "later-run"),
      sequence: 3,
      createdAt: 500,
    };
    await store.taskExperiences.appendTaskExperienceObservations(laterTask, [laterObservation]);
    await store.taskExperiences.recordTaskExperienceReuse({
      reuseId: "reuse",
      workspaceKey: "workspace",
      candidateId: "lesson",
      contentVersion: 1,
      itemId: accepted.itemId,
      itemVersion: 1,
      taskId: laterTask.taskId,
      taskVersion: 1,
      sessionId: "session",
      runId: "later-run",
      referenceHash: hash("reference"),
      referenceContent: "实际有界引用",
      adoption: "unknown",
      validation: "unknown",
      excluded: false,
      sources: [],
      createdAt: 500,
      updatedAt: 500,
    });
    await store.taskExperiences.settleTaskExperienceReuse({
      reuseId: "reuse",
      candidateId: "lesson",
      contentVersion: 1,
      taskVersion: 1,
      adoption: "observed",
      validation: "pass",
      sources: [laterObservation.source],
      now: 600,
    });
    const passed = await store.taskExperiences.readTaskExperienceCandidate("lesson");
    assert.equal(passed?.enabled, true);
    assert.equal(passed?.validation, "unknown");
    assert.equal(
      (await store.taskExperiences.listTaskExperienceReuse("workspace"))[0]?.validation,
      "pass",
    );
    const corrected = await store.taskExperiences.feedbackTaskExperience({
      workspaceKey: "workspace",
      candidateId: "lesson",
      expectedContentVersion: 1,
      operationId: "correct",
      taskId: laterTask.taskId,
      taskVersion: 1,
      action: "correct",
      now: 700,
    });
    assert.equal(corrected.enabled, false);
    assert.equal(corrected.validation, "unknown");
    assert.equal(corrected.reason, "user_correction");
    const edited = await store.taskExperiences.reviewTaskExperience({
      workspaceKey: "workspace",
      candidateId: "lesson",
      expectedRecordRevision: corrected.recordRevision,
      expectedContentVersion: 1,
      operationId: "edit",
      action: "edit_accept",
      content: "先独立验证当前工具输入，再采用检查结果。",
      now: 800,
    });
    assert.equal(edited.contentVersion, 2);
    assert.equal(edited.validation, "unknown");
    assert.equal(edited.enabled, true);
    const late = await store.taskExperiences.completeTaskExperienceJob({
      job,
      expectedRecordRevision: 1,
      content: "过期模型覆盖",
      applicability: initial.candidate.applicability,
      sources: initial.candidate.sources,
      now: 900,
    });
    assert.equal(late?.content, edited.content);
    const deleted = await store.taskExperiences.reviewTaskExperience({
      workspaceKey: "workspace",
      candidateId: "lesson",
      expectedRecordRevision: edited.recordRevision,
      expectedContentVersion: 2,
      operationId: "delete",
      action: "delete",
      now: 1000,
    });
    assert.equal(deleted.content, "");
    assert.equal(await store.readItem(edited.itemId!), undefined);
    assert.equal((await store.experienceLedger.readExperienceUse("reuse"))?.deleted, true);
    assert.equal(
      (await store.experienceLedger.readExperienceUse("reuse"))?.referenceContent,
      undefined,
    );
    assert.equal((await store.taskExperiences.reviewTaskExperience(request)).content, "");
    const db = new DatabaseSync(path);
    try {
      assert.equal(
        Number(
          db
            .prepare(
              "SELECT count(*) n FROM task_experience_actions WHERE result_json LIKE '%运行当前检查%' OR result_json LIKE '%实际有界引用%'",
            )
            .get()!.n,
        ),
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("反思以冻结短别名提交Host SHA证据，原ID与外来ID不能自证来源，真实内容PII仍被拒绝", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-experience-alias-"));
  const store = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  const machineId =
    "task-experience-observation:46eedcef85992ca01875217136682dc75409acff5db4da0ea762374079d90a12";
  const checksum = machineId.slice("task-experience-observation:".length);
  const documentSummary = (name: string, text: string) =>
    `document: succeeded\n${JSON.stringify({ source: { ref: "<current-input-artifact>", name, digest: checksum, action: "analyze" }, kind: "spreadsheet", text })}`.slice(
      0,
      800,
    );
  let worker: ExecutionLearningWorker | undefined;
  try {
    for (const [suffix, responseId, summary, expected, goal] of [
      ["valid", "e1", "当前求和范围完整覆盖", "pending", "当前表格求和"],
      ["forged", machineId, "当前求和范围完整覆盖", "reflection_output_invalid", "当前表格求和"],
      ["foreign", "e99", "当前求和范围完整覆盖", "reflection_output_invalid", "当前表格求和"],
      ["pii", "e1", "真实用户数据包含手机号13800138000", "reflection_input_unsafe", "当前表格求和"],
      [
        "checksum",
        "e1",
        documentSummary("current.xlsx", "当前求和范围完整覆盖" + "x".repeat(1600)),
        "pending",
        "当前表格求和",
      ],
      [
        "checksum-text-pii",
        "e1",
        documentSummary("current.xlsx", "真实用户数据包含手机号13800138000"),
        "reflection_input_unsafe",
        "当前表格求和",
      ],
      [
        "checksum-name-pii",
        "e1",
        documentSummary("13800138000.xlsx", "当前求和范围完整覆盖"),
        "reflection_input_unsafe",
        "当前表格求和",
      ],
      [
        "checksum-goal-pii",
        "e1",
        documentSummary("current.xlsx", "当前求和范围完整覆盖"),
        "reflection_input_unsafe",
        "用户手机13800138000",
      ],
    ] as const) {
      const initial = await seed(store, suffix, `${suffix}-task`, goal, {
        observationId: machineId + suffix,
        summary,
        toolName: "document",
        arguments: {
          action: "analyze",
          operation: "sum",
          header: false,
          range: "A1:A3",
          column: "A",
        },
      });
      let factoryCalls = 0;
      worker = new ExecutionLearningWorker({
        picoHome: root,
        store: store.executionLearning,
        taskExperiences: store.taskExperiences,
        idleMs: 0,
        pollMs: 60000,
        now: () => 1000,
        validateTaskExperienceSources: async () => true,
        taskExperienceModelFactory: async () => {
          factoryCalls++;
          return {
            model: {
              call: async (request) => {
                const payload = JSON.parse(request.prompt.split("\n").at(-1)!);
                assert.deepEqual(
                  payload.evidence.map((entry: { evidenceId: string }) => entry.evidenceId),
                  ["e1"],
                );
                assert.ok(!request.prompt.includes(initial.observation.observationId));
                if (suffix === "checksum") {
                  assert.ok(!request.prompt.includes(checksum));
                  assert.ok(payload.evidence[0].summary.includes("<host-checksum>"));
                }
                return JSON.stringify({
                  content: "当前范围求和方法适用于有限数值。",
                  applicability: {
                    taskFamily: "spreadsheet",
                    toolNames: ["document"],
                    conditions: [],
                  },
                  evidenceIds: [
                    responseId === machineId ? initial.observation.observationId : responseId,
                  ],
                });
              },
            },
          };
        },
      });
      await worker.flushOnce();
      await worker.drain();
      await worker.close();
      worker = undefined;
      const candidate = await store.taskExperiences.readTaskExperienceCandidate(suffix);
      assert.ok(candidate);
      assert.equal(expected === "pending" ? candidate.review : candidate.reason, expected);
      assert.equal(factoryCalls, expected === "reflection_input_unsafe" ? 0 : 1);
      if (expected === "pending") assert.deepEqual(candidate.sources, [initial.observation.source]);
      const persisted = await store.taskExperiences.listTaskExperienceObservations(
        initial.task.taskId,
      );
      assert.equal(
        persisted[0]?.summary,
        summary,
        "projection must not alter persistent Host checksums or actual text",
      );
    }
  } finally {
    await worker?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Host与Engine Run绑定审计行冷恢复后仍按scope读取且immutable，损坏记录failclosed", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-run-binding-"));
  const path = join(root, "memory.sqlite");
  let store = new SqliteMemoryItemStore(path);
  const binding = {
    workspaceKey: "workspace",
    sessionId: "session",
    executionRunId: "engine-run",
    hostRunId: "host-run",
    createdAt: 100,
  };
  try {
    await store.taskExperiences.saveTaskExperienceRunBinding(binding);
    await store.taskExperiences.saveTaskExperienceRunBinding({ ...binding });
    assert.deepEqual(
      await store.taskExperiences.readTaskExperienceRunBinding(
        "workspace",
        "session",
        "engine-run",
      ),
      binding,
    );
    store.close();
    store = new SqliteMemoryItemStore(path);
    assert.deepEqual(
      await store.taskExperiences.readTaskExperienceRunBinding(
        "workspace",
        "session",
        "engine-run",
      ),
      binding,
    );
    assert.equal(
      await store.taskExperiences.readTaskExperienceRunBinding(
        "other-workspace",
        "session",
        "engine-run",
      ),
      undefined,
    );
    assert.equal(
      await store.taskExperiences.readTaskExperienceRunBinding(
        "workspace",
        "other-session",
        "engine-run",
      ),
      undefined,
    );
    await assert.rejects(
      store.taskExperiences.saveTaskExperienceRunBinding({ ...binding, hostRunId: "another-host" }),
      (error) =>
        error instanceof MemoryItemStoreConflictError && error.reason === "operation_reused",
    );
    await assert.rejects(
      store.taskExperiences.saveTaskExperienceRunBinding({ ...binding, createdAt: 101 }),
      /identity reused/,
    );
    const db = new DatabaseSync(path);
    try {
      const row = db.prepare("SELECT * FROM task_experience_actions").get()!;
      assert.equal(row.candidate_id, "run-binding:engine-run");
      assert.equal(JSON.parse(String(row.result_json)).kind, "host-run-binding");
      db.prepare("UPDATE task_experience_actions SET result_json=? WHERE operation_id=?").run(
        JSON.stringify({
          kind: "host-run-binding",
          binding: { ...binding, hostRunId: "tampered-host" },
        }),
        String(row.operation_id),
      );
      assert.equal(
        await store.taskExperiences.readTaskExperienceRunBinding(
          "workspace",
          "session",
          "engine-run",
        ),
        undefined,
      );
      await assert.rejects(
        store.taskExperiences.saveTaskExperienceRunBinding(binding),
        /identity reused/,
      );
      assert.equal(
        Number(db.prepare("SELECT count(*) n FROM task_experience_actions").get()!.n),
        1,
      );
    } finally {
      db.close();
    }
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("审批发布规范化多行Unicode正文及附件目标键，编辑批准移除旧Host谓词并保留CAS冲突类型", async () => {
  const store = new SqliteMemoryItemStore(":memory:", { now: () => 1000 });
  try {
    const initial = await seed(
      store,
      "unicode",
      "unicode-task",
      "整理 cafe\u0301\u200b 方法\n[当前附件](pico://artifact/uploaded_file)\n核对范围",
    );
    const job = await store.executionLearning.claimExecutionLearningJob(
      "unicode-worker",
      200,
      90000,
    );
    assert.ok(job);
    const applicability = {
      taskFamily: "spreadsheet" as const,
      toolNames: ["document"],
      conditions: ["当前纯数值范围"],
      spreadsheet: {
        operation: "sum" as const,
        header: false as const,
        dataKind: "finite-numbers" as const,
      },
    };
    const pending = await store.taskExperiences.completeTaskExperienceJob({
      job,
      expectedRecordRevision: 1,
      content: "  cafe\u0301 方法\n核对\u200b当前结果。  ",
      applicability,
      sources: initial.candidate.sources,
      now: 300,
    });
    assert.ok(pending);
    assert.equal(pending.content, "café 方法 核对当前结果。");
    const request = {
      workspaceKey: "workspace",
      candidateId: "unicode",
      expectedRecordRevision: pending.recordRevision,
      expectedContentVersion: 1,
      operationId: "unicode-accept",
      action: "accept" as const,
      now: 400,
    };
    const approved = await store.taskExperiences.reviewTaskExperience(request);
    assert.ok(approved.itemId);
    const record = await store.readItem(approved.itemId);
    assert.ok(record);
    assert.equal(record.sourceType, "reviewed-reference");
    assert.equal(record.taskExperience?.candidateId, "unicode");
    assert.equal(record.item.content, approved.content);
    assert.equal(record.item.contentHash, hash(approved.content));
    assert.ok(record.keys.length > 0);
    assert.ok(
      record.keys.every(
        (key) =>
          Array.from(key.key).length <= 256 &&
          !/[\p{Cc}\p{Cs}\u200B-\u200D\uFEFF]|pico:\/\/artifact\//u.test(key.key),
      ),
    );
    await assert.rejects(
      store.taskExperiences.reviewTaskExperience({
        ...request,
        operationId: "unicode-stale-review",
      }),
      (error) =>
        error instanceof MemoryItemStoreConflictError && error.reason === "version_conflict",
    );
    const edited = await store.taskExperiences.reviewTaskExperience({
      workspaceKey: "workspace",
      candidateId: "unicode",
      expectedRecordRevision: approved.recordRevision,
      expectedContentVersion: 1,
      operationId: "unicode-edit",
      action: "edit_accept",
      content: " cafe\u0301 新方法\n核对当前范围。 ",
      applicability: { ...applicability, conditions: ["当前用户提供的文件"] },
      now: 500,
    });
    assert.equal(edited.content, "café 新方法 核对当前范围。");
    assert.equal(edited.contentVersion, 2);
    assert.equal(edited.validation, "unknown");
    assert.equal(edited.applicability.spreadsheet, undefined);
    assert.deepEqual(edited.applicability, {
      taskFamily: "spreadsheet",
      toolNames: ["document"],
      conditions: ["当前用户提供的文件"],
    });
    const editedRecord = await store.readItem(edited.itemId!);
    assert.equal(editedRecord?.taskExperience?.contentVersion, 2);
    assert.equal(editedRecord?.item.contentHash, hash(edited.content));
    await assert.rejects(
      store.taskExperiences.feedbackTaskExperience({
        workspaceKey: "workspace",
        candidateId: "unicode",
        expectedContentVersion: 1,
        operationId: "unicode-stale-feedback",
        taskId: initial.task.taskId,
        taskVersion: 1,
        action: "correct",
        now: 600,
      }),
      (error) =>
        error instanceof MemoryItemStoreConflictError && error.reason === "version_conflict",
    );
  } finally {
    store.close();
  }
});

test("通用worker固定输入IDs并且缺当前route不消费持久预算", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-task-worker-"));
  const path = join(root, "memory.sqlite");
  const store = new SqliteMemoryItemStore(path);
  let worker: ExecutionLearningWorker | undefined;
  try {
    await seed(store);
    worker = new ExecutionLearningWorker({
      picoHome: root,
      store: store.executionLearning,
      taskExperiences: store.taskExperiences,
      idleMs: 0,
      pollMs: 60000,
      now: () => 1000,
      validateTaskExperienceSources: async () => true,
      taskExperienceModelFactory: async () => {
        throw new Error("Current route removed");
      },
    });
    await worker.flushOnce();
    await worker.drain();
    const candidate = await store.taskExperiences.readTaskExperienceCandidate("lesson");
    assert.equal(candidate?.reason, "model_route_blocked");
    assert.equal(candidate?.enabled, false);
    const db = new DatabaseSync(path);
    try {
      assert.equal(
        Number(db.prepare("SELECT count(*) n FROM execution_learning_attempts").get()!.n),
        0,
      );
    } finally {
      db.close();
    }
    await worker.close();
    const successful = await seed(store, "success", "success-task");
    worker = new ExecutionLearningWorker({
      picoHome: root,
      store: store.executionLearning,
      taskExperiences: store.taskExperiences,
      idleMs: 0,
      pollMs: 60000,
      now: () => 1100,
      validateTaskExperienceSources: async () => true,
      taskExperienceModelFactory: async () => ({
        model: {
          call: async () =>
            JSON.stringify({
              content: "当前工作区检查结果需要独立核对。",
              applicability: { taskFamily: "general", toolNames: ["bash"], conditions: [] },
              evidenceIds: ["e1"],
            }),
        },
      }),
    });
    await worker.flushOnce();
    await worker.drain();
    const pending = await store.taskExperiences.readTaskExperienceCandidate("success");
    assert.equal(pending?.review, "pending", JSON.stringify(pending));
    assert.equal(pending?.validation, "unknown");
    assert.equal(pending?.enabled, false);
    assert.deepEqual(pending?.sources, [successful.observation.source]);
  } finally {
    await worker?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原生settled receipt恢复不再排新任务，跨Run删除不伤其他候选", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-recover-"));
  const path = join(root, "memory.sqlite");
  const store = new SqliteMemoryItemStore(path);
  const db = new DatabaseSync(path);
  try {
    const settings = await store.readSettings("workspace");
    const epoch = await store.executionLearning.advanceExecutionLearningInput("workspace");
    const admission = {
      admissionId: "native-admission",
      workspaceKey: "workspace",
      workDir: "/fixture",
      sessionId: "session",
      runId: "run",
      settingsVersion: settings.version,
      deletionRevision: await store.readDeletionRevision(),
      ...epoch,
      createdAt: 100,
    };
    const claim: ExecutionAcceptanceClaim = {
      candidateId: "native",
      revision: 1,
      failureKey: "native-key",
      predicateId: "command-conditions.v1",
      admission,
      target: {
        targetId: "target",
        label: "check",
        kind: "command",
        command: "node check.cjs",
        argv: ["node", "check.cjs"],
        cwd: "/fixture",
        scopeHash: hash("scope"),
        entryFiles: [],
      },
      claimHash: hash("claim"),
      conditions: [],
      recipe: [
        {
          kind: "file",
          path: "/fixture/repair.cjs",
          afterHash: hash("secret-template"),
          content: "secret-template",
          source: source("repair-event", "repair-run"),
        },
      ],
      failedTestIds: [],
      failure: source("failure"),
      createdAt: 100,
    };
    await store.executionLearning.admitExecutionLearning(admission);
    await store.executionLearning.saveExecutionLearningClaim(claim);
    for (let i = 0; i < 100; i++) {
      const c = { ...claim, candidateId: `done-${i}`, failureKey: `done-key-${i}`, recipe: [] };
      db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        c.candidateId,
        "workspace",
        "session",
        "run",
        c.failureKey,
        "saved",
        1,
        null,
        100,
        JSON.stringify({ claim: c, state: "saved", updatedAt: 100 }),
      );
      db.prepare("INSERT INTO execution_learning_tickets VALUES(?,?,?,?)").run(
        `ticket-${i}`,
        c.candidateId,
        JSON.stringify({
          ticketId: `ticket-${i}`,
          candidateId: c.candidateId,
          claimRevision: 1,
          claimHash: c.claimHash,
        }),
        "{}",
      );
    }
    db.prepare("INSERT INTO execution_learning_tickets VALUES(?,?,?,?)").run(
      "ticket-live",
      "native",
      JSON.stringify({
        ticketId: "ticket-live",
        candidateId: "native",
        claimRevision: 1,
        claimHash: claim.claimHash,
        sessionId: "session",
        runId: "run",
        inputEpoch: epoch.inputEpoch,
      }),
      "{}",
    );
    await store.executionLearning.recoverSettledExecutionLearningJobs(200);
    assert.equal(
      Number(
        db
          .prepare("SELECT count(*) n FROM execution_learning_jobs WHERE candidate_id='native'")
          .get()!.n,
      ),
      0,
    );
    db.prepare("INSERT INTO execution_learning_native_facts VALUES(?,?,?,?,?)").run(
      "repair-admission",
      "repair",
      "prepared",
      "file",
      JSON.stringify({
        source: source("repair-event", "repair-run"),
        commits: [{ content: "secret-template", source: source("repair-event", "repair-run") }],
      }),
    );
    db.prepare("INSERT INTO execution_learning_native_facts VALUES(?,?,?,?,?)").run(
      "other-admission",
      "other",
      "other-prepared",
      "file",
      JSON.stringify({
        source: source("other-event"),
        commits: [{ content: "other-template", source: source("other-event") }],
      }),
    );
    await store.executionLearning.discardExecutionLearning("native", "workspace", 1);
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM execution_learning_native_facts WHERE admission_id='repair-admission'",
          )
          .get()!.n,
      ),
      0,
    );
    assert.equal(
      Number(
        db
          .prepare(
            "SELECT count(*) n FROM execution_learning_native_facts WHERE admission_id='other-admission'",
          )
          .get()!.n,
      ),
      1,
    );
  } finally {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("后台每次IO重新读持久权限，已撤销路径不会沿用旧read授权", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-permission-"));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  await writeFile(join(workDir, "input.txt"), "input");
  const session = new Session("session", workDir, { picoHome, persistence: true });
  try {
    await session.recover();
    const profile = createReadOnlyPermissionProfile();
    session.updateRuntimeState({
      settings: snapshotSessionSettings(
        createDefaultSessionSettings({
          sessionId: "session",
          cwd: workDir,
          provider: "openai",
          model: "test",
          modelRouteId: "test/test",
        }),
      ),
      boundary: { kind: "managed", profile, revision: 1 },
    });
    await session.flushPersistence();
    const authorize = executionLearningPathAuthorizer(workDir, picoHome, "session");
    assert.equal(
      await authorize(join(workDir, "input.txt")),
      await realpath(join(workDir, "input.txt")),
    );
    session.updateRuntimeState({
      boundary: {
        kind: "managed",
        profile: {
          ...profile,
          fileSystem: {
            ...profile.fileSystem,
            entries: [
              ...profile.fileSystem.entries,
              { kind: "path", path: join(workDir, "input.txt"), match: "exact", access: "deny" },
            ],
          },
        },
        revision: 2,
      },
    });
    await session.flushPersistence();
    await assert.rejects(authorize(join(workDir, "input.txt")));
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("原生附件只认冻结身份；编辑与纠正断开，删除清理派生数据且保留共享与历史记录", async () => {
  const root = await mkdtemp(join(tmpdir(), "pico-native-attachment-"));
  const path = join(root, "memory.sqlite");
  let store = new SqliteMemoryItemStore(path, { now: () => 1000 });
  const db = new DatabaseSync(path);
  try {
    const initial = await seed(store);
    db.prepare("DELETE FROM execution_learning_jobs WHERE candidate_id='lesson'").run();
    await store.executionLearning.recoverSettledExecutionLearningJobs(150);
    assert.equal(db.prepare("SELECT count(*) n FROM execution_learning_jobs WHERE candidate_id='lesson'").get()!.n, 1);
    const claim: ExecutionAcceptanceClaim = {
      candidateId: "native-attachment",
      revision: 1,
      failureKey: "native-attachment-key",
      predicateId: "command-conditions.v1",
      admission: {
        admissionId: "native-admission",
        workspaceKey: "workspace",
        workDir: "/fixture",
        sessionId: "session",
        runId: "run",
        inputEpoch: initial.candidate.inputEpoch,
        settingsVersion: 1,
        managementRevision: 0,
        deletionRevision: 0,
        createdAt: 100,
      },
      target: {
        targetId: "check",
        label: "check",
        kind: "command",
        command: "node check.js",
        argv: ["node", "check.js"],
        cwd: "/fixture",
        scopeHash: hash("scope"),
        entryFiles: [],
      },
      claimHash: hash("claim"),
      conditions: [],
      failedTestIds: [],
      recipe: [
        {
          kind: "file",
          path: "/fixture/check.js",
          afterHash: hash("private-template"),
          content: "private-template",
          source: source("native-repair"),
        },
      ],
      failure: initial.candidate.sources[0]!,
      createdAt: 100,
    };
    const native = { claim, state: "waiting", hypothesis: "private-hypothesis", updatedAt: 100 };
    for (const [id, state] of [
      [claim.candidateId, "waiting"],
      ["historical-native", "saved"],
    ]) {
      const record = {
        ...native,
        state,
        claim: { ...claim, candidateId: id, failureKey: `${id}-key` },
      };
      db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
        id!,
        "workspace",
        "session",
        "run",
        `${id}-key`,
        state!,
        1,
        null,
        100,
        JSON.stringify(record),
      );
      db.prepare("INSERT INTO execution_learning_tickets VALUES(?,?,?,?)").run(
        `ticket-${id}`,
        id!,
        JSON.stringify({ candidateId: id, body: "ticket-template" }),
        "{}",
      );
    }
    db.prepare("INSERT INTO execution_learning_native_facts VALUES(?,?,?,?,?)").run(
      "native-admission",
      "repair",
      "prepared",
      "file",
      JSON.stringify({ source: source("native-repair"), commits: claim.recipe }),
    );
    const attachment = {
      candidateId: claim.candidateId,
      claimRevision: 1,
      claimHash: claim.claimHash,
      scopeHash: claim.target.scopeHash,
    };
    const job = await store.executionLearning.claimExecutionLearningJob("worker", 200, 90000);
    assert.ok(job);
    const completion = {
      job,
      expectedRecordRevision: 1,
      content: "运行检查前核对输入条件。",
      applicability: initial.candidate.applicability,
      sources: initial.candidate.sources,
      now: 300,
    };
    await assert.rejects(
      store.executionLearning.completeExecutionLearningJob({
        jobId: job.jobId,
        fencingToken: job.fencingToken,
        candidateRevision: 1,
        content: "不得消耗通用任务",
        now: 300,
      }),
      /candidate missing/,
    );
    for (const invalid of [
      { ...attachment, claimRevision: 2 },
      { ...attachment, claimHash: hash("foreign") },
      { ...attachment, scopeHash: hash("foreign") },
      { ...attachment, candidateId: "missing" },
    ])
      await assert.rejects(
        store.taskExperiences.completeTaskExperienceJob({ ...completion, nativeEvidence: invalid }),
        /native evidence/,
      );
    for (const state of ["discarded", "expired", "invalidated"]) {
      db.prepare("UPDATE execution_learning_candidates SET record_json=? WHERE candidate_id=?")
        .run(JSON.stringify({ ...native, state }), claim.candidateId);
      await assert.rejects(store.taskExperiences.completeTaskExperienceJob({ ...completion, nativeEvidence: attachment }), /native evidence/);
    }
    const originalClaim = native.claim;
    for (const changed of [
      { ...originalClaim, admission: { ...originalClaim.admission, workspaceKey: "other" } },
      { ...originalClaim, failure: { ...originalClaim.failure, runId: "other" } },
    ]) {
      db.prepare("UPDATE execution_learning_candidates SET record_json=? WHERE candidate_id=?").run(
        JSON.stringify({ ...native, claim: changed }),
        claim.candidateId,
      );
      await assert.rejects(
        store.taskExperiences.completeTaskExperienceJob({
          ...completion,
          nativeEvidence: attachment,
        }),
        /native evidence/,
      );
    }
    db.prepare("UPDATE execution_learning_candidates SET record_json=? WHERE candidate_id=?").run(
      JSON.stringify(native),
      claim.candidateId,
    );
    const pending = await store.taskExperiences.completeTaskExperienceJob({
      ...completion,
      nativeEvidence: attachment,
    });
    assert.deepEqual(pending?.nativeEvidence, attachment);
    assert.equal(pending?.validation, "unknown");
    assert.equal(pending?.enabled, false);
    await store.executionLearning.admitExecutionLearning(claim.admission);
    await assert.rejects(store.executionLearning.saveExecutionLearningClaim({
      ...claim, revision: 2, claimHash: hash("later-operation"),
    }), /Attached native evidence is frozen/);
    assert.equal((await store.executionLearning.readExecutionLearningCandidate(claim.candidateId))?.claim.claimHash, claim.claimHash);
    store.close();
    store = new SqliteMemoryItemStore(path, { now: () => 1000 });
    assert.deepEqual(
      (await store.taskExperiences.readTaskExperienceCandidate("lesson"))?.nativeEvidence,
      attachment,
    );
    const accept = {
      workspaceKey: "workspace",
      candidateId: "lesson",
      expectedContentVersion: 1,
      expectedRecordRevision: pending!.recordRevision,
      operationId: "native-accept",
      action: "accept" as const,
      now: 400,
    };
    const saved = await store.taskExperiences.reviewTaskExperience(accept);
    await store.taskExperiences.recordTaskExperienceReuse({
      reuseId: "native-reuse",
      workspaceKey: "workspace",
      candidateId: "lesson",
      contentVersion: 1,
      itemId: saved.itemId!,
      itemVersion: 1,
      taskId: initial.task.taskId,
      taskVersion: 1,
      sessionId: "session",
      runId: "run",
      referenceHash: hash("reference"),
      adoption: "unknown",
      validation: "unknown",
      excluded: false,
      sources: [],
      createdAt: 450,
      updatedAt: 450,
    });
    const corrected = await store.taskExperiences.feedbackTaskExperience({
      workspaceKey: "workspace",
      candidateId: "lesson",
      expectedContentVersion: 1,
      operationId: "native-correct",
      taskId: initial.task.taskId,
      taskVersion: 1,
      action: "correct",
      now: 500,
    });
    assert.equal(corrected.nativeEvidence, undefined);
    assert.equal(corrected.validation, "unknown");
    assert.equal(
      (await store.taskExperiences.reviewTaskExperience(accept)).nativeEvidence,
      undefined,
    );
    // Simulate another active consumer and check that shared templates survive the first deletion.
    const shared = { ...pending!, candidateId: "shared", failureKey: "shared-key" };
    db.prepare("INSERT INTO execution_learning_candidates VALUES(?,?,?,?,?,?,?,?,?,?)").run(
      "shared",
      "workspace",
      "session",
      "run",
      "shared-key",
      "ready",
      shared.recordRevision,
      null,
      500,
      JSON.stringify(shared),
    );
    db.prepare("INSERT INTO task_experience_actions VALUES(?,?,?,?,?,?)").run(
      "native-evidence:shared",
      "workspace",
      "shared",
      hash("link"),
      JSON.stringify({ kind: "native-evidence-link", candidateId: claim.candidateId }),
      500,
    );
    const edited = await store.taskExperiences.reviewTaskExperience({
      workspaceKey: "workspace",
      candidateId: "shared",
      expectedContentVersion: 1,
      expectedRecordRevision: shared.recordRevision,
      operationId: "native-edit",
      action: "edit_accept",
      content: "用户编辑后的独立检查方法。",
      now: 600,
    });
    assert.equal(edited.nativeEvidence, undefined);
    assert.equal(edited.validation, "unknown");
    for (const candidate of [corrected, edited]) {
      const deleted = await store.taskExperiences.reviewTaskExperience({
        workspaceKey: "workspace",
        candidateId: candidate.candidateId,
        expectedContentVersion: candidate.contentVersion,
        expectedRecordRevision: candidate.recordRevision,
        operationId: `delete-${candidate.candidateId}`,
        action: "delete",
        now: 700,
      });
      assert.equal(deleted.nativeEvidence, undefined);
      assert.equal(deleted.content, "");
      if (candidate === corrected)
        assert.equal(
          (await store.executionLearning.readExecutionLearningCandidate(claim.candidateId))
            ?.hypothesis,
          "private-hypothesis",
        );
    }
    const cleared = await store.executionLearning.readExecutionLearningCandidate(claim.candidateId);
    assert.equal(cleared?.state, "discarded");
    assert.equal(cleared?.hypothesis, undefined);
    assert.deepEqual(cleared?.claim.recipe, []);
    assert.equal(
      await store.executionLearning.readExecutionVerification(`ticket-${claim.candidateId}`),
      undefined,
    );
    assert.equal(
      (await store.executionLearning.readExecutionLearningCandidate("historical-native"))?.state,
      "saved",
    );
    assert.ok(await store.executionLearning.readExecutionVerification("ticket-historical-native"));
    assert.equal((await store.taskExperiences.reviewTaskExperience(accept)).content, "");
    assert.equal(
      (
        await store.taskExperiences.completeTaskExperienceJob({
          ...completion,
          nativeEvidence: attachment,
        })
      )?.nativeEvidence,
      undefined,
    );
    assert.equal(
      db
        .prepare(
          "SELECT count(*) n FROM task_experience_actions WHERE result_json LIKE '%nativeEvidence%' OR result_json LIKE '%运行检查前%'",
        )
        .get()!.n,
      0,
    );
    // The saved native fixture shares the repair source, so its fact must remain.
    assert.equal(db.prepare("SELECT count(*) n FROM execution_learning_native_facts").get()!.n, 1);
  } finally {
    db.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
