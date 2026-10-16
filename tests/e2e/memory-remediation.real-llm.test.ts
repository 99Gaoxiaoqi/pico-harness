import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  LLMProvider,
  LLMProviderRequestOptions,
  MemoryItemWrite,
  Message,
  TaskExperienceCandidate,
  TaskExperienceObservation,
  TaskExperienceTask,
  ToolDefinition,
} from "@pico/core";
import { AtomicMemoryLifecycle, countTokens } from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { globalSessionManager } from "@pico/pico-host/session";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { getOrCreateSessionSettings } from "@pico/pico-host/input/session-settings";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEvent } from "@pico/storage/runtime-event";
import { configuredUserDefaultRealModel, type RealModel } from "./real-llm-user-model.js";

// This is eight controlled Host runs, not natural-learning or broad model-quality evidence.
// No config/credential is read unless both opt-ins and the exact candidate SHA guard pass.
const enabled = process.env.RUN_LLM_E2E === "1" && process.env.RUN_MEMORY_REMEDIATION === "1";
const realTest = enabled ? test : test.skip;
const scenarios = ["continue", "new-topic", "cancelled", "compare-methods"] as const;
type Scenario = (typeof scenarios)[number];
// The initial authorized suite used four physical dispatches for the two passing
// comparison runs. A failed-only continuation reserves those calls permanently.
const failedOnly = process.env.RUN_MEMORY_REMEDIATION_FAILED_ONLY === "1";
const selectedScenarios = failedOnly
  ? scenarios.filter((scenario) => scenario !== "compare-methods")
  : scenarios;
const priorAttempts = failedOnly ? 4 : 0;
const MAX_RUNS = selectedScenarios.length * 2;
const MAX_ATTEMPTS = 24;
const MAX_ATTEMPTS_PER_RUN = 3;
const MAX_INPUT_TOKENS = 20_000;
const MAX_OUTPUT_TOKENS = 2_048;

realTest(
  `bounded memory remediation acceptance: ${failedOnly ? "failed boundary scenarios only" : "four controlled scenarios"}, two repetitions`,
  { timeout: 520_000 },
  async (t) => {
    const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
    const sha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: codeRoot,
      encoding: "utf8",
    }).trim();
    assert.match(
      process.env.PICO_MEMORY_REMEDIATION_SHA ?? "",
      /^[a-f0-9]{40}$/,
      "an exact final candidate SHA is required",
    );
    assert.equal(
      sha,
      process.env.PICO_MEMORY_REMEDIATION_SHA,
      "candidate changed; do not spend against a different revision",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], { cwd: codeRoot, encoding: "utf8" }).trim(),
      "",
      "real-model acceptance requires a clean candidate",
    );
    const model = await configuredUserDefaultRealModel();
    const overall = new AbortController();
    const timer = setTimeout(
      () => overall.abort(new Error("Eight-run acceptance deadline reached")),
      480_000,
    );
    t.after(() => clearTimeout(timer));
    let attempts = priorAttempts;
    let runs = 0;
    const failures: string[] = [];
    for (const scenario of selectedScenarios)
      for (const repetition of [1, 2]) {
        overall.signal.throwIfAborted();
        assert.ok(runs < MAX_RUNS);
        runs++;
        let runAttempts = 0;
        const runStartedAt = Date.now();
        const signal = AbortSignal.any([overall.signal, AbortSignal.timeout(60_000)]);
        const fixture = await makeFixture(model, scenario, repetition, signal, async () => {
          signal.throwIfAborted();
          assert.ok(attempts < MAX_ATTEMPTS, "suite physical dispatch allowance exhausted");
          assert.ok(
            runAttempts < MAX_ATTEMPTS_PER_RUN,
            "run physical dispatch allowance exhausted",
          );
          attempts++;
          runAttempts++;
        });
        try {
          const outcome = await fixture.run();
          const result = await fixture.verify(outcome.finalMessage);
          t.diagnostic(
            JSON.stringify({
              sha,
              scenario,
              repetition,
              routeId: model.route.id,
              durationMs: Date.now() - runStartedAt,
              priorAttempts,
              cumulativeAttempts: attempts,
              runAttempts,
              ...result,
            }),
          );
        } catch (error) {
          // Do not forward SDK/provider messages, causes, request bodies, URLs or credential objects.
          failures.push(
            `${scenario}/${repetition}: ${error instanceof assert.AssertionError ? error.message.split("\n")[0] : error instanceof Error ? error.name : "UnknownError"}`,
          );
          t.diagnostic(
            JSON.stringify({
              sha,
              scenario,
              repetition,
              runAttempts,
              durationMs: Date.now() - runStartedAt,
              priorAttempts,
              cumulativeAttempts: attempts,
              ...fixture.diagnostics(),
              status: "failed",
            }),
          );
        } finally {
          await fixture.close();
        }
      }
    assert.equal(runs, MAX_RUNS);
    assert.ok(attempts <= MAX_ATTEMPTS);
    t.diagnostic(
      JSON.stringify({
        sha,
        failedOnly,
        runs,
        priorAttempts,
        physicalAttemptsThisRun: attempts - priorAttempts,
        cumulativeAttempts: attempts,
        physicalCap: MAX_ATTEMPTS,
      }),
    );
    assert.deepEqual(failures, [], "failed runs are reported, never rerun or used to tune gold");
  },
);

