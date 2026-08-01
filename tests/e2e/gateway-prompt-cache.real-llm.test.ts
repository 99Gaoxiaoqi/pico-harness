import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  capturePreparedProviderRequest,
  diagnosePreparedProviderRequest,
  type PreparedRequestCacheBreakpointChangeReason,
  type PreparedRequestCacheBreakpointLayer,
  type PreparedRequestCapture,
  type PreparedRequestChangeReason,
  type PreparedRequestDiagnostic,
} from "../../src/observability/provider-request-diagnostics.js";

const RUN_GATEWAY_CACHE_E2E = process.env.RUN_GATEWAY_CACHE_E2E === "1";
const gatewayTest = RUN_GATEWAY_CACHE_E2E ? test : test.skip;
const PROTOCOL_PROBE_TIMEOUT_MS = 15_000;
const REQUEST_TIMEOUT_MS = 30_000;
const models = ["gpt-5.6-terra", "claude-sonnet-4-6"] as const;
const MODEL_SCENARIO_REQUEST_COUNT = 6;
const MAX_MODEL_SCENARIO_RUNS = 2;
const EXPLICIT_FIELD_PROBE_COUNT = 2;
const PROTOCOL_PROBE_COUNT = 2;
const TIMEOUT_MS =
  REQUEST_TIMEOUT_MS *
    (1 +
      models.length * MODEL_SCENARIO_REQUEST_COUNT * MAX_MODEL_SCENARIO_RUNS +
      EXPLICIT_FIELD_PROBE_COUNT) +
  PROTOCOL_PROBE_TIMEOUT_MS * PROTOCOL_PROBE_COUNT +
  30_000;

gatewayTest(
  "gateway OpenAI-compatible models expose isolated implicit prompt-cache cold/warm/control results",
  { timeout: TIMEOUT_MS },
  async (context) => {
    const suiteSignal = context.signal;
    const baseURL = requiredEnv("GATEWAY_CACHE_E2E_BASE_URL");
    const apiKey = requiredEnv("GATEWAY_CACHE_E2E_API_KEY");
    const discovered = await listModels(baseURL, apiKey, suiteSignal);
    for (const model of models) {
      assert.ok(discovered.has(model), `gateway /models missing required model ${model}`);
    }
    const matrix = await protocolMatrix(baseURL, apiKey, suiteSignal);
    // This suite intentionally uses only the OpenAI-compatible column. The native Anthropic probe
    // is reported safely but never treated as Claude prompt-cache verification.
    assert.equal(
      matrix.openaiChat.available,
      true,
      "gateway OpenAI-compatible chat endpoint is unavailable",
    );

    for (const model of models) {
      suiteSignal.throwIfAborted();
      let scenario: GatewayScenario;
      try {
        scenario = await runModelScenario(baseURL, apiKey, model, suiteSignal);
      } catch (error) {
        suiteSignal.throwIfAborted();
        if (!(error instanceof GatewayTransportError)) throw error;
        // A transport failure may leave an ambiguous partial sequence. Restart the complete
        // scenario once with a fresh marker; never retry an individual warm/control request.
        scenario = await runModelScenario(baseURL, apiKey, model, suiteSignal);
      }
      safeReport({ model, protocol: "openai", matrix, ...scenario });
    }

    // A gateway may reject provider-specific experimental fields. This is a capability probe only.
    suiteSignal.throwIfAborted();
    const explicit = await probeExplicitFields(baseURL, apiKey, suiteSignal);
    safeReport({ model: "gpt-5.6-terra", protocol: "openai", explicit });
  },
);

interface GatewayResult {
  readonly status: number;
  readonly latencyMs: number;
  readonly promptHash: string;
  readonly promptTokens: number | null;
  readonly cachedTokens: number;
}

