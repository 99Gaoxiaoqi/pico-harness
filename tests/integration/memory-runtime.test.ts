import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LOCAL_RUNTIME_PROTOCOL_VERSION } from "@pico/protocol";
import { globalSessionManager } from "../../src/engine/session.js";
import type { Message } from "../../src/schema/message.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import {
  MemoryContextBuilder,
  MEMORY_CONTEXT_CANDIDATE_LIMIT,
  MEMORY_CONTEXT_MAX_FACTS,
  MEMORY_CONTEXT_MAX_TOKENS,
} from "../../src/memory/context-builder.js";
import { MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE } from "../../src/memory/memory-repository.js";
import { SqliteMemoryRepository } from "../../src/storage/sqlite/sqlite-memory-repository.js";
import { closeAllOperationalDatabasesForTest } from "../../src/storage/sqlite/sqlite-database.js";
import { MemoryRepositoryProposalStore } from "../../src/memory/proposal-engine.js";
import {
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
  MEMORY_PROPOSAL_JOB_TYPE,
  type MemoryProposalModelPort,
} from "../../src/memory/proposal-contracts.js";
import {
  MemoryReviewScheduler,
  MEMORY_REVIEW_LEASE_TTL_MS,
} from "../../src/memory/runtime-scheduler.js";
import {
  MemoryReviewWorker,
  ProviderMemoryProposalModel,
  type MemoryProposalPublishedNotice,
} from "../../src/memory/worker.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { estimateCost, type BillingRoute } from "../../src/observability/pricing.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { SqliteMemoryItemStore } from "../../src/storage/sqlite/sqlite-memory-item-store.js";
import { DesktopAtomicMemoryService } from "../../src/daemon/desktop-atomic-memory-service.js";
import {
  memorySessionKey,
  type MemoryExtractionModel,
} from "../../src/memory/atomic/runtime-contracts.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { createEngineRuntimePort } from "../../src/runtime/engine-runtime-port-adapter.js";
import {
  invalidateMemoryReviewRecoverySuccess,
  recoverMemoryReviewJobs,
} from "../../src/runtime/memory-review-recovery.js";
import { createSessionRuntime } from "../../src/runtime/session-runtime.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { SqliteRuntimeControlStore } from "../../src/storage/sqlite/sqlite-runtime-control-store.js";
import { publishDesktopMemoryProposal } from "../../src/daemon/production-host.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";

/** Windows:分离的 memory review worker 可能仍持有 pico.sqlite 句柄,
 * 删除临时目录按 EBUSY 有界重试,等待 drain 归还 lease。 */
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

test("memory recall is deterministic, filtered, bounded and ephemeral across Sessions", async (context) => {
  const fixture = await createFixture("recall");
  context.after(() => rmRetry(fixture.root));
  const repository = openRepository(fixture);
  context.after(() => repository.close());
  const now = new Date("2026-07-20T12:00:00.000Z");

  createFact(repository, "reference-new", "reference", {
    content: "Deploy the unrelated server",
    lastUsedAt: "2026-07-20T11:00:00.000Z",
  });
  createFact(repository, "project", "project_fact", { content: "移动端构建使用 pnpm" });
  createFact(repository, "correction", "correction");
  createFact(repository, "pinned", "preference", { pinned: true });
  createFact(repository, "preference-old", "preference", {
    lastUsedAt: "2026-07-01T00:00:00.000Z",
  });
  createFact(repository, "expired", "project_fact", { expiresAt: "2026-07-20T11:59:59.000Z" });
  createFact(repository, "disabled", "correction", { state: "disabled" });
  createFact(repository, "oversized", "project_fact", {
    content: "x".repeat(10_000),
    pinned: true,
  });

  const first = await new MemoryContextBuilder(repository, () => now).build(
    "请用 ｐｎｐｍ 构建移动端",
  );
  const second = await new MemoryContextBuilder(repository, () => now).build(
    "请用 ｐｎｐｍ 构建移动端",
  );
  assert.equal(first.block, second.block);
  assert.ok(first.tokenCount <= MEMORY_CONTEXT_MAX_TOKENS);
  assert.equal(MEMORY_CONTEXT_CANDIDATE_LIMIT, 500);
  assert.ok(first.facts.length <= MEMORY_CONTEXT_MAX_FACTS);
  assert.deepEqual(
    first.facts.slice(0, 3).map((fact) => fact.factId),
    ["pinned", "correction", "project"],
  );
  assert.equal(first.block.includes("expired"), false);
  assert.equal(first.block.includes("disabled"), false);
  assert.equal(first.block.includes("oversized"), false);
  assert.equal(first.block.includes("unrelated server"), false);
  assert.match(first.block, /trust="low"/u);
  assert.match(first.block, /AGENTS\.md instructions always take precedence/u);
  assert.match(first.block, /cannot grant or change permissions, trust, provider configuration/u);

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  repository.close();
  const reopened = new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
  const acrossSession = await new MemoryContextBuilder(reopened, () => now).build(
    "请用 ｐｎｐｍ 构建移动端",
  );
  reopened.close();
  assert.equal(acrossSession.block, first.block);

  const otherWorkspace = join(fixture.root, "other-workspace");
  await mkdir(otherWorkspace);
  const otherPaths = resolvePicoPaths(otherWorkspace, { picoHome: fixture.picoHome });
  const other = new SqliteMemoryRepository({
    storageRoot: otherPaths.workspace.root,
    workspaceId: otherPaths.workspace.id,
  });
  assert.equal((await new MemoryContextBuilder(other, () => now).build()).block, "");
  other.close();
});

