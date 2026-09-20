import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runExperiment, summarizeExperiment } from "../../scripts/eval/experiment.js";
import type { LLMProvider, Message } from "@pico/core";
import { AgentEngine } from "@pico/pico-host/agent-engine";
import { createCodeModeTool } from "@pico/pico-host/code-mode-tool";
import { createEngineRuntimePort } from "@pico/pico-host/engine-runtime-port-adapter";
import { currentRuntimeRun } from "@pico/pico-host/product-runtime-run";
import { ToolRegistry } from "@pico/pico-host/product-tool-registry";
import { createProvider } from "@pico/pico-host/provider/factory";
import { ReadFileTool } from "@pico/pico-host/read-file-tool";
import { Session } from "@pico/pico-host/session";
import { SilentReporter } from "@pico/runtime/silent-reporter";
import { configuredUserDefaultRealModel, type RealModel } from "./real-llm-user-model.js";

// Frozen pre-guidance description: the A/B arms differ only in exec's description.
const BASELINE_DESCRIPTION = [
  "Execute one bounded JavaScript orchestration cell over tools active in this Step.",
  "Send exec alone in its assistant Step; do not combine it with other top-level calls.",
  "Call tools.<name>(object), using the tool names and input schemas shown alongside exec.",
  "Only tools explicitly enabled for nesting are callable; exec and direct-only tools are unavailable.",
  "Tool calls return their output as strings; use JSON.parse only when that tool returns JSON.",
  "Use await for dependencies and Promise.all for independent calls, then return a JSON-serializable value.",
  "The fresh sandbox has no host filesystem, process, network, timers, module imports or dynamic code generation.",
  "Limits: 30 seconds, 64 MiB memory, 64 KiB source, 1 MiB per input/output/result, 32 calls, 8 in flight.",
  "Exec requires an exclusive Step; the host admits one active cell and one waiting cell.",
  "The entire cell is never automatically retried; inspect structured failure diagnostics before any new cell.",
].join(" ");

interface Scenario {
  name: string;
  eligible: boolean;
  files: Record<string, unknown>;
  prompt: string;
  expected: unknown;
}

const scenarios: Scenario[] = [
  {
    name: "dependency-comparison",
    eligible: true,
    files: Object.fromEntries(
      ["web", "api", "worker", "admin", "docs", "cli"].map((name, index) => [
        `${name}.json`,
        { name, dependencies: { widget: index % 3 === 0 ? "2.0.0" : "1.0.0" }, notes: "fixture" },
      ]),
    ),
    prompt:
      "检查 web.json、api.json、worker.json、admin.json、docs.json、cli.json 中的 widget 依赖，找出版本不是 1.0.0 的项目。只返回 JSON 对象，projects 字段为项目名数组，按字母排序。",
    expected: { projects: ["admin", "web"] },
  },
  {
    name: "batch-filter-sum",
    eligible: true,
    files: Object.fromEntries(
      [17, 42, 8, 63, 29, 51].map((amount, index) => [
        `order-${index + 1}.json`,
        { id: index + 1, amount, status: index === 3 ? "cancelled" : "paid" },
      ]),
    ),
    prompt:
      "检查 order-1.json 到 order-6.json，统计 status 为 paid 且 amount 大于 30 的订单数量和金额总和。只返回 JSON 对象，字段为 count 和 total。",
    expected: { count: 2, total: 93 },
  },
  {
    name: "single-read",
    eligible: false,
    files: { "config.json": { timeout: 4500, retries: 3 } },
    prompt: "查看 config.json 的 timeout 值。只返回 JSON 对象，字段为 timeout。",
    expected: { timeout: 4500 },
  },
];

type Variant = "baseline" | "guided";
interface Trial {
  variant: Variant;
  scenario: string;
  eligible: boolean;
  repetition: number;
  triggered: boolean;
  success: boolean;
  steps: number;
  modelResponses: number;
  toolCalls: string[];
  physicalReads: string[];
  execSucceeded: number;
  execFailed: number;
  execEvidence: Array<{ code: string; result: unknown }>;
  elapsedMs: number;
  tokens: number | null;
  final: string;
  answerFormat: "invalid" | "json" | "json_fence" | "json_fence_with_prose";
  error?: string;
}