interface GatewayScenario {
  readonly cold: GatewayResult;
  readonly warm: GatewayResult;
  readonly changed: GatewayResult;
  readonly toolCold: GatewayResult;
  readonly toolWarm: GatewayResult;
  readonly toolChanged: GatewayResult;
  readonly toolPrefixDiagnostics: {
    readonly cold: SafePrefixDiagnostic;
    readonly warm: SafePrefixDiagnostic;
    readonly descriptionChanged: SafePrefixDiagnostic;
  };
}

interface GatewayCall {
  readonly result: GatewayResult;
  readonly capture: PreparedRequestCapture;
}

interface SafePrefixLayerDiagnostic {
  readonly layer: PreparedRequestCacheBreakpointLayer;
  readonly hash: string;
  readonly bytes: number;
  readonly changeReason: PreparedRequestCacheBreakpointChangeReason;
}

interface SafePrefixDiagnostic {
  readonly changeReason: PreparedRequestChangeReason;
  readonly firstChangedLayer: PreparedRequestCacheBreakpointLayer | null;
  readonly layers: readonly SafePrefixLayerDiagnostic[];
}

interface ProtocolProbe {
  readonly available: boolean;
  readonly status: number | null;
}

interface ProtocolMatrix {
  readonly openaiChat: ProtocolProbe;
  readonly anthropicMessages: ProtocolProbe;
}

class GatewayTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayTransportError";
  }
}

class GatewayHttpError extends Error {
  constructor(
    readonly status: number,
    readonly rejectedPromptCacheFields: readonly PromptCacheField[],
  ) {
    super(`gateway HTTP request failed; status=${status}; response omitted`);
    this.name = "GatewayHttpError";
  }
}

