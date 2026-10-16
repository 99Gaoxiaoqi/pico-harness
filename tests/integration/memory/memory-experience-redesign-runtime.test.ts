import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type {
  ExecutionLearningJob,
  RuntimeToolStartedEvent,
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceStore,
  TaskExperienceTask,
} from "@pico/core";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { countTokens } from "@pico/runtime";
import { ExecutionLearningWorker } from "../../../packages/pico-host/src/execution-learning-worker.js";
import { TaskExperienceRuntime } from "../../../packages/pico-host/src/task-experience-runtime.js";
import { ExperienceFeedbackRuntime } from "../../../packages/pico-host/src/experience-feedback-runtime.js";
import {
  scoreExperienceMatch,
  searchTaskExperienceCases,
  taskExperienceRecallTargets,
} from "../../../packages/pico-host/src/task-experience-recall.js";
import { buildMemorySearchTool } from "../../../packages/pico-host/src/memory-trigger-tools.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const source = (eventId: string) => ({
  sessionId: "session",
  runId: "run",
  turnId: "turn",
  eventId,
});
async function waiting(store: SqliteMemoryItemStore, workDir: string, useful = true) {
  const now = Date.now();
  const settings = await store.readSettings("workspace");
  const epoch = await store.executionLearning.advanceExecutionLearningInput("workspace");
  const task: TaskExperienceTask = {
    taskId: "task",
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir,
    sessionId: "session",
    runId: "run",
    goal: "整理需求边界",
    goalSource: source("input"),
    coverage: "complete",
    throughSequence: 1,
    createdAt: now,
    updatedAt: now,
  };
  const observation: TaskExperienceObservation = {
    observationId: "observation",
    taskId: task.taskId,
    taskVersion: 1,
    source: source("input"),
    sequence: 1,
    kind: useful ? "user-input" : "tool-result",
    summary: useful
      ? "这种方法：先明确具体边界再给出建议，很有效，请保留。"
      : "本次操作成功，原因未知。",
    coverage: "complete",
    ...(useful ? {} : { status: "succeeded" as const, toolName: "read_file" }),
    createdAt: now,
  };
  await store.taskExperiences.appendTaskExperienceObservations(task, [observation]);
  const candidate: TaskExperienceCandidate = {
    candidateId: "candidate",
    kind: "task-lesson",
    taskId: task.taskId,
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir,
    sessionId: "session",
    runId: "run",
    failureKey: "failure",
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
    representation: "case",
    usagePolicy: "case_only",
    matchHints: [],
    requiredConditions: [],
    createdAt: now,
    updatedAt: now,
  };
  await store.taskExperiences.createTaskExperienceCandidate(candidate);
  const job: ExecutionLearningJob = {
    jobId: "job",
    workspaceKey: "workspace",
    candidateId: candidate.candidateId,
    sessionId: "session",
    runId: "run",
    kind: "reflect",
    state: "ready",
    inputEpoch: epoch.inputEpoch,
    createdAt: now,
    updatedAt: now,
    leaseUntil: 0,
    fencingToken: 0,
  };
  await store.executionLearning.enqueueExecutionLearningJob(job);
  return { candidate, task, job };
}
const proposal = (representation = "method") =>
  JSON.stringify({
    representation,
    content: "讨论具体边界时，先明确约束，再逐项给出建议。",
    matchHints: ["具体边界"],
    applicability: { taskFamily: "general", toolNames: [], conditions: ["讨论需求边界时参考"] },
    evidenceIds: ["e1"],
  });

