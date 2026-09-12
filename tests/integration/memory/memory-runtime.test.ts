import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { DesktopAtomicMemoryService } from "../../../src/daemon/desktop-atomic-memory-service.js";
import { globalSessionManager } from "../../../src/engine/session.js";
import {
  memorySessionKey,
  type MemoryExtractionModel,
} from "../../../src/memory/atomic/runtime-contracts.js";
import { resolvePicoPaths } from "../../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../../src/provider/interface.js";
import { executeAgentRuntime } from "../../../src/runtime/agent-runtime.js";
import { createEngineRuntimePort } from "../../../src/runtime/engine-runtime-port-adapter.js";
import { createSessionRuntime } from "../../../src/runtime/session-runtime.js";
import type { Message } from "../../../src/schema/message.js";
import { WorkspaceTrustStore } from "../../../src/security/workspace-trust.js";
import { closeAllOperationalDatabasesForTest } from "../../../src/storage/sqlite/sqlite-database.js";
import { SqliteMemoryItemStore } from "../../../src/storage/sqlite/sqlite-memory-item-store.js";
import { SqliteRuntimeEventStore } from "../../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { initializeRuntimeEventOwner } from "../helpers/runtime-event-owner.js";

/** Windows: release SQLite owners before retrying temporary directory cleanup. */
async function rmRetry(target: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EBUSY") throw error;
      if (attempt === 0) {
        // 文件纪元的测试可以不关句柄直接 rm;SQLite 纪元先强制放掉本进程
        // 全部 pico.sqlite owner(事后各 close() 钩子对已释放 lease 静默空转)。
        closeAllOperationalDatabasesForTest();
      }
      if (attempt >= 50) throw error;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

test("foreground Runtime injects atomic recall ephemerally and respects disabled and untrusted gates", async (context) => {
  const fixture = await createFixture("runtime");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  const service = new DesktopAtomicMemoryService({ picoHome: fixture.picoHome, publish: () => {} });
  await service.create(fixture.workspace, "Use npm run verify-memory with hidden-recall-policy");
  await service.create(fixture.workspace, "Deploy with kubectl");
  const captured: Message[][] = [];
  let extractionCalls = 0;
  const provider: LLMProvider = {
    modelName: "memory-fixture",
    async generate(messages, tools) {
      captured.push(structuredClone(messages));
      if (tools?.some((tool) => tool.name === "memory_extract") && !messages.at(-1)?.toolCallId) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "memory-runtime-trigger", name: "memory_extract", arguments: "{}" }],
        };
      }
      return { role: "assistant", content: "done" };
    },
  };
  const sessionId = "memory-runtime-session";
  const result = await executeAgentRuntime(
    {
      prompt:
        "Please use npm run verify-memory. Please remember that this is a durable project convention.",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      allowedTools: ["memory_extract"],
    },
    {
      provider,
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      atomicMemoryModelFactory: async () => ({
        model: createAtomicModel(fixture, sessionId, false, () => {
          extractionCalls++;
        }),
      }),
    },
  );
  assert.equal(result.finalMessage, "done");
  await waitForAtomicCursor(fixture, sessionId);
  assert.equal(extractionCalls, 1);
  const firstRequest = captured[0] ?? [];
  const currentUser = firstRequest.findLast(
    (message) =>
      message.role === "user" &&
      !message.toolCallId &&
      message.providerData?.["picoHiddenFromTranscript"] !== true,
  );
  assert.doesNotMatch(firstRequest[0]?.content ?? "", /hidden-recall-policy/u);
  assert.match(currentUser?.content ?? "", /hidden-recall-policy/u);
  assert.doesNotMatch(currentUser?.content ?? "", /Deploy with kubectl/u);
  assert.equal(JSON.stringify(result.messages).includes("hidden-recall-policy"), false);
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const transcript = await events.readSession(sessionId);
  events.close();
  assert.equal(
    JSON.stringify(transcript).includes("hidden-recall-policy"),
    false,
    "recall must never become transcript or checkpoint evidence",
  );
  const initial = (await service.getSettings(fixture.workspace)).settings;
  await service.updateSettings(fixture.workspace, {
    workspacePath: fixture.workspace,
    expectedVersion: initial.version,
    idempotencyKey: "off",
    enabled: false,
  });
  let disabledFactoryCalls = 0;
  const disabledModel = async () => {
    disabledFactoryCalls++;
    throw new Error("disabled/untrusted runs must not acquire a memory model");
  };
  for (const scenario of ["disabled", "untrusted"]) {
    if (scenario === "untrusted") {
      const settings = (await service.getSettings(fixture.workspace)).settings;
      await service.updateSettings(fixture.workspace, {
        workspacePath: fixture.workspace,
        expectedVersion: settings.version,
        idempotencyKey: "on",
        enabled: true,
      });
      await trustStore.setTrusted(await trustStore.canonicalize(fixture.workspace), false);
    }
    captured.length = 0;
    await executeAgentRuntime(
      {
        prompt: "verify-memory",
        dir: fixture.workspace,
        sessionSelection: { mode: "new", sessionId: `memory-runtime-${scenario}` },
        provider: "openai",
        modelRouteId: "test/test",
      },
      {
        provider,
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        atomicMemoryModelFactory: disabledModel,
      },
    );
    await waitForImmediate();
    assert.equal(JSON.stringify(captured).includes("hidden-recall-policy"), false);
    assert.equal(extractionCalls, 1);
    assert.equal(disabledFactoryCalls, 0);
  }
  service.close();
});

