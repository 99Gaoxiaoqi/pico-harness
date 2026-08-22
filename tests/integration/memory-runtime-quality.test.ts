import assert from "node:assert/strict";
import { SqliteRuntimeEventStore } from "../../src/storage/sqlite/sqlite-runtime-event-store.js";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SilentReporter } from "../../src/engine/reporter.js";
import { globalSessionManager } from "../../src/engine/session.js";
import { SqliteMemoryRepository } from "../../src/storage/sqlite/sqlite-memory-repository.js";
import {
  MEMORY_PROPOSAL_JOB_TYPE,
  type MemoryProposalExtractionRequest,
  type MemoryProposalExtractionResult,
  type MemoryProposalModelPort,
} from "../../src/memory/proposal-contracts.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import {
  executeAgentRuntime,
  type RunAgentProviderFactory,
} from "../../src/runtime/agent-runtime.js";
import type { Message } from "../../src/schema/message.js";
import { WorkspaceTrustStore } from "../../src/security/workspace-trust.js";
import { SqliteRuntimeControlStore } from "../../src/storage/sqlite/sqlite-runtime-control-store.js";

const MEMORY_CANARY = "npm run reviewed-memory-canary";

test("accepted Session A memory reaches Session B AgentRuntime prompt but not another workspace", async () => {
  const fixture = await createFixture("cross-session");
  const otherWorkspace = join(fixture.root, "other-workspace");
  await mkdir(otherWorkspace, { recursive: true });
  const trustStore = await trustWorkspaces(fixture.picoHome, fixture.workspace, otherWorkspace);
  const sessionIds = ["quality-memory-a", "quality-memory-b", "quality-memory-other"];
  let reviewCalls = 0;

  try {
    // 本测试走人工评审流：默认 autoCommit=true 会把干净提案直接 accept，
    // 关掉以获得 pending 提案供手动 resolve。
    const settingsRepository = openRepository(fixture.workspace, fixture.picoHome);
    const initialSettings = settingsRepository.getSettings();
    settingsRepository.updateSettings({
      expectedVersion: initialSettings.version,
      autoCommit: false,
      idempotencyKey: "quality-cross-session-manual-review",
    });
    settingsRepository.close();
    await executeAgentRuntime(
      runtimeRequest(
        fixture.workspace,
        sessionIds[0]!,
        `请记住：这个项目固定使用 ${MEMORY_CANARY} 验证记忆。`,
        { allowMemoryTrigger: true },
      ),
      {
        picoHome: fixture.picoHome,
        memoryTrustStore: trustStore,
        provider: finalAnswerProvider("session A complete"),
        memoryProposalModelFactory: () => ({
          model: successfulReviewModel(() => reviewCalls++),
        }),
        memoryReviewDebounceMs: 0,
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
    assert.doesNotMatch(sessionBPrompts[0]?.[0]?.content ?? "", new RegExp(MEMORY_CANARY, "u"));
    assert.match(
      currentVisibleUserContent(sessionBPrompts[0] ?? []),
      new RegExp(MEMORY_CANARY, "u"),
    );

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
    assert.equal(currentVisibleUserContent(otherPrompts[0] ?? []).includes(MEMORY_CANARY), false);
    // Session A 自身评审恰好一次（候选一律由模型生成，ffca119e）；
    // Session B（autoPropose=false）与其他工作区不得再触发评审。
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
      // 记忆关闭时触发器工具不注册，模型单趟直答
      expectedMainCalls: 1,
    },
    {
      name: "autoPropose=false",
      settings: { autoPropose: false },
      expectedRecall: true,
      expectedReviewCalls: 0,
      expectedJobs: 0,
      // 调度器不建（autoPropose=false），触发器工具不注册，单趟直答
      expectedMainCalls: 1,
    },
    {
      name: "injectionEnabled=false",
      settings: { injectionEnabled: false },
      expectedRecall: false,
      // 注入关闭只 gate 召回，不 gate 评审：job 正常走完（succeeded 必然调过模型）
      expectedReviewCalls: 1,
      expectedJobs: 1,
      // 调度器在（enabled+autoPropose）：模型先举手 memory_extract 再回终稿，两趟
      expectedMainCalls: 2,
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
            { allowMemoryTrigger: settingCase.expectedJobs > 0 },
          ),
          {
            picoHome: fixture.picoHome,
            memoryTrustStore: trustStore,
            provider: {
              async generate(messages, tools) {
                mainCalls++;
                prompts.push(structuredClone(messages));
                // 模拟真实模型：memory_extract 可用时先举手（模型工具触发门控）
                if (
                  mainCalls === 1 &&
                  tools?.some((tool) => tool.name === "memory_extract") === true
                ) {
                  return {
                    role: "assistant",
                    content: "",
                    toolCalls: [
                      { id: "memory-settings-trigger", name: "memory_extract", arguments: "{}" },
                    ],
                  };
                }
                return { role: "assistant", content: "foreground complete" };
              },
            },
            memoryProposalModelFactory: () => ({
              model: emptyReviewModel(() => reviewCalls++),
            }),
            memoryReviewDebounceMs: 0,
            reporter: new SilentReporter(),
          },
        );
        assert.equal(mainCalls, settingCase.expectedMainCalls);
        assert.equal(prompts[0]?.[0]?.content.includes(MEMORY_CANARY), false);
        assert.equal(
          currentVisibleUserContent(prompts[0] ?? []).includes(MEMORY_CANARY),
          settingCase.expectedRecall,
        );

        if (settingCase.expectedJobs > 0) {
          await waitForMemoryState(fixture, (current) =>
            current.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.status === "succeeded"
              ? true
              : undefined,
          );
        } else {
          await flushAsyncWork();
        }
        assert.equal(reviewCalls, settingCase.expectedReviewCalls);
        const inspection = openRepository(fixture.workspace, fixture.picoHome);
        assert.equal(
          inspection.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE }).length,
          settingCase.expectedJobs,
        );
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
  let streamCalls = 0;
  const streamingProvider: LLMProvider = {
    async generate() {
      throw new Error("streaming provider must use generateStream");
    },
    async generateStream(_messages, _tools, onDelta) {
      streamCalls++;
      if (streamCalls === 1) {
        // 模型先举手 memory_extract（模型工具触发门控），工具结果回来后第二趟再流式终稿
        onDelta("stream");
        onDelta("ed");
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "memory-streaming-trigger", name: "memory_extract", arguments: "{}" }],
        };
      }
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
        "请记住：本项目固定使用前面提到的 npm run stream-memory 流程。",
        { allowMemoryTrigger: true },
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
        memoryReviewDebounceMs: 0,
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
      repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.status === "succeeded"
        ? true
        : undefined,
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
        "请记住：本项目固定使用前面提到的 npm run failing-review 流程。",
        { allowMemoryTrigger: true },
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
        memoryReviewDebounceMs: 0,
        reporter: new SilentReporter(),
      },
    );
    assert.equal(result.finalMessage, "foreground survived");
    await waitForMemoryState(fixture, (repository) =>
      repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.status === "failed"
        ? true
        : undefined,
    );
    assert.equal(reviewCalls, 1);
    const paths = resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome });
    const eventStore = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
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
  let generateCalls = 0;
  const providerFactory: RunAgentProviderFactory = () => {
    providerInstances++;
    return {
      async generate(_messages, tools) {
        // 评审模型路径：ADR 26 后 review 调用 tools=[]，靠提取 prompt 识别；
        // 提案 JSON 作为 content 返回（inline 哲学）。
        if (isMemoryReviewRequest(_messages)) {
          return {
            role: "assistant",
            content: JSON.stringify({
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
            usage: { promptTokens: 40, completionTokens: 20 },
          };
        }
        // 主对话：memory_extract 可用时先举手（模型工具触发门控），再回终稿
        generateCalls++;
        if (generateCalls === 1 && tools.some((tool) => tool.name === "memory_extract")) {
          return {
            role: "assistant",
            content: "",
            toolCalls: [{ id: "quality-priced-trigger", name: "memory_extract", arguments: "{}" }],
            usage: { promptTokens: 100, completionTokens: 50 },
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
          "请记住：这个项目固定使用前面提到的 npm run priced-review 流程。",
          { allowMemoryTrigger: true },
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
        memoryReviewDebounceMs: 0,
        reporter: new SilentReporter(),
      },
    );
    const session = globalSessionManager.get(sessionId, fixture.workspace, {
      picoHome: fixture.picoHome,
    });
    assert.ok(session);
    const usageBeforeReview = structuredClone(session.getRuntimeStateSnapshot().usage);

    await waitForMemoryState(fixture, (repository) =>
      repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.status === "succeeded"
        ? true
        : undefined,
    );
    await waitForProviderCalls(fixture, 3);
    const usageAfterReview = session.getRuntimeStateSnapshot().usage;
    assert.deepEqual(usageAfterReview, usageBeforeReview);
    // 模型举手 memory_extract 的工具往返是主对话正常两趟
    assert.equal(usageAfterReview.totalProviderCalls, 2);

    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace
        .root,
    });
    try {
      const calls = ledger.listProviderCalls();
      assert.equal(calls.length, 3);
      assert.deepEqual(calls.map((call) => call.purpose).sort(), ["main", "main", "memory_review"]);
      assert.equal(calls.filter((call) => call.purpose === "main").length, 2);
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
  // ADR 26 工具结果全文 inline：提案 JSON 作为 assistant content 返回，不走 toolCall 形状。
  return {
    response: {
      role: "assistant",
      content: JSON.stringify({
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
      content: JSON.stringify({ proposals: [] }),
      usage: { promptTokens: 4, completionTokens: 1 },
    },
    inputTokens: 4,
    outputTokens: 1,
    costUsd: 0.0001,
  };
}

function finalAnswerProvider(content: string): LLMProvider {
  // 记忆调度门控为模型工具触发（memory_extract 举手，ffca119e）：
  // 模拟真实模型——看到 memory_extract 工具且对话含"请记住"时先举手，再回终稿。
  let calls = 0;
  return {
    async generate(_messages, tools) {
      calls++;
      if (calls === 1 && tools?.some((tool) => tool.name === "memory_extract") === true) {
        return {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "memory-quality-trigger", name: "memory_extract", arguments: "{}" }],
        };
      }
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

function currentVisibleUserContent(messages: readonly Message[]): string {
  return (
    messages.findLast(
      (message) =>
        message.role === "user" &&
        message.toolCallId === undefined &&
        message.providerData?.["picoHiddenFromTranscript"] !== true,
    )?.content ?? ""
  );
}

function runtimeRequest(
  workspace: string,
  sessionId: string,
  prompt: string,
  options: { readonly allowMemoryTrigger?: boolean } = {},
) {
  return {
    prompt,
    dir: workspace,
    sessionSelection: { mode: "new" as const, sessionId },
    provider: "openai" as const,
    modelRouteId: "test/test",
    // 记忆门控为模型工具触发（ffca119e）：记忆场景须放行触发器工具，
    // 与 e2e memory-behavior 的 allowedTools 口径一致。
    // 注意命令级 allowlist 对未注册工具 fail-fast：仅调度器会存在的场景才放行
    //（enabled/autoPropose=false 时工具不注册，须传空）。
    allowedTools: (options.allowMemoryTrigger ? ["memory_extract"] : []) as readonly string[],
  };
}

function isMemoryReviewRequest(messages: readonly Message[]): boolean {
  // ADR 26 后评审调用 tools=[]，请求末尾是提取 prompt + evidence JSON。
  const last = messages.at(-1);
  return last?.role === "user" && last.content.includes("Extract only stable workspace facts");
}

function extractEvidenceEventId(messages: Message[]): string {
  // evidence JSON 附在提取 prompt 之后（prompt 与 JSON 以空行分隔）
  const last = messages.at(-1);
  const payload = last?.role === "user" ? (last.content.split("\n\n").at(-1) ?? "") : "";
  const parsed = JSON.parse(payload) as { readonly evidenceEventId?: unknown };
  assert.equal(typeof parsed.evidenceEventId, "string");
  return parsed.evidenceEventId as string;
}

function openRepository(workspace: string, picoHome: string): SqliteMemoryRepository {
  const paths = resolvePicoPaths(workspace, { picoHome });
  return new SqliteMemoryRepository({
    storageRoot: paths.workspace.root,
    workspaceId: paths.workspace.id,
  });
}

function openJobStatus(fixture: RuntimeFixture): string | undefined {
  const repository = openRepository(fixture.workspace, fixture.picoHome);
  try {
    return repository.listJobs({ type: MEMORY_PROPOSAL_JOB_TYPE })[0]?.status;
  } finally {
    repository.close();
  }
}

async function waitForMemoryState<Result>(
  fixture: RuntimeFixture,
  read: (repository: SqliteMemoryRepository) => Result | undefined,
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
    const ledger = new SqliteRuntimeControlStore({
      storageRoot: resolvePicoPaths(fixture.workspace, { picoHome: fixture.picoHome }).workspace
        .root,
    });
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
