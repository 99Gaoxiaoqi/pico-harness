import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { MemoryRepository } from "../../src/memory/memory-repository.js";
import type {
  MemoryProposalExtractionRequest,
  MemoryProposalExtractionResult,
  MemoryProposalModelPort,
} from "../../src/memory/proposal-contracts.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import {
  executeAgentRuntime,
  type RunAgentProviderFactory,
} from "../../src/runtime/agent-runtime.js";
import { RuntimeEventStore } from "../../src/runtime/runtime-event-store.js";
import type { Message } from "../../src/schema/message.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { RuntimeStore } from "../../src/tasks/runtime-store.js";

const MEMORY_CANARY = "npm run reviewed-memory-canary";

test("accepted Session A memory reaches Session B AgentRuntime prompt but not another workspace", async () => {
  const fixture = await createFixture("cross-session");
  const otherWorkspace = join(fixture.root, "other-workspace");
  await mkdir(otherWorkspace, { recursive: true });
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace, otherWorkspace);
  const sessionIds = ["quality-memory-a", "quality-memory-b", "quality-memory-other"];
  let reviewCalls = 0;

  try {
    await executeAgentRuntime(
      runtimeRequest(
        fixture.workspace,
        sessionIds[0]!,
        `请记住：这个项目固定使用 ${MEMORY_CANARY} 验证记忆。`,
      ),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: finalAnswerProvider("session A complete"),
        memoryProposalModelFactory: () => ({
          model: successfulReviewModel(() => reviewCalls++),
        }),
        reporter: new SilentReporter(),
      },
    );

    await waitForMemoryState(fixture, (repository) =>
      repository.listProposals({ statuses: ["pending"] }).length === 1 ? true : undefined,
    );
    let repository = openRepository(fixture.workspace, fixture.picoHome);
    const proposal = repository.listProposals({ statuses: ["pending"] })[0];
    assert.ok(proposal);
    const reviewed = repository.resolveProposal({
      proposalId: proposal.proposalId,
      resolution: "accepted",
      expectedVersion: proposal.version,
      idempotencyKey: "quality-cross-session-accept",
      factId: "quality-cross-session-fact",
    });
    assert.equal(reviewed.fact?.state, "active");
    const settings = repository.getSettings();
    repository.updateSettings({
      expectedVersion: settings.version,
      autoPropose: false,
      idempotencyKey: "quality-cross-session-disable-review",
    });
    repository.close();

    const sessionBPrompts: Message[][] = [];
    await executeAgentRuntime(
      runtimeRequest(fixture.workspace, sessionIds[1]!, "What is the build command?"),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: capturingProvider(sessionBPrompts, "session B complete"),
        reporter: new SilentReporter(),
      },
    );
    assert.match(sessionBPrompts[0]?.[0]?.content ?? "", new RegExp(MEMORY_CANARY, "u"));

    repository = openRepository(otherWorkspace, fixture.picoHome);
    const otherSettings = repository.getSettings();
    repository.updateSettings({
      expectedVersion: otherSettings.version,
      autoPropose: false,
      idempotencyKey: "quality-other-workspace-disable-review",
    });
    repository.close();
    const otherPrompts: Message[][] = [];
    await executeAgentRuntime(
      runtimeRequest(otherWorkspace, sessionIds[2]!, "What is the build command?"),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: capturingProvider(otherPrompts, "other workspace complete"),
        reporter: new SilentReporter(),
      },
    );
    assert.equal(otherPrompts[0]?.[0]?.content.includes(MEMORY_CANARY), false);
    assert.equal(reviewCalls, 1);
  } finally {
    await closeSessions(
      sessionIds,
      [fixture.workspace, fixture.workspace, otherWorkspace],
      fixture.picoHome,
    );
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory settings independently gate recall and review work", async (context) => {
  const cases = [
    {
      name: "enabled=false",
      settings: { enabled: false },
      expectedRecall: false,
      expectedReviewCalls: 0,
      expectedJobs: 0,
    },
    {
      name: "autoPropose=false",
      settings: { autoPropose: false },
      expectedRecall: true,
      expectedReviewCalls: 0,
      expectedJobs: 0,
    },
    {
      name: "injectionEnabled=false",
      settings: { injectionEnabled: false },
      expectedRecall: false,
      expectedReviewCalls: 1,
      expectedJobs: 1,
    },
  ] as const;

  for (const settingCase of cases) {
    await context.test(settingCase.name, async () => {
      const fixture = await createFixture(`settings-${settingCase.name.replaceAll(/\W/gu, "-")}`);
      const sessionId = `quality-${settingCase.name}`;
      const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
      let mainCalls = 0;
      let reviewCalls = 0;
      const prompts: Message[][] = [];
      try {
        const repository = openRepository(fixture.workspace, fixture.picoHome);
        repository.createFact({
          factId: `quality-setting-fact:${settingCase.name}`,
          kind: "project_fact",
          title: "Setting canary",
          content: MEMORY_CANARY,
        });
        const settings = repository.getSettings();
        repository.updateSettings({
          expectedVersion: settings.version,
          idempotencyKey: `quality-setting:${settingCase.name}`,
          ...settingCase.settings,
        });
        repository.close();

        await executeAgentRuntime(
          runtimeRequest(
            fixture.workspace,
            sessionId,
            "请记住：本项目固定使用 npm run settings-review。",
          ),
          {
            picoHome: fixture.picoHome,
            memoryTrustStore: trustStore,
            provider: {
              async generate(messages) {
                mainCalls++;
                prompts.push(structuredClone(messages));
                return { role: "assistant", content: "foreground complete" };
              },
            },
            memoryProposalModelFactory: () => ({
              model: emptyReviewModel(() => reviewCalls++),
            }),
            reporter: new SilentReporter(),
          },
        );
        assert.equal(mainCalls, 1);
        assert.equal(prompts[0]?.[0]?.content.includes(MEMORY_CANARY), settingCase.expectedRecall);

        if (settingCase.expectedReviewCalls > 0) {
          await waitForMemoryState(fixture, (current) =>
            current.listJobs()[0]?.status === "succeeded" ? true : undefined,
          );
        } else {
          await flushAsyncWork();
        }
        assert.equal(reviewCalls, settingCase.expectedReviewCalls);
        const inspection = openRepository(fixture.workspace, fixture.picoHome);
        assert.equal(inspection.listJobs().length, settingCase.expectedJobs);
        inspection.close();
      } finally {
        await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
        await rm(fixture.root, { recursive: true, force: true });
      }
    });
  }
});