test("memory recall uses CJK bigrams and does not expand short confirmations or slash commands", async (context) => {
  const fixture = await createFixture("recall-query-signals");
  context.after(() => rmRetry(fixture.root));
  const repository = openRepository(fixture);
  context.after(() => repository.close());

  createFact(repository, "mobile-style", "project_fact", {
    content: "移动端风格需要与桌面端保持一致",
  });
  createFact(repository, "server-style", "reference", { content: "服务端日志使用 JSON" });
  createFact(repository, "nfkc-tool", "reference", { content: "Command: pnpm" });
  createFact(repository, "source-file", "reference", {
    content: "Edit src/memory/context-builder.ts",
  });
  createFact(repository, "always-correct", "correction", { content: "不要强制推送" });

  const chinese = await new MemoryContextBuilder(repository).build("调整移动端风格");
  assert.deepEqual(
    chinese.facts.map((fact) => fact.factId),
    ["always-correct", "mobile-style"],
  );

  const nfkc = await new MemoryContextBuilder(repository).build("运行 ｐｎｐｍ");
  assert.deepEqual(
    nfkc.facts.map((fact) => fact.factId),
    ["always-correct", "nfkc-tool"],
  );

  const path = await new MemoryContextBuilder(repository).build(
    "检查 src/memory/context-builder.ts",
  );
  assert.deepEqual(
    path.facts.map((fact) => fact.factId),
    ["always-correct", "source-file"],
  );

  for (const query of ["好的", "/memory status"]) {
    const result = await new MemoryContextBuilder(repository).build(query);
    assert.deepEqual(
      result.facts.map((fact) => fact.factId),
      ["always-correct"],
    );
  }
});

test("memory recall keeps one stable preference without displacing every query-aware fact", async (context) => {
  const fixture = await createFixture("recall-resident-preference");
  context.after(() => rmRetry(fixture.root));
  const repository = openRepository(fixture);
  context.after(() => repository.close());

  createFact(repository, "reply-language", "preference", {
    content: "始终使用中文回复",
    lastUsedAt: "2026-07-20T10:00:00.000Z",
  });
  createFact(repository, "older-preference", "preference", {
    content: "回答保持简洁",
    lastUsedAt: "2026-07-19T10:00:00.000Z",
  });
  createFact(repository, "archived-preference", "preference", {
    content: "使用英文回复",
    state: "archived",
  });
  createFact(repository, "fix-command", "project_fact", {
    content: "修复错误后运行 npm test",
  });
  createFact(repository, "fix-style", "reference", {
    content: "修复错误时先检查代码风格",
  });
  createFact(repository, "pinned", "reference", {
    content: "不要修改协议",
    pinned: true,
  });

  const result = await new MemoryContextBuilder(repository).build("帮我修复错误");
  assert.deepEqual(
    result.facts.map((fact) => fact.factId),
    ["pinned", "fix-command", "fix-style"],
  );
  assert.ok(result.tokenCount <= MEMORY_CONTEXT_MAX_TOKENS);
  assert.ok(result.facts.length <= MEMORY_CONTEXT_MAX_FACTS);
  assert.equal(result.block.includes("older-preference"), false);
  assert.equal(result.block.includes("archived-preference"), false);
  assert.equal(result.block.includes("reply-language"), false);
  assert.match(result.block, /trust="low"/u);

  const withRemainingCapacity = await new MemoryContextBuilder(repository).build("帮我分析需求");
  assert.deepEqual(
    withRemainingCapacity.facts.map((fact) => fact.factId),
    ["pinned", "reply-language"],
  );
});

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
  const legacy = openRepository(fixture);
  assert.equal(legacy.listJobs().length, 0, "atomic extraction must not write legacy review jobs");
  legacy.close();
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
  const legacy = openRepository(fixture);
  assert.equal(legacy.listJobs().length, 0);
  legacy.close();
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

test("startup does not reconstruct obsolete review jobs from durable completed terminals", async (context) => {
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
  await runtimeStore.initializeSession({ sessionId, workDir: fixture.workspace });
  await runtimeStore.appendBatch([
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
  ]);
  runtimeStore.close();
  const beforeRestart = openRepository(fixture);
  assert.equal(beforeRestart.listJobs().length, 0);
  beforeRestart.close();

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
      memoryReviewDebounceMs: 0,
      atomicMemoryModelFactory: async () => {
        startupModelCalls++;
        assert.fail("ordinary startup must not acquire a memory model");
      },
    },
  );
  assert.equal(result.finalMessage, "4");

  for (let attempt = 0; attempt < 5; attempt++) await waitForImmediate();
  const repository = openRepository(fixture);
  assert.equal(repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE }).length, 0);
  repository.close();
  const atomic = new SqliteMemoryItemStore(join(fixture.picoHome, "memory.sqlite"));
  assert.equal((await atomic.listItems({ workspaceKey: paths.workspace.id })).length, 0);
  atomic.close();
  assert.equal(startupModelCalls, 0);
});

test("atomic extraction is independent of obsolete debounce settings and is not repeated on ordinary startup", async (context) => {
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
      memoryReviewDebounceMs: -1,
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
  const repository = openRepository(fixture);
  assert.equal(repository.listJobs().length, 0);
  repository.close();
  assert.equal(extractionCalls, 1);
  assert.equal(startupModelCalls, 0);
});

