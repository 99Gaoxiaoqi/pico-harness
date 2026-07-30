import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

const RUN_GATEWAY_CACHE_E2E = process.env.RUN_GATEWAY_CACHE_E2E === "1";
const gatewayTest = RUN_GATEWAY_CACHE_E2E ? test : test.skip;
const TIMEOUT_MS = 5 * 60_000;
const models = ["gpt-5.6-terra", "claude-sonnet-4-6", "gemini-2.5-flash"] as const;

gatewayTest(
  "gateway OpenAI-compatible models expose isolated implicit prompt-cache cold/warm/control results",
  { timeout: TIMEOUT_MS },
  async () => {
    const baseURL = requiredEnv("GATEWAY_CACHE_E2E_BASE_URL");
    const apiKey = requiredEnv("GATEWAY_CACHE_E2E_API_KEY");
    const discovered = await listModels(baseURL, apiKey);
    for (const model of models) {
      assert.ok(discovered.has(model), `gateway /models missing required model ${model}`);
    }
    const matrix = await protocolMatrix(baseURL, apiKey);
    // This suite intentionally uses only the OpenAI-compatible column. Native protocol probes are
    // reported safely but never treated as Claude/Gemini prompt-cache verification.
    assert.equal(
      matrix.openaiChat.available,
      true,
      "gateway OpenAI-compatible chat endpoint is unavailable",
    );

    for (const model of models) {
      let scenario: GatewayScenario;
      try {
        scenario = await runModelScenario(baseURL, apiKey, model);
      } catch (error) {
        if (!(error instanceof GatewayTransportError)) throw error;
        // A transport failure may leave an ambiguous partial sequence. Restart the complete
        // scenario once with a fresh marker; never retry an individual warm/control request.
        scenario = await runModelScenario(baseURL, apiKey, model);
      }
      safeReport({ model, protocol: "openai", matrix, ...scenario });
    }

    // A gateway may reject provider-specific experimental fields. This is a capability probe only.
    const explicit = await probeExplicitFields(baseURL, apiKey);
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
}

interface ProtocolProbe {
  readonly available: boolean;
  readonly status: number | null;
}

interface ProtocolMatrix {
  readonly openaiChat: ProtocolProbe;
  readonly anthropicMessages: ProtocolProbe;
  readonly geminiGenerateContent: ProtocolProbe;
}

class GatewayTransportError extends Error {}

async function listModels(baseURL: string, apiKey: string): Promise<Set<string>> {
  const response = await fetch(`${normalizeBaseURL(baseURL)}/models`, { headers: auth(apiKey) });
  assert.equal(response.ok, true, `gateway /models failed with status ${response.status}`);
  const body = (await response.json()) as { data?: Array<{ id?: unknown }> };
  return new Set(
    body.data?.flatMap((item) => (typeof item.id === "string" ? [item.id] : [])) ?? [],
  );
}

async function protocolMatrix(baseURL: string, apiKey: string): Promise<ProtocolMatrix> {
  const root = normalizeBaseURL(baseURL);
  const nativeRoot = root.endsWith("/v1") ? root.slice(0, -3) : root;
  // Execute sequentially so one opt-in test never creates concurrent paid requests.
  const openaiChat = await protocolProbe(`${root}/chat/completions`, {
    method: "POST",
    headers: { ...auth(apiKey), "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-5.6-terra",
      messages: [{ role: "user", content: "Reply PROBE." }],
      max_tokens: 1,
    }),
  });
  const anthropicMessages = await protocolProbe(`${root}/messages`, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "Reply PROBE." }],
      max_tokens: 1,
    }),
  });
  const geminiGenerateContent = await protocolProbe(
    `${nativeRoot}/v1beta/models/gemini-2.5-flash:generateContent`,
    {
      method: "POST",
      headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: "Reply PROBE." }] }],
        generationConfig: { maxOutputTokens: 1 },
      }),
    },
  );
  return {
    openaiChat,
    anthropicMessages,
    geminiGenerateContent,
  };
}

async function protocolProbe(url: string, init: RequestInit): Promise<ProtocolProbe> {
  try {
    const response = await fetch(url, init);
    await response.body?.cancel().catch(() => undefined);
    return { available: response.ok, status: response.status };
  } catch {
    return { available: false, status: null };
  }
}

