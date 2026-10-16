import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, open, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type {
  LLMProvider,
  LLMProviderRequestOptions,
  Message,
  PreparedProviderRequest,
  ProviderPhysicalAttempt,
  ToolDefinition,
} from "@pico/core";
import {
  AtomicMemoryContextBuilder,
  AtomicMemoryLifecycle,
  countTokens,
  primeTokenizer,
} from "@pico/runtime";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { executeAgentRuntime } from "@pico/pico-host/agent-runtime";
import { createProvider } from "@pico/pico-host/provider/factory";
import { globalSessionManager } from "@pico/pico-host/session";
import { WorkspaceTrustStore } from "@pico/pico-host/workspace-trust";
import { closeExecutionLearningWorker } from "@pico/pico-host/execution-learning-worker";
import { resolvePicoPaths } from "@pico/pico-host";
import { SqliteMemoryItemStore } from "@pico/storage/sqlite/sqlite-memory-item-store";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { buildMemorySearchTool } from "@pico/pico-host/memory-trigger-tools";
import type { RealModel } from "./real-llm-user-model.js";
import {
  ComparisonBudget,
  ComparisonBudgetStop,
  comparisonPrompt,
  MEMORY_READ_CAPS,
  MEMORY_READ_GOLD_SHA,
  readComparisonCases,
  scoreComparison,
  type ComparisonCase,
} from "./memory-read-comparison-helper.js";

const enabled = process.env.RUN_LLM_E2E === "1" && process.env.RUN_MEMORY_READ_COMPARISON === "1";
const codeRoot = fileURLToPath(new URL("../../", import.meta.url));
const git = (...args: string[]) =>
  execFileSync("git", args, { cwd: codeRoot, encoding: "utf8" }).trim();
type Arm = "A" | "B";
function guardCandidate() {
  assert.match(
    process.env.PICO_MEMORY_READ_SHA ?? "",
    /^[a-f0-9]{40}$/,
    "exact candidate SHA required",
  );
  assert.equal(git("rev-parse", "HEAD"), process.env.PICO_MEMORY_READ_SHA, "candidate changed");
  assert.equal(git("status", "--porcelain"), "", "candidate must be clean before every run");
}

// Always offline: no helper/config invocation and no network/provider construction.
test("memory read comparison: frozen gold, exact scoring and all budget boundaries without credentials", async () => {
  const cases = await readComparisonCases();
  assert.equal(cases.length, 12);
  assert.deepEqual(
    cases.reduce(
      (v, c) => ({ ...v, [c.group]: (v[c.group] ?? 0) + 1 }),
      {} as Record<string, number>,
    ),
    { short: 3, long: 6, multi: 2, "no-hit": 1 },
  );
  for (const c of cases) {
    assert.ok(c.items.every((item) => Array.from(item).length <= 2000));
    assert.ok(
      scoreComparison(c, JSON.stringify({ answer: c.answer, quotes: c.requiredEvidence })).passed,
    );
  }
  await primeTokenizer();
  const prepared: PreparedProviderRequest = {
    provider: "openai",
    model: "offline",
    body: {
      messages: [{ role: "user", content: "synthetic only" }],
      tools: [{ name: "memory_read" }],
    },
  };
  const budget = new ComparisonBudget();
  assert.ok(budget.reserve("offline-1", 0, prepared) > 0);
  budget.settle({
    attemptId: "offline-1",
    attempt: 1,
    provider: "openai",
    model: "offline",
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    status: "succeeded",
    latencyMs: 0,
    usageBasis: "reported",
    usage: { promptTokens: 30, completionTokens: 6 },
  });
  assert.equal(budget.outputTokens, 6);
  assert.equal(budget.reportedInputTokens, 30);
  assert.equal(budget.reservedOutput, 0);
  const withoutUsage = new ComparisonBudget();
  withoutUsage.reserve("offline-missing-usage", 0, prepared);
  withoutUsage.settle({
    attemptId: "offline-missing-usage",
    attempt: 1,
    provider: "openai",
    model: "offline",
    startedAt: "",
    completedAt: "",
    status: "failed",
    latencyMs: 0,
    usageBasis: "missing",
  });
  assert.equal(withoutUsage.outputTokens, 1024);
  const checks: [
    string,
    (b: ComparisonBudget) => void,
    number,
    PreparedProviderRequest | undefined,
  ][] = [
    ["missing_actual_prepared_request", () => {}, 0, undefined],
    ["physical_cap", () => {}, 5, prepared],
    [
      "physical_cap",
      (b) => {
        b.physical = 120;
      },
      0,
      prepared,
    ],
    [
      "suite_input_cap",
      (b) => {
        b.chargedInputTokens = 500000;
      },
      0,
      prepared,
    ],
    [
      "suite_output_cap",
      (b) => {
        b.outputTokens = 24576;
      },
      0,
      prepared,
    ],
    ["input_per_call", () => {}, 0, { ...prepared, body: { messages: "z ".repeat(21000) } }],
  ];
  for (const [reason, setup, runCount, request] of checks) {
    const b = new ComparisonBudget();
    setup(b);
    assert.throws(
      () => b.reserve("rejected", runCount, request),
      (e: unknown) => e instanceof ComparisonBudgetStop && e.reason === reason,
    );
  }
});