test("无工具方法由明确来源成为建议；未支持因果的输出留案例，skip不造记忆", async (t) => {
  for (const kind of ["method", "case", "skip"] as const) {
    const store = new SqliteMemoryItemStore(":memory:");
    await waiting(store, "/fixture", kind === "method");
    const worker = new ExecutionLearningWorker({
      picoHome: `/fixture-${kind}`,
      store: store.executionLearning,
      taskExperiences: store.taskExperiences,
      idleMs: 0,
      pollMs: 60_000,
      validateTaskExperienceSources: async () => true,
      taskExperienceModelFactory: async () => ({
        model: { call: async () => (kind === "skip" ? '{"representation":"skip"}' : proposal()) },
        dispose() {},
      }),
    });
    t.after(async () => {
      await worker.close();
      store.close();
    });
    await worker.flushOnce();
    await worker.drain();
    const saved = await store.taskExperiences.readTaskExperienceCandidate("candidate");
    assert.ok(saved);
    const items = await store.listItems({ workspaceKey: "workspace", learningVersion: 2 });
    if (kind === "skip") {
      assert.equal(items.length, 0);
      assert.equal(saved.reason, "reflection_skipped");
      continue;
    }
    assert.equal(saved.representation, kind);
    assert.equal(saved.usagePolicy, kind === "method" ? "suggestion" : "case_only");
    assert.equal(items.length, kind === "method" ? 1 : 0);
    if (kind === "method") {
      assert.equal(saved.enabled, true);
      assert.equal(saved.validation, "unknown");
      const targets = await taskExperienceRecallTargets({
        store: store.taskExperiences,
        workspaceKey: "workspace",
        workDir: "/fixture",
        query: "讨论具体边界",
        toolAllowed: () => false,
      });
      assert.equal(targets.length, 1);
      const block = await new AtomicMemoryContextBuilder(store, "workspace").build("讨论具体边界", {
        reviewedExperiences: targets,
      });
      assert.equal(block.items.length, 1);
      assert.ok(block.tokenCount <= 320);
      assert.match(block.block, /历史建议/);
      assert.equal(
        (
          await taskExperienceRecallTargets({
            store: store.taskExperiences,
            workspaceKey: "workspace",
            workDir: "/fixture",
            query: "天气怎么样",
            toolAllowed: () => true,
          })
        ).length,
        0,
      );
      const root = await mkdtemp(join(tmpdir(), "pico-provider-reference-gate-"));
      const events = new SqliteRuntimeEventStore({ storageRoot: root });
      t.after(async () => {
        events.close();
        await rm(root, { recursive: true, force: true });
      });
      const feedback = new ExperienceFeedbackRuntime({
        session: { id: "session", runtimeEventStore: events },
        workspaceKey: "workspace",
        workDir: "/fixture",
        picoHome: root,
        store,
        currentTask: () => undefined,
        referenceGate: async () => ({ allowed: true }),
        effectGate: async () => ({ allowed: true }),
        nativeGate: async () => ({ allowed: true }),
        io: { realpath: async () => undefined, readFile: async () => undefined },
        validateReviewed: async () => ({ adoption: "unknown", validation: "unknown", sources: [] }),
      });
      feedback.admit("run");
      const activeSearch = await new AtomicMemoryContextBuilder(store, "workspace").build(
        "具体边界",
        { mode: "search", reviewedExperiences: targets },
      );
      const messages = [{ role: "user" as const, content: activeSearch.block }];
      assert.equal(
        (await feedback.filterProviderMessages(messages))[0]!.content,
        activeSearch.block,
      );
      await store.taskExperiences.reviewTaskExperience({
        workspaceKey: "workspace",
        candidateId: saved.candidateId,
        expectedContentVersion: saved.contentVersion,
        expectedRecordRevision: saved.recordRevision,
        action: "disable",
        operationId: "disable-before-next-provider",
        now: Date.now(),
      });
      assert.doesNotMatch(
        (await feedback.filterProviderMessages(messages))[0]!.content,
        /<memory /,
        "下一Provider调用不携带已停用原片段",
      );
      assert.equal(
        (await store.experienceLedger.queryExperienceUses("workspace")).uses.length,
        0,
        "过滤本身不伪造投递或采用",
      );
    } else {
      const block = await searchTaskExperienceCases({
        store: store.taskExperiences,
        workspaceKey: "workspace",
        workDir: "/fixture",
        query: "具体边界",
      });
      assert.match(block, /<case /);
      assert.ok(countTokens(block) <= 1500);
      assert.equal(
        (await new AtomicMemoryContextBuilder(store, "workspace").build("具体边界")).items.length,
        0,
      );
    }
  }
});

