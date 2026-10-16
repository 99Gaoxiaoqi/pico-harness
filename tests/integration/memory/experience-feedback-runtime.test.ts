import { DatabaseSync } from "node:sqlite";
import { configureReviewedFixture, approveReviewedFixture } from "./unified-experience-fixture.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { LLMProvider, Message, ProviderAttemptLifecycleSnapshot, ToolCall } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { initializeBashParser } from "@pico/runtime/bash-parser";
import { AtomicMemoryContextBuilder } from "@pico/runtime/atomic-memory/context-builder";
import { RuntimeRun } from "@pico/pico-host/product-runtime-run";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import {
  closeExecutionLearningWorker,
  getExecutionLearningWorker,
} from "@pico/pico-host/execution-learning-worker";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { scoreExperienceMatch } from "../../../packages/pico-host/src/task-experience-recall.js";

const command = "node --test check.test.cjs";
const call = (id: string, name: string, input: object): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(input),
});

/** A deterministic provider adapter exposes its prepared body and actual dispatch lifecycle. */
function provider(
  calls: readonly ToolCall[],
  carrier: "present" | "removed" | "unobserved",
): LLMProvider {
  let step = 0;
  const requestKey = randomUUID();
  return {
    requestCapabilities: { physicalAttempts: true, toolChoiceNoneWithTools: true },
    generate: async (messages, _tools, options): Promise<Message> => {
      const index = step++;
      if (carrier !== "unobserved") {
        options?.onRequestPrepared?.({
          provider: "openai",
          model: "test",
          body: {
            messages:
              carrier === "present"
                ? messages
                : [{ role: "user", content: "prepared body omits reference" }],
          },
        });
        const snapshot: ProviderAttemptLifecycleSnapshot = {
          physicalAttemptId: `fixture-physical-${requestKey}-${index}`,
          revision: 0,
          attempt: 1,
          provider: "openai",
          model: "test",
          startedAt: new Date().toISOString(),
          status: "prepared",
          usageBasis: "missing",
        };
        await options?.onProviderAttemptStart?.(snapshot);
        await options?.onProviderAttemptUpdate?.({
          ...snapshot,
          revision: 1,
          status: "observed",
          httpStatus: 200,
        });
        await options?.onProviderAttemptUpdate?.({
          ...snapshot,
          revision: 2,
          status: "succeeded",
          httpStatus: 200,
          completedAt: new Date().toISOString(),
          latencyMs: 0,
        });
      }
      const next = calls[index];
      return next
        ? { role: "assistant", content: "", toolCalls: [next] }
        : { role: "assistant", content: "检查完成。" };
    },
  };
}