test("an invalidated in-flight recovery continues with the current generation", async (context) => {
  const fixture = await createFixture("recovery-generation-handoff");
  context.after(() => rmRetry(fixture.root));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const sessionId = "memory-recovery-generation-handoff";
  await store.initializeSession({ sessionId, workDir: fixture.workspace });
  const appendCompletedRun = async (suffix: string): Promise<void> => {
    const runId = `generation-run-${suffix}`;
    const base = {
      schemaVersion: 2 as const,
      sessionId,
      invocationId: `invocation-${suffix}`,
      runId,
      turnId: `turn-${suffix}`,
      at: "2026-07-22T00:00:00.000Z",
      partial: false,
    };
    await store.appendBatch([
      {
        ...base,
        eventId: `generation-started-${suffix}`,
        visibility: "internal",
        kind: "run.started",
        data: { workDir: fixture.workspace },
      },
      {
        ...base,
        eventId: `generation-user-${suffix}`,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "user", content: `请记住：固定使用 generation-${suffix}` } },
      },
      {
        ...base,
        eventId: `generation-assistant-${suffix}`,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "assistant", content: "done" } },
      },
      {
        ...base,
        eventId: `generation-terminal-${suffix}`,
        visibility: "internal",
        kind: "run.terminal",
        data: { status: "completed" },
      },
    ]);
  };
  await appendCompletedRun("old");

  let releaseFirstEnqueue = (): void => undefined;
  const firstEnqueueReleased = new Promise<void>((resolve) => {
    releaseFirstEnqueue = resolve;
  });
  let notifyFirstEnqueue = (): void => undefined;
  const firstEnqueueStarted = new Promise<void>((resolve) => {
    notifyFirstEnqueue = resolve;
  });
  const terminalCalls: string[] = [];
  let calls = 0;
  const scheduler = {
    async enqueue(input: { readonly terminalEventId: string }): Promise<void> {
      terminalCalls.push(input.terminalEventId);
      calls++;
      if (calls === 1) {
        notifyFirstEnqueue();
        await firstEnqueueReleased;
      }
    },
  };

  const staleRecovery = recoverMemoryReviewJobs({
    runtimeStorageRoot: paths.workspace.root,
    scheduler,
  });
  await firstEnqueueStarted;
  await appendCompletedRun("new");
  invalidateMemoryReviewRecoverySuccess(paths.workspace.root);
  const currentRecovery = recoverMemoryReviewJobs({
    runtimeStorageRoot: paths.workspace.root,
    scheduler,
  });
  releaseFirstEnqueue();
  await Promise.all([staleRecovery, currentRecovery]);
  store.close();

  assert.equal(
    terminalCalls.includes("generation-terminal-new"),
    true,
    "the caller waiting on a stale flight must observe the current-generation rescan",
  );
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

test("recovery yields to the host after each fixed enqueue batch", async (context) => {
  const fixture = await createFixture("review-enqueue-batch-yield");
  context.after(() => rmRetry(fixture.root));
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const store = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const sessionId = "memory-review-enqueue-batch-yield";
  await store.initializeSession({ sessionId, workDir: fixture.workspace });
  const at = "2026-07-22T00:00:00.000Z";
  await store.appendBatch(
    Array.from({ length: 26 }, (_, index) => {
      const runId = `batch-run-${index}`;
      const base = {
        schemaVersion: 2 as const,
        sessionId,
        invocationId: `invocation-${index}`,
        runId,
        turnId: `turn-${index}`,
        at,
        partial: false,
      };
      return [
        {
          ...base,
          eventId: `batch-started-${index}`,
          visibility: "internal" as const,
          kind: "run.started" as const,
          data: { workDir: fixture.workspace },
        },
        {
          ...base,
          eventId: `batch-user-${index}`,
          visibility: "model" as const,
          kind: "message.committed" as const,
          data: { message: { role: "user" as const, content: `请记住：批次约定 ${index}` } },
        },
        {
          ...base,
          eventId: `batch-assistant-${index}`,
          visibility: "model" as const,
          kind: "message.committed" as const,
          data: { message: { role: "assistant" as const, content: "done" } },
        },
        {
          ...base,
          eventId: `batch-terminal-${index}`,
          visibility: "internal" as const,
          kind: "run.terminal" as const,
          data: { status: "completed" as const },
        },
      ];
    }).flat(),
  );
  store.close();

  let enqueued = 0;
  let hostYielded = false;
  await recoverMemoryReviewJobs({
    runtimeStorageRoot: paths.workspace.root,
    scheduler: {
      enqueue() {
        enqueued++;
        if (enqueued === 25) setImmediate(() => void (hostYielded = true));
        if (enqueued === 26) assert.equal(hostYielded, true);
      },
    },
  });
  assert.equal(enqueued, 26);
});

/**
 * 以"遗留账本"方式播种 Runtime 事件：绕过 appendBatch（其校验拒绝
 * legacy-only kind，如 history.rewound），直接向 session.jsonl 追加一条
 * event-batch 行，模拟旧版本持久化的账本。manifest 为过期投影，由
 * loadSession 的 repairManifests 在下次读取时自动修复。
 */

test("an ordinary foreground question leaves existing legacy review jobs untouched", async (context) => {
  let startupModelCalls = 0;
  const fixture = await createFixture("ordinary-recovery-kick");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trustStore, "memory-recovery-before-ordinary");

  let repository = openRepository(fixture);
  const queued = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  assert.equal(queued.length, 1);
  assert.equal(queued[0]?.status, "queued");
  repository.close();

  await executeAgentRuntime(
    {
      prompt: "What is 2 + 2?",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-ordinary-recovery-trigger" },
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
      memoryReviewDebounceMs: 0,
      atomicMemoryModelFactory: async () => {
        startupModelCalls++;
        assert.fail("legacy queued reviews must not acquire an atomic model");
      },
    },
  );

  for (let attempt = 0; attempt < 5; attempt++) await waitForImmediate();
  repository = openRepository(fixture);
  const jobs = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]?.status, "queued");
  assert.equal(jobs[0]?.attemptCount, 0);
  repository.close();
  assert.equal(startupModelCalls, 0);
});

