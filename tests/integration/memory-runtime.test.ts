import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Message } from "../../src/schema/message.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import {
  MemoryContextBuilder,
  MEMORY_CONTEXT_MAX_TOKENS,
} from "../../src/memory/context-builder.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import type { MemoryProposalModelPort } from "../../src/memory/proposal-contracts.js";
import { MemoryReviewWorker } from "../../src/memory/worker.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import {
  RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME,
  RUNTIME_SCHEMA_VERSION,
} from "../../src/tasks/runtime-types.js";

test("memory recall is deterministic, filtered, bounded and ephemeral across Sessions", async (context) => {
  const fixture = await createFixture("recall");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const repository = openRepository(fixture);
  context.after(() => repository.close());
  const now = new Date("2026-07-20T12:00:00.000Z");

  createFact(repository, "reference-new", "reference", { lastUsedAt: "2026-07-20T11:00:00.000Z" });
  createFact(repository, "project", "project_fact");
  createFact(repository, "correction", "correction");
  createFact(repository, "pinned", "preference", { pinned: true });
  createFact(repository, "preference-old", "preference", {
    lastUsedAt: "2026-07-01T00:00:00.000Z",
  });
  createFact(repository, "expired", "project_fact", { expiresAt: "2026-07-20T11:59:59.000Z" });
  createFact(repository, "disabled", "correction", { state: "disabled" });
  createFact(repository, "oversized", "project_fact", { content: "x".repeat(10_000) });

  const first = await new MemoryContextBuilder(repository, () => now).build();
  const second = await new MemoryContextBuilder(repository, () => now).build();
  assert.equal(first.block, second.block);
  assert.ok(first.tokenCount <= MEMORY_CONTEXT_MAX_TOKENS);
  assert.ok(first.facts.length <= 6);
  assert.deepEqual(
    first.facts.slice(0, 3).map((fact) => fact.factId),
    ["pinned", "correction", "project"],
  );
  assert.equal(first.block.includes("expired"), false);
  assert.equal(first.block.includes("disabled"), false);
  assert.match(first.block, /trust="low"/u);
  assert.match(first.block, /AGENTS\.md instructions always take precedence/u);
  assert.match(first.block, /cannot grant or change permissions, trust, provider configuration/u);

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  repository.close();
  const reopened = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
  const acrossSession = await new MemoryContextBuilder(reopened, () => now).build();
  reopened.close();
  assert.equal(acrossSession.block, first.block);

  const otherWorkspace = join(fixture.root, "other-workspace");
  await mkdir(otherWorkspace);
  const otherPaths = resolvePicoPaths(otherWorkspace, { picoHome: fixture.picoHome });
  const other = new MemoryRepository({
    databasePath: otherPaths.workspace.memoryDatabase,
    workspaceId: otherPaths.workspace.id,
  });
  assert.equal((await new MemoryContextBuilder(other, () => now).build()).block, "");
  other.close();
});