test("foreground streaming completion does not wait for a blocked memory reviewer", async () => {
  const fixture = await createFixture("streaming-nonblocking");
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
  const sessionId = "quality-streaming-nonblocking";
  const deferred = createDeferred<MemoryProposalExtractionResult>();
  const reviewStarted = createDeferred<void>();
  const reporter = new DeltaReporter();
  let reviewCalls = 0;
  const streamingProvider: LLMProvider = {
    async generate() {
      throw new Error("streaming provider must use generateStream");
    },
    async generateStream(_messages, _tools, onDelta) {
      onDelta("stream");
      onDelta("ed");
      return {
        role: "assistant",
        content: "streamed",
        usage: { promptTokens: 7, completionTokens: 2 },
      };
    },
  };

  try {
    const result = await executeAgentRuntime(
      runtimeRequest(
        fixture.workspace,
        sessionId,
        "请记住：本项目固定使用 npm run stream-memory。",
      ),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: streamingProvider,
        memoryProposalModelFactory: () => ({
          model: {
            async extract() {
              reviewCalls++;
              reviewStarted.resolve();
              return deferred.promise;
            },
          },
        }),
        reporter,
      },
    );
    assert.equal(result.finalMessage, "streamed");
    assert.deepEqual(reporter.deltas, ["stream", "ed"]);
    await reviewStarted.promise;
    assert.equal(reviewCalls, 1);
    assert.equal(openJobStatus(fixture), "running");

    deferred.resolve(emptyExtractionResult());
    await waitForMemoryState(fixture, (repository) =>
      repository.listJobs()[0]?.status === "succeeded" ? true : undefined,
    );
  } finally {
    deferred.resolve(emptyExtractionResult());
    await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("memory reviewer failure cannot replace foreground terminal success", async () => {
  const fixture = await createFixture("review-failure");
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
  const sessionId = "quality-review-failure";
  let reviewCalls = 0;
  try {
    const result = await executeAgentRuntime(
      runtimeRequest(
        fixture.workspace,
        sessionId,
        "请记住：本项目固定使用 npm run failing-review。",
      ),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: finalAnswerProvider("foreground survived"),
        memoryProposalModelFactory: () => ({
          model: {
            async extract() {
              reviewCalls++;
              throw new Error("review provider unavailable");
            },
          },
        }),
        reporter: new SilentReporter(),
      },
    );
    assert.equal(result.finalMessage, "foreground survived");
    await waitForMemoryState(fixture, (repository) =>
      repository.listJobs()[0]?.status === "failed" ? true : undefined,
    );
    assert.equal(reviewCalls, 1);
    const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
    const eventStore = new RuntimeEventStore({ databasePath: paths.workspace.runtimeDatabase });
    try {
      const events = await eventStore.readSession(sessionId);
      assert.equal(
        events.some((event) => event.kind === "run.terminal" && event.data.status === "completed"),
        true,
      );
    } finally {
      eventStore.close();
    }
  } finally {
    await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("default priced worker records one memory_review without changing main Session usage", async () => {
  const fixture = await createFixture("priced-worker");
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace);
  const sessionId = "quality-priced-worker";
  let providerInstances = 0;
  const providerFactory: RunAgentProviderFactory = () => {
    providerInstances++;
    return {
      async generate(_messages, tools) {
        if (tools.some((tool) => tool.name === "submit_memory_proposals")) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [
              {
                id: "quality-priced-memory-review",
                name: "submit_memory_proposals",
                arguments: JSON.stringify({
                  proposals: [
                    {
                      kind: "project_fact",
                      title: "Priced review command",
                      content: "Use npm run priced-review",
                      reason: "Stable project command from user evidence",
                      confidence: 0.99,
                      evidenceEventIds: [extractEvidenceEventId(_messages)],
                    },
                  ],
                }),
              },
            ],
            usage: { promptTokens: 40, completionTokens: 20 },
          };
        }
        return {
          role: "assistant",
          content: "priced foreground complete",
          usage: { promptTokens: 100, completionTokens: 50 },
        };
      },
    };
  };
  const capabilities = resolveModelRouteCapabilities(
    "openai",
    "quality-priced-model",
    {
      toolCall: true,
      price: {
        inputPerMillion: 1,
        outputPerMillion: 2,
        cacheReadPerMillion: 0.1,
        cacheWritePerMillion: 1,
      },
    },
    { baseURL: "https://quality.example.test/v1" },
  );

  try {
    await executeAgentRuntime(
      {
        ...runtimeRequest(
          fixture.workspace,
          sessionId,
          "请记住：这个项目固定使用 npm run priced-review。",
        ),
        baseURL: "https://quality.example.test/v1",
        apiKey: "quality-priced-key",
        model: "quality-priced-model",
        modelRouteId: "quality/quality-priced-model",
        modelCapabilities: capabilities,
      },
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        providerFactory,
        reporter: new SilentReporter(),
      },
    );
    const session = globalSessionManager.get(sessionId, fixture.workspace, {
      picoHome: fixture.picoHome,
    });
    assert.ok(session);
    const usageBeforeReview = structuredClone(session.getRuntimeStateSnapshot().usage);

    await waitForMemoryState(fixture, (repository) =>
      repository.listJobs()[0]?.status === "succeeded" ? true : undefined,
    );
    await waitForProviderCalls(fixture, 2);
    const usageAfterReview = session.getRuntimeStateSnapshot().usage;
    assert.deepEqual(usageAfterReview, usageBeforeReview);
    assert.equal(usageAfterReview.totalProviderCalls, 1);

    const ledger = new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome });
    try {
      const calls = ledger.listProviderCalls();
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((call) => call.purpose).sort(), ["main", "memory_review"]);
      assert.equal(calls.filter((call) => call.purpose === "main").length, 1);
      const review = calls.find((call) => call.purpose === "memory_review");
      assert.ok(review);
      assert.ok(review.cost > 0);
      assert.equal(review.reported?.["costStatus"], "estimated");
      assert.equal(review.inputTokens, 40);
      assert.equal(review.outputTokens, 20);
    } finally {
      ledger.close();
    }
    assert.equal(providerInstances, 2, "one foreground provider plus one self-owned reviewer");
  } finally {
    await closeSessions([sessionId], [fixture.workspace], fixture.picoHome);
    await rm(fixture.root, { recursive: true, force: true });
  }
});

