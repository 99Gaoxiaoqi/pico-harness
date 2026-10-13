import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type {
  ExecutionAcceptanceClaim,
  ExecutionLearningAdmission,
  Message,
  ToolCall,
} from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { initializeBashParser } from "@pico/runtime/bash-parser";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import {
  closeExecutionLearningWorker,
  ExecutionLearningWorker,
  getExecutionLearningWorker,
} from "@pico/pico-host/execution-learning-worker";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

test(
  "普通新输入在反思前继续修复可取得跨 Run T1 验收票，旧反思不降级候选或消耗模型额度",
  { timeout: 30_000 },
  async (t) => {
    const inheritedTestContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    t.after(() => {
      if (inheritedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = inheritedTestContext;
    });
    const root = await mkdtemp(join(tmpdir(), "pico-learning-cross-run-"));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(picoHome);
    await writeFile(
      join(workDir, "check.test.cjs"),
      'const {test}=require("node:test");const assert=require("node:assert/strict");const fs=require("node:fs");test("BuildCheck",()=>assert.equal(fs.readFileSync("config.json","utf8"),"ready\\n"));\n',
    );
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    const paths = resolvePicoPaths(workDir, { picoHome });
    const repository = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    await initializeBashParser();
    const sessionIds = ["cross-run-failure", "cross-run-repair"];
    const held: { foreground?: { release(): void } } = {};
    t.after(async () => {
      held.foreground?.release();
      await closeExecutionLearningWorker(picoHome);
      await lifecycle.close();
      for (const sessionId of sessionIds)
        await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      repository.close();
      await rm(root, { recursive: true, force: true });
    });
    const command = "node --test check.test.cjs";
    const call = (id: string, name: string, input: object): ToolCall => ({
      id,
      name,
      arguments: JSON.stringify(input),
    });
    const run = async (sessionId: string, calls: readonly ToolCall[]) => {
      let step = 0;
      return executeAgentRuntime(
        {
          prompt: `继续完成检查入口 ${command}，保留此前执行证据。`,
          dir: workDir,
          sessionSelection: { mode: "new", sessionId },
          provider: "openai",
          modelRouteId: "test/test",
          permissionMode: "full-access",
          allowedTools: ["bash", "write_file", "memory_learn"],
        },
        {
          picoHome,
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          reporter: new SilentReporter(),
          provider: {
            generate: async (): Promise<Message> => {
              const next = calls[step++];
              return next
                ? { role: "assistant", content: "", toolCalls: [next] }
                : { role: "assistant", content: "本轮已完成。" };
            },
          },
          // A held foreground lease models the production idle window without a ten-second sleep.
          executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
          atomicMemoryModelFactory: async () => {
            throw new Error("This regression uses no model inference");
          },
        },
      );
    };

    await run(sessionIds[0]!, [call("first-failure", "bash", { command })]);
    const worker = getExecutionLearningWorker(picoHome);
    assert.ok(worker);
    // No event-loop delay occurs between the first completion and this scheduling barrier.
    const foreground = worker.foregroundRun(paths.workspace.id);
    held.foreground = foreground;
    const seed = (
      await repository.executionLearning.listExecutionLearningCandidates(paths.workspace.id)
    )[0];
    assert.ok(seed, "the first real failed test must create an admitted candidate");
    assert.equal(seed.state, "waiting", "queued reflection must leave the seed eligible at T1");
    const completedAt = Date.now();
    await run(sessionIds[1]!, [
      call("native-repair", "write_file", { path: "config.json", content: "ready\n" }),
      call("natural-pass", "bash", { command }),
    ]);
    assert.ok(
      Date.now() - completedAt < 10_000,
      "ordinary continuation occurs within the idle window",
    );
    assert.equal(await worker.flushOnce(), false, "reflection stays behind the foreground barrier");

    const inspect = <T>(read: (db: DatabaseSync) => T): T => {
      const db = new DatabaseSync(join(picoHome, "memory.sqlite"), { readOnly: true });
      try {
        return read(db);
      } finally {
        db.close();
      }
    };
    assert.equal(
      inspect((db) =>
        Number(
          db
            .prepare(
              "SELECT count(*) AS n FROM execution_learning_tickets WHERE result_json IS NOT NULL",
            )
            .get()!.n,
        ),
      ),
      1,
      "natural execution of the next Run has a persisted T1 ticket and complete result",
    );
    const frozen = await repository.executionLearning.readExecutionLearningCandidate(
      seed.claim.candidateId,
    );
    assert.ok(frozen);
    assert.equal(frozen.state, "ready");
    assert.equal(frozen.claim.revision, seed.claim.revision + 1);
    assert.equal(frozen.claim.recipe[0]?.source.sessionId, sessionIds[1]);

    foreground.release();
    await worker.flushOnce();
    await worker.drain();
    assert.equal(
      (await repository.executionLearning.readExecutionLearningCandidate(seed.claim.candidateId))
        ?.state,
      "ready",
      "the old input epoch settles only its reflection job and leaves the verified claim eligible",
    );
    assert.equal(
      inspect((db) =>
        Number(db.prepare("SELECT count(*) AS n FROM execution_learning_attempts").get()!.n),
      ),
      0,
      "superseded reflection is rejected before reserving a model attempt",
    );
    await worker.flushOnce();
    await worker.drain();
    const items = await repository.listItems({ workspaceKey: paths.workspace.id });
    assert.equal(items.length, 1);
    assert.equal(items[0]?.sourceType, "execution-validated");
    assert.equal(items[0]?.taskAcceptance?.predicateId, "test-target-pass.v1");
    assert.equal(
      (await repository.executionLearning.readExecutionLearningCandidate(seed.claim.candidateId))
        ?.state,
      "saved",
    );
  },
);

test("反思入队后关闭自动提取会在模型工厂和额度扣减之前拒绝旧任务", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pico-learning-disabled-reflection-"));
  const repository = new SqliteMemoryItemStore(join(root, "memory.sqlite"));
  const held: { worker?: ExecutionLearningWorker } = {};
  t.after(async () => {
    await held.worker?.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  });
  const workspaceKey = "policy-workspace";
  const settings = await repository.readSettings(workspaceKey);
  const generation = await repository.executionLearning.advanceExecutionLearningInput(workspaceKey);
  const admission: ExecutionLearningAdmission = {
    admissionId: "policy-admission",
    workspaceKey,
    sessionId: "policy-session",
    runId: "policy-run",
    workDir: "/fixture",
    settingsVersion: settings.version,
    deletionRevision: await repository.readDeletionRevision(),
    managementRevision: generation.managementRevision,
    inputEpoch: generation.inputEpoch,
    createdAt: Date.now(),
  };
  await repository.executionLearning.admitExecutionLearning(admission);
  const claim: ExecutionAcceptanceClaim = {
    candidateId: "policy-candidate",
    revision: 1,
    failureKey: "policy-failure",
    predicateId: "command-conditions.v1",
    admission,
    target: {
      targetId: "policy-target",
      label: "node check.cjs",
      kind: "command",
      command: "node check.cjs",
      argv: ["node", "check.cjs"],
      cwd: "/fixture",
      scopeHash: "a".repeat(64),
      entryFiles: [{ path: "/fixture/check.cjs", hash: "b".repeat(64) }],
    },
    claimHash: "c".repeat(64),
    conditions: [],
    recipe: [],
    failedTestIds: [],
    failure: {
      sessionId: admission.sessionId,
      runId: admission.runId,
      turnId: "policy-turn",
      eventId: "native-policy-failure",
    },
    createdAt: Date.now(),
  };
  await repository.executionLearning.saveExecutionLearningClaim(claim);
  await repository.executionLearning.enqueueExecutionLearningJob({
    jobId: "policy-reflection",
    workspaceKey,
    sessionId: admission.sessionId,
    runId: admission.runId,
    candidateId: claim.candidateId,
    kind: "reflect",
    state: "ready",
    inputEpoch: admission.inputEpoch,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    leaseUntil: 0,
    fencingToken: 0,
  });
  await repository.updateSettings({
    workspaceKey,
    expectedVersion: settings.version,
    autoExtract: false,
  });
  let factoryCalls = 0;
  const worker = new ExecutionLearningWorker({
    picoHome: root,
    store: repository.executionLearning,
    idleMs: 0,
    pollMs: 60_000,
    validateEvidence: async () => ({ status: "insufficient" }),
    modelFactory: async () => {
      factoryCalls++;
      return { model: { call: async () => '{"hypothesis":"Possibly configuration related"}' } };
    },
  });
  held.worker = worker;
  await worker.flushOnce();
  await worker.drain();
  assert.equal(factoryCalls, 0, "disabled automatic extraction must not create a model lease");
  const db = new DatabaseSync(join(root, "memory.sqlite"), { readOnly: true });
  try {
    assert.equal(
      Number(db.prepare("SELECT count(*) AS n FROM execution_learning_attempts").get()!.n),
      0,
    );
  } finally {
    db.close();
  }
  assert.equal(
    (await repository.executionLearning.readExecutionLearningCandidate(claim.candidateId))?.state,
    "invalidated",
  );
});