test("proposal notification outbox retries across workers without repeating extraction", async (context) => {
  const fixture = await createFixture("worker");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  const settingsRepository = openRepository(fixture);
  const settings = settingsRepository.getSettings();
  settingsRepository.updateSettings({
    expectedVersion: settings.version,
    autoCommit: false,
    idempotencyKey: "memory-worker-manual-review",
  });
  settingsRepository.close();
  await enqueueCompletedReview(
    fixture,
    trustStore,
    "memory-worker-session",
    "请记住：这个项目固定使用 npm run build-memory 进行构建，并且延续现有发布约定。",
  );

  let modelCalls = 0;
  let disposals = 0;
  const notices: MemoryProposalPublishedNotice[] = [];
  const billingRoute = {
    provider: "openai",
    model: "memory-priced-fixture",
    baseUrl: "https://example.test",
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0,
      cacheWritePerMillion: 0,
      source: "configured",
    },
  } satisfies BillingRoute;
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const modelFactory = () => {
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace
        .root,
    });
    const provider = new CostTracker(
      {
        modelName: billingRoute.model,
        async generate(messages) {
          modelCalls++;
          const last = messages.at(-1);
          const evidenceText =
            last?.role === "user" ? (last.content.split("\n\n").at(-1) ?? "{}") : "{}";
          const evidence = JSON.parse(evidenceText) as {
            evidenceEventId?: string;
          };
          return {
            role: "assistant" as const,
            content: JSON.stringify({
              proposals: [
                {
                  kind: "project_fact",
                  title: "Build command",
                  content: "Use npm run build-memory",
                  reason: "The user explicitly stated a stable project command.",
                  confidence: 0.99,
                  evidenceEventIds: [evidence.evidenceEventId],
                },
              ],
            }),
            usage: { promptTokens: 12, completionTokens: 8 },
          };
        },
      },
      billingRoute,
      undefined,
      { ledger, context: { purpose: "memory_review" } },
    );
    return {
      model: new ProviderMemoryProposalModel(provider, billingRoute),
      dispose: () => {
        disposals++;
        ledger.close();
      },
    };
  };
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory,
    proposalSink: async (notice) => {
      notices.push(notice);
      await Promise.resolve();
      throw new Error("notification transport unavailable");
    },
  });
  const results = await worker.drain();
  assert.equal(results[0]?.status, "succeeded");
  assert.equal(modelCalls, 1);
  assert.equal(disposals, 1);
  assert.deepEqual(Object.keys(notices[0] ?? {}).sort(), ["kind", "proposalId", "version"]);

  const repository = openRepository(fixture);
  const completedJob = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0];
  assert.equal(completedJob?.status, "succeeded");
  assert.ok((completedJob?.costUsd ?? 0) > 0);
  const proposal = repository.listProposals({ statuses: ["pending"] })[0];
  assert.ok(proposal);
  const queuedNotice = repository.listJobs({ type: MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE })[0];
  assert.equal(queuedNotice?.status, "queued");
  assert.equal(queuedNotice?.cursor.eventId, proposal.proposalId);
  assert.equal(queuedNotice?.cursor.sequence, proposal.version);
  assert.equal(JSON.stringify(queuedNotice).includes("Use npm run build-memory"), false);
  assert.equal(JSON.stringify(queuedNotice).includes("Build command"), false);
  repository.close();
  const usageLedger = new SqliteRuntimeControlStore({
    storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace.root,
  });
  assert.equal(
    usageLedger.listProviderCalls().some((call) => call.purpose !== "memory_review"),
    false,
    "isolated review billing must not enter foreground usage",
  );
  const memoryCall = usageLedger
    .listProviderCalls()
    .find((call) => call.purpose === "memory_review");
  usageLedger.close();
  assert.ok((memoryCall?.cost ?? 0) > 0);
  assert.ok(
    Math.abs((memoryCall?.cost ?? 0) - (completedJob?.costUsd ?? 0) * 7.2) < 1e-12,
    "memory job USD and provider-call CNY must derive from the same estimate",
  );
  const recoveredNotices: MemoryProposalPublishedNotice[] = [];
  const recoveredWorker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory,
    proposalSink: (notice) => {
      recoveredNotices.push(notice);
    },
  });
  assert.deepEqual(await recoveredWorker.drain(), []);
  assert.equal(modelCalls, 1, "succeeded jobs are exactly-once");
  assert.equal(disposals, 1, "notification delivery must not acquire a model lease");
  assert.deepEqual(recoveredNotices, [notices[0]]);
  const recoveredRepository = openRepository(fixture);
  assert.equal(
    recoveredRepository.listJobs({ type: MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE })[0]?.status,
    "succeeded",
  );
  assert.equal(recoveredRepository.listProposals().length, 1);
  recoveredRepository.close();
});