for (const legacy of [false, true])
  test(
    `关闭学习仍核验${legacy ? "历史原生" : "已审核通用"}引用，可靠反证会暂停当前经验`,
    { timeout: 45_000 },
    async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pico-experience-feedback-")));
      const workDir = join(root, "workspace"),
        picoHome = join(root, "home");
      await mkdir(workDir);
      await mkdir(picoHome);
      await writeFile(
        join(workDir, "check.test.cjs"),
        [
          'const {test}=require("node:test");const assert=require("node:assert/strict");const fs=require("node:fs");',
          'test("BuildCheck",()=>{assert.equal(fs.readFileSync("config.json","utf8"),"ready\\n");assert.notEqual(process.env.PICO_EXPERIENCE_FAIL,"1");});',
        ].join("\n"),
      );
      const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
      await trust.trust(await trust.canonicalize(workDir));
      const lifecycle = new AtomicMemoryLifecycle();
      const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
      const workspaceKey = resolvePicoPaths(workDir, { picoHome }).workspace.id;
      configureReviewedFixture(
        picoHome,
        "BuildCheck 依赖 config.json 中的 ready 配置。准备配置后运行 check.test.cjs。",
      );
      const sessions: string[] = [];
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const inheritedContext = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      t.after(async () => {
        await closeExecutionLearningWorker(picoHome);
        await lifecycle.close();
        for (const sessionId of sessions)
          await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
        store.close();
        await rm(root, { recursive: true, force: true });
        if (inheritedContext !== undefined) process.env.NODE_TEST_CONTEXT = inheritedContext;
      });
      await initializeBashParser();
      let modelAttempts = 0;
      const run = async (
        sessionId: string,
        calls: readonly ToolCall[],
        carrier: "present" | "removed" | "unobserved",
        fail = false,
        allowBash = true,
      ) => {
        sessions.push(sessionId);
        return executeAgentRuntime(
          {
            prompt: `完成 BuildCheck，检查入口 ${command}。`,
            dir: workDir,
            sessionSelection: { mode: "new", sessionId },
            provider: "openai",
            modelRouteId: "test/test",
            permissionMode: "full-access",
            allowedTools: allowBash ? ["bash", "write_file"] : ["write_file"],
          },
          {
            picoHome,
            env: { ...env, PICO_EXPERIENCE_FAIL: fail ? "1" : "0" },
            memoryTrustStore: trust,
            atomicMemoryLifecycle: lifecycle,
            reporter: new SilentReporter(),
            provider: provider(calls, carrier),
            executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
            atomicMemoryModelFactory: async () => {
              modelAttempts++;
              throw new Error("This fixture must not invoke a proposal model");
            },
          },
        );
      };
      await run(
        "native-source",
        [
          call("source-failure", "bash", { command }),
          call("source-repair", "write_file", { path: "config.json", content: "ready\n" }),
          call("source-pass", "bash", { command }),
        ],
        "unobserved",
      );
      const worker = getExecutionLearningWorker(picoHome);
      assert.ok(worker);
      await worker.flushOnce();
      await worker.drain();
      const reviewed = await approveReviewedFixture(store, workspaceKey);
      const native = await store.executionLearning.readExecutionLearningCandidate(
        reviewed.nativeEvidence!.candidateId,
      );
      assert.ok(native);
      const saved = { ...native, itemId: reviewed.itemId! };
      if (legacy) {
        // A pre-unification database snapshot: migrate an existing item into the historical native shape.
        const item = (await store.readItem(saved.itemId))!;
        const db = new DatabaseSync(join(picoHome, "memory.sqlite"));
        try {
          db.prepare(
            "UPDATE execution_learning_items SET candidate_id=?,source_type='execution-validated',metadata_json=? WHERE item_id=?",
          ).run(
            native.claim.candidateId,
            JSON.stringify({
              candidateId: native.claim.candidateId,
              predicateId: native.claim.predicateId,
              targetId: native.claim.target.targetId,
              targetLabel: native.claim.target.label,
              acceptedAt: Date.now(),
              claimHash: native.claim.claimHash,
              scopeHash: native.claim.target.scopeHash,
            }),
            item.item.itemId,
          );
          db.prepare(
            "UPDATE execution_learning_candidates SET state='saved',item_id=?,record_json=? WHERE candidate_id=?",
          ).run(
            saved.itemId,
            JSON.stringify({ ...native, state: "saved", itemId: saved.itemId }),
            native.claim.candidateId,
          );
          db.prepare(
            "UPDATE execution_learning_candidates SET state='discarded',item_id=NULL,record_json=? WHERE candidate_id=?",
          ).run(
            JSON.stringify({ ...reviewed, state: "discarded", enabled: false, itemId: undefined }),
            reviewed.candidateId,
          );
        } finally {
          db.close();
        }
      }
      const initialCandidateCount = (await store.taskExperiences.queryTaskExperiences(workspaceKey))
        .length;
      await store.updateSettings({
        workspaceKey,
        expectedVersion: (await store.readSettings(workspaceKey)).version,
        autoExtract: false,
      });
      const beforeModelAttempts = modelAttempts;

      await store.updateSettings({
        workspaceKey,
        expectedVersion: (await store.readSettings(workspaceKey)).version,
        enabled: false,
      });
      const executionPrototype: SqliteMemoryItemStore["executionLearning"] = Object.getPrototypeOf(
        store.executionLearning,
      );
      const originalTargets = executionPrototype.listExecutionLearningCandidates;
      const originalReviewed = executionPrototype.queryTaskExperiences;
      let targetReads = 0;
      executionPrototype.listExecutionLearningCandidates = async function (...args) {
        targetReads++;
        return originalTargets.apply(this, args);
      };
      executionPrototype.queryTaskExperiences = async function (...args) {
        targetReads++;
        return originalReviewed.apply(this, args);
      };
      try {
        await run("globally-disabled", [], "present");
      } finally {
        executionPrototype.listExecutionLearningCandidates = originalTargets;
        executionPrototype.queryTaskExperiences = originalReviewed;
      }
      assert.equal(targetReads, 0, "总开关关闭在targets和附件/runner读取前短路");
      await store.updateSettings({
        workspaceKey,
        expectedVersion: (await store.readSettings(workspaceKey)).version,
        enabled: true,
      });
      await run(
        "native-pass",
        [
          call("reused-pass", "bash", { command }),
          call("unrelated-write", "write_file", { path: "notes.txt", content: "memo" }),
        ],
        "present",
      );
      const passedUses = (
        await store.experienceLedger.queryExperienceUses(workspaceKey, { sessionId: "native-pass" })
      ).uses;
      assert.ok(
        passedUses.some(
          (use) =>
            use.source.kind === (legacy ? "execution-validated" : "reviewed-reference") &&
            use.delivery === "carried" &&
            use.adoption === "observed" &&
            use.validation === "pass",
        ),
        JSON.stringify(passedUses),
      );
      const passed = passedUses.find((use) => use.validation === "pass")!;
      assert.ok(passed.recallEventId && passed.providerCallId && passed.physicalAttemptId);
      assert.match(passed.referenceContent!, /^<memory\b/u);
      assert.equal(
        (await store.experienceLedger.listExperienceEffects(passed.useId))[0]?.trustedContradiction,
        false,
      );
      assert.equal(
        (await store.executionLearning.listAdmissions()).filter(
          (admission) => admission.sessionId === "native-pass",
        ).length,
        0,
        "复用不借用proposal admission",
      );
      await store.experienceLedger.feedbackExperienceUse({
        workspaceKey,
        useId: passed.useId,
        expectedItemVersion: passed.itemVersion,
        operationId: "current-task-native-not-applicable",
        action: "not_applicable",
        now: Date.now(),
      });
      const excluded = await new AtomicMemoryContextBuilder(store, workspaceKey).build(command, {
        executionTargets: [
          { targetId: saved.claim.target.targetId, scopeHash: saved.claim.target.scopeHash },
        ],
        reviewedExperiences: [
          {
            candidateId: reviewed.candidateId,
            contentVersion: reviewed.contentVersion,
            recordRevision: reviewed.recordRevision,
            relevanceScore: scoreExperienceMatch(["check.test.cjs"], command),
          },
        ],
        trace: {},
        experienceAllowed: async (record) =>
          !(await store.experienceLedger.isExperienceExcluded({
            workspaceKey,
            itemId: record.item.itemId,
            taskId: passed.taskId,
            taskVersion: passed.taskVersion,
          })),
      });
      assert.equal(
        excluded.references.length,
        0,
        "同task/version后续Run仍在构建上下文前排除本次不适用native方法",
      );
      assert.equal(excluded.trace?.selected.length, 0);

      await run(
        "native-unobserved",
        [call("unobserved-provider", "bash", { command })],
        "unobserved",
      );
      const unobserved = (
        await store.experienceLedger.queryExperienceUses(workspaceKey, {
          sessionId: "native-unobserved",
        })
      ).uses;
      assert.ok(unobserved.length);
      assert.ok(
        unobserved.every((use) => use.delivery === "pending" && use.adoption === "unknown"),
        "缺少prepared与physical事实时不能把命中记为交付",
      );

      const originalRecallRecord = RuntimeRun.prototype.recordRecall;
      RuntimeRun.prototype.recordRecall = async () => {
        throw new Error("private fixture credential=secret-diagnostic-731");
      };
      try {
        await run("native-diagnostic", [], "present");
      } finally {
        RuntimeRun.prototype.recordRecall = originalRecallRecord;
      }
      const diagnostics = await store.experienceLedger.listExperienceDiagnostics(
        workspaceKey,
        "native-diagnostic",
      );
      assert.equal(diagnostics[0]?.phase, "reference");
      assert.equal(
        diagnostics[0]?.reason,
        "experience_feedback_unavailable",
        "无use的失败也持久化为GUI可查询诊断",
      );
      assert.doesNotMatch(JSON.stringify(diagnostics), /secret-diagnostic-731|credential=/u);

      await run("native-removed", [call("removed-carrier", "bash", { command })], "removed", true);
      const removed = (
        await store.experienceLedger.queryExperienceUses(workspaceKey, {
          sessionId: "native-removed",
        })
      ).uses;
      assert.ok(removed.length);
      assert.ok(
        removed.every(
          (use) =>
            use.delivery === "pending" &&
            use.adoption === "unknown" &&
            use.validation === "unknown",
        ),
      );
      assert.equal(
        (await store.readItem(saved.itemId))?.item.lifecycleState,
        "active",
        "命中或本次失败不能冒充方法已采用",
      );

      await run(
        "native-contradiction",
        [call("original-test-failure", "bash", { command })],
        "present",
        true,
      );
      const failedUses = (
        await store.experienceLedger.queryExperienceUses(workspaceKey, {
          sessionId: "native-contradiction",
        })
      ).uses;
      const failed = failedUses.find((use) => use.validation === "fail");
      assert.ok(failed, JSON.stringify(failedUses));
      const effect = (await store.experienceLedger.listExperienceEffects(failed.useId)).find(
        (effect) => effect.validation === "fail",
      );
      assert.equal(effect?.adoption, "observed");
      assert.equal(effect?.validationScope, "native-claim");
      assert.equal(effect?.trustedContradiction, true);
      assert.ok(effect!.preparedSequence > failed.deliverySequence!);
      assert.equal(
        (await store.readItem(saved.itemId))?.item.lifecycleState,
        legacy ? "archived" : "active",
      );
      if (!legacy) {
        const contradicted = await store.taskExperiences.readTaskExperienceCandidate(
          reviewed.candidateId,
        );
        assert.equal(contradicted?.maturity, "suspended");
        assert.equal(contradicted?.enabled, false);
      }
      assert.equal(
        (await store.taskExperiences.queryTaskExperiences(workspaceKey)).length,
        initialCandidateCount,
        "关闭期间不生成generic候选",
      );
      assert.equal(
        (await store.executionLearning.listExecutionLearningCandidates(workspaceKey)).length,
        1,
        "关闭期间不生成native候选",
      );
      assert.equal(modelAttempts, beforeModelAttempts, "引用与效果不调用提案模型");
      if (!legacy) {
        await run("native-permission-revoked", [], "present", false, false);
        assert.equal(
          (
            await store.experienceLedger.queryExperienceUses(workspaceKey, {
              sessionId: "native-permission-revoked",
            })
          ).uses.length,
          0,
        );
        const db = new DatabaseSync(join(picoHome, "memory.sqlite"));
        try {
          db.prepare(
            "UPDATE execution_learning_candidates SET revision=?,record_json=? WHERE candidate_id=?",
          ).run(
            native.claim.revision + 1,
            JSON.stringify({
              ...native,
              claim: { ...native.claim, revision: native.claim.revision + 1 },
            }),
            native.claim.candidateId,
          );
          await run("native-claim-revised", [], "present");
          assert.equal(
            (
              await store.experienceLedger.queryExperienceUses(workspaceKey, {
                sessionId: "native-claim-revised",
              })
            ).uses.length,
            0,
          );
          db.prepare(
            "UPDATE execution_learning_candidates SET revision=?,record_json=? WHERE candidate_id=?",
          ).run(native.claim.revision, JSON.stringify(native), native.claim.candidateId);
        } finally {
          db.close();
        }
        await writeFile(
          join(workDir, "check.test.cjs"),
          "require('node:test').test('different',()=>{});\n",
        );
        await run("native-scope-changed", [], "present");
        assert.equal(
          (
            await store.experienceLedger.queryExperienceUses(workspaceKey, {
              sessionId: "native-scope-changed",
            })
          ).uses.length,
          0,
        );
      }

      await store.updateSettings({
        workspaceKey,
        expectedVersion: (await store.readSettings(workspaceKey)).version,
        autoExtract: true,
      });
      await run("after-reenabled", [], "unobserved");
      assert.equal(
        (await store.executionLearning.listExecutionLearningCandidates(workspaceKey)).length,
        1,
        "重新开启不补生成关闭期间的失败",
      );
    },
  );