test("memory_remember persists requested memory before the next model step and before terminal", async (context) => {
  const fixture = await createFixture("remember-synchronous");
  context.after(() => rmRetry(fixture.root));
  const sessionId = "memory-remember-synchronous";
  const trustStore = await trustFixture(fixture);
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  let calls = 0;
  const result = await executeAgentRuntime(
    {
      prompt: "请记住：本项目固定运行 npm run post-terminal-memory。",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      allowedTools: ["memory_remember"],
    },
    {
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      atomicMemoryModelFactory: async () => ({
        model: createAtomicModel(fixture, sessionId, true),
      }),
      provider: {
        async generate(messages) {
          if (calls++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "remember-call", name: "memory_remember", arguments: "{}" }],
            };
          const store = new SqliteMemoryItemStore(join(fixture.picoHome, "memory.sqlite"));
          const items = await store.listItems({ workspaceKey: paths.workspace.id });
          store.close();
          assert.equal(items.length, 1);
          assert.match(
            messages.find((message) => message.toolCallId === "remember-call")?.content ?? "",
            /remembered/,
          );
          const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
          const entries = await events.readSession(sessionId);
          events.close();
          assert.equal(
            entries.some((event) => event.kind === "run.terminal"),
            false,
          );
          return { role: "assistant", content: "done" };
        },
      },
    },
  );
  assert.equal(result.finalMessage, "done");
});

test("the second turn in one Session extracts atomic memory only when its model requests the trigger", async (context) => {
  const fixture = await createFixture("multi-turn-signal-gate");
  const workspace = await realpath(fixture.workspace);
  const trustStore = await trustFixture(fixture);
  const sessionId = "memory-multi-turn-signal-gate";
  const sessionLease = await globalSessionManager.getOrCreatePinned(sessionId, workspace, {
    persistence: true,
    picoHome: fixture.picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  const session = sessionLease.session;
  const runtimeState = await createSessionRuntime({
    session,
    sessionLease,
    hooks: false,
    lspServers: [],
  });
  context.after(async () => {
    await runtimeState.dispose();
    const released = globalSessionManager.delete(sessionId, workspace, {
      picoHome: fixture.picoHome,
    });
    await released?.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const provider: LLMProvider = {
    async generate(messages, tools) {
      if (
        tools?.some((tool) => tool.name === "memory_extract") === true &&
        messages.at(-1)?.toolCallId === undefined
      ) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "memory-multi-turn-trigger", name: "memory_extract", arguments: "{}" }],
        };
      }
      return { role: "assistant", content: "done" };
    },
  };
  const executeDesktopTurn = async (prompt: string, eventId: string) => {
    await session.commitMessageOnce(eventId, {
      role: "user",
      content: prompt,
      providerData: {
        picoKind: "desktop_user_input",
        picoDesktopInputId: eventId,
        displayText: prompt,
      },
    });
    await executeAgentRuntime(
      {
        prompt,
        dir: workspace,
        sessionSelection: { mode: "resume", sessionId },
        provider: "openai",
        modelRouteId: "test/test",
        allowedTools: prompt.includes("请记住") ? ["memory_extract"] : [],
      },
      {
        provider,
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        atomicMemoryModelFactory: async () => ({
          model: createAtomicModel(fixture, sessionId, false),
        }),
        runtimeState,
        resumeExistingSession: true,
      },
    );
  };

  await executeDesktopTurn("What is 2 + 2?", "desktop-user-ordinary");
  await waitForImmediate();
  let atomic = new SqliteMemoryItemStore(join(fixture.picoHome, "memory.sqlite"));
  assert.equal(
    await atomic.readExtractionCursor(
      memorySessionKey(
        resolvePicoPaths(workspace, { picoHome: fixture.picoHome }).workspace.id,
        sessionId,
      ),
    ),
    undefined,
  );
  atomic.close();

  await executeDesktopTurn(
    "请记住：这个项目固定使用 npm run multi-turn-memory 。",
    "desktop-user-stable",
  );
  await waitForImmediate();
  await waitForAtomicCursor(fixture, sessionId);
  atomic = new SqliteMemoryItemStore(join(fixture.picoHome, "memory.sqlite"));
  const items = await atomic.listItems({
    workspaceKey: resolvePicoPaths(workspace, { picoHome: fixture.picoHome }).workspace.id,
  });
  assert.equal(items.length, 1);
  assert.match(items[0]?.item.content ?? "", /multi-turn-memory/);
  assert.ok(items[0]?.sources.some((source) => source.sessionId.includes(sessionId)));
  atomic.close();
});

