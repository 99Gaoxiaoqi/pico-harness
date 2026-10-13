import { configureExecutionLearningHost } from "../../packages/pico-host/dist/execution-learning-host.js";
import { ProviderAtomicMemoryModel } from "@pico/pico-host/atomic-memory-runtime";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import type { LLMProvider, Message } from "@pico/core";
import { isForegroundProcessFacts } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import {
  closeExecutionLearningWorker,
  getExecutionLearningWorker,
} from "@pico/pico-host/execution-learning-worker";
import { createProvider } from "@pico/pico-host/provider/factory";
import { globalSessionManager } from "@pico/pico-host/session";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { configuredUserDefaultRealModel } from "./real-llm-user-model.js";

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
const command = "node --test check.test.cjs";
const checker = [
  'const { test } = require("node:test");',
  'const assert = require("node:assert/strict");',
  'const fs = require("node:fs");',
  'test("BuildCheck", () => {',
  '  assert.ok(fs.existsSync("config.json"), "BuildCheck expects config.json with project FixtureNorth");',
  '  const config = JSON.parse(fs.readFileSync("config.json", "utf8"));',
  '  assert.equal(config.project, "FixtureNorth");',
  "});",
].join("\n");

realModelTest(
  "真实通用反思经用户审核后复用，Node原生证据只验证冻结范围",
  { timeout: 5 * 60_000 },
  async (t) => {
    const configured = await configuredUserDefaultRealModel();
    const root = await realpath(await mkdtemp(join(tmpdir(), "pico-autonomous-learning-real-")));
    const workDir = join(root, "workspace"),
      picoHome = join(root, "home");
    await mkdir(workDir);
    await mkdir(picoHome);
    await writeFile(join(workDir, "check.test.cjs"), checker);
    const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
    await trust.trust(await trust.canonicalize(workDir));
    const lifecycle = new AtomicMemoryLifecycle();
    const paths = resolvePicoPaths(workDir, { picoHome });
    const repository = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
    const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
    const sessions = ["autonomous-real-source", "autonomous-real-reuse"];
    const inheritedTestContext = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    t.after(async () => {
      try {
        await closeExecutionLearningWorker(picoHome);
        await lifecycle.close();
        for (const sessionId of sessions)
          await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
        events.close();
        repository.close();
        if (process.env.PICO_KEEP_EXPERIENCE_E2E !== "1")
          await rm(root, { recursive: true, force: true });
        else t.diagnostic(`fixture retained: ${root}`);
      } finally {
        if (inheritedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
        else process.env.NODE_TEST_CONTEXT = inheritedTestContext;
      }
    });
    const requests: Message[][] = [];
    let reflectionCalls = 0;
    configureExecutionLearningHost(picoHome, {
      modelFactory: async () => {
        reflectionCalls++;
        return {
          model: new ProviderAtomicMemoryModel(
            createProvider(configured.provider, configured.config),
          ),
        };
      },
    });
    const main = createProvider(configured.provider, configured.config);
    const provider = new Proxy(main, {
      get(target, key) {
        if (key === "generate")
          return (...args: Parameters<LLMProvider["generate"]>) => {
            requests.push(structuredClone(args[0]));
            return target.generate(...args);
          };
        if (key === "generateStream" && target.generateStream)
          return (...args: Parameters<NonNullable<LLMProvider["generateStream"]>>) => {
            requests.push(structuredClone(args[0]));
            return target.generateStream!(...args);
          };
        const value: unknown = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const run = (sessionId: string, prompt: string) =>
      executeAgentRuntime(
        {
          prompt,
          dir: workDir,
          sessionSelection: { mode: "new", sessionId },
          provider: configured.provider,
          modelRouteId: configured.route.id,
          baseURL: configured.config.baseURL,
          apiKey: configured.config.apiKey,
          model: configured.config.model,
          modelCapabilities: configured.route.capabilities,
          permissionMode: "full-access",
          allowedTools: ["bash", "write_file"],
        },
        {
          picoHome,
          modelRouter: configured.runtime.router,
          provider,
          memoryTrustStore: trust,
          reporter: new SilentReporter(),
          atomicMemoryLifecycle: lifecycle,
          maxTurns: 8,
          executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
          atomicMemoryModelFactory: async () => {
            throw new Error(
              "User-fact reflection is disabled; execution acceptance is deterministic",
            );
          },
        },
      );
    await run(
      sessions[0]!,
      `完成 BuildCheck 验收。检查入口为 ${command}，Bash 只用于这个入口。先执行检查，依据实际失败信息修复项目配置；创建或修改文件使用正式 write_file，然后原样复测该入口一次，通过后结束。保持检查源码不变。`,
    );
    const worker = getExecutionLearningWorker(picoHome);
    assert.ok(worker, "production repair did not create an authorized background worker");
    await worker.flushOnce();
    await worker.drain();
    assert.equal(
      (await repository.listItems({ learningVersion: 2, workspaceKey: paths.workspace.id })).length,
      0,
      "native evidence and unreviewed generic proposals cannot publish memories",
    );
    const proposals = await repository.taskExperiences.queryTaskExperiences(paths.workspace.id, {
      review: "pending",
    });
    assert.equal(
      proposals.length,
      1,
      JSON.stringify(await repository.taskExperiences.queryTaskExperiences(paths.workspace.id)),
    );
    const proposal = proposals[0]!;
    assert.ok(reflectionCalls > 0, "generic proposal must use the configured real model");
    assert.ok(
      proposal.nativeEvidence,
      "real proposal must cite its unique canonical failed native claim",
    );
    const reviewed = await repository.taskExperiences.reviewTaskExperience({
      workspaceKey: paths.workspace.id,
      candidateId: proposal.candidateId,
      expectedRecordRevision: proposal.recordRevision,
      expectedContentVersion: proposal.contentVersion,
      operationId: "real-review-native-method",
      action: "accept",
      now: Date.now(),
    });
    const saved = (await repository.readItem(reviewed.itemId!))!;
    assert.equal(saved.sourceType, "reviewed-reference");
    assert.equal(reviewed.validation, "unknown", "approval does not validate model prose");
    const learned = await events.readSession(sessions[0]!);
    const outcomes = learned.filter((event) => event.kind === "tool.result.recorded");
    const checks = outcomes.filter(
      (event) =>
        event.data.toolName === "bash" && isForegroundProcessFacts(event.data.executionFacts),
    );
    assert.deepEqual(
      checks.map((event) => event.data.executionFacts!.exitCode),
      [1, 0],
    );
    const starts = learned.filter((event) => event.kind === "tool.started");
    assert.equal(
      starts.some((event) => event.data.toolName === "memory_learn"),
      false,
      "learning must run without a model-directed memory action",
    );
    assert.ok(
      outcomes.some(
        (event) => event.data.toolName === "write_file" && event.data.status === "succeeded",
      ),
    );
    const candidate = (
      await repository.executionLearning.listExecutionLearningCandidates(paths.workspace.id)
    ).find((entry) => entry.claim.candidateId === proposal.nativeEvidence!.candidateId);
    assert.ok(candidate);
    const native = await repository.executionLearning.listNativeFacts(
      candidate.claim.admission.admissionId,
    );
    const checkTargets = native
      .filter((entry) => entry.kind === "command")
      .map((entry) => (entry.fact as { target: { argv: readonly string[] } }).target.argv);
    assert.deepEqual(
      checkTargets,
      [
        ["node", "--test", "check.test.cjs"],
        ["node", "--test", "check.test.cjs"],
      ],
      "both native dispatches must preserve the requested checker target before reporter instrumentation",
    );
    const commit = native
      .filter((entry) => entry.kind === "file")
      .flatMap((entry) => (entry.fact as { commits: readonly { path: string }[] }).commits)
      .find((entry) => basename(entry.path) === "config.json");
    assert.ok(commit);
    assert.equal(await realpath(commit.path), await realpath(join(workDir, "config.json")));
    await rm(join(workDir, "config.json"));
    assert.equal(await readFile(join(workDir, "check.test.cjs"), "utf8"), checker);
    requests.length = 0;
    await run(
      sessions[1]!,
      `完成 BuildCheck 验收，检查入口为 ${command}。先依据已有项目经验准备必要配置，再执行这个检查入口，通过后结束。写文件使用 write_file，Bash 只用于检查入口，保持检查源码不变，不查阅旧会话。`,
    );
    assert.ok(
      requests.some((messages) =>
        messages.some(
          (message) =>
            message.content.includes('source="reviewed-reference"') &&
            message.content.includes(saved.item.content.slice(0, 80)),
        ),
      ),
      "the new Session must receive the accepted execution recipe",
    );
    const reused = await events.readSession(sessions[1]!);
    const reusedOutcomes = reused.filter((event) => event.kind === "tool.result.recorded");
    const reusedChecks = reusedOutcomes.filter(
      (event) =>
        event.data.toolName === "bash" && isForegroundProcessFacts(event.data.executionFacts),
    );
    assert.equal(
      reusedChecks.length,
      1,
      "the recalled preparation must make the first checker succeed",
    );
    assert.equal(reusedChecks[0]!.data.executionFacts!.exitCode, 0);
    const uses = await repository.experienceLedger.queryExperienceUses(paths.workspace.id, {
      sessionId: sessions[1]!,
    });
    const nativeUse = uses.uses.find(
      (use) =>
        use.source.kind === "reviewed-reference" &&
        use.itemId === saved.item.itemId &&
        use.adoption === "observed" &&
        use.validation === "pass",
    );
    assert.ok(nativeUse, "new Session must have an independent native experience use receipt");
    assert.equal(nativeUse.delivery, "carried");
    assert.equal(nativeUse.adoption, "observed");
    assert.equal(nativeUse.validation, "pass");
    assert.equal(nativeUse.validationScope, "native-claim");
    assert.equal(
      (await repository.taskExperiences.readTaskExperienceCandidate(reviewed.candidateId))
        ?.validation,
      "unknown",
    );
    const effect = (await repository.experienceLedger.listExperienceEffects(nativeUse.useId)).find(
      (effect) => effect.validation === "pass",
    );
    assert.ok(effect && effect.preparedSequence > nativeUse.deliverySequence!);
    assert.equal(effect.trustedContradiction, false);
    const reuseStarts = reused.filter((event) => event.kind === "tool.started");
    const preparationIndex = reuseStarts.findIndex((event) => event.data.toolName === "write_file");
    const checkIndex = reuseStarts.findIndex((event) => event.data.toolName === "bash");
    assert.ok(preparationIndex >= 0 && preparationIndex < checkIndex);
    assert.equal(
      reuseStarts.some((event) => event.data.toolName === "memory_learn"),
      false,
    );
    assert.equal(await readFile(join(workDir, "check.test.cjs"), "utf8"), checker);
    await worker.flushOnce();
    await worker.drain();
    assert.equal(
      (await repository.listItems({ learningVersion: 2, workspaceKey: paths.workspace.id })).length,
      1,
    );
  },
);