test("所有maturity与审核状态共享硬条件；重叠双字词和泛词不构成相关命中", async () => {
  const base: TaskExperienceCandidate = {
    candidateId: "method",
    kind: "task-lesson",
    taskId: "task",
    taskVersion: 1,
    workspaceKey: "workspace",
    workDir: "/fixture",
    sessionId: "session",
    runId: "run",
    failureKey: "failure",
    inputEpoch: 0,
    settingsVersion: 1,
    deletionRevision: 0,
    state: "saved",
    lifecycleState: "active",
    goal: "具体边界",
    content: "讨论具体边界时先明确约束。",
    contentVersion: 1,
    recordRevision: 1,
    review: "approved",
    validation: "unknown",
    enabled: true,
    representation: "method",
    usagePolicy: "suggestion",
    matchHints: ["具体边界"],
    requiredConditions: [
      { kind: "spreadsheet-range", operation: "sum", header: false, dataKind: "finite-numbers" },
    ],
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: [source("input")],
    observationIds: [],
    itemId: "item",
    createdAt: 1,
    updatedAt: 1,
  };
  for (const maturity of ["trial", "active"] as const)
    for (const match of [false, "unknown", true] as const) {
      const store = {
        queryTaskExperiences: async () => [{ ...base, maturity }],
      } as unknown as TaskExperienceStore;
      assert.equal(
        (
          await taskExperienceRecallTargets({
            store,
            workspaceKey: "workspace",
            workDir: "/fixture",
            query: "具体边界",
            toolAllowed: () => false,
            conditionMatches: async () => match,
          })
        ).length,
        match === true ? 1 : 0,
      );
    }
  const expired = {
    queryTaskExperiences: async () => [
      { ...base, requiredConditions: [], expiresAt: Date.now() - 1 },
    ],
  } as unknown as TaskExperienceStore;
  assert.equal(
    (
      await taskExperienceRecallTargets({
        store: expired,
        workspaceKey: "workspace",
        workDir: "/fixture",
        query: "具体边界",
        toolAllowed: () => true,
      })
    ).length,
    0,
  );
  assert.equal(scoreExperienceMatch(["代码", "任务", "测试"], "代码任务测试"), 0);
  assert.equal(scoreExperienceMatch(["计算器"], "计算器"), 0);
  assert.ok(scoreExperienceMatch(["具体边界"], "具体边界") > 0);
  assert.equal(scoreExperienceMatch(["boundary"], "boundaries"), 0);
});

test("memory_search显式case模式保持缺省memory且拒绝混合原生目标", async () => {
  const seen: string[] = [];
  const tool = buildMemorySearchTool({
    search: async (_query, _context, _target, recordType) => {
      seen.push(recordType!);
      return "history";
    },
  });
  await tool.execute('{"query":"boundary"}');
  await tool.execute('{"query":"boundary","record_type":"case"}');
  assert.deepEqual(seen, ["memory", "case"]);
  await assert.rejects(
    tool.execute('{"query":"boundary","record_type":"case","execution_target_id":"target"}'),
  );
});

test("10秒空闲后反思，新输入中断后用新租约恢复有效冻结来源", async (t) => {
  const store = new SqliteMemoryItemStore(":memory:");
  await waiting(store, "/fixture");
  let now = Date.now(),
    calls = 0;
  let started!: () => void;
  const modelStarted = new Promise<void>((resolve) => {
    started = resolve;
  });
  const worker = new ExecutionLearningWorker({
    picoHome: "/interrupted-fixture",
    store: store.executionLearning,
    taskExperiences: store.taskExperiences,
    now: () => now,
    pollMs: 60_000,
    validateTaskExperienceSources: async () => true,
    taskExperienceModelFactory: async () => ({
      model: {
        call: async ({ signal }) => {
          calls++;
          if (calls > 1) return proposal();
          started();
          return new Promise<string>((resolve) =>
            signal!.addEventListener("abort", () => resolve(proposal()), { once: true }),
          );
        },
      },
    }),
  });
  t.after(async () => {
    await worker.close();
    store.close();
  });
  now += 9_999;
  assert.equal(await worker.flushOnce(), false);
  now++;
  const interrupted = worker.flushOnce();
  await modelStarted;
  worker.notifyForegroundInput("workspace");
  await store.executionLearning.advanceExecutionLearningInput("workspace");
  await interrupted;
  assert.equal(
    (await store.taskExperiences.readTaskExperienceCandidate("candidate"))!.state,
    "waiting",
  );
  now += 10_000;
  await worker.flushOnce();
  await worker.drain();
  assert.equal(calls, 2);
  assert.equal(
    (await store.taskExperiences.readTaskExperienceCandidate("candidate"))!.usagePolicy,
    "suggestion",
  );
});

