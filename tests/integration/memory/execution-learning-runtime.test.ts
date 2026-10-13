import { configureReviewedFixture, approveReviewedFixture } from "./unified-experience-fixture.js";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { Message, ToolCall } from "@pico/core";
import { isForegroundProcessFacts } from "@pico/core";
import { AtomicMemoryContextBuilder } from "../../../packages/runtime/src/atomic-memory/context-builder.js";
import { taskExperienceRecallTargets } from "../../../packages/pico-host/src/task-experience-recall.js";
import { AtomicMemoryLifecycle, countTokens } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { ApprovalManager } from "@pico/pico-host/global-approval-manager";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import {
  closeExecutionLearningWorker,
  getExecutionLearningWorker,
} from "@pico/pico-host/execution-learning-worker";
import { globalSessionManager } from "@pico/pico-host/session";
import { SqliteRuntimeEventStore } from "@pico/pico-host/product-runtime-event-store";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";

const command = "node --test check.test.cjs";
const configuration = '{"project":"FixtureNorth"}\n';
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

const call = (id: string, name: string, input: object): ToolCall => ({
  id,
  name,
  arguments: JSON.stringify(input),
});

async function fixture(t: TestContext, prefix: string, trusted = true) {
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  await writeFile(join(workDir, "check.test.cjs"), checker);
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  if (trusted) await trust.trust(await trust.canonicalize(workDir));
  const lifecycle = new AtomicMemoryLifecycle();
  const paths = resolvePicoPaths(workDir, { picoHome });
  const repository = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  configureReviewedFixture(picoHome, "观察失败信息，做最小修复，然后原样复测同一检查入口。");
  const sessions: string[] = [];
  // Native node:test invocations must behave like normal foreground commands.
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
      await rm(root, { recursive: true, force: true });
    } finally {
      if (inheritedTestContext === undefined) delete process.env.NODE_TEST_CONTEXT;
      else process.env.NODE_TEST_CONTEXT = inheritedTestContext;
    }
  });
  const run = async (
    sessionId: string,
    generate: (messages: readonly Message[]) => Promise<Message>,
    options: Partial<Parameters<typeof executeAgentRuntime>[0]> = {},
    dependencies: Parameters<typeof executeAgentRuntime>[1] = {},
  ) => {
    sessions.push(sessionId);
    return executeAgentRuntime(
      {
        prompt: `完成 BuildCheck 验收，检查入口为 ${command}。按失败信息修复配置后自然复测，通过后结束。`,
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        permissionMode: "full-access",
        allowedTools: ["bash", "write_file"],
        ...options,
      },
      {
        picoHome,
        memoryTrustStore: trust,
        atomicMemoryLifecycle: lifecycle,
        reporter: new SilentReporter(),
        provider: { generate },
        executionLearningWorkerOptions: { idleMs: 0, pollMs: 60_000 },
        atomicMemoryModelFactory: async () => {
          throw new Error("User-fact inference is disabled in this fixture");
        },
        ...dependencies,
      },
    );
  };
  const finishLearning = async () => {
    const worker = getExecutionLearningWorker(picoHome);
    assert.ok(worker, "authorized native execution must create the production learning worker");
    await worker.flushOnce();
    await worker.drain();
  };
  return { workDir, picoHome, paths, repository, events, run, finishLearning };
}