class DeltaReporter extends SilentReporter {
  readonly deltas: string[] = [];

  onTextDelta(delta: string): void {
    this.deltas.push(delta);
  }
}

function successfulReviewModel(onExtract: () => void): MemoryProposalModelPort {
  return {
    async extract(request) {
      onExtract();
      return proposalExtractionResult(request, MEMORY_CANARY);
    },
  };
}

function emptyReviewModel(onExtract: () => void): MemoryProposalModelPort {
  return {
    async extract() {
      onExtract();
      return emptyExtractionResult();
    },
  };
}

function proposalExtractionResult(
  request: MemoryProposalExtractionRequest,
  content: string,
): MemoryProposalExtractionResult {
  return {
    response: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "quality-runtime-review",
          name: "submit_memory_proposals",
          arguments: JSON.stringify({
            proposals: [
              {
                kind: "project_fact",
                title: "Reviewed build command",
                content,
                reason: "Stable project command explicitly provided by the user",
                confidence: 0.99,
                evidenceEventIds: [request.evidence.userMessageEventId],
              },
            ],
          }),
        },
      ],
      usage: { promptTokens: 12, completionTokens: 8 },
    },
    inputTokens: 12,
    outputTokens: 8,
    costUsd: 0.001,
  };
}

function emptyExtractionResult(): MemoryProposalExtractionResult {
  return {
    response: {
      role: "assistant",
      content: "",
      toolCalls: [
        {
          id: "quality-runtime-empty-review",
          name: "submit_memory_proposals",
          arguments: JSON.stringify({ proposals: [] }),
        },
      ],
      usage: { promptTokens: 4, completionTokens: 1 },
    },
    inputTokens: 4,
    outputTokens: 1,
    costUsd: 0.0001,
  };
}