test("production adapter publishes a durable body-free memory.proposed notification", async (context) => {
  const fixture = await createFixture("proposal-notification");
  const workspace = await realpath(fixture.workspace);
  const service = new WorkspaceRuntimeService({
    env: { PICO_HOME: fixture.picoHome },
    execute: async () => undefined,
  });
  context.after(async () => {
    await service.close();
    await rm(fixture.root, { recursive: true, force: true });
  });
  const received: unknown[] = [];
  service.subscribe((notification) => received.push(notification));

  publishDesktopMemoryProposal(
    service,
    workspace,
    { proposalId: "proposal-notice", version: 3, kind: "project_fact" },
    () => 9,
    () => 123,
  );

  assert.equal(received.length, 1);
  assert.deepEqual(received[0], {
    eventId: (received[0] as { eventId: string }).eventId,
    protocolVersion: LOCAL_RUNTIME_PROTOCOL_VERSION,
    topic: "memory.proposed",
    scope: { workspacePath: workspace },
    resourceVersion: 9,
    at: 123,
    payload: { proposalId: "proposal-notice", version: 3, kind: "project_fact" },
  });
  assert.equal(JSON.stringify(received).includes("content"), false);
  const replay = await service.replayEvents({ workspacePath: workspace });
  assert.equal(
    replay.events.some((event) => event.topic === "memory.proposed"),
    true,
  );
});

test("explicit single-fact review goes through the model lease and cites its evidence", async (context) => {
  const fixture = await createFixture("worker-deterministic");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(
    fixture,
    trustStore,
    "memory-deterministic-session",
    "请记住：这个项目固定使用 pnpm 管理依赖。",
  );

  let factoryCalls = 0;
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory: () => {
      factoryCalls++;
      return {
        // 候选一律由模型生成（ffca119e）：模型从证据原文产出单条提案。
        model: {
          async extract(request) {
            return {
              response: {
                role: "assistant",
                content: JSON.stringify({
                  proposals: [
                    {
                      kind: "project_fact",
                      title: "包管理器",
                      content: "这个项目固定使用 pnpm 管理依赖。",
                      reason: "The user explicitly stated a stable project command.",
                      confidence: 0.99,
                      evidenceEventIds: [request.evidence.userMessageEventId],
                    },
                  ],
                }),
              },
            };
          },
        },
      };
    },
  });
  const results = await worker.drain();
  assert.equal(results[0]?.status, "succeeded");
  assert.equal(factoryCalls, 1);

  const repository = openRepository(fixture);
  const proposal = repository.listProposals({ statuses: ["pending"] })[0];
  assert.equal(proposal?.content, "这个项目固定使用 pnpm 管理依赖。");
  const source = proposal?.sourceId ? repository.getSource(proposal.sourceId) : undefined;
  assert.deepEqual(source?.eventIds, [
    repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.cursor.eventId,
  ]);
  repository.close();
});

test("supported queued and stale-running reviews are not starved by over 500 unsupported jobs", async (context) => {
  const fixture = await createFixture("worker-recovery");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trustStore, "memory-recovery-stale-session");
  await enqueueCompletedReview(fixture, trustStore, "memory-recovery-queued-session");

  let repository = openRepository(fixture);
  const supported = repository.listJobs({
    type: MEMORY_PROPOSAL_JOB_TYPE,
    extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
    limit: 10,
  });
  const staleCandidate = supported.find(
    (job) => job.cursor.sessionId === "memory-recovery-stale-session",
  );
  const queuedCandidate = supported.find(
    (job) => job.cursor.sessionId === "memory-recovery-queued-session",
  );
  assert.ok(staleCandidate);
  assert.ok(queuedCandidate);
  const running = new MemoryRepositoryProposalStore(repository).markJobRunning(staleCandidate);
  for (let index = 0; index < 501; index++) {
    const suffix = String(index).padStart(3, "0");
    repository.createJob({
      jobId: `zz-unsupported-queued-${suffix}`,
      type: MEMORY_PROPOSAL_JOB_TYPE,
      terminalEventId: `unsupported-queued-terminal-${suffix}`,
      extractorVersion: "memory-proposal-v2",
      cursor: { sessionId: "future", eventId: `unsupported-queued-user-${suffix}` },
      maxAttempts: 3,
    });
    const unsupportedRunning = repository.createJob({
      jobId: `zz-unsupported-running-${suffix}`,
      type: "future-terminal-extraction",
      terminalEventId: `unsupported-running-terminal-${suffix}`,
      extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
      cursor: { sessionId: "future", eventId: `unsupported-running-user-${suffix}` },
      maxAttempts: 3,
    });
    repository.updateJob({
      jobId: unsupportedRunning.jobId,
      expectedVersion: unsupportedRunning.version,
      status: "running",
      attemptCount: 1,
    });
  }
  repository.close();

  let modelCalls = 0;
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    now: () => new Date(Date.parse(running.updatedAt) + MEMORY_REVIEW_LEASE_TTL_MS + 1),
    modelFactory: () => ({
      model: createSuccessfulModel(() => {
        modelCalls++;
      }),
    }),
  });
  const results = await worker.drain();
  assert.equal(results.filter((result) => result.status === "succeeded").length, 2);
  assert.equal(modelCalls, 2);

  repository = openRepository(fixture);
  const recovered = repository.getJob(running.jobId);
  assert.equal(recovered?.status, "succeeded");
  assert.equal(recovered?.attemptCount, 2, "recovery preserves the crashed attempt before retry");
  assert.equal(repository.getJob(queuedCandidate.jobId)?.status, "succeeded");
  assert.equal(repository.getJob(queuedCandidate.jobId)?.attemptCount, 1);
  assert.equal(repository.getJob("zz-unsupported-queued-000")?.status, "queued");
  assert.equal(repository.getJob("zz-unsupported-queued-500")?.status, "queued");
  assert.equal(repository.getJob("zz-unsupported-running-000")?.status, "running");
  assert.equal(repository.getJob("zz-unsupported-running-500")?.status, "running");
  repository.close();
});