async function listModels(
  baseURL: string,
  apiKey: string,
  suiteSignal: AbortSignal,
): Promise<Set<string>> {
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseURL(baseURL)}/models`, {
      headers: auth(apiKey),
      signal: requestSignal(suiteSignal, REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new GatewayTransportError("gateway /models transport failed; request omitted");
  }
  assert.equal(response.ok, true, `gateway /models failed with status ${response.status}`);
  const body = (await readJson(response, "gateway /models")) as {
    data?: Array<{ id?: unknown }>;
  };
  return new Set(
    body.data?.flatMap((item) => (typeof item.id === "string" ? [item.id] : [])) ?? [],
  );
}

async function protocolMatrix(
  baseURL: string,
  apiKey: string,
  suiteSignal: AbortSignal,
): Promise<ProtocolMatrix> {
  const root = normalizeBaseURL(baseURL);
  // Execute sequentially so one opt-in test never creates concurrent paid requests.
  const openaiChat = await protocolProbe(
    `${root}/chat/completions`,
    {
      method: "POST",
      headers: { ...auth(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "gpt-5.6-terra",
        messages: [{ role: "user", content: "Reply PROBE." }],
        max_tokens: 16,
      }),
    },
    suiteSignal,
  );
  const anthropicMessages = await protocolProbe(
    `${root}/messages`,
    {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        messages: [{ role: "user", content: "Reply PROBE." }],
        max_tokens: 16,
      }),
    },
    suiteSignal,
  );
  return {
    openaiChat,
    anthropicMessages,
  };
}

async function protocolProbe(
  url: string,
  init: RequestInit,
  suiteSignal: AbortSignal,
): Promise<ProtocolProbe> {
  try {
    const response = await fetch(url, {
      ...init,
      signal: requestSignal(suiteSignal, PROTOCOL_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => undefined);
    return { available: response.ok, status: response.status };
  } catch {
    suiteSignal.throwIfAborted();
    return { available: false, status: null };
  }
}

async function runModelScenario(
  baseURL: string,
  apiKey: string,
  model: (typeof models)[number],
  suiteSignal: AbortSignal,
): Promise<GatewayScenario> {
  const marker = `gateway-cache-${model}-${randomUUID()}`;
  const stable = isolatedCorpus(marker);
  const coldCall = await chat(
    baseURL,
    apiKey,
    model,
    stable,
    "Reply with exactly COLD_READY.",
    suiteSignal,
  );
  const warmCall = await chat(
    baseURL,
    apiKey,
    model,
    stable,
    "Reply with exactly WARM_READY.",
    suiteSignal,
  );
  const changedCall = await chat(
    baseURL,
    apiKey,
    model,
    `${marker}-changed\n${stable}`,
    "Reply with exactly CONTROL_READY.",
    suiteSignal,
  );
  const { result: cold } = coldCall;
  const { result: warm } = warmCall;
  const { result: changed } = changedCall;
  assertUsage(cold, `${model} cold`);
  assertUsage(warm, `${model} warm`);
  assertUsage(changed, `${model} control`);
  assert.ok(warm.cachedTokens > 0, `${model} warm request must report cached_tokens > 0`);
  assert.ok(
    changed.cachedTokens < warm.cachedTokens,
    `${model} changed-prefix control must read fewer cached tokens than warm request`,
  );

  const sameTools = toolSchema("stable cache probe");
  const toolColdCall = await chat(
    baseURL,
    apiKey,
    model,
    stable,
    "Reply TOOL_COLD.",
    suiteSignal,
    sameTools,
  );
  const toolWarmCall = await chat(
    baseURL,
    apiKey,
    model,
    stable,
    "Reply TOOL_WARM.",
    suiteSignal,
    sameTools,
  );
  const toolChangedCall = await chat(
    baseURL,
    apiKey,
    model,
    stable,
    "Reply TOOL_CHANGED.",
    suiteSignal,
    toolSchema("changed cache probe"),
  );
  const { result: toolCold } = toolColdCall;
  const { result: toolWarm } = toolWarmCall;
  const { result: toolChanged } = toolChangedCall;
  assertUsage(toolCold, `${model} tool cold`);
  assertUsage(toolWarm, `${model} tool warm`);
  assertUsage(toolChanged, `${model} tool changed`);
  assert.ok(toolWarm.cachedTokens > 0, `${model} repeated identical tool schema must cache`);
  assert.ok(
    toolChanged.cachedTokens < toolWarm.cachedTokens,
    `${model} changed tool schema must reduce cached tokens`,
  );
  const toolPrefixDiagnostics = {
    cold: safePrefixDiagnostic(diagnosePreparedProviderRequest(toolColdCall.capture)),
    warm: safePrefixDiagnostic(
      diagnosePreparedProviderRequest(toolWarmCall.capture, toolColdCall.capture),
    ),
    descriptionChanged: safePrefixDiagnostic(
      diagnosePreparedProviderRequest(toolChangedCall.capture, toolWarmCall.capture),
    ),
  };
  assertStableToolPrefix(toolPrefixDiagnostics.cold, toolPrefixDiagnostics.warm, model);
  assert.equal(
    toolPrefixDiagnostics.descriptionChanged.firstChangedLayer,
    "tools",
    `${model} changed tool description must first change the tools prefix layer`,
  );
  assert.equal(
    toolPrefixDiagnostics.descriptionChanged.layers.find(({ layer }) => layer === "tools")
      ?.changeReason,
    "changed",
    `${model} changed tool description must change the tools prefix hash`,
  );
  return {
    cold,
    warm,
    changed,
    toolCold,
    toolWarm,
    toolChanged,
    toolPrefixDiagnostics,
  };
}

async function chat(
  baseURL: string,
  apiKey: string,
  model: string,
  stable: string,
  question: string,
  suiteSignal: AbortSignal,
  tools?: readonly Record<string, unknown>[],
  cacheProbe?: ChatCacheProbe,
): Promise<GatewayCall> {
  const systemContent = cacheProbe?.explicitBreakpoint
    ? [
        {
          type: "text",
          text: stable,
          prompt_cache_breakpoint: { mode: "explicit" },
        },
      ]
    : stable;
  const body = {
    model,
    messages: [
      { role: "system", content: systemContent },
      { role: "user", content: "Stable cache probe history turn." },
      { role: "assistant", content: "Stable cache probe history acknowledgement." },
      { role: "user", content: question },
    ],
    max_tokens: 16,
    ...(tools ? { tools } : {}),
    ...(cacheProbe?.key ? { prompt_cache_key: cacheProbe.key } : {}),
    ...(cacheProbe?.explicitBreakpoint
      ? { prompt_cache_options: { mode: "explicit", ttl: "30m" } }
      : {}),
  };
  const capture = capturePreparedProviderRequest({
    provider: "openai",
    model,
    body,
  });
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseURL(baseURL)}/chat/completions`, {
      method: "POST",
      headers: { ...auth(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: requestSignal(suiteSignal, REQUEST_TIMEOUT_MS),
    });
  } catch {
    suiteSignal.throwIfAborted();
    throw new GatewayTransportError(
      `gateway transport failed for model ${model}; request content and credentials omitted`,
    );
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) {
    const errorBody = await readText(response, `gateway chat error for model ${model}`);
    throw new GatewayHttpError(
      response.status,
      rejectedFields(response.status, errorBody, cacheProbe?.expectedField),
    );
  }
  const parsed = (await readJson(response, `gateway chat success for model ${model}`)) as {
    usage?: { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  };
  return {
    capture,
    result: {
      status: response.status,
      latencyMs,
      promptHash: sha256(JSON.stringify({ model, stable, question, tools, cacheProbe })),
      promptTokens:
        typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : null,
      cachedTokens:
        typeof parsed.usage?.prompt_tokens_details?.cached_tokens === "number"
          ? parsed.usage.prompt_tokens_details.cached_tokens
          : 0,
    },
  };
}