async function assertBaselineCompatibility() {
  const expected = JSON.parse(
    await readFile(new URL("./memory-read-comparison-baseline.json", import.meta.url), "utf8"),
  );
  const store = new SqliteMemoryItemStore(":memory:");
  try {
    await store.applyMutations({
      operationId: "compatibility",
      mutations: [
        {
          type: "create",
          item: {
            content: "CompatTask56 stores a stable compatibility fact.",
            kind: "knowledge",
            statementType: "fact",
            temporalType: "undated",
            scopeType: "workspace",
            scopeKey: "/compat/task56",
            observedAt: 1700000000000,
            origin: "user_requested",
            keys: [{ key: "CompatTask56", keyType: "concept", keyOrigin: "user" }],
            sources: [],
          },
        },
      ],
    });
    const auto = await new AtomicMemoryContextBuilder(store, "/compat/task56").build(
      "CompatTask56",
    );
    assert.deepEqual(
      {
        search: buildMemorySearchTool({ search: async () => "" }).definition(),
        autoBlock: auto.block,
        autoTokens: auto.tokenCount,
      },
      expected.snapshot,
    );
    assert.equal(expected.baseline, "8b2b28d5edc5a72bf2b00df8676c34bab33bbe28");
  } finally {
    store.close();
  }
}
test(
  "memory read comparison: A search schema and automatic projection retain exact 8b2 baseline",
  assertBaselineCompatibility,
);

// Explicit offline opt-in runs the actual Host once, using only a local scripted provider.
(process.env.RUN_MEMORY_READ_COMPARISON_OFFLINE === "1" ? test : test.skip)(
  "memory read comparison: isolated Host instrumentation smoke, no credentials",
  { timeout: 30000 },
  async () => {
    const c = (await readComparisonCases())[0]!;
    const scripted: LLMProvider = {
      modelName: "offline",
      requestCapabilities: { physicalAttempts: true, toolChoiceNoneWithTools: true },
      async generate(messages, tools, options) {
        const prepared: PreparedProviderRequest = {
          provider: "openai",
          model: "offline",
          body: { messages, tools },
        };
        options?.onRequestPrepared?.(prepared);
        await options?.onProviderAttemptStart?.({
          physicalAttemptId: "offline-host",
          revision: 0,
          attempt: 1,
          provider: "openai",
          model: "offline",
          startedAt: new Date().toISOString(),
          status: "prepared",
          usageBasis: "missing",
        });
        const content = JSON.stringify({ answer: c.answer, quotes: c.requiredEvidence });
        options?.onProviderAttempt?.({
          attemptId: "offline-host",
          attempt: 1,
          provider: "openai",
          model: "offline",
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
          status: "succeeded",
          latencyMs: 0,
          usageBasis: "reported",
          usage: {
            promptTokens: countTokens(JSON.stringify(prepared.body)),
            completionTokens: countTokens(content),
          },
        });
        return {
          role: "assistant",
          content,
          usage: {
            promptTokens: countTokens(JSON.stringify(prepared.body)),
            completionTokens: countTokens(content),
          },
        };
      },
    };
    const toolModule = await import("@pico/pico-host/memory-trigger-tools");
    const arms: Arm[] = "buildMemoryReadTool" in toolModule ? ["A", "B"] : ["A"];
    for (const arm of arms) {
      const row = await runCase(
        c,
        arm,
        new ComparisonBudget(),
        undefined,
        scripted,
        AbortSignal.timeout(25000),
      );
      assert.equal(row.auxiliaryCalls, 0);
      assert.equal(row.physicalAttempts.length, 1);
      assert.ok(row.score?.passed);
      assert.equal(row.failure, undefined);
    }
  },
);