test("startup does not extract historical completed turns without a memory trigger", async (context) => {
  let startupModelCalls = 0;
  const fixture = await createFixture("terminal-job-gap-recovery");
  context.after(async () => {
    // executeAgentRuntime(mode:new) 会把会话留在 globalSessionManager;其
    // SqliteRuntimeEventStore 持有 pico.sqlite 句柄,清理前先删除并关闭。
    const leftover = globalSessionManager.delete("memory-gap-restart-trigger", fixture.workspace, {
      picoHome: fixture.picoHome,
    });
    await leftover?.close();
    await rmRetry(fixture.root);
  });
  const trustStore = await trustFixture(fixture);
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const runtimeStore = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const sessionId = "memory-terminal-job-gap";
  const runId = "run-before-crash";
  const at = "2026-07-22T00:00:00.000Z";
  const { ownerFence } = await initializeRuntimeEventOwner(runtimeStore, {
    sessionId,
    workDir: fixture.workspace,
  });
  await runtimeStore.appendBatch(
    [
      {
        schemaVersion: 2,
        eventId: "started-before-crash",
        sessionId,
        invocationId: "invocation-before-crash",
        runId,
        turnId: "turn-before-crash",
        at,
        partial: false,
        visibility: "internal",
        kind: "run.started",
        data: { workDir: fixture.workspace },
      },
      {
        schemaVersion: 2,
        eventId: "user-before-crash",
        sessionId,
        invocationId: "invocation-before-crash",
        runId,
        turnId: "turn-before-crash",
        at,
        partial: false,
        visibility: "model",
        kind: "message.committed",
        data: {
          message: {
            role: "user",
            content: "请记住：这个项目固定使用 npm run recovered-gap 。",
          },
        },
      },
      {
        schemaVersion: 2,
        eventId: "assistant-before-crash",
        sessionId,
        invocationId: "invocation-before-crash",
        runId,
        turnId: "turn-before-crash",
        at,
        partial: false,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "assistant", content: "foreground complete" } },
      },
      {
        schemaVersion: 2,
        eventId: "terminal-before-crash",
        sessionId,
        invocationId: "invocation-before-crash",
        runId,
        turnId: "turn-before-crash",
        at,
        partial: false,
        visibility: "internal",
        kind: "run.terminal",
        data: { status: "completed" },
      },
    ],
    { ownerFence },
  );
  runtimeStore.close();

  const result = await executeAgentRuntime(
    {
      prompt: "What is 2 + 2?",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-gap-restart-trigger" },
      provider: "openai",
      modelRouteId: "test/test",
    },
    {
      provider: {
        async generate() {
          return { role: "assistant", content: "4" };
        },
      },
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      atomicMemoryModelFactory: async () => {
        startupModelCalls++;
        assert.fail("ordinary startup must not acquire a memory model");
      },
    },
  );
  assert.equal(result.finalMessage, "4");

  for (let attempt = 0; attempt < 5; attempt++) await waitForImmediate();
  const atomic = new SqliteMemoryItemStore(join(fixture.picoHome, "memory.sqlite"));
  assert.equal((await atomic.listItems({ workspaceKey: paths.workspace.id })).length, 0);
  atomic.close();
  assert.equal(startupModelCalls, 0);
});

test("atomic extraction is not repeated on ordinary startup", async (context) => {
  let startupModelCalls = 0;
  const fixture = await createFixture("obsolete-debounce");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  const sessionId = "memory-obsolete-debounce";
  let foregroundCalls = 0,
    extractionCalls = 0;
  await executeAgentRuntime(
    {
      prompt: "请记住：本项目使用 npm run cache-recovery。",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
      modelRouteId: "test/test",
      allowedTools: ["memory_extract"],
    },
    {
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      atomicMemoryModelFactory: async () => ({
        model: createAtomicModel(fixture, sessionId, false, () => {
          extractionCalls++;
        }),
      }),
      provider: {
        async generate() {
          if (foregroundCalls++ === 0)
            return {
              role: "assistant",
              content: "",
              toolCalls: [{ id: "extract", name: "memory_extract", arguments: "{}" }],
            };
          return { role: "assistant", content: "done" };
        },
      },
    },
  );
  await waitForAtomicCursor(fixture, sessionId);
  assert.equal(extractionCalls, 1);
  await executeAgentRuntime(
    {
      prompt: "What is 3 + 3?",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "ordinary-after-extract" },
      provider: "openai",
      modelRouteId: "test/test",
    },
    {
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      provider: {
        async generate() {
          return { role: "assistant", content: "6" };
        },
      },
      atomicMemoryModelFactory: async () => {
        startupModelCalls++;
        assert.fail("startup must not replay extraction");
      },
    },
  );
  await waitForImmediate();
  assert.equal(extractionCalls, 1);
  assert.equal(startupModelCalls, 0);
});