test("two workers racing the same queued review have one model call and one proposal", async (context) => {
  const fixture = await createFixture("worker-cas-race");
  context.after(() => rmRetry(fixture.root));
  const trusted = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trusted, "memory-race-session");
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const rendezvous = createRendezvous(2);
  let modelCalls = 0;
  const model = createSuccessfulModel(() => {
    modelCalls++;
  });
  const createWorker = () =>
    new MemoryReviewWorker({
      workDir: fixture.workspace,
      workspaceId: paths.workspace.id,
      runtimeStorageRoot: paths.workspace.root,
      trustStore: new SecondCanonicalizeBarrierTrustStore(
        { userStateDirectory: fixture.picoHome },
        rendezvous,
      ),
      modelFactory: () => ({ model }),
    });

  const outcomes = await Promise.all([createWorker().drain(), createWorker().drain()]);
  assert.equal(modelCalls, 1);
  assert.equal(outcomes.flat().filter((result) => result.status === "succeeded").length, 1);
  const repository = openRepository(fixture);
  assert.equal(repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.status, "succeeded");
  assert.equal(repository.listProposals({ statuses: ["pending"] }).length, 1);
  repository.close();
});

test("one drain reuses its model lease and a failed extraction does not advance another job", async (context) => {
  const fixture = await createFixture("worker-shared-lease");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trustStore, "memory-shared-lease-a");
  await enqueueCompletedReview(fixture, trustStore, "memory-shared-lease-b");

  let factoryCalls = 0;
  let modelCalls = 0;
  let disposals = 0;
  const model: MemoryProposalModelPort = {
    async extract(request) {
      modelCalls++;
      // 无 JSON 文本在新解析器下 = 模型选择"无可记内容"（空提案成功）；
      // 要触发 retryable_failure 须给非法 envelope（proposals 非数组）。
      if (modelCalls === 1)
        return { response: { role: "assistant", content: '{"proposals": 42}' } };
      return {
        response: {
          role: "assistant",
          content: JSON.stringify({
            proposals: [
              {
                kind: "project_fact",
                title: "Recovery build command",
                content: "Use npm run memory-recovery",
                reason: "Stable project command",
                confidence: 0.99,
                evidenceEventIds: [request.evidence.userMessageEventId],
              },
            ],
          }),
        },
      };
    },
  };
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory: () => {
      factoryCalls++;
      return {
        model,
        dispose: () => {
          disposals++;
        },
      };
    },
  });
  const results = await worker.drain();
  assert.equal(factoryCalls, 1);
  assert.equal(disposals, 1);
  assert.equal(modelCalls, 2);
  assert.equal(results.filter((result) => result.status === "retryable_failure").length, 1);
  assert.equal(results.filter((result) => result.status === "succeeded").length, 1);

  const repository = openRepository(fixture);
  const jobs = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  const succeeded = jobs.find((job) => job.status === "succeeded");
  const failed = jobs.find((job) => job.status === "failed");
  assert.ok(succeeded?.sourceId);
  assert.equal(failed?.sourceId, undefined);
  assert.deepEqual(repository.getSource(succeeded.sourceId)?.eventIds, [succeeded.cursor.eventId]);
  repository.close();
});

test("an in-flight review cannot commit after its rewind job is cancelled", async (context) => {
  const fixture = await createFixture("worker-rewind-cancel");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  const sessionId = "memory-rewind-cancel-session";
  await enqueueCompletedReview(fixture, trustStore, sessionId);
  let signalStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    signalStarted = resolve;
  });
  let releaseModel!: () => void;
  const released = new Promise<void>((resolve) => {
    releaseModel = resolve;
  });
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory: () => ({
      model: {
        async extract(request) {
          signalStarted();
          await released;
          return {
            response: {
              role: "assistant",
              content: JSON.stringify({
                proposals: [
                  {
                    kind: "project_fact",
                    title: "Cancelled build command",
                    content: "Use npm run cancelled-memory",
                    reason: "Stable project command",
                    confidence: 0.99,
                    evidenceEventIds: [request.evidence.userMessageEventId],
                  },
                ],
              }),
            },
            modelCalls: 1,
            inputTokens: 20,
            outputTokens: 10,
          };
        },
      },
    }),
  });
  const draining = worker.drain();
  await started;
  const repository = openRepository(fixture);
  repository.cancelSessionJobs({
    sessionId,
    type: MEMORY_PROPOSAL_JOB_TYPE,
    extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
    afterSequence: 0,
    errorCode: "memory_source_rewound",
    idempotencyKeyPrefix: "test-rewind-cancel",
  });
  repository.close();
  releaseModel();
  await draining;

  const verify = openRepository(fixture);
  const cancelled = verify.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0];
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(cancelled?.modelCalls, 1, "rewind must retain actual provider usage");
  assert.equal(cancelled?.inputTokens, 20);
  assert.equal(cancelled?.outputTokens, 10);
  assert.equal(verify.listProposals({ statuses: ["pending"] }).length, 0);
  assert.equal(verify.listSessionSources(sessionId).length, 0);
  verify.close();
});