(enabled ? test : test.skip)(
  "real model saved-memory reader comparison: twelve frozen tasks, paired A/B; no outcome tuning",
  { timeout: 610000 },
  async (t) => {
    guardCandidate();
    await assertBaselineCompatibility();
    const readModule = await import("@pico/pico-host/memory-trigger-tools");
    assert.ok(
      "buildMemoryReadTool" in readModule,
      "candidate memory_read feature missing; no paid call authorized for this code",
    );
    const output = process.env.PICO_MEMORY_READ_OUTPUT;
    assert.ok(output && isAbsolute(output), "absolute evidence output path required");
    await mkdir(dirname(output), { recursive: true });
    // An existing evidence file is a hard stop: never silently restart a spent budget.
    const marker = await open(output, "wx");
    await marker.close();
    const cases = await readComparisonCases();
    const budget = new ComparisonBudget();
    const overall = AbortSignal.timeout(MEMORY_READ_CAPS.deadlineMs);
    const rows: Awaited<ReturnType<typeof runCase>>[] = [];
    const persist = async () => {
      await writeFile(
        output,
        JSON.stringify(
          {
            candidate: process.env.PICO_MEMORY_READ_SHA,
            goldSha256: MEMORY_READ_GOLD_SHA,
            caps: MEMORY_READ_CAPS,
            budget: budget.snapshot(),
            rows,
            pending: cases.flatMap((c) =>
              (["A", "B"] as Arm[])
                .filter((arm) => !rows.some((r) => r.caseId === c.id && r.arm === arm))
                .map((arm) => ({ caseId: c.id, arm })),
            ),
            interpretation:
              "strictExact is mechanical; primary semantic correctness requires predeclared arm-blind source-grounded review. No assertion that B wins.",
          },
          null,
          2,
        ) + "\n",
      );
      const blind = rows
        .map((r) => {
          const c = cases.find((c) => c.id === r.caseId)!;
          return {
            anonymousId: createHash("sha256")
              .update(`t56-blind:${r.caseId}:${r.arm}`)
              .digest("hex")
              .slice(0, 16),
            question: c.question,
            source: c.items,
            answer: r.answer,
            rubric:
              "Accept equivalent wording/units if every required relation, negation and effective period is correct and source-supported; do not infer missing facts. No-hit requires null. Judge independently of tool choice/cost.",
          };
        })
        .sort((a, b) => a.anonymousId.localeCompare(b.anonymousId));
      await writeFile(output + ".blind-review.json", JSON.stringify(blind, null, 2) + "\n");
    };
    await persist();
    // Only here, behind both flags + exact clean SHA + exclusive output, is user config read.
    const { configuredUserDefaultRealModel } = await import("./real-llm-user-model.js");
    const model = await configuredUserDefaultRealModel();
    assert.equal(model.route.id, model.runtime.config.defaultModelRouteId);
    assert.equal(
      model.route.id,
      "codex-oauth/gpt-5.6-luna-fast",
      "frozen user default route changed",
    );
    assert.equal(model.provider, "openai");
    assert.equal(model.config.model, "gpt-5.6-luna-fast");
    for (const [index, c] of cases.entries()) {
      const order: Arm[] = index % 2 ? ["B", "A"] : ["A", "B"];
      for (const arm of order) {
        try {
          budget.assertLive();
          overall.throwIfAborted();
          guardCandidate();
        } catch {
          await persist();
          return;
        }
        const row = await runCase(
          c,
          arm,
          budget,
          model,
          undefined,
          AbortSignal.any([overall, AbortSignal.timeout(MEMORY_READ_CAPS.runMs)]),
        );
        rows.push(row);
        await persist();
        t.diagnostic(
          JSON.stringify({
            caseId: c.id,
            arm,
            failure: row.failure ?? null,
            strictExact: row.score?.passed ?? false,
            physical: row.physicalAttempts.length,
            tools: row.toolCalls,
            durationMs: row.durationMs,
            cumulativeBudget: budget.snapshot(),
          }),
        );
        if (budget.stopped) return;
      }
    }
    assert.equal(rows.length, 24);
    assert.ok(rows.every((row) => row.auxiliaryCalls === 0));
  },
);