async function probeExplicitFields(
  baseURL: string,
  apiKey: string,
  suiteSignal: AbortSignal,
): Promise<{
  readonly promptCacheKey: ExplicitFieldProbe;
  readonly promptCacheBreakpoint: ExplicitFieldProbe;
}> {
  const promptCacheKey = await probeExplicitField(baseURL, apiKey, suiteSignal, {
    key: `pico-cache-probe-${randomUUID()}`,
    expectedField: "prompt_cache_key",
  });
  const promptCacheBreakpoint = await probeExplicitField(baseURL, apiKey, suiteSignal, {
    explicitBreakpoint: true,
    expectedField: "prompt_cache_breakpoint",
  });
  return { promptCacheKey, promptCacheBreakpoint };
}

type PromptCacheField = "prompt_cache_key" | "prompt_cache_breakpoint";

interface ChatCacheProbe {
  readonly key?: string;
  readonly explicitBreakpoint?: boolean;
  readonly expectedField: PromptCacheField;
}

interface ExplicitFieldProbe {
  readonly state: "accepted" | "rejected" | "inconclusive";
  readonly status?: number;
  readonly result?: GatewayResult;
}

async function probeExplicitField(
  baseURL: string,
  apiKey: string,
  suiteSignal: AbortSignal,
  cacheProbe: ChatCacheProbe,
): Promise<ExplicitFieldProbe> {
  try {
    const call = await chat(
      baseURL,
      apiKey,
      "gpt-5.6-terra",
      isolatedCorpus(randomUUID()),
      "Reply KEY_READY.",
      suiteSignal,
      undefined,
      cacheProbe,
    );
    return { state: "accepted", status: call.result.status, result: call.result };
  } catch (error) {
    suiteSignal.throwIfAborted();
    if (
      error instanceof GatewayHttpError &&
      (error.status === 400 || error.status === 422) &&
      error.rejectedPromptCacheFields.includes(cacheProbe.expectedField)
    ) {
      return { state: "rejected", status: error.status };
    }
    return {
      state: "inconclusive",
      ...(error instanceof GatewayHttpError ? { status: error.status } : {}),
    };
  }
}