async function runTrial(
  model: RealModel,
  scenario: Scenario,
  variant: Variant,
  repetition: number,
  signal: AbortSignal,
): Promise<Trial> {
  const started = Date.now();
  const root = await mkdtemp(join(tmpdir(), "pico-code-selection-"));
  const workDir = join(root, "workspace");
  await mkdir(workDir);
  const runtimePort = createEngineRuntimePort();
  const session = new Session(randomUUID(), workDir, {
    persistence: true,
    picoHome: join(root, "pico-home"),
    runtimePort,
  });
  const trial: Trial = {
    variant,
    scenario: scenario.name,
    eligible: scenario.eligible,
    repetition,
    triggered: false,
    success: false,
    steps: 0,
    modelResponses: 0,
    toolCalls: [],
    physicalReads: [],
    execSucceeded: 0,
    execFailed: 0,
    execEvidence: [],
    elapsedMs: 0,
    tokens: null,
    final: "",
    answerFormat: "invalid",
  };
  try {
    for (const [path, value] of Object.entries(scenario.files)) {
      await writeFile(join(workDir, path), JSON.stringify(value, null, 2));
    }
    await session.recover();
    const registry = new ToolRegistry();
    const read = new ReadFileTool(workDir);
    const executeRead = read.execute.bind(read);
    read.execute = async (args) => {
      const result = await executeRead(args);
      const { path } = JSON.parse(args) as { path: string };
      trial.physicalReads.push(relative(workDir, resolve(workDir, path)));
      return result;
    };
    registry.register(read);
    const exec = createCodeModeTool({ registry, getRuntimeRun: currentRuntimeRun });
    if (variant === "baseline") {
      const definition = exec.definition();
      exec.definition = () => ({ ...definition, description: BASELINE_DESCRIPTION });
    }
    const executeExec = exec.execute.bind(exec);
    exec.execute = async (args, context) => {
      try {
        const result = await executeExec(args, context);
        const parsed = JSON.parse(result) as { ok: boolean };
        trial.execEvidence.push({
          code: (JSON.parse(args) as { code: string }).code,
          result: parsed,
        });
        if (parsed.ok) trial.execSucceeded++;
        else trial.execFailed++;
        return result;
      } catch (error) {
        trial.execFailed++;
        trial.execEvidence.push({
          code: (JSON.parse(args) as { code: string }).code,
          result: { error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      }
    };
    registry.register(exec);
    const actual = createProvider(model.provider, { ...model.config, sessionId: session.id });
    const responses: Message[] = [];
    let completeUsage = true;
    let tokens = 0;
    const provider: LLMProvider = {
      modelName: actual.modelName,
      requestCapabilities: actual.requestCapabilities,
      async generate(messages, tools, options) {
        trial.steps++;
        const response = await actual.generate(messages, tools, { ...options, timeoutMs: 60_000 });
        responses.push(response);
        completeUsage &&=
          response.usage !== undefined &&
          (response.usage.reportedFields === undefined ||
            (response.usage.reportedFields.includes("prompt") &&
              response.usage.reportedFields.includes("completion")));
        if (response.usage) tokens += response.usage.promptTokens + response.usage.completionTokens;
        trial.tokens = completeUsage ? tokens : null;
        trial.modelResponses++;
        for (const call of response.toolCalls ?? []) {
          trial.toolCalls.push(call.name);
          if (call.name === "exec") trial.triggered = true;
        }
        return response;
      },
    };
    const engine = new AgentEngine({
      provider,
      registry,
      workDir,
      runtimePort,
      reporter: new SilentReporter(),
      maxTurns: 10,
      // Deliberately no workflow, tool preference, or supplied code in the task prompt.
      systemPrompt: "根据工作区内的实际文件完成用户任务，准确回答，不猜测文件内容。",
    });
    await session.commitMessages({ role: "user", content: scenario.prompt });
    await engine.run(session, undefined, undefined, signal);
    trial.final = responses.at(-1)?.content ?? "";
    const finalText = trial.final.trim();
    // Assess the complete JSON answer block, not whether the model adds prose after it.
    // Keep presentation compliance observable; malformed JSON and wrong values still fail.
    const fenced = finalText.match(/^```(?:json)?\s*\n([\s\S]*?)\n```/i);
    const answer = JSON.parse(fenced ? fenced[1]! : finalText);
    trial.answerFormat = fenced
      ? finalText.slice(fenced[0].length).trim()
        ? "json_fence_with_prose"
        : "json_fence"
      : "json";
    assert.deepEqual(answer, scenario.expected);
    assert.deepEqual([...new Set(trial.physicalReads)].sort(), Object.keys(scenario.files).sort());
    trial.success = true;
  } catch (error) {
    if (trial.steps !== trial.modelResponses) trial.tokens = null;
    trial.error = error instanceof Error ? error.message : String(error);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
    trial.elapsedMs = Date.now() - started;
  }
  // Provider errors may contain request context. Never persist the resolved credential.
  return model.config.apiKey
    ? (JSON.parse(
        JSON.stringify(trial, (_key, value: unknown) =>
          typeof value === "string" ? value.split(model.config.apiKey).join("[REDACTED]") : value,
        ),
      ) as Trial)
    : trial;
}

const realModelTest = process.env.RUN_LLM_E2E === "1" ? test : test.skip;
realModelTest(
  "真实模型自主选择 Code Mode：旧提示与使用时机提示的重复对照",
  { timeout: 1_800_000 },
  async (context) => {
    const repetitions = Number(process.env.CODE_MODE_SELECTION_REPEATS ?? 5);
    assert.ok(Number.isInteger(repetitions) && repetitions >= 5 && repetitions <= 20);
    const model = await configuredUserDefaultRealModel();
    const directory =
      process.env.CODE_MODE_SELECTION_RUN_DIR ??
      join("output", "eval", `code-mode-selection-${randomUUID()}`);
    // Pin fixtures/scoring and the tool implementation without serializing provider credentials.
    const sources = await Promise.all(
      [
        new URL(import.meta.url),
        new URL("../../packages/pico-host/src/code-mode-tool.ts", import.meta.url),
      ].map((url) => readFile(fileURLToPath(url))),
    );
    const implementation = createHash("sha256").update(Buffer.concat(sources)).digest("hex");
    context.diagnostic(
      `model=${model.route.id}; repetitions=${repetitions}; run=${directory}; no forced tool choice`,
    );
    const attempts = await runExperiment<Trial>({
      directory,
      signal: context.signal,
      spec: {
        schemaVersion: 1,
        id: "code-mode-selection",
        subjects: ["baseline", "guided"],
        scenarios: scenarios.map((scenario) => scenario.name),
        repetitions,
        config: {
          implementation,
          model: model.route.id,
          provider: model.provider,
          endpointFingerprint: createHash("sha256").update(model.config.baseURL).digest("hex"),
          thinkingEffort: model.config.thinkingEffort ?? null,
          capabilities: JSON.parse(JSON.stringify(model.config.capabilities ?? null)),
        },
      },
      shouldStop: (samples) =>
        samples.length >= 2 && samples.slice(-2).every((sample) => !sample.measurement.available),
      execute: async (cell) => {
        const scenario = scenarios.find((candidate) => candidate.name === cell.scenario)!;
        const trial = await runTrial(
          model,
          scenario,
          cell.subject as Variant,
          cell.repetition,
          context.signal,
        );
        return {
          result: trial,
          measurement: {
            available: trial.modelResponses > 0,
            triggered: trial.triggered,
            success: trial.success,
            error: !trial.success || trial.execFailed > 0,
            elapsedMs: trial.elapsedMs,
            tokens: trial.tokens,
            cost: null,
          },
        };
      },
    });
    const trials = attempts.map((attempt) => attempt.result);
    const summary = (["baseline", "guided"] as const).flatMap((variant) =>
      [true, false].map((eligible) => {
        const selectedAttempts = attempts.filter(
          (attempt) => attempt.result.variant === variant && attempt.result.eligible === eligible,
        );
        const selected = selectedAttempts.map((attempt) => attempt.result);
        return {
          variant,
          eligible,
          ...summarizeExperiment(
            repetitions * scenarios.filter((scenario) => scenario.eligible === eligible).length,
            selectedAttempts,
          ),
          execFailed: selected.reduce((total, trial) => total + trial.execFailed, 0),
          answersWithExtraProse: selected.filter(
            (trial) => trial.answerFormat === "json_fence_with_prose",
          ).length,
        };
      }),
    );
    const report = {
      model: model.route.id,
      timestamp: new Date().toISOString(),
      repetitions,
      directory,
      summary,
      trials,
    };
    if (process.env.CODE_MODE_SELECTION_REPORT) {
      await writeFile(
        process.env.CODE_MODE_SELECTION_REPORT,
        JSON.stringify(report, null, 2) + "\n",
      );
    }
    context.diagnostic(JSON.stringify(summary));
    assert.equal(
      trials.length,
      repetitions * scenarios.length * 2,
      "模型连续不可用时停止采样，不报告触发率",
    );
    assert.ok(
      trials.every((trial) => trial.modelResponses > 0),
      "触发率统计要求每次试验获得模型响应",
    );
    const guided = trials.filter((trial) => trial.variant === "guided");
    assert.ok(
      guided.every((trial) => trial.success),
      "所有 guided 任务必须正确完成，失败样本不剔除",
    );
    assert.ok(
      guided.every((trial) => trial.execFailed === 0),
      "guided 不应产生 exec 执行错误",
    );
    const eligible = guided.filter((trial) => trial.eligible);
    const simple = guided.filter((trial) => !trial.eligible);
    assert.ok(
      eligible.filter((trial) => trial.triggered).length / eligible.length >= 0.8,
      "批量任务触发率至少 80%",
    );
    assert.ok(
      simple.filter((trial) => trial.triggered).length / simple.length <= 0.2,
      "单次简单操作误触发率至多 20%",
    );
  },
);