test("one provider call microbatches fuzzy reviews and isolates one malformed evidence", async (context) => {
  const fixture = await createFixture("worker-model-microbatch");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  for (const [index, command] of ["alpha", "beta", "gamma"].entries()) {
    await enqueueCompletedReview(
      fixture,
      trustStore,
      `memory-model-microbatch-${index}`,
      `请记住：这个项目固定使用 npm run ${command} 进行构建，并且延续对应的发布约定。`,
    );
  }

  const billingRoute = {
    provider: "openai",
    model: "memory-microbatch-fixture",
    baseUrl: "https://example.test",
    pricing: {
      inputPerMillion: 1,
      outputPerMillion: 2,
      cacheReadPerMillion: 0,
      cacheWritePerMillion: 0,
      source: "configured",
    },
  } satisfies BillingRoute;
  let providerCalls = 0;
  let disposals = 0;
  const provider: LLMProvider = {
    modelName: billingRoute.model,
    async generate(messages) {
      providerCalls++;
      // ADR 26 后评审请求消息 = [...源对话快照, user(提取 prompt + "\n\n" + evidence JSON)]：
      // evidence JSON 恒在最后一条 user 消息的空行分隔之后。
      const last = messages.at(-1);
      const evidenceText =
        last?.role === "user" ? (last.content.split("\n\n").at(-1) ?? "{}") : "{}";
      const payload = JSON.parse(evidenceText) as {
        evidences?: Array<{ evidenceEventId: string; userText: string }>;
      };
      assert.equal(payload.evidences?.length, 3);
      return {
        role: "assistant",
        content: JSON.stringify({
          proposals: payload.evidences?.map((evidence, index) => ({
            kind: "project_fact",
            title: `Build command ${index}`,
            content: `Use npm run ${["alpha", "beta", "gamma"][index]}`,
            reason: "The user explicitly stated a stable project command.",
            confidence: index === 2 ? 2 : 0.99,
            evidenceEventIds: [evidence.evidenceEventId],
          })),
        }),
        usage: { promptTokens: 101, completionTokens: 41 },
      };
    },
  };
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory: () => ({
      model: new ProviderMemoryProposalModel(provider, billingRoute),
      dispose: () => {
        disposals++;
      },
    }),
  });
  const results = await worker.drain();
  assert.equal(providerCalls, 1, "three fuzzy reviews must share one provider.generate");
  assert.equal(disposals, 1);
  assert.equal(results.filter((result) => result.status === "succeeded").length, 2);
  assert.equal(results.filter((result) => result.status === "retryable_failure").length, 1);

  const repository = openRepository(fixture);
  const jobs = repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE });
  assert.equal(jobs.filter((job) => job.status === "succeeded").length, 2);
  assert.equal(jobs.filter((job) => job.status === "failed").length, 1);
  assert.equal(repository.listProposals({ statuses: ["pending"] }).length, 2);
  assert.equal(
    jobs.reduce((sum, job) => sum + job.inputTokens, 0),
    101,
  );
  assert.equal(
    jobs.reduce((sum, job) => sum + job.outputTokens, 0),
    41,
  );
  assert.equal(
    jobs.reduce((sum, job) => sum + job.modelCalls, 0),
    1,
  );
  const expectedCost = estimateCost(billingRoute, {
    promptTokens: 101,
    completionTokens: 41,
  }).costUSD;
  assert.ok(Math.abs(jobs.reduce((sum, job) => sum + job.costUsd, 0) - expectedCost) < 1e-18);
  const failed = jobs.find((job) => job.status === "failed");
  assert.equal(failed?.sourceId, undefined);
  repository.close();
});

test("eco review mode resolves fuzzy evidence without acquiring a model", async (context) => {
  const fixture = await createFixture("worker-eco-mode");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trustStore, "memory-eco-mode");
  const repository = openRepository(fixture);
  const settings = repository.getSettings();
  repository.updateSettings({
    expectedVersion: settings.version,
    reviewMode: "eco",
    idempotencyKey: "memory-eco-mode",
  });
  repository.close();

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  let factoryCalls = 0;
  const results = await new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory: () => {
      factoryCalls++;
      return { model: createSuccessfulModel(() => undefined) };
    },
  }).drain();

  assert.equal(factoryCalls, 0);
  assert.equal(results.filter((result) => result.status === "succeeded").length, 1);
  const inspection = openRepository(fixture);
  const job = inspection.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0];
  assert.equal(job?.status, "succeeded");
  assert.equal(job?.modelCalls, 0);
  assert.equal(inspection.listProposals({ statuses: ["pending"] }).length, 0);
  inspection.close();
});

test("exhausted workspace review budget defers fuzzy jobs without consuming an attempt", async (context) => {
  const fixture = await createFixture("worker-review-budget");
  context.after(() => rmRetry(fixture.root));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trustStore, "memory-review-budget");
  const repository = openRepository(fixture);
  for (let index = 0; index < 8; index++) {
    const historical = repository.createJob({
      type: MEMORY_PROPOSAL_JOB_TYPE,
      terminalEventId: `memory-budget-history-${index}`,
      extractorVersion: MEMORY_PROPOSAL_EXTRACTOR_VERSION,
      cursor: { sessionId: "memory-budget-history", sequence: index + 1 },
      idempotencyKey: `memory-budget-history-create-${index}`,
    });
    repository.updateJob({
      jobId: historical.jobId,
      expectedVersion: historical.version,
      status: "succeeded",
      modelCalls: 1,
      inputTokens: 100,
      outputTokens: 10,
      costUsd: 0.001,
      idempotencyKey: `memory-budget-history-finish-${index}`,
    });
  }
  repository.close();

  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  let factoryCalls = 0;
  const results = await new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    runtimeStorageRoot: paths.workspace.root,
    trustStore,
    modelFactory: () => {
      factoryCalls++;
      return { model: createSuccessfulModel(() => undefined) };
    },
  }).drain();

  assert.equal(factoryCalls, 0);
  assert.deepEqual(results, []);
  const inspection = openRepository(fixture);
  const pending = inspection
    .listJobs({ statuses: ["queued"], type: MEMORY_PROPOSAL_JOB_TYPE })
    .find((job) => job.cursor.sessionId === "memory-review-budget");
  assert.ok(pending?.nextAttemptAt);
  assert.equal(pending.attemptCount, 0);
  assert.equal(pending.modelCalls, 0);
  inspection.close();
});