function safePrefixDiagnostic(diagnostic: PreparedRequestDiagnostic): SafePrefixDiagnostic {
  const comparisons = diagnostic.cacheBreakpointComparisons ?? [];
  const firstChangedLayer = comparisons.find(
    ({ changeReason }) =>
      changeReason === "changed" || changeReason === "added" || changeReason === "removed",
  )?.layer;
  const layers = comparisons.flatMap(({ layer, changeReason, current }) =>
    current
      ? [
          {
            layer,
            hash: current.hash,
            bytes: current.bytes,
            changeReason,
          },
        ]
      : [],
  );
  return {
    changeReason: diagnostic.changeReason,
    firstChangedLayer: firstChangedLayer ?? null,
    layers,
  };
}

function assertStableToolPrefix(
  cold: SafePrefixDiagnostic,
  warm: SafePrefixDiagnostic,
  model: string,
): void {
  const expectedLayers: readonly PreparedRequestCacheBreakpointLayer[] = [
    "tools",
    "tools+system",
    "history",
  ];
  assert.deepEqual(
    cold.layers.map(({ layer }) => layer),
    expectedLayers,
    `${model} tool cold request must expose all cache prefix layers`,
  );
  assert.deepEqual(
    warm.layers.map(({ layer }) => layer),
    expectedLayers,
    `${model} tool warm request must expose all cache prefix layers`,
  );
  assert.equal(warm.firstChangedLayer, null, `${model} identical tool schema must keep its prefix`);
  for (const layer of expectedLayers) {
    const coldLayer = cold.layers.find((item) => item.layer === layer);
    const warmLayer = warm.layers.find((item) => item.layer === layer);
    assert.ok(coldLayer);
    assert.ok(warmLayer);
    assert.equal(
      warmLayer.changeReason,
      "stable",
      `${model} identical tool schema must keep ${layer} stable`,
    );
    assert.equal(
      warmLayer.hash,
      coldLayer.hash,
      `${model} identical tool schema must keep ${layer} hash stable`,
    );
  }
}

function isolatedCorpus(marker: string): string {
  // Marker appears once: repeating a UUID can multiply billed tokens under subword tokenizers.
  const corpus = Array.from(
    { length: 384 },
    () => "alpha beta gamma delta epsilon zeta eta theta",
  ).join(" ");
  return `${marker} ${corpus}`;
}

function toolSchema(description: string): readonly Record<string, unknown>[] {
  return [
    {
      type: "function",
      function: {
        name: "cache_probe",
        description,
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    },
  ];
}

function assertUsage(result: GatewayResult, label: string): void {
  assert.notEqual(result.promptTokens, null, `${label} must return prompt usage`);
}

function safeReport(value: unknown): void {
  // Deliberately only serializable metrics/hashes reach test output; never response bodies or headers.
  console.info(JSON.stringify(value));
}

function requestSignal(suiteSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([suiteSignal, AbortSignal.timeout(timeoutMs)]);
}

async function readJson(response: Response, label: string): Promise<unknown> {
  const text = await readText(response, label);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} returned invalid JSON; response omitted`);
  }
}

async function readText(response: Response, label: string): Promise<string> {
  try {
    return await response.text();
  } catch {
    throw new GatewayTransportError(`${label} response transfer failed; response omitted`);
  }
}

function rejectedFields(
  status: number,
  errorBody: string,
  expectedField: PromptCacheField | undefined,
): readonly PromptCacheField[] {
  if ((status !== 400 && status !== 422) || expectedField === undefined) return [];
  const namesExpectedField =
    expectedField === "prompt_cache_key"
      ? /\bprompt_cache_key\b/iu.test(errorBody)
      : /\bprompt_cache_(?:breakpoint|options)\b/iu.test(errorBody);
  return namesExpectedField ? [expectedField] : [];
}

function auth(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

function normalizeBaseURL(value: string): string {
  const url = new URL(value);
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error("gateway cache E2E base URL must be an HTTP(S) URL without credentials/query");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`gateway cache E2E missing ${name}`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