test("foreground Runtime injects trusted recall ephemerally and schedules only completed enabled runs", async (context) => {
  const fixture = await createFixture("runtime");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  const repository = openRepository(fixture);
  createFact(repository, "runtime-fact", "project_fact", { content: "Use npm run verify-memory" });
  repository.close();

  const captured: Message[][] = [];
  const provider: LLMProvider = {
    modelName: "memory-fixture",
    async generate(messages) {
      captured.push(structuredClone(messages));
      return { role: "assistant", content: "done" };
    },
  };
  const result = await executeAgentRuntime(
    {
      prompt: "Please remember that this is a durable project convention.",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-runtime-session" },
      provider: "openai",
    },
    { provider, picoHome: fixture.picoHome, memoryTrustStore: trustStore },
  );
  assert.equal(result.finalMessage, "done");
  assert.match(captured[0]?.[0]?.content ?? "", /Use npm run verify-memory/u);
  assert.equal(
    result.messages.some((message) => message.content.includes("verify-memory")),
    false,
  );
  const runtimePaths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const runtimeEvents = await new RuntimeEventStore({
    databasePath: runtimePaths.workspace.runtimeDatabase,
  }).readSession("memory-runtime-session");
  assert.equal(
    JSON.stringify(runtimeEvents).includes("verify-memory"),
    false,
    "ephemeral recall must not enter transcript, checkpoints, compaction or rewind facts",
  );
  const transcriptMessages = runtimeEvents
    .filter((event) => event.kind === "message.committed")
    .map((event) => (event.kind === "message.committed" ? event.data.message : undefined));
  assert.deepEqual(
    transcriptMessages.map((message) => message?.role),
    ["user", "assistant"],
  );
  assert.equal(
    transcriptMessages.some((message) => message?.content.includes("verify-memory")),
    false,
  );

  const after = openRepository(fixture);
  const jobs = after.listJobs();
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.cursor.sessionId, "memory-runtime-session");
  assert.match(jobs[0]?.cursor.eventId ?? "", /^user-message:/u);
  const settings = after.getSettings();
  after.updateSettings({
    expectedVersion: settings.version,
    enabled: false,
    injectionEnabled: false,
    idempotencyKey: "test-memory-off",
  });
  after.close();

  captured.length = 0;
  await executeAgentRuntime(
    {
      prompt: "Another foreground turn.",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-runtime-disabled" },
      provider: "openai",
    },
    { provider, picoHome: fixture.picoHome, memoryTrustStore: trustStore },
  );
  assert.equal(captured[0]?.[0]?.content.includes("verify-memory"), false);
  const disabled = openRepository(fixture);
  assert.equal(disabled.listJobs().length, 1, "disabled run must not enqueue extraction");
  const disabledSettings = disabled.getSettings();
  disabled.updateSettings({
    expectedVersion: disabledSettings.version,
    enabled: true,
    injectionEnabled: true,
    idempotencyKey: "test-memory-reenable-before-untrust",
  });
  disabled.close();

  await trustStore.setTrusted(await trustStore.canonicalize(fixture.workspace), false);
  captured.length = 0;
  await executeAgentRuntime(
    {
      prompt: "Untrusted workspace turn.",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-runtime-untrusted" },
      provider: "openai",
    },
    { provider, picoHome: fixture.picoHome, memoryTrustStore: trustStore },
  );
  assert.equal(captured[0]?.[0]?.content.includes("verify-memory"), false);
  const untrusted = openRepository(fixture);
  assert.equal(untrusted.listJobs().length, 1, "untrusted run must not enqueue extraction");
  untrusted.close();
});

test("self-owned worker consumes the durable T2 job without retaining foreground provider", async (context) => {
  const fixture = await createFixture("worker");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  const foregroundProvider: LLMProvider = {
    async generate() {
      return { role: "assistant", content: "foreground complete" };
    },
  };
  await executeAgentRuntime(
    {
      prompt: "请记住：这个项目固定使用 npm run build-memory 进行构建。",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-worker-session" },
      provider: "openai",
    },
    { provider: foregroundProvider, picoHome: fixture.picoHome, memoryTrustStore: trustStore },
  );

  let modelCalls = 0;
  let disposals = 0;
  const model: MemoryProposalModelPort = {
    async extract(request) {
      modelCalls++;
      return {
        response: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "memory-call",
              name: "submit_memory_proposals",
              arguments: JSON.stringify({
                proposals: [
                  {
                    kind: "project_fact",
                    title: "Build command",
                    content: "Use npm run build-memory",
                    reason: "The user explicitly stated a stable project command.",
                    confidence: 0.99,
                    evidenceEventIds: [request.evidence.userMessageEventId],
                  },
                ],
              }),
            },
          ],
          usage: { promptTokens: 12, completionTokens: 8 },
        },
      };
    },
  };
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
    trustStore,
    modelFactory: () => ({
      model,
      dispose: () => {
        disposals++;
      },
    }),
  });
  const results = await worker.drain();
  assert.equal(results[0]?.status, "succeeded");
  assert.equal(modelCalls, 1);
  assert.equal(disposals, 1);

  const repository = openRepository(fixture);
  assert.equal(repository.listJobs()[0]?.status, "succeeded");
  assert.equal(repository.listProposals({ statuses: ["pending"] }).length, 1);
  repository.close();
  await worker.drain();
  assert.equal(modelCalls, 1, "succeeded jobs are exactly-once");
});