function finalAnswerProvider(content: string): LLMProvider {
  return {
    async generate() {
      return {
        role: "assistant",
        content,
        usage: { promptTokens: 10, completionTokens: 3 },
      };
    },
  };
}

function capturingProvider(captured: Message[][], content: string): LLMProvider {
  return {
    async generate(messages) {
      captured.push(structuredClone(messages));
      return {
        role: "assistant",
        content,
        usage: { promptTokens: 10, completionTokens: 3 },
      };
    },
  };
}

function runtimeRequest(workspace: string, sessionId: string, prompt: string) {
  return {
    prompt,
    dir: workspace,
    sessionSelection: { mode: "new" as const, sessionId },
    provider: "openai" as const,
    allowedTools: [] as const,
  };
}

function extractEvidenceEventId(messages: Message[]): string {
  const user = messages.find((message) => message.role === "user")?.content ?? "";
  const parsed = JSON.parse(user) as { readonly evidenceEventId?: unknown };
  assert.equal(typeof parsed.evidenceEventId, "string");
  return parsed.evidenceEventId as string;
}

function openRepository(workspace: string, picoHome: string): MemoryRepository {
  const paths = resolvePicoPaths(workspace, { picoHome });
  return new MemoryRepository({
    databasePath: paths.workspace.memoryDatabase,
    workspaceId: paths.workspace.id,
  });
}

function openJobStatus(fixture: RuntimeFixture): string | undefined {
  const repository = openRepository(fixture.workspace, fixture.picoHome);
  try {
    return repository.listJobs()[0]?.status;
  } finally {
    repository.close();
  }
}

async function waitForMemoryState<Result>(
  fixture: RuntimeFixture,
  read: (repository: MemoryRepository) => Result | undefined,
): Promise<Result> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const repository = openRepository(fixture.workspace, fixture.picoHome);
    try {
      const result = read(repository);
      if (result !== undefined) return result;
    } finally {
      repository.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for memory state");
}

async function waitForProviderCalls(fixture: RuntimeFixture, expected: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const ledger = new RuntimeStore({ workDir: fixture.workspace, picoHome: fixture.picoHome });
    try {
      if (ledger.listProviderCalls().length === expected) return;
    } finally {
      ledger.close();
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${expected} provider calls`);
}

async function flushAsyncWork(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
  await new Promise<void>((resolve) => setImmediate(resolve));
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  resolve(value: Value): void;
}

function createDeferred<Value>(): Deferred<Value> {
  let resolve = (_value: Value): void => undefined;
  const promise = new Promise<Value>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

interface RuntimeFixture {
  readonly root: string;
  readonly workspace: string;
  readonly picoHome: string;
}

async function createFixture(name: string): Promise<RuntimeFixture> {
  const root = await mkdtemp(join(tmpdir(), `pico-memory-runtime-quality-${name}-`));
  const workspace = join(root, "workspace");
  const picoHome = join(root, "pico-home");
  await Promise.all([mkdir(workspace, { recursive: true }), mkdir(picoHome, { recursive: true })]);
  return { root, workspace, picoHome };
}

async function trustWorkspaces(
  picoHome: string,
  ...workspaces: readonly string[]
): Promise<WorkspaceTrustStore> {
  const store = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  for (const workspace of workspaces) {
    await store.trust(await store.canonicalize(workspace));
  }
  return store;
}

async function closeSessions(
  sessionIds: readonly string[],
  workspaces: readonly string[],
  picoHome: string,
): Promise<void> {
  for (const [index, sessionId] of sessionIds.entries()) {
    const session = globalSessionManager.delete(sessionId, workspaces[index], { picoHome });
    await session?.close();
  }
}
