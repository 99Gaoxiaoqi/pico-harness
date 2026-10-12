import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test, { type TestContext } from "node:test";
import type { Message, ToolCall } from "@pico/core";
import { isForegroundProcessFacts } from "@pico/core";
import { AtomicMemoryLifecycle } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
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

async function fixture(t: TestContext, prefix: string) {
  const root = await mkdtemp(join(tmpdir(), prefix));
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
  const sessions: string[] = [];
  t.after(async () => {
    await closeExecutionLearningWorker(picoHome);
    await lifecycle.close();
    for (const sessionId of sessions)
      await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    repository.close();
    await rm(root, { recursive: true, force: true });
  });
  const run = async (
    sessionId: string,
    generate: (messages: readonly Message[]) => Promise<Message>,
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
        allowedTools: ["bash", "write_file", "memory_learn"],
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
  "production execution learning autonomously saves one named-test repair and prepares a new Session before its first check",
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t, "pico-learning-runtime-");
    let step = 0;
    const seedSession = "autonomous-source";
    const result = await f.run(seedSession, async () => {
      const next = [
        call("failed-check", "bash", { command }),
        call("repair-config", "write_file", { path: "config.json", content: configuration }),
        call("passed-check", "bash", { command }),
      ][step++];
      return next
        ? { role: "assistant", content: "", toolCalls: [next] }
        : { role: "assistant", content: "BuildCheck 已通过。" };
    });
    assert.equal(result.finalMessage, "BuildCheck 已通过。");
    await f.finishLearning();
    const items = await f.repository.listItems({ workspaceKey: f.paths.workspace.id });
    assert.equal(items.length, 1);
    const saved = items[0]!;
    assert.equal(saved.sourceType, "execution-validated");
    assert.equal(saved.taskAcceptance?.predicateId, "test-target-pass.v1");
    assert.match(saved.item.content, /config\.json/u);
    assert.match(saved.item.content, /FixtureNorth/u);
    assert.equal(
      saved.executionEvidence,
      undefined,
      "the new acceptance must not reuse manual three-vote metadata",
    );
    const observed = await f.events.readSession(seedSession);
    const outcomes = observed.filter((event) => event.kind === "tool.result.recorded");
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
    assert.deepEqual(
      new Set(saved.sources.map((source) => source.eventId)),
      new Set(outcomes.map((event) => event.eventId)),
    );
    assert.ok(
      outcomes.some(
        (event) => event.data.toolName === "write_file" && event.data.status === "succeeded",
      ),
    );
    const candidate = (
      await f.repository.executionLearning.listExecutionLearningCandidates(f.paths.workspace.id)
    ).find((entry) => entry.itemId === saved.item.itemId);
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
      outcomes.find((event) => event.data.toolName === "write_file")?.eventId,
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
        0,
        "deterministic verification must not consume a model attempt",
      );
    } finally {
      db.close();
    }
    await rm(join(f.workDir, "config.json"));
    let reuse = 0;
    await f.run("autonomous-reuse", async (messages) => {
      if (reuse++ === 0) {
        const memory = messages.map((message) => message.content).join("\n");
        assert.match(memory, /source="execution-validated"/u);
        assert.match(memory, /config\.json/u);
        assert.match(memory, /FixtureNorth/u);
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
    await f.finishLearning();
    assert.equal((await f.repository.listItems({ workspaceKey: f.paths.workspace.id })).length, 1);
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
    assert.equal((await f.repository.listItems({ workspaceKey: f.paths.workspace.id })).length, 0);
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