test(
  "统一通用提案从自然失败生成并经用户审核后跨 Session 复用，原生执行只保存冻结证据且不会自动发布另一条经验",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "pico-learning-runtime-");
    configureReviewedFixture(
      f.picoHome,
      "观察失败信息，做最小修复，然后原样复测同一检查入口。" +
        "将失败输出视为需求来源，仅针对项目配置缺口进行最小变更；保留验收逻辑与其他内容不变；随后使用同一检查入口重新评估，并以原始断言是否被消除作为结束条件。该方法适用于配置驱动的构建验收，可减少无关改动并保留可追溯性。",
    );
    let step = 0;
    const seedSession = "autonomous-source";
    const result = await f.run(seedSession, async () => {
      const next = [
        call("failed-check", "bash", { command }),
        call("sensitive-config", "write_file", {
          path: "sensitive-config.json",
          content: '{"token":"sk-fixtureOnlySecretToken0123456789"}',
        }),
        call("oversized-config", "write_file", {
          path: "large-config.json",
          content: JSON.stringify({ description: "not-a-reusable-template ".repeat(80) }),
        }),
        call("repair-config", "write_file", { path: "config.json", content: configuration }),
        call("passed-check", "bash", { command }),
      ][step++];
      return next
        ? { role: "assistant", content: "", toolCalls: [next] }
        : { role: "assistant", content: "BuildCheck 已通过。" };
    });
    assert.equal(result.finalMessage, "BuildCheck 已通过。");
    await f.finishLearning();
    const pending = (
      await f.repository.taskExperiences.queryTaskExperiences(f.paths.workspace.id, {
        review: "pending",
      })
    )[0];
    assert.ok(pending, "abstract model method still produces a reviewable proposal");
    assert.match(pending.content, /准备文件 \.\/config\.json/u);
    assert.ok(
      pending.content.includes(JSON.stringify(configuration)),
      "review sees the complete canonical configuration, not only an invisible evidence reference",
    );
    assert.match(pending.content, /观察失败信息/u);
    assert.doesNotMatch(
      pending.content,
      /sk-fixtureOnlySecretToken|sensitive-config|not-a-reusable-template/u,
    );
    assert.equal(pending.validation, "unknown");
    assert.ok(countTokens(pending.content) <= 160 && [...pending.content].length <= 2000);
    assert.equal(
      (await f.repository.listItems({ workspaceKey: f.paths.workspace.id, learningVersion: 2 }))
        .length,
      0,
    );
    const reviewed = await approveReviewedFixture(f.repository, f.paths.workspace.id);
    const items = await f.repository.listItems({
      learningVersion: 2,
      workspaceKey: f.paths.workspace.id,
    });
    const observed = await f.events.readSession(seedSession);
    assert.equal(
      items.length,
      1,
      JSON.stringify({
        candidates: (
          await f.repository.executionLearning.listExecutionLearningCandidates(f.paths.workspace.id)
        ).map((candidate) => ({
          state: candidate.state,
          reason: candidate.reason,
          revision: candidate.claim.revision,
          preparationCount: candidate.claim.recipe.length,
        })),
        outcomes: observed
          .filter((event) => event.kind === "tool.result.recorded")
          .map((event) => ({
            toolName: event.data.toolName,
            status: event.data.status,
            exitCode: event.data.executionFacts?.exitCode,
          })),
      }),
    );
    const saved = items[0]!;
    assert.equal(saved.sourceType, "reviewed-reference");
    assert.ok(reviewed.nativeEvidence);
    assert.match(saved.item.content, /config\.json/u);
    assert.match(saved.item.content, /FixtureNorth/u);
    assert.equal(
      saved.executionEvidence,
      undefined,
      "the new acceptance must not reuse manual three-vote metadata",
    );
    const outcomes = observed.filter((event) => event.kind === "tool.result.recorded");
    assert.equal(
      outcomes[0]?.data.status,
      "succeeded",
      "derived process failure must not rewrite the tool journal status",
    );
    assert.deepEqual(
      outcomes
        .filter((event) => event.data.toolName === "bash")
        .map((event) => event.data.executionFacts?.exitCode),
      [1, 0],
    );
    assert.equal(
      observed.some(
        (event) => event.kind === "tool.started" && event.data.toolName === "memory_learn",
      ),
      false,
    );
    assert.ok(
      outcomes.some(
        (event) => event.data.toolName === "write_file" && event.data.status === "succeeded",
      ),
    );
    const candidate = (
      await f.repository.executionLearning.listExecutionLearningCandidates(f.paths.workspace.id)
    ).find((entry) => entry.claim.candidateId === reviewed.nativeEvidence!.candidateId);
    assert.ok(candidate);
    const nativeFacts = await f.repository.executionLearning.listNativeFacts(
      candidate.claim.admission.admissionId,
    );
    const commit = nativeFacts.find(
      (entry) => entry.kind === "file" && entry.toolCallId === "repair-config",
    );
    assert.ok(commit, "the template must originate in a physical native file commit");
    const fileFact = commit.fact as {
      commits: readonly { path: string; beforeHash: string | null; afterHash: string }[];
      source: { eventId: string };
    };
    assert.equal(fileFact.commits.length, 1);
    const committed = fileFact.commits[0]!;
    assert.equal(
      fileFact.source.eventId,
      outcomes.find((event) => event.refs.toolCallId === "repair-config")?.eventId,
    );
    assert.equal(await realpath(committed.path), await realpath(join(f.workDir, "config.json")));
    assert.equal(committed.beforeHash, null);
    assert.equal(committed.afterHash, createHash("sha256").update(configuration).digest("hex"));
    const prepared = observed.find(
      (event) => event.kind === "tool.started" && event.refs?.toolCallId === "repair-config",
    );
    assert.equal(commit.preparedEventId, prepared?.eventId);
    const db = new DatabaseSync(join(f.picoHome, "memory.sqlite"), { readOnly: true });
    try {
      assert.equal(
        Number(db.prepare("SELECT count(*) AS n FROM execution_learning_attempts").get()!.n),
        1,
        "only the generic proposal consumes a model attempt",
      );
    } finally {
      db.close();
    }
    await rm(join(f.workDir, "config.json"));
    let reuse = 0;
    await f.run("autonomous-reuse", async (messages) => {
      if (reuse++ === 0) {
        const memory = messages.map((message) => message.content).join("\n");
        assert.match(memory, /source="reviewed-reference"/u);
        assert.match(memory, /config\.json/u);
        assert.match(memory, /FixtureNorth/u);
        const prefix = saved.item.content.slice(0, saved.item.content.lastIndexOf("方法："));
        assert.ok(
          memory.includes(
            prefix
              .replaceAll("&", "&amp;")
              .replaceAll("<", "&lt;")
              .replaceAll(">", "&gt;")
              .replaceAll('"', "&quot;")
              .replaceAll("'", "&apos;"),
          ),
          "first request must preserve the entire preparation including escaped JSON",
        );
        return {
          role: "assistant",
          content: "",
          toolCalls: [
            call("prepare-config", "write_file", { path: "config.json", content: configuration }),
          ],
        };
      }
      return reuse === 2
        ? { role: "assistant", content: "", toolCalls: [call("first-check", "bash", { command })] }
        : { role: "assistant", content: "BuildCheck 首次通过。" };
    });
    const reused = await f.events.readSession("autonomous-reuse");
    const checks = reused.filter(
      (event) =>
        event.kind === "tool.result.recorded" &&
        event.data.toolName === "bash" &&
        isForegroundProcessFacts(event.data.executionFacts),
    );
    assert.equal(checks.length, 1);
    assert.equal(
      checks[0]!.kind === "tool.result.recorded" && checks[0]!.data.executionFacts?.exitCode,
      0,
    );
    const starts = reused.filter((event) => event.kind === "tool.started");
    assert.deepEqual(
      starts.map((event) => event.data.toolName),
      ["write_file", "bash"],
    );
    assert.equal(await readFile(join(f.workDir, "check.test.cjs"), "utf8"), checker);
    assert.equal(
      (
        await f.repository.executionLearning.readExecutionLearningCandidate(
          candidate.claim.candidateId,
        )
      )?.claim.revision,
      candidate.claim.revision,
      "reviewed evidence remains frozen across reuse",
    );
    await f.finishLearning();
    assert.equal(
      (await f.repository.listItems({ learningVersion: 2, workspaceKey: f.paths.workspace.id }))
        .length,
      1,
    );
    const identities = await taskExperienceRecallTargets({
      store: f.repository.taskExperiences,
      workspaceKey: f.paths.workspace.id,
      workDir: f.workDir,
      query: "BuildCheck config",
      toolAllowed: () => true,
      nativeEvidenceMatches: async () => true,
    });
    const prefixLength = identities[0]?.requiredPrefixLength;
    assert.ok(prefixLength && prefixLength > 0);
    const builder = new AtomicMemoryContextBuilder(f.repository, f.paths.workspace.id);
    const intact = await builder.build("BuildCheck config", { reviewedExperiences: identities });
    assert.equal(intact.references[0]?.range.start, 0);
    assert.ok(intact.references[0]!.range.end >= prefixLength);
    assert.ok(intact.tokenCount <= 320);
    const tooSmall = await builder.build("BuildCheck config", {
      reviewedExperiences: identities,
      maxTokens: 210,
    });
    assert.equal(tooSmall.references.length, 0, "insufficient budget omits the whole preparation");
    assert.equal(tooSmall.diagnostics[0]?.reason, "budget");
    await f.repository.applyMutations({
      operationId: "competing-memory",
      expectedDeletionRevision: 0,
      mutations: [
        {
          type: "create",
          item: {
            content:
              "BuildCheck config priority：" +
              "当前项目验收范围固定，保留相关配置与原检查入口。".repeat(4),
            kind: "knowledge",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: f.paths.workspace.id,
            observedAt: Date.now(),
            origin: "user_requested",
            keys: ["priority", "config", "BuildCheck"].map((key) => ({
              key,
              keyType: "concept",
              keyOrigin: "user",
            })),
            sources: [],
          },
        },
      ],
    });
    const competing = await builder.build("priority config BuildCheck", {
      reviewedExperiences: identities,
    });
    assert.equal(competing.references.length, 1);
    assert.notEqual(competing.references[0]?.source, "reviewed-reference");
    assert.ok(
      competing.diagnostics.some(
        (entry) => entry.itemId === saved.item.itemId && entry.reason === "budget",
      ),
      "other memory may consume the budget but cannot split the preparation",
    );
  },
);