test("/memory registry command uses atomic storage, sanitizer, idempotency, settings and executable undo", async (context) => {
  const fixture = await createFixture("command");
  context.after(() => rmRetry(fixture.root));
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
  const execute = async (argv: string[]) => {
    const result = await command.execute(
      { raw: `/memory ${argv.join(" ")}`, name: "memory", args: argv.join(" "), argv },
      {},
    );
    assert.equal(result.type, "local");
    return result.type === "local" ? (result.message ?? "") : "";
  };
  const remembered = await execute(["remember", "Use npm run test:memory"]);
  const undo = remembered.match(/\/memory undo (\S+)/u)?.[1];
  assert.ok(undo);
  await execute(["remember", "Use npm run test:memory"]);
  assert.match(await execute(["status"]), /Active facts: 1/);
  assert.match(
    await execute(["remember", "sk-abcdefghijklmnopqrstuvwxyz123456"]),
    /安全扫描未通过/,
  );
  assert.doesNotMatch(await execute(["status"]), /Review budget|Pending proposals/);
  await execute(["off"]);
  assert.match(await execute(["status"]), /Memory: off[\s\S]*Injection: off/);
  await execute(["on"]);
  assert.match(await execute(["status"]), /Memory: on[\s\S]*Injection: on/);
  await execute(["undo", undo]);
  assert.match(await execute(["status"]), /Active facts: 0[\s\S]*Archived facts: 1/);
  assert.match(await execute(["undo", undo]), /fact changed/);
  const legacy = openRepository(fixture);
  assert.equal(legacy.listFacts().length, 0);
  legacy.close();
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

async function enqueueCompletedReview(
  fixture: { workspace: string; picoHome: string },
  _trustStore: WorkspaceTrustStore,
  sessionId: string,
  prompt = "请记住：这个项目固定使用 npm run memory-recovery 进行构建，并且延续现有发布约定。",
): Promise<void> {
  // Legacy workers retain isolated regression coverage without relying on removed production wiring.
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const runId = `run-${sessionId}`;
  const userMessageEventId = `user-${sessionId}`,
    terminalEventId = `terminal-${sessionId}`;
  try {
    await events.initializeSession({ sessionId, workDir: fixture.workspace });
    const base = {
      schemaVersion: 2 as const,
      sessionId,
      invocationId: `invocation-${sessionId}`,
      runId,
      turnId: `turn-${sessionId}`,
      at: new Date().toISOString(),
      partial: false,
    };
    await events.appendBatch([
      {
        ...base,
        eventId: `started-${sessionId}`,
        visibility: "internal",
        kind: "run.started",
        data: { workDir: fixture.workspace },
      },
      {
        ...base,
        eventId: userMessageEventId,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "user", content: prompt } },
      },
      {
        ...base,
        eventId: `assistant-${sessionId}`,
        visibility: "model",
        kind: "message.committed",
        data: { message: { role: "assistant", content: "foreground complete" } },
      },
      {
        ...base,
        eventId: terminalEventId,
        visibility: "internal",
        kind: "run.terminal",
        data: { status: "completed" },
      },
    ]);
    const repository = openRepository(fixture);
    try {
      const settings = repository.getSettings();
      repository.updateSettings({
        expectedVersion: settings.version,
        autoCommit: false,
        idempotencyKey: `manual-review:${sessionId}`,
      });
      new MemoryReviewScheduler(repository, { debounceMs: 0 }).enqueue({
        sessionId,
        runId,
        userMessageEventId,
        terminalEventId,
      });
    } finally {
      repository.close();
    }
  } finally {
    events.close();
  }
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

function createSuccessfulModel(onExtract: () => void): MemoryProposalModelPort {
  return {
    async extract(request) {
      onExtract();
      return {
        response: {
          role: "assistant",
          content: JSON.stringify({
            proposals: [
              {
                kind: "project_fact",
                title: "Recovery build command",
                content: "Use npm run memory-recovery",
                reason: "The user explicitly stated a stable project command.",
                confidence: 0.99,
                evidenceEventIds: [request.evidence.userMessageEventId],
              },
            ],
          }),
        },
      };
    },
  };
}

function createRendezvous(parties: number): () => Promise<void> {
  let arrivals = 0;
  let release = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  return async () => {
    arrivals++;
    if (arrivals === parties) release();
    await ready;
  };
}

class SecondCanonicalizeBarrierTrustStore extends WorkspaceTrustStore {
  private canonicalizeCalls = 0;

  constructor(
    options: ConstructorParameters<typeof WorkspaceTrustStore>[0],
    private readonly rendezvous: () => Promise<void>,
  ) {
    super(options);
  }

  override async canonicalize(workspacePath: string): Promise<string> {
    const canonical = await super.canonicalize(workspacePath);
    this.canonicalizeCalls++;
    if (this.canonicalizeCalls === 2) await this.rendezvous();
    return canonical;
  }

  override async isTrusted(_canonicalWorkspacePath: string): Promise<boolean> {
    return true;
  }
}

function openRepository(fixture: { workspace: string; picoHome: string }) {
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  return new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
}

function createFact(
  repository: SqliteMemoryRepository,
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