test("manifest pages keep a fixed upper bound and DESC keyset across concurrent mutations", async (context) => {
  const fixture = await createFixture("manifest-keyset");
  context.after(() => rmRetry(fixture.root));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const originalIds = Array.from(
    { length: 30 },
    (_, index) => `keyset-${String(index).padStart(2, "0")}`,
  );
  for (const [index, sessionId] of originalIds.entries()) {
    await store.initializeSession({
      sessionId,
      workDir: fixture.workspace,
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, index)),
    });
  }
  const upperBound = await store.getSessionManifestScanUpperBound();
  assert.ok(upperBound);
  const first = await store.listSessionManifestsPage({ upperBound, limit: 10 });
  assert.equal(first.length, 10);
  await store.deleteSession(first[0]!.sessionId);
  await store.initializeSession({
    sessionId: "keyset-newer-than-upper-bound",
    workDir: fixture.workspace,
    now: () => new Date("2026-01-02T00:00:00.000Z"),
  });

  const scanned = [...first];
  let before = {
    createdAt: first.at(-1)!.createdAt,
    sessionId: first.at(-1)!.sessionId,
  };
  while (true) {
    const page = await store.listSessionManifestsPage({ upperBound, before, limit: 10 });
    if (page.length === 0) break;
    scanned.push(...page);
    const last = page.at(-1)!;
    before = { createdAt: last.createdAt, sessionId: last.sessionId };
  }
  store.close();
  assert.deepEqual(new Set(scanned.map((manifest) => manifest.sessionId)), new Set(originalIds));
  assert.equal(
    scanned.some((manifest) => manifest.sessionId === "keyset-newer-than-upper-bound"),
    false,
  );
});

test.after(async () => {
  // mode:new Sessions stay process-owned after each foreground Run. Drain the suite's
  // shared manager so OwnerLease heartbeats and SQLite handles cannot survive this file.
  await globalSessionManager.clearAndDrain();
  closeAllOperationalDatabasesForTest();
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

function createAtomicModel(
  fixture: { workspace: string; picoHome: string },
  sessionId: string,
  requested: boolean,
  onProposal: () => void = () => {},
): MemoryExtractionModel {
  return {
    async call(request) {
      const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
      const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
      const entries = await events.readSession(sessionId);
      events.close();
      const user = entries.findLast(
        (event) =>
          event.kind === "message.committed" &&
          event.data.message.role === "user" &&
          !event.data.message.toolCallId,
      );
      assert.ok(user?.kind === "message.committed");
      const content = user.data.message.content;
      const item = {
        content,
        kind: "context",
        statementType: "fact",
        temporalType: "undated",
        scope: "workspace",
        eventStartedAt: null,
        eventEndedAt: null,
        keys: [{ key: "memory", type: "concept" }],
      };
      if (request.stage === "canonicalize")
        return JSON.stringify({
          results: [{ candidateId: "candidate_0", status: "accepted", item }],
        });
      onProposal();
      const proposed = {
        ...item,
        evidence: [{ sourceRef: `event:${user.eventId}`, quote: content }],
      };
      return JSON.stringify({
        status: "complete",
        coverageStatus: "processed",
        requestedStatus: requested ? "resolved" : "not_applicable",
        requestedItems: requested ? [proposed] : [],
        incidentalItems: requested ? [] : [proposed],
      });
    },
  };
}

async function waitForAtomicCursor(
  fixture: { workspace: string; picoHome: string },
  sessionId: string,
): Promise<void> {
  const key = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace.id;
  for (let attempt = 0; attempt < 300; attempt++) {
    await waitForImmediate();
    const store = new SqliteMemoryItemStore(join(fixture.picoHome, "memory.sqlite"));
    const cursor = await store.readExtractionCursor(memorySessionKey(key, sessionId));
    store.close();
    if (cursor && cursor.processedOrdinal > 0) return;
  }
  assert.fail(`atomic extraction did not settle for ${sessionId}`);
}

function waitForImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