async function runCase(
  c: ComparisonCase,
  arm: Arm,
  budget: ComparisonBudget,
  model: RealModel | undefined,
  scripted: LLMProvider | undefined,
  signal: AbortSignal,
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pico-memory-read-comparison-")));
  const workDir = join(root, "workspace"),
    picoHome = join(root, "home");
  await mkdir(workDir);
  await mkdir(picoHome);
  const sessionId = `t56-${c.id}-${arm}`;
  const paths = resolvePicoPaths(workDir, { picoHome });
  const store = new SqliteMemoryItemStore(join(picoHome, "memory.sqlite"));
  const events = new SqliteRuntimeEventStore({ storageRoot: paths.workspace.root });
  const trust = new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const lifecycle = new AtomicMemoryLifecycle();
  const requests: { messages: Message[]; tools: ToolDefinition[] }[] = [];
  const preparedRequests: {
    provider: string;
    model: string;
    body: Readonly<Record<string, unknown>>;
    localTokens: number;
  }[] = [];
  const reservations: {
    physicalAttemptId: string;
    preparedIndex: number;
    localInputTokens: number;
  }[] = [];
  const physicalAttempts: ProviderPhysicalAttempt[] = [];
  const responses: Message[] = [];
  let runAttempts = 0,
    toolCalls = 0,
    auxiliaryCalls = 0;
  let answer = "",
    failure: string | undefined;
  let history: unknown[] = [];
  const started = performance.now();
  try {
    await trust.trust(await trust.canonicalize(workDir));
    await store.applyMutations({
      operationId: "frozen-case",
      mutations: c.items.map((content) => ({
        type: "create" as const,
        item: {
          content,
          kind: (c.group === "long" ? "note" : "knowledge") as "note" | "knowledge",
          statementType: "fact" as const,
          temporalType: "undated" as const,
          scopeType: "workspace" as const,
          scopeKey: paths.workspace.id,
          observedAt: 1700000000000,
          origin: "user_requested" as const,
          keys: [
            {
              key: c.group === "no-hit" ? "AsterTrail" : c.topic,
              keyType: "concept" as const,
              keyOrigin: "user" as const,
            },
          ],
          sources: [],
        },
      })),
    });
    const settings = await store.readSettings(paths.workspace.id);
    await store.updateSettings({
      workspaceKey: paths.workspace.id,
      expectedVersion: settings.version,
      autoExtract: false,
    });
    const original = scripted ?? createProvider(model!.provider, model!.config);
    assert.equal(
      original.requestCapabilities?.physicalAttempts,
      true,
      "physical dispatch accounting capability required",
    );
    const allowed = arm === "A" ? ["memory_search"] : ["memory_search", "memory_read"];
    const optionsFor = (
      messages: Message[],
      tools: ToolDefinition[],
      options?: LLMProviderRequestOptions,
    ): LLMProviderRequestOptions => {
      signal.throwIfAborted();
      budget.assertLive();
      assert.ok(
        tools.some((tool) => tool.name === "memory_search"),
        "actual A/B schema must expose search",
      );
      assert.equal(
        tools.some((tool) => tool.name === "memory_read"),
        arm === "B",
        "actual allowedTools arm boundary changed",
      );
      requests.push(structuredClone({ messages, tools }));
      let prepared: PreparedProviderRequest | undefined;
      return {
        ...options,
        signal: options?.signal ? AbortSignal.any([signal, options.signal]) : signal,
        timeoutMs: Math.min(options?.timeoutMs ?? 55000, 55000),
        maxOutputTokens: 1024,
        onRequestPrepared: (value) => {
          prepared = structuredClone(value);
          preparedRequests.push({
            ...prepared,
            localTokens: countTokens(JSON.stringify(prepared.body)),
          });
          options?.onRequestPrepared?.(value);
        },
        onProviderAttemptStart: async (snapshot) => {
          signal.throwIfAborted();
          const tokens = budget.reserve(snapshot.physicalAttemptId, runAttempts, prepared);
          runAttempts++;
          reservations.push({
            physicalAttemptId: snapshot.physicalAttemptId,
            preparedIndex: preparedRequests.length - 1,
            localInputTokens: tokens,
          });
          prepared = undefined;
          await options?.onProviderAttemptStart?.(snapshot);
        },
        onProviderAttempt: (attempt) => {
          physicalAttempts.push(structuredClone(attempt));
          budget.settle(attempt);
          options?.onProviderAttempt?.(attempt);
        },
      };
    };
    const observe = (message: Message) => {
      responses.push(structuredClone(message));
      toolCalls += message.toolCalls?.length ?? 0;
      if (toolCalls > 4) throw new ComparisonBudgetStop("run_tool_call_cap_before_execution");
      return message;
    };
    const provider: LLMProvider = {
      modelName: original.modelName,
      requestCapabilities: original.requestCapabilities,
      generate: async (messages, tools, options) =>
        observe(await original.generate(messages, tools, optionsFor(messages, tools, options))),
      ...(original.generateStream
        ? {
            generateStream: async (
              messages: Message[],
              tools: ToolDefinition[],
              delta: (text: string) => void,
              options?: LLMProviderRequestOptions,
            ) =>
              observe(
                await original.generateStream!(
                  messages,
                  tools,
                  delta,
                  optionsFor(messages, tools, options),
                ),
              ),
          }
        : {}),
      ...(original.isRetryableError
        ? { isRetryableError: original.isRetryableError.bind(original) }
        : {}),
    };
    const result = await executeAgentRuntime(
      {
        prompt: comparisonPrompt(c),
        dir: workDir,
        sessionSelection: { mode: "new", sessionId },
        provider: model?.provider ?? "openai",
        modelRouteId: model?.route.id ?? "offline/offline",
        model: model?.config.model ?? "offline",
        ...(model
          ? {
              baseURL: model.config.baseURL,
              apiKey: model.config.apiKey,
              modelCapabilities: model.route.capabilities,
            }
          : {}),
        allowedTools: allowed,
      },
      {
        picoHome,
        ...(model ? { modelRouter: model.runtime.router } : {}),
        provider,
        providerFactory: () => provider,
        reporter: new SilentReporter(),
        signal,
        maxTurns: 5,
        memoryTrustStore: trust,
        atomicMemoryLifecycle: lifecycle,
        executionLearningWorkerOptions: { idleMs: 600000, pollMs: 600000 },
        atomicMemoryModelFactory: async () => ({
          model: {
            call: async () => {
              auxiliaryCalls++;
              throw new Error("Auxiliary model forbidden");
            },
          },
        }),
      },
    );
    answer = result.finalMessage;
    assert.equal(auxiliaryCalls, 0);
  } catch (error) {
    // Never persist SDK messages/causes, URLs, credentials or provider config.
    failure =
      error instanceof ComparisonBudgetStop
        ? error.reason
        : error instanceof assert.AssertionError
          ? error.message.split("\n")[0]
          : error instanceof Error
            ? error.name
            : "UnknownError";
  } finally {
    try {
      history = await events.readSession(sessionId);
    } catch {
      /* partial failure remains evidence */
    }
    await lifecycle.close();
    await closeExecutionLearningWorker(picoHome);
    await globalSessionManager.delete(sessionId, workDir, { picoHome })?.close();
    events.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
  return {
    caseId: c.id,
    group: c.group,
    arm,
    answer,
    failure,
    score: scoreComparison(c, answer),
    toolCalls,
    auxiliaryCalls,
    durationMs: performance.now() - started,
    requests,
    preparedRequests,
    reservations,
    physicalAttempts,
    localPreparedInputTokens: reservations.reduce((sum, value) => sum + value.localInputTokens, 0),
    providerUsage: {
      promptTokens: physicalAttempts.reduce(
        (sum, value) => sum + (value.usage?.promptTokens ?? 0),
        0,
      ),
      completionTokens: physicalAttempts.reduce(
        (sum, value) => sum + (value.usage?.completionTokens ?? 0),
        0,
      ),
      missingOrPartialAttempts: physicalAttempts.filter((value) => value.usageBasis !== "reported")
        .length,
      note: "Missing/partial usage prevents an actual-cost acceptance claim; local prepared JSON tokens remain a separate estimate.",
    },
    responses,
    history,
  };
}