test(
  "passing a different test node after changing the checker cannot validate the original BuildCheck claim",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "pico-learning-unrelated-");
    let step = 0;
    await f.run("unrelated-test-node", async () => {
      const next = [
        call("failed-check", "bash", { command }),
        call("repair-config", "write_file", { path: "config.json", content: configuration }),
        call("replace-checker", "write_file", {
          path: "check.test.cjs",
          content: checker.replace('test("BuildCheck"', 'test("UnrelatedCheck"'),
        }),
        call("different-test-pass", "bash", { command }),
      ][step++];
      return next
        ? { role: "assistant", content: "", toolCalls: [next] }
        : { role: "assistant", content: "另一个测试节点已通过。" };
    });
    await f.finishLearning();
    assert.equal(
      (await f.repository.listItems({ learningVersion: 2, workspaceKey: f.paths.workspace.id }))
        .length,
      0,
    );
    const outcomes = (await f.events.readSession("unrelated-test-node"))
      .filter((event) => event.kind === "tool.result.recorded")
      .filter((event) => event.data.toolName === "bash");
    assert.deepEqual(
      outcomes.map((event) => event.data.executionFacts?.exitCode),
      [1, 0],
    );
    assert.ok(
      outcomes[1]!.data.body.storage === "inline" &&
        outcomes[1]!.data.body.content.includes("UnrelatedCheck"),
    );
  },
);

