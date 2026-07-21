import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import type { Message } from "../../src/schema/message.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import {
  MemoryContextBuilder,
  MEMORY_CONTEXT_CANDIDATE_LIMIT,
  MEMORY_CONTEXT_MAX_FACTS,
  MEMORY_CONTEXT_MAX_TOKENS,
} from "../../src/memory/context-builder.js";
import {
  MEMORY_PROPOSED_NOTIFICATION_JOB_TYPE,
  MemoryRepository,
} from "../../src/memory/memory-repository.js";
import { MemoryRepositoryProposalStore } from "../../src/memory/proposal-engine.js";
import {
  MEMORY_PROPOSAL_EXTRACTOR_VERSION,
  MEMORY_PROPOSAL_JOB_TYPE,
  type MemoryProposalModelPort,
} from "../../src/memory/proposal-contracts.js";
import { MEMORY_REVIEW_LEASE_TTL_MS } from "../../src/memory/runtime-scheduler.js";
import {
  MemoryReviewWorker,
  ProviderMemoryProposalModel,
  type MemoryProposalPublishedNotice,
} from "../../src/memory/worker.js";
import { createPicoCommandRegistry } from "../../src/input/pico-command-registry.js";
import { CostTracker } from "../../src/observability/tracker.js";
import { estimateCost, type BillingRoute } from "../../src/observability/pricing.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import { executeAgentRuntime } from "../../src/runtime/agent-runtime.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";
import { publishDesktopMemoryProposal } from "../../src/daemon/production-host.js";
import { WorkspaceRuntimeService } from "../../src/daemon/workspace-runtime-service.js";
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
  const reopened = new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
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
  const other = new MemoryRepository({
    databasePath: otherPaths.workspace.memoryDatabase,
    workspaceId: otherPaths.workspace.id,
  });
  assert.equal((await new MemoryContextBuilder(other, () => now).build()).block, "");
  other.close();
});