test("明确引用旧事实的纠正在capture中同步归档，模糊结果纠正不批量改写", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-fact-correction-"));
  const store = new SqliteMemoryItemStore(":memory:");
  const events = new SqliteRuntimeEventStore({ storageRoot: join(root, "events") });
  t.after(async () => {
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  await store.applyMutations({
    operationId: "fact",
    mutations: [
      {
        type: "create",
        item: {
          content: "部署命令是 old.sh",
          kind: "knowledge",
          statementType: "fact",
          temporalType: "undated",
          scopeType: "workspace",
          scopeKey: "workspace",
          observedAt: Date.now(),
          origin: "user_requested",
          keys: [{ key: "部署命令", keyType: "concept", keyOrigin: "llm" }],
          sources: [source("fact-source")],
        },
      },
    ],
  });
  const sessionId = "fact-correction";
  await events.initializeSession({ sessionId, workDir: root });
  const ownerFence = await events.advanceOwnerFence(sessionId, 0);
  for (const [index, content] of [
    "刚才结果错了，请重新处理。",
    "“部署命令是 old.sh”不对，应该是 new.sh。",
  ].entries()) {
    const runId = `run-${index}`;
    const base = {
      schemaVersion: 2 as const,
      sessionId,
      runId,
      invocationId: runId,
      turnId: "turn",
      at: new Date().toISOString(),
      partial: false,
      visibility: "model" as const,
    };
    await events.append(
      {
        ...base,
        eventId: `start-${index}`,
        kind: "run.started",
        data: { workDir: root, agentSwarmAuthorization: "none" },
      },
      { ownerFence },
    );
    await events.append(
      {
        ...base,
        eventId: `input-${index}`,
        kind: "message.committed",
        data: { message: { role: "user", content } },
      },
      { ownerFence },
    );
    const runtime = new TaskExperienceRuntime({
      session: { id: sessionId, runtimeEventStore: events },
      workspaceKey: "workspace",
      workDir: root,
      store,
      gate: async () => ({ allowed: true }),
      worker: { wake() {} },
    });
    await runtime.admit(runId);
    await runtime.capture(`input-${index}`);
    const active = await store.listItems({ workspaceKey: "workspace" });
    assert.equal(active.length, index === 0 ? 1 : 0);
  }
  assert.equal(
    (await new AtomicMemoryContextBuilder(store, "workspace").build("部署命令")).items.length,
    0,
  );
});

test("成功预筛仅接受有产物回执及结构流程的任务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-memory-redesign-runtime-"));
  const store = new SqliteMemoryItemStore(":memory:");
  const events = new SqliteRuntimeEventStore({ storageRoot: join(root, "events") });
  t.after(async () => {
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  });
  let index = 0;
  for (const valuable of [false, true]) {
    const sessionId = `session-${index++}`,
      runId = "run";
    await events.initializeSession({ sessionId, workDir: root });
    const ownerFence = await events.advanceOwnerFence(sessionId, 0);
    const base = (eventId: string) => ({
      schemaVersion: 2 as const,
      sessionId,
      runId,
      eventId: `${sessionId}-${eventId}`,
      invocationId: runId,
      turnId: "turn",
      at: new Date().toISOString(),
      partial: false,
      visibility: "model" as const,
    });
    const append = (event: RuntimeEvent) => events.append(event, { ownerFence });
    await append({
      ...base("start"),
      kind: "run.started",
      data: { workDir: root, agentSwarmAuthorization: "none" },
    });
    await append({
      ...base("input"),
      kind: "message.committed",
      data: { message: { role: "user", content: "先读取输入再写入报告，并复读检查。" } },
    });
    for (const [step, name] of ["read_file", "write_file", "read_file"].entries()) {
      const toolCallId = `${sessionId}-tool-${step}`,
        args = JSON.stringify({ path: "report.html" });
      const prepared: RuntimeToolStartedEvent = {
        ...base(`prepared-${step}`),
        kind: "tool.started",
        refs: { toolCallId },
        data: {
          toolName: name,
          argumentsJson: args,
          argumentsHash: hash(args),
          argumentsRedacted: false,
          recoveryMode: "replay_safe",
        },
      };
      const operation = await events.prepareToolOperation({
        dispatchEvent: prepared,
        toolCallId,
        ownerFence,
      });
      const content =
        name === "write_file" && valuable
          ? "✅ 新建文件: report.html\n已登记生成文件: report.html"
          : "普通操作成功";
      await events.settleToolOperation({
        toolCallId,
        expectedVersion: operation.operation.version,
        ownerFence,
        resultEvent: {
          ...base(`result-${step}`),
          kind: "tool.result.recorded",
          refs: { toolCallId },
          data: {
            toolName: name,
            status: "succeeded",
            body: {
              storage: "inline",
              content,
              sha256: hash(content),
              sizeBytes: Buffer.byteLength(content),
            },
            projection: {
              version: 1,
              mode: "full",
              text: content,
              strategy: "full",
              truncated: false,
            },
          },
        },
      });
    }
    await append({ ...base("terminal"), kind: "run.terminal", data: { status: "completed" } });
    const runtime = new TaskExperienceRuntime({
      session: { id: sessionId, runtimeEventStore: events },
      workspaceKey: "workspace",
      workDir: root,
      store,
      gate: async () => ({ allowed: true }),
      worker: { wake() {} },
    });
    await runtime.admit(runId);
    await runtime.capture();
    await runtime.completed(runId);
    assert.equal(
      (await store.taskExperiences.queryTaskExperiences("workspace", { sessionId })).length,
      valuable ? 1 : 0,
    );
  }
});