test(
  "native learning uses Bash availability and retains approval, mode, trust and extraction gates",
  { timeout: 60_000, skip: process.platform === "win32" },
  async (t) => {
    for (const mode of ["ask", "auto"] as const) {
      for (const approved of [true, false]) {
        await t.test(`${mode}: ${approved ? "approved" : "rejected"} command`, async (t) => {
          const f = await fixture(t, "pico-learning-permission-");
          const manager = new ApprovalManager(5_000);
          let approvals = 0;
          let step = 0;
          const sessionId = `${mode}-${approved}`;
          await f.run(
            sessionId,
            async () =>
              step++ === 0
                ? {
                    role: "assistant",
                    content: "",
                    toolCalls: [call("check", "bash", { command: "node check.test.cjs" })],
                  }
                : { role: "assistant", content: "done" },
            { permissionMode: mode, allowedTools: ["bash"] },
            {
              approvalManager: manager,
              approvalNotifier: (notice) => {
                approvals++;
                manager.resolveApproval(notice.taskId, approved, "fixture decision");
              },
              executionLearningWorkerOptions: { idleMs: 60_000 },
            },
          );
          assert.ok(approvals > 0, "learning must preserve normal command authorization");
          const candidates = await f.repository.executionLearning.listExecutionLearningCandidates(
            f.paths.workspace.id,
          );
          assert.equal(candidates.length, approved ? 1 : 0);
          const outcomes = (await f.events.readSession(sessionId)).filter(
            (event) => event.kind === "tool.result.recorded" && event.data.toolName === "bash",
          );
          assert.equal(
            outcomes.some(
              (event) =>
                event.kind === "tool.result.recorded" && event.data.executionFacts?.exitCode === 1,
            ),
            approved,
          );
        });
      }
    }
    for (const scenario of [
      "no-bash",
      "plan",
      "research",
      "untrusted",
      "extraction-off",
    ] as const) {
      await t.test(scenario, async (t) => {
        const f = await fixture(t, "pico-learning-disabled-", scenario !== "untrusted");
        if (scenario === "extraction-off") {
          const settings = await f.repository.readSettings(f.paths.workspace.id);
          await f.repository.updateSettings({
            workspaceKey: f.paths.workspace.id,
            expectedVersion: settings.version,
            autoExtract: false,
          });
        }
        await f.run(
          `disabled-${scenario}`,
          async () =>
            scenario === "plan"
              ? {
                  role: "assistant",
                  content: "",
                  toolCalls: [
                    call("submit-plan", "submit_plan", {
                      title: "Inspect BuildCheck",
                      steps: [{ title: "Verify", description: "Inspect the existing check." }],
                    }),
                  ],
                }
              : { role: "assistant", content: "done" },
          {
            allowedTools: scenario === "no-bash" ? ["memory_search"] : ["bash"],
            ...(scenario === "plan" || scenario === "research"
              ? { collaborationMode: scenario }
              : {}),
          },
        );
        assert.deepEqual(await f.repository.executionLearning.listAdmissions(), []);
        assert.deepEqual(
          await f.repository.executionLearning.listExecutionLearningCandidates(
            f.paths.workspace.id,
          ),
          [],
        );
      });
    }
  },
);