test("memory recall uses CJK bigrams and does not expand short confirmations or slash commands", async (context) => {
  const fixture = await createFixture("recall-query-signals");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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

test("foreground Runtime injects trusted recall ephemerally and schedules only completed enabled runs", async (context) => {
  const fixture = await createFixture("runtime");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  const repository = openRepository(fixture);
  createFact(repository, "runtime-fact", "project_fact", {
    content: "Use npm run verify-memory with hidden-recall-policy",
  });
  createFact(repository, "runtime-unrelated", "reference", { content: "Deploy with kubectl" });
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
      prompt:
        "Please use npm run verify-memory. Please remember that this is a durable project convention.",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-runtime-session" },
      provider: "openai",
    },
    { provider, picoHome: fixture.picoHome, memoryTrustStore: trustStore },
  );
  assert.equal(result.finalMessage, "done");
  const beforeDetachedEnqueue = openRepository(fixture);
  assert.equal(
    beforeDetachedEnqueue.listJobs().length,
    0,
    "foreground result must resolve before the detached durable enqueue runs",
  );
  beforeDetachedEnqueue.close();
  await waitForImmediate();
  assert.match(captured[0]?.[0]?.content ?? "", /hidden-recall-policy/u);
  assert.doesNotMatch(captured[0]?.[0]?.content ?? "", /Deploy with kubectl/u);
  assert.equal(
    result.messages.some((message) => message.content.includes("hidden-recall-policy")),
    false,
  );
  const runtimePaths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const runtimeEvents = await new RuntimeEventStore({
    databasePath: runtimePaths.workspace.runtimeDatabase,
  }).readSession("memory-runtime-session");
  assert.equal(
    JSON.stringify(runtimeEvents).includes("hidden-recall-policy"),
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
    transcriptMessages.some((message) => message?.content.includes("hidden-recall-policy")),
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

test("proposal notification outbox retries across workers without repeating extraction", async (context) => {
  const fixture = await createFixture("worker");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  const foregroundProvider: LLMProvider = {
    async generate() {
      return { role: "assistant", content: "foreground complete" };
    },
  };
  const foreground = await executeAgentRuntime(
    {
      prompt: "请记住：这个项目固定使用 npm run build-memory 进行构建，并且延续现有发布约定。",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-worker-session" },
      provider: "openai",
    },
    {
      provider: foregroundProvider,
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      memoryReviewDebounceMs: 0,
    },
  );
  await waitForImmediate();

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
    const ledger = new RuntimeStore({
      workDir: fixture.workspace,
      picoHome: fixture.picoHome,
    });
    const provider = new CostTracker(
      {
        modelName: billingRoute.model,
        async generate(messages) {
          modelCalls++;
          const evidence = JSON.parse(messages[1]?.content ?? "{}") as {
            evidenceEventId?: string;
          };
          return {
            role: "assistant" as const,
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
                      evidenceEventIds: [evidence.evidenceEventId],
                    },
                  ],
                }),
              },
            ],
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
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
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
  assert.equal(foreground.usage.costCNY, 0, "memory review must not enter main Session usage");
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
  const usageLedger = new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome });
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
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
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
    protocolVersion: 1,
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

test("explicit single-fact review commits without acquiring a model lease", async (context) => {
  const fixture = await createFixture("worker-deterministic");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  await executeAgentRuntime(
    {
      prompt: "请记住：这个项目固定使用 pnpm 管理依赖。",
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId: "memory-deterministic-session" },
      provider: "openai",
    },
    {
      provider: {
        async generate() {
          return { role: "assistant", content: "foreground complete" };
        },
      },
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      memoryReviewDebounceMs: 0,
    },
  );
  await waitForImmediate();

  let factoryCalls = 0;
  const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
  const worker = new MemoryReviewWorker({
    workDir: fixture.workspace,
    workspaceId: paths.workspace.id,
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
    trustStore,
    modelFactory: () => {
      factoryCalls++;
      return { model: createSuccessfulModel(() => undefined) };
    },
  });
  const results = await worker.drain();
  assert.equal(results[0]?.status, "succeeded");
  assert.equal(factoryCalls, 0);

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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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
      memoryDatabasePath: paths.workspace.memoryDatabase,
      runtimeDatabasePath: paths.workspace.runtimeDatabase,
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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const trustStore = await trustFixture(fixture);
  await enqueueCompletedReview(fixture, trustStore, "memory-shared-lease-a");
  await enqueueCompletedReview(fixture, trustStore, "memory-shared-lease-b");

  let factoryCalls = 0;
  let modelCalls = 0;
  let disposals = 0;
  const model: MemoryProposalModelPort = {
    async extract(request) {
      modelCalls++;
      if (modelCalls === 1) return { response: { role: "assistant", content: "invalid" } };
      return {
        response: {
          role: "assistant",
          content: "",
          toolCalls: [
            {
              id: "memory-shared-lease-call",
              name: "submit_memory_proposals",
              arguments: JSON.stringify({
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
          ],
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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
    trustStore,
    modelFactory: () => ({
      model: {
        async extract(request) {
          signalStarted();
          await released;
          return {
            response: {
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  id: "rewind-cancel-call",
                  name: "submit_memory_proposals",
                  arguments: JSON.stringify({
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
              ],
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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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
      const payload = JSON.parse(messages[1]?.content ?? "{}") as {
        evidences?: Array<{ evidenceEventId: string; userText: string }>;
      };
      assert.equal(payload.evidences?.length, 3);
      return {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "memory-microbatch-call",
            name: "submit_memory_proposals",
            arguments: JSON.stringify({
              proposals: payload.evidences?.map((evidence, index) => ({
                kind: "project_fact",
                title: `Build command ${index}`,
                content: `Use npm run ${["alpha", "beta", "gamma"][index]}`,
                reason: "The user explicitly stated a stable project command.",
                confidence: index === 2 ? 2 : 0.99,
                evidenceEventIds: [evidence.evidenceEventId],
              })),
            }),
          },
        ],
        usage: { promptTokens: 101, completionTokens: 41 },
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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
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
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
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
    memoryDatabasePath: paths.workspace.memoryDatabase,
    runtimeDatabasePath: paths.workspace.runtimeDatabase,
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
  repository = openRepository(fixture);
  const reviewJob = repository.createJob({
    type: "terminal-extraction",
    terminalEventId: "memory-command-review",
    extractorVersion: "memory-command-v1",
    cursor: { sessionId: "memory-command-session" },
  });
  repository.updateJob({
    jobId: reviewJob.jobId,
    expectedVersion: reviewJob.version,
    status: "succeeded",
    modelCalls: 1,
    inputTokens: 120,
    outputTokens: 30,
    costUsd: 0.0125,
    idempotencyKey: "memory-command-review-complete",
  });
  const settings = repository.getSettings();
  repository.updateSettings({
    expectedVersion: settings.version,
    autoPropose: false,
    idempotencyKey: "test-disable-auto-propose",
  });
  repository.close();
  const balancedStatus = await execute(["status"]);
  assert.match(
    balancedStatus.type === "local" ? (balancedStatus.message ?? "") : "",
    /Review mode: balanced[\s\S]*Review budget \(rolling 24h\): available[\s\S]*Review usage: 1\/8 calls, 120\/16000 input tokens, 30\/2000 output tokens, \$0\.0125\/\$0\.1000/u,
  );
  repository = openRepository(fixture);
  const balancedSettings = repository.getSettings();
  repository.updateSettings({
    expectedVersion: balancedSettings.version,
    reviewMode: "eco",
    idempotencyKey: "memory-command-review-eco",
  });
  repository.close();
  const ecoStatus = await execute(["status"]);
  assert.match(
    ecoStatus.type === "local" ? (ecoStatus.message ?? "") : "",
    /Review mode: eco[\s\S]*Eco mode guarantees zero model review calls/u,
  );
  await execute(["off"]);
  repository = openRepository(fixture);
  assert.equal(repository.getSettings().enabled, false);
  assert.equal(repository.getSettings().injectionEnabled, false);
  repository.close();
  const enabled = await execute(["on"]);
  assert.match(enabled.type === "local" ? (enabled.message ?? "") : "", /review remains off/u);
  await execute(["undo", undoCommand]);
  repository = openRepository(fixture);
  assert.equal(repository.listFacts({ states: ["active"] }).length, 0);
  assert.equal(repository.listFacts({ states: ["disabled"] }).length, 1);
  assert.equal(repository.getSettings().enabled, true);
  assert.equal(repository.getSettings().autoPropose, false);
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
  downgradeRuntimeDatabaseToV6(databasePath);
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

test("runtime v6 migration name is verified before the v7 provider purpose upgrade", async (context) => {
  const fixture = await createFixture("provider-purpose-v6-name");
  context.after(() => rm(fixture.root, { recursive: true, force: true }));
  const ledger = new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome });
  const databasePath = ledger.databasePath;
  ledger.close();
  downgradeRuntimeDatabaseToV6(databasePath, "tampered_v6");

  assert.throws(
    () => new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome }),
    /schema 6 migration tampered_v6 不受支持/u,
  );
  const inspected = new Database(databasePath, { readonly: true });
  const current = inspected
    .prepare("SELECT MAX(version) AS version FROM schema_migrations")
    .get() as { version: number };
  const providerTable = inspected
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'provider_calls'")
    .get() as { sql: string };
  inspected.close();
  assert.equal(current.version, 6, "fail-closed validation must not partially apply v7");
  assert.equal(providerTable.sql.includes("memory_review"), false);
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
  trustStore: WorkspaceTrustStore,
  sessionId: string,
  prompt = "请记住：这个项目固定使用 npm run memory-recovery 进行构建，并且延续现有发布约定。",
): Promise<void> {
  await executeAgentRuntime(
    {
      prompt,
      dir: fixture.workspace,
      sessionSelection: { mode: "new", sessionId },
      provider: "openai",
    },
    {
      provider: {
        async generate() {
          return { role: "assistant", content: "foreground complete" };
        },
      },
      picoHome: fixture.picoHome,
      memoryTrustStore: trustStore,
      memoryReviewDebounceMs: 0,
    },
  );
  for (let attempt = 0; attempt < 100; attempt++) {
    await waitForImmediate();
    const repository = openRepository(fixture);
    const jobs = repository.listJobs({ statuses: ["queued"], type: MEMORY_PROPOSAL_JOB_TYPE });
    if (jobs.length > 0) {
      for (const job of jobs) {
        repository.updateJob({
          jobId: job.jobId,
          expectedVersion: job.version,
          nextAttemptAt: null,
          idempotencyKey: `memory-test-release-debounce:${job.jobId}:${job.version}`,
        });
      }
      repository.close();
      return;
    }
    repository.close();
  }
  throw new Error("Timed out waiting for the debounced memory review job");
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
          content: "",
          toolCalls: [
            {
              id: "memory-success-call",
              name: "submit_memory_proposals",
              arguments: JSON.stringify({
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
          ],
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

function downgradeRuntimeDatabaseToV6(
  databasePath: string,
  migrationName = "daemon_run_projection_and_idempotency",
): void {
  const database = new Database(databasePath);
  try {
    database.transaction(() => {
      database.exec(`
        DROP INDEX IF EXISTS provider_calls_session_idx;
        DROP INDEX IF EXISTS provider_calls_goal_idx;
        DROP INDEX IF EXISTS provider_calls_job_idx;
        ALTER TABLE provider_calls RENAME TO provider_calls_v7_fixture;
        CREATE TABLE provider_calls (
          call_id TEXT PRIMARY KEY,
          session_id TEXT,
          conversation_id TEXT,
          goal_id TEXT,
          job_id TEXT REFERENCES jobs(job_id) ON DELETE SET NULL,
          attempt_id TEXT REFERENCES job_attempts(attempt_id) ON DELETE SET NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('main','subagent','compaction','aux','grace','hook')),
          provider TEXT NOT NULL,
          model TEXT NOT NULL,
          route TEXT,
          status TEXT NOT NULL CHECK (status IN ('succeeded','failed','cancelled')),
          input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
          output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
          cache_read_tokens INTEGER NOT NULL CHECK (cache_read_tokens >= 0),
          cache_write_tokens INTEGER NOT NULL CHECK (cache_write_tokens >= 0),
          cost REAL NOT NULL CHECK (cost >= 0),
          reported_json TEXT,
          created_at INTEGER NOT NULL
        );
        INSERT INTO provider_calls (
          call_id, session_id, conversation_id, goal_id, job_id, attempt_id, purpose,
          provider, model, route, status, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost, reported_json, created_at
        )
        SELECT
          call_id, session_id, conversation_id, goal_id, job_id, attempt_id, purpose,
          provider, model, route, status, input_tokens, output_tokens, cache_read_tokens,
          cache_write_tokens, cost, reported_json, created_at
        FROM provider_calls_v7_fixture;
        DROP TABLE provider_calls_v7_fixture;
        CREATE INDEX provider_calls_session_idx ON provider_calls(session_id, created_at);
        CREATE INDEX provider_calls_goal_idx ON provider_calls(goal_id, created_at);
        CREATE INDEX provider_calls_job_idx ON provider_calls(job_id, created_at);
      `);
      database.prepare("DELETE FROM schema_migrations WHERE version = 7").run();
      database
        .prepare("UPDATE schema_migrations SET name = ? WHERE version = 6")
        .run(migrationName);
    })();
  } finally {
    database.close();
  }
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