async function runModelScenario(
  baseURL: string,
  apiKey: string,
  model: (typeof models)[number],
): Promise<GatewayScenario> {
  const marker = `gateway-cache-${model}-${randomUUID()}`;
  const stable = isolatedCorpus(marker);
  const cold = await chat(baseURL, apiKey, model, stable, "Reply with exactly COLD_READY.");
  const warm = await chat(baseURL, apiKey, model, stable, "Reply with exactly WARM_READY.");
  const changed = await chat(
    baseURL,
    apiKey,
    model,
    `${marker}-changed\n${stable}`,
    "Reply with exactly CONTROL_READY.",
  );
  assertUsage(cold, `${model} cold`);
  assertUsage(warm, `${model} warm`);
  assertUsage(changed, `${model} control`);
  assert.ok(warm.cachedTokens > 0, `${model} warm request must report cached_tokens > 0`);
  assert.ok(
    changed.cachedTokens < warm.cachedTokens,
    `${model} changed-prefix control must read fewer cached tokens than warm request`,
  );

  const sameTools = toolSchema("stable cache probe");
  const toolCold = await chat(baseURL, apiKey, model, stable, "Reply TOOL_COLD.", sameTools);
  const toolWarm = await chat(baseURL, apiKey, model, stable, "Reply TOOL_WARM.", sameTools);
  const toolChanged = await chat(
    baseURL,
    apiKey,
    model,
    stable,
    "Reply TOOL_CHANGED.",
    toolSchema("changed cache probe"),
  );
  assertUsage(toolCold, `${model} tool cold`);
  assertUsage(toolWarm, `${model} tool warm`);
  assertUsage(toolChanged, `${model} tool changed`);
  assert.ok(toolWarm.cachedTokens > 0, `${model} repeated identical tool schema must cache`);
  assert.ok(
    toolChanged.cachedTokens < toolWarm.cachedTokens,
    `${model} changed tool schema must reduce cached tokens`,
  );
  return { cold, warm, changed, toolCold, toolWarm, toolChanged };
}

async function chat(
  baseURL: string,
  apiKey: string,
  model: string,
  stable: string,
  question: string,
  tools?: readonly Record<string, unknown>[],
  extra?: Readonly<Record<string, unknown>>,
): Promise<GatewayResult> {
  const body = {
    model,
    messages: [
      { role: "system", content: stable },
      { role: "user", content: question },
    ],
    max_tokens: 16,
    ...(tools ? { tools } : {}),
    ...extra,
  };
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseURL(baseURL)}/chat/completions`, {
      method: "POST",
      headers: { ...auth(apiKey), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new GatewayTransportError(
      `gateway transport failed for model ${model}; request content and credentials omitted`,
    );
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) {
    throw new Error(
      `gateway chat failed for model ${model}; status=${response.status}; response omitted`,
    );
  }
  const parsed = (await response.json()) as {
    usage?: { prompt_tokens?: unknown; prompt_tokens_details?: { cached_tokens?: unknown } };
  };
  return {
    status: response.status,
    latencyMs,
    promptHash: sha256(JSON.stringify({ model, stable, question, tools, extra })),
    promptTokens:
      typeof parsed.usage?.prompt_tokens === "number" ? parsed.usage.prompt_tokens : null,
    cachedTokens:
      typeof parsed.usage?.prompt_tokens_details?.cached_tokens === "number"
        ? parsed.usage.prompt_tokens_details.cached_tokens
        : 0,
  };
}

async function probeExplicitFields(
  baseURL: string,
  apiKey: string,
): Promise<{
  readonly promptCacheKey: ExplicitFieldProbe;
  readonly promptCacheBreakpoint: ExplicitFieldProbe;
}> {
  const promptCacheKey = await probeExplicitField(baseURL, apiKey, {
    prompt_cache_key: `pico-cache-probe-${randomUUID()}`,
  });
  const promptCacheBreakpoint = await probeExplicitField(baseURL, apiKey, {
    prompt_cache_breakpoint: true,
  });
  return { promptCacheKey, promptCacheBreakpoint };
}

interface ExplicitFieldProbe {
  readonly supported: boolean;
  readonly status?: number;
  readonly result?: GatewayResult;
}

async function probeExplicitField(
  baseURL: string,
  apiKey: string,
  field: Readonly<Record<string, unknown>>,
): Promise<ExplicitFieldProbe> {
  try {
    const result = await chat(
      baseURL,
      apiKey,
      "gpt-5.6-terra",
      isolatedCorpus(randomUUID()),
      "Reply KEY_READY.",
      undefined,
      field,
    );
    return { supported: true, result };
  } catch (error) {
    const status = /status=(\d{3})/u.exec(error instanceof Error ? error.message : "")?.[1];
    return { supported: false, ...(status ? { status: Number(status) } : {}) };
  }
}

function isolatedCorpus(marker: string): string {
  // About 3,072 whitespace tokens; marker makes cross-run cache hits impossible.
  return Array.from(
    { length: 384 },
    (_, index) => `${marker} cache-token-${index} alpha beta gamma delta epsilon zeta eta`,
  ).join(" ");
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

function auth(apiKey: string): HeadersInit {
  return { Authorization: `Bearer ${apiKey}` };
}

function normalizeBaseURL(value: string): string {
  return value.replace(/\/+$/u, "");
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`gateway cache E2E missing ${name}`);
  return value;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