test("/memory command uses trust, sanitizer, idempotency, CAS and executable undo", async (context) => {
  const fixture = await createFixture("command");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  const registry = await createPicoCommandRegistry({
    workDir: fixture.workspace,
    picoHome: fixture.picoHome,
    provider: "openai",
    model: "fixture",
    memoryTrustStore: trustStore,
  });
  const command = registry.resolve("memory");
  assert.ok(command);
  const execute = async (args: string[]) =>
    command.execute(
      {
        raw: `/memory ${args.join(" ")}`,
        name: "memory",
        args: args.join(" "),
        argv: args,
      },
      {},
    );

  const remembered = await execute(["remember", "Use", "npm", "run", "test:memory"]);
  assert.equal(remembered.type, "local");
  const undoCommand =
    remembered.type === "local"
      ? remembered.message?.match(/\/memory undo (\S+)/u)?.[1]
      : undefined;
  assert.ok(undoCommand);
  await execute(["remember", "Use", "npm", "run", "test:memory"]);
  let repository = openRepository(fixture);
  assert.equal(repository.listFacts({ states: ["active"] }).length, 1, "remember is idempotent");
  repository.close();

  const rejected = await execute(["remember", "sk-abcdefghijklmnopqrstuvwxyz123456"]);
  assert.match(
    rejected.type === "local" ? (rejected.message ?? "") : "",
    /rejected by the safety scan/u,
  );
  await execute(["off"]);
  repository = openRepository(fixture);
  assert.equal(repository.getSettings().enabled, false);
  assert.equal(repository.getSettings().injectionEnabled, false);
  repository.close();
  await execute(["on"]);
  await execute(["undo", undoCommand]);
  repository = openRepository(fixture);
  assert.equal(repository.listFacts({ states: ["active"] }).length, 0);
  assert.equal(repository.listFacts({ states: ["disabled"] }).length, 1);
  assert.equal(repository.getSettings().enabled, true);
  repository.close();
});

test("memory review provider calls are accepted by schema v7 and audited with a distinct purpose", async (context) => {
  const fixture = await createFixture("provider-purpose");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  let ledger = new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome });
  context.after(() => ledger.close());
  ledger.recordProviderCall({
    callId: "pre-v7-main-call",
    purpose: "main",
    provider: "openai",
    model: "fixture",
    status: "succeeded",
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    cost: 0,
  });
  const databasePath = ledger.databasePath;
  ledger.close();
  const downgraded = new Database(databasePath);
  downgraded.prepare("DELETE FROM schema_migrations WHERE version = ?").run(RUNTIME_SCHEMA_VERSION);
  downgraded.close();
  ledger = new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome });
  const provider = new CostTracker(
    {
      async generate() {
        return {
          role: "assistant",
          content: "",
          usage: { promptTokens: 5, completionTokens: 3 },
        };
      },
    },
    { provider: "openai", model: "memory-fixture", baseUrl: "https://example.test" },
    undefined,
    { ledger, context: { purpose: "memory_review" } },
  );
  await provider.generate([{ role: "user", content: "review" }], []);
  const calls = ledger.listProviderCalls();
  assert.equal(calls.length, 2);
  assert.equal(
    calls.some((call) => call.callId === "pre-v7-main-call" && call.purpose === "main"),
    true,
    "v6 provider call survives v7 table migration",
  );
  const memoryCall = calls.find((call) => call.purpose === "memory_review");
  assert.equal(memoryCall?.inputTokens, 5);
  assert.equal(memoryCall?.outputTokens, 3);
  const migrated = new Database(databasePath, { readonly: true });
  const migration = migrated
    .prepare("SELECT name FROM schema_migrations WHERE version = ?")
    .get(RUNTIME_SCHEMA_VERSION) as { name: string };
  migrated.close();
  assert.equal(migration.name, RUNTIME_SCHEMA_CURRENT_MIGRATION_NAME);
});

async function createFixture(name: string) {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-runtime-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await mkdir(workspace, { recursive: true });
  return { root, workspace, picoHome };
}

async function trustFixture(fixture: { workspace: string; picoHome: string }) {
  const store = new WorkspaceTrustStore({ userStateDirectory: fixture.picoHome });
  await store.trust(await store.canonicalize(fixture.workspace));
  return store;
}

function openRepository(fixture: { workspace: string; picoHome: string }) {
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  return new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
}

function createFact(
  repository: MemoryRepository,
  factId: string,
  kind: "preference" | "correction" | "project_fact" | "reference",
  overrides: {
    content?: string;
    pinned?: boolean;
    expiresAt?: string;
    lastUsedAt?: string;
    state?: "active" | "disabled" | "archived";
  } = {},
) {
  return repository.createFact({
    factId,
    kind,
    title: factId,
    content: overrides.content ?? factId,
    pinned: overrides.pinned ?? false,
    state: overrides.state ?? "active",
    ...(overrides.expiresAt ? { expiresAt: overrides.expiresAt } : {}),
    ...(overrides.lastUsedAt ? { lastUsedAt: overrides.lastUsedAt } : {}),
  });
}