async function makeFixture(
  model: RealModel,
  scenario: Scenario,
  repetition: number,
  signal: AbortSignal,
  admit: () => Promise<void>,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-memory-remediation-real-")));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  const sessionId = `acceptance-${scenario}-${repetition}`;
  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const lifecycle = new AtomicMemoryLifecycle();
  const requests: Message[][] = [];
  let auxiliaryCalls = 0;
  const marker = `Recall${randomUUID().replaceAll("-", "")}`;
  const markers = [
    `MethodA${randomUUID().replaceAll("-", "")}`,
    `MethodB${randomUUID().replaceAll("-", "")}`,
  ];
  const task =
    "CedarRecallTopic 帮我读取这个专题的记忆代号；只输出代号，没有信息则回答 UNKNOWN，不要猜测。";
  const firstPrompt =
    scenario === "compare-methods"
      ? '只作对比，不采用、不执行任何方法：必须调用 memory_search，query为 "CedarCompareTopic"，比较其中两条独立合格方法。只输出JSON对象，键为A和B，值分别是两条方法原文中的A标签和B标签。不要把检索或复述说成采用。'
      : scenario === "new-topic"
        ? "换个完全无关的话题，不需要记忆或旧任务。只输出 NEW_TASK_OK。"
        : "继续";
  await trust.trust(await trust.canonicalize(workDir));
  const item = (content: string): MemoryItemWrite => ({
    content,
    kind: "knowledge",
    statementType: "fact",
    temporalType: "undated",
    scopeType: "workspace",
    scopeKey: paths.workspace.id,
    observedAt: Date.now(),
    origin: "user_requested",
    keys: [{ key: "CedarRecallTopic", keyType: "concept", keyOrigin: "user" }],
    sources: [],
  });
  if (scenario !== "compare-methods") {
    await store.applyMutations({
      operationId: "frozen-fact",
      mutations: [{ type: "create", item: item(`CedarRecallTopic 的专题代号是 ${marker}。`) }],
    });
    await events.initializeSession({ sessionId, workDir });
    const fence = await events.advanceOwnerFence(sessionId, 0);
    const base = {
      schemaVersion: 2 as const,
      sessionId,
      runId: "controlled-prior-run",
      invocationId: "controlled-prior-run",
      turnId: "controlled-prior-turn",
      at: new Date().toISOString(),
      partial: false,
      visibility: "model" as const,
    };
    const history: RuntimeEvent[] = [
      {
        ...base,
        eventId: "controlled-start",
        kind: "run.started",
        data: { workDir, agentSwarmAuthorization: "none" },
      },
      {
        ...base,
        eventId: "controlled-input",
        kind: "message.committed",
        data: { message: { role: "user", content: task } },
      },
      {
        ...base,
        eventId: "controlled-terminal",
        kind: "run.terminal",
        data: { status: scenario === "cancelled" ? "cancelled" : "completed" },
      },
    ];
    for (const event of history) await events.append(event, { ownerFence: fence });
    // A resumable Host session needs durable settings/boundary as well as events.
    // Use the same public Session persistence path as a real initial Host run;
    // endpoint/credential data remain process-local in the existing model router.
    const lease = await globalSessionManager.getOrCreatePinned(sessionId, workDir, {
      picoHome,
      persistence: true,
      runtimePort: createEngineRuntimePort(),
    });
    try {
      getOrCreateSessionSettings(
        {
          sessionId,
          cwd: workDir,
          picoHome,
          provider: model.provider,
          model: model.config.model,
          modelRouteId: model.route.id,
        },
        { persistence: lease.session },
      );
      await lease.session.flushPersistence();
      assert.ok(lease.session.getRuntimeStateSnapshot().settings);
    } finally {
      lease.release();
    }
    assert.ok(
      !history.some(
        (event) =>
          event.kind === "message.committed" && event.data.message.content.includes(marker),
      ),
      "the old conversation must not reveal the answer",
    );
  } else {
    await seedMethod(store, paths.workspace.id, workDir, "A", markers[0]!);
    await seedMethod(store, paths.workspace.id, workDir, "B", markers[1]!);
  }
  // Controlled historical methods are seeded through the public write/review protocol first.
  // Disable extraction before any Host/model run; fixture construction itself makes no model call.
  const settings = await store.readSettings(paths.workspace.id);
  await store.updateSettings({
    workspaceKey: paths.workspace.id,
    expectedVersion: settings.version,
    autoExtract: false,
  });
  const original = createProvider(model.provider, model.config);
  const boundedOptions = (
    messages: Message[],
    tools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): LLMProviderRequestOptions => {
    assert.ok(
      countTokens(JSON.stringify({ messages, tools })) <= MAX_INPUT_TOKENS,
      "fixture input allowance exceeded before dispatch",
    );
    requests.push(structuredClone(messages));
    return {
      ...options,
      signal: options?.signal ? AbortSignal.any([options.signal, signal]) : signal,
      timeoutMs: Math.min(options?.timeoutMs ?? 55_000, 55_000),
      maxOutputTokens: Math.min(options?.maxOutputTokens ?? MAX_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS),
      onProviderAttemptStart: async (snapshot) => {
        await admit();
        await options?.onProviderAttemptStart?.(snapshot);
      },
    };
  };
  const provider: LLMProvider = {
    modelName: original.modelName!,
    requestCapabilities: original.requestCapabilities!,
    generate: (messages, tools, options) =>
      original.generate(messages, tools, boundedOptions(messages, tools, options)),
    ...(original.generateStream
      ? {
          generateStream: (
            messages: Message[],
            tools: ToolDefinition[],
            delta: (text: string) => void,
            options?: LLMProviderRequestOptions,
          ) =>
            original.generateStream!(
              messages,
              tools,
              delta,
              boundedOptions(messages, tools, options),
            ),
        }
      : {}),
    ...(original.isRetryableError
      ? { isRetryableError: original.isRetryableError.bind(original) }
      : {}),
  };
  return {
    diagnostics: () => ({ logicalCalls: requests.length, auxiliaryCalls }),
    run: () =>
      executeAgentRuntime(
        {
          prompt: firstPrompt,
          dir: workDir,
          sessionSelection: { mode: scenario === "compare-methods" ? "new" : "resume", sessionId },
          provider: model.provider,
          modelRouteId: model.route.id,
          baseURL: model.config.baseURL,
          apiKey: model.config.apiKey,
          model: model.config.model,
          modelCapabilities: model.route.capabilities,
          allowedTools: scenario === "compare-methods" ? ["memory_search"] : [],
        },
        {
          picoHome,
          modelRouter: model.runtime.router,
          provider,
          providerFactory: () => provider,
          reporter: new SilentReporter(),
          signal,
          maxTurns: 2,
          memoryTrustStore: trust,
          atomicMemoryLifecycle: lifecycle,
          executionLearningWorkerOptions: { idleMs: 600_000, pollMs: 600_000 },
          atomicMemoryModelFactory: async () => ({
            model: {
              call: async () => {
                auxiliaryCalls++;
                throw new Error("Auxiliary calls are forbidden during bounded acceptance");
              },
            },
          }),
        },
      ),
    verify: async (answer: string) => {
      assert.equal(auxiliaryCalls, 0);
      const history = await events.readSession(sessionId);
      if (scenario === "continue") {
        assert.ok(
          requests[0]?.some((message) => message.content.includes(marker)),
          "continued task memory was not sent in the first real request",
        );
        assert.equal(answer.trim(), marker, "continued answer must come from the synthetic memory");
      } else if (scenario === "compare-methods") {
        assert.deepEqual(JSON.parse(answer.trim()), { A: markers[0], B: markers[1] });
        assert.ok(
          history.some(
            (event) => event.kind === "tool.started" && event.data.toolName === "memory_search",
          ),
          "comparison skipped active search",
        );
        assert.ok(
          requests.some((messages) =>
            messages.some(
              (message) =>
                message.toolCallId && markers.every((value) => message.content.includes(value)),
            ),
          ),
          "both independent methods must reach a real model through a tool result",
        );
        const reuse = await store.taskExperiences.listTaskExperienceReuse(
          paths.workspace.id,
          sessionId,
        );
        assert.ok(
          reuse.every((record) => record.adoption !== "observed"),
          "comparison cannot count as adoption",
        );
        const uses = await store.experienceLedger.queryExperienceUses(paths.workspace.id, {
          sessionId,
          limit: 100,
        });
        assert.ok(
          uses.uses.every((record) => record.adoption !== "observed"),
          "reference delivery cannot count as adoption",
        );
      } else {
        assert.ok(
          requests.every((messages) =>
            messages.every((message) => !message.content.includes(marker)),
          ),
          "old task memory crossed a topic/cancellation boundary",
        );
        assert.ok(!answer.includes(marker));
        if (scenario === "new-topic") assert.equal(answer.trim(), "NEW_TASK_OK");
      }
      return { status: "passed", logicalCalls: requests.length, auxiliaryCalls };
    },
    close: async () => {
      await lifecycle.close();
      await closeExecutionLearningWorker(picoHome);
      await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
      events.close();
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function seedMethod(
  store: SqliteMemoryItemStore,
  workspaceKey: string,
  workDir: string,
  label: string,
  marker: string,
) {
  const now = Date.now();
  const id = `controlled-${label}`;
  const settings = await store.readSettings(workspaceKey);
  const epoch = await store.executionLearning.advanceExecutionLearningInput(workspaceKey);
  const source = {
    sessionId: `source-${label}`,
    runId: `source-run-${label}`,
    turnId: "source-turn",
    eventId: `source-input-${label}`,
  };
  const task: TaskExperienceTask = {
    taskId: id,
    taskVersion: 1,
    workspaceKey,
    workDir,
    sessionId: source.sessionId,
    runId: source.runId,
    goal: "CedarCompareTopic 历史方法比较",
    goalSource: source,
    coverage: "complete",
    throughSequence: 2,
    createdAt: now,
    updatedAt: now,
  };
  await store.taskExperiences.saveTaskExperienceTask(task);
  const observations: TaskExperienceObservation[] = [
    {
      observationId: `${id}-input`,
      taskId: id,
      taskVersion: 1,
      kind: "user-input",
      source,
      sequence: 1,
      summary: "用户要求保存以供比较，不代表以后采用。",
      correction: true,
      coverage: "complete",
      createdAt: now,
    },
    {
      observationId: `${id}-result`,
      taskId: id,
      taskVersion: 1,
      kind: "tool-result",
      source: { ...source, eventId: `${id}-result` },
      sequence: 2,
      summary: "历史输出有明确标签。",
      status: "succeeded",
      toolName: "document.query",
      coverage: "complete",
      createdAt: now,
    },
  ];
  await store.taskExperiences.appendTaskExperienceObservations(task, observations);
  const candidate: TaskExperienceCandidate = {
    candidateId: id,
    kind: "task-lesson",
    lifecycleState: "active",
    taskId: id,
    taskVersion: 1,
    workspaceKey,
    workDir,
    sessionId: source.sessionId,
    runId: source.runId,
    failureKey: id,
    inputEpoch: epoch.inputEpoch,
    settingsVersion: settings.version,
    deletionRevision: await store.readDeletionRevision(),
    state: "waiting",
    goal: task.goal,
    content: "",
    contentVersion: 1,
    recordRevision: 1,
    review: "unneeded",
    validation: "unknown",
    enabled: false,
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: observations.map((record) => record.source),
    observationIds: observations.map((record) => record.observationId),
    createdAt: now,
    updatedAt: now,
  };
  await store.taskExperiences.createTaskExperienceCandidate(candidate);
  const job = await store.executionLearning.claimExecutionLearningJob(
    "controlled-fixture",
    now + 1,
    60_000,
  );
  assert.ok(job);
  const completed = await store.taskExperiences.completeTaskExperienceJob({
    job,
    expectedRecordRevision: 1,
    content: `CedarCompareTopic 的${label}方法标签是 ${marker}。这是供比较的历史建议，不代表已采用或当前已验证。`,
    representation: "method",
    matchHints: ["CedarCompareTopic"],
    requiredConditions: [],
    applicability: { taskFamily: "general", toolNames: [], conditions: [] },
    sources: candidate.sources,
    now: now + 2,
  });
  assert.ok(completed);
  await store.taskExperiences.reviewTaskExperience({
    workspaceKey,
    candidateId: completed.candidateId,
    expectedRecordRevision: completed.recordRevision,
    expectedContentVersion: completed.contentVersion,
    operationId: `approve-${id}`,
    action: "accept",
    now: now + 3,
  });
}