for (const deterministic of [false, true])
  test(
    `${deterministic ? "完整冻结测试" : "独立冻结命令任务"}结果保留具体证据且不触发成熟度晋级`,
    { timeout: 45_000 },
    async (t) => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "pico-trial-promotion-")));
      const workDir = join(root, "workspace"),
        picoHome = join(root, "home");
      await mkdir(workDir);
      await mkdir(picoHome);
      const checkFile = deterministic ? "check.test.cjs" : "check.cjs";
      const target = `node ${deterministic ? "--test " : ""}${checkFile}`;
      const check =
        'assert.equal(fs.readFileSync("config.json","utf8"),"ready\\n");assert.notEqual(process.env.PICO_EXPERIENCE_FAIL,"1");';
      await writeFile(
        join(workDir, checkFile),
        'const assert=require("node:assert/strict"),fs=require("node:fs");\n' +
          (deterministic ? `require("node:test").test("BuildCheck",()=>{${check}});\n` : check),
      );
      const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
      await trust.trust(await trust.canonicalize(workDir));
      const lifecycle = new AtomicMemoryLifecycle();
      const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
      const workspaceKey = resolvePicoPaths(workDir, { picoHome }).workspace.id;
      configureReviewedFixture(
        picoHome,
        `BuildCheck 依赖 ready 配置。准备配置后运行 ${checkFile}。`,
      );
      const sessions: string[] = [];
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const inheritedContext = process.env.NODE_TEST_CONTEXT;
      delete process.env.NODE_TEST_CONTEXT;
      t.after(async () => {
        await closeExecutionLearningWorker(picoHome);
        await lifecycle.close();
        for (const sessionId of sessions)
          await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
        store.close();
        await rm(root, { recursive: true, force: true });
        if (inheritedContext !== undefined) process.env.NODE_TEST_CONTEXT = inheritedContext;
      });
      await initializeBashParser();
      const run = async (
        sessionId: string,
        calls: readonly ToolCall[],
        carrier: "present" | "removed" | "unobserved" = "present",
        fail = false,
        resume = false,
      ) => {
        if (!sessions.includes(sessionId)) sessions.push(sessionId);
        await executeAgentRuntime(
          {
            prompt: resume
              ? `刚才的结果不对，请重新核对 BuildCheck，检查入口 ${target}。`
              : `完成 BuildCheck，检查入口 ${target}。`,
            dir: workDir,
            sessionSelection: { mode: resume ? "resume" : "new", sessionId },
            provider: "openai",
            modelRouteId: "test/test",
            permissionMode: "full-access",
            allowedTools: ["bash", "write_file"],
          },
          {
            picoHome,
            env: { ...env, PICO_EXPERIENCE_FAIL: fail ? "1" : "0" },
            memoryTrustStore: trust,
            atomicMemoryLifecycle: lifecycle,
            reporter: new SilentReporter(),
            provider: provider(calls, carrier),
            executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
            atomicMemoryModelFactory: async () => {
              throw new Error("No general extraction model in this fixture");
            },
          },
        );
      };
      await run(
        "trial-source",
        [
          call("original-failure", "bash", { command: target }),
          call("prepare-config", "write_file", { path: "config.json", content: "ready\n" }),
          call("original-pass", "bash", { command: target }),
        ],
        "unobserved",
      );
      const worker = getExecutionLearningWorker(picoHome)!;
      await worker.flushOnce();
      await worker.drain();
      const candidate = (await store.taskExperiences.queryTaskExperiences(workspaceKey))[0]!;
      assert.equal(candidate.review, "unneeded");
      assert.equal(candidate.maturity, "trial");
      assert.equal(candidate.risk, "low");
      assert.ok(candidate.nativeEvidence);
      const native = (await store.executionLearning.readExecutionLearningCandidate(
        candidate.nativeEvidence.candidateId,
      ))!;
      assert.equal(
        native.claim.predicateId,
        deterministic ? "test-target-pass.v1" : "command-conditions.v1",
      );
      assert.ok(native.claim.recipe.length && native.claim.conditions.length);
      await store.updateSettings({
        workspaceKey,
        expectedVersion: (await store.readSettings(workspaceKey)).version,
        autoExtract: false,
      });
      const current = () =>
        store.taskExperiences.readTaskExperienceCandidate(candidate.candidateId);
      await run("ordinary-zero", [
        call("unrelated-success", "bash", { command: "node -e 'process.exit(0)'" }),
      ]);
      assert.equal((await current())!.positiveReuseCount, 0);
      await run("not-carried", [call("omitted-success", "bash", { command: target })], "removed");
      assert.equal((await current())!.positiveReuseCount, 0);
      await run("independent-one", [
        call("first-pass", "bash", { command: target }),
        call("same-task-retry", "bash", { command: target }),
      ]);
      let after = (await current())!;
      assert.equal(after.positiveReuseCount, 0, "历史计数不再由复用更新");
      assert.equal(after.maturity, "trial");
      assert.equal(after.promotionReason, "none");
      const firstUses = (
        await store.experienceLedger.queryExperienceUses(workspaceKey, {
          sessionId: "independent-one",
        })
      ).uses;
      assert.ok(
        firstUses.some(
          (use) =>
            use.delivery === "carried" &&
            use.adoption === "observed" &&
            use.validation === "pass" &&
            use.validationScope === (deterministic ? "native-claim" : "command"),
        ),
      );
      if (!deterministic) {
        const disabled = await store.taskExperiences.reviewTaskExperience({
          workspaceKey,
          candidateId: after.candidateId,
          expectedContentVersion: after.contentVersion,
          expectedRecordRevision: after.recordRevision,
          operationId: "disable-trial",
          action: "disable",
          now: Date.now(),
        });
        after = await store.taskExperiences.reviewTaskExperience({
          workspaceKey,
          candidateId: after.candidateId,
          expectedContentVersion: after.contentVersion,
          expectedRecordRevision: disabled.recordRevision,
          operationId: "restore-trial",
          action: "restore",
          now: Date.now(),
        });
        assert.equal(after.maturity, "trial");
        assert.equal(after.positiveReuseCount, 0);
        await run(
          "independent-one",
          [call("corrected-task-retry", "bash", { command: target })],
          "present",
          false,
          true,
        );
        after = (await current())!;
        assert.equal(
          after.positiveReuseCount,
          0,
          "a correction creates another version of the same task, not an independent task",
        );
        assert.equal(after.maturity, "trial");
        const versions = (
          await store.experienceLedger.queryExperienceUses(workspaceKey, {
            sessionId: "independent-one",
          })
        ).uses;
        assert.equal(new Set(versions.map((use) => use.taskId)).size, 1);
        assert.ok(versions.some((use) => use.taskVersion === 2 && use.validation === "pass"));
      }
      await run("independent-two", [call("second-pass", "bash", { command: target })]);
      after = (await current())!;
      assert.equal(after.maturity, "trial");
      assert.equal(after.review, "unneeded", "evidence maturity does not fabricate human approval");
      assert.equal(after.positiveReuseCount, 0);
      assert.equal(after.promotionReason, "none");
      await run("active-reuse", [call("active-pass", "bash", { command: target })]);
      const activeUses = (
        await store.experienceLedger.queryExperienceUses(workspaceKey, {
          sessionId: "active-reuse",
        })
      ).uses;
      assert.ok(
        activeUses.some(
          (use) =>
            use.delivery === "carried" && use.adoption === "observed" && use.validation === "pass",
        ),
        "具体范围证据不改变建议的使用边界",
      );
      await run(
        "same-scope-failure",
        [call("contradicted", "bash", { command: target })],
        "present",
        true,
      );
      after = (await current())!;
      assert.equal(
        after.maturity,
        deterministic ? "suspended" : "trial",
        "ordinary process failure is not trusted counter-evidence",
      );
      if (deterministic) {
        assert.equal(after.enabled, false);
        await assert.rejects(
          store.taskExperiences.reviewTaskExperience({
            workspaceKey,
            candidateId: after.candidateId,
            expectedContentVersion: after.contentVersion,
            expectedRecordRevision: after.recordRevision,
            operationId: "restore-contradiction",
            action: "restore",
            now: Date.now(),
          }),
          /must be (?:edited|revised)/,
        );
        await run("after-suspension", [call("no-reference", "bash", { command: target })]);
        assert.equal(
          (
            await store.experienceLedger.queryExperienceUses(workspaceKey, {
              sessionId: "after-suspension",
            })
          ).uses.length,
          0,
        );
      }
      const edited = await store.taskExperiences.reviewTaskExperience({
        workspaceKey,
        candidateId: after.candidateId,
        expectedContentVersion: after.contentVersion,
        expectedRecordRevision: after.recordRevision,
        operationId: "edit-resets-evidence",
        action: "edit_accept",
        content: "人工修订后的新检查方法。",
        now: Date.now(),
      });
      assert.equal(edited.contentVersion, after.contentVersion + 1);
      assert.equal(
        edited.positiveReuseCount,
        0,
        "verification counts belong to the previous content version",
      );
      assert.equal(edited.validation, "unknown");
      assert.equal(edited.nativeEvidence, undefined);
      assert.equal(edited.promotionReason, "human_approved");
    },
  );
