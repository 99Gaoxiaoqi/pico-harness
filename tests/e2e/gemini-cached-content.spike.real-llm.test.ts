import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { geminiPromptCacheGateId } from "../../src/provider/gemini-prompt-cache.js";

const enabled = process.env.RUN_GEMINI_CACHE_SPIKE === "1";
const geminiSpike = enabled ? test : test.skip;
const REQUEST_TIMEOUT_MS = 45_000;
const CLEANUP_TIMEOUT_MS = 10_000;
const LIFECYCLE_REQUEST_COUNT = 16;
const TIMEOUT_MS = REQUEST_TIMEOUT_MS * LIFECYCLE_REQUEST_COUNT + CLEANUP_TIMEOUT_MS + 30_000;

/**
 * Native Gemini-only gate for production cachedContents. An OpenAI-compatible gateway result is
 * deliberately not evidence for this API because lifecycle semantics and wire fields differ.
 */
geminiSpike(
  "native Gemini cachedContents lifecycle spike",
  { timeout: TIMEOUT_MS },
  async (context) => {
    const suiteSignal = context.signal;
    const baseURL = requiredEnv("GEMINI_CACHE_SPIKE_BASE_URL");
    const apiKey = requiredEnv("GEMINI_CACHE_SPIKE_API_KEY");
    const model = process.env.GEMINI_CACHE_SPIKE_MODEL?.trim() || "gemini-2.5-flash";
    const minimumTokens = minimumCacheTokens(model);
    const marker = `pico-gemini-native-${randomUUID()}`;
    const source = {
      model: `models/${model}`,
      systemInstruction: { parts: [{ text: isolatedCorpus(marker) }] },
      tools: [
        {
          functionDeclarations: [
            {
              name: "cache_probe",
              description: "native cached content compatibility probe",
              parameters: {
                type: "object",
                properties: { marker: { type: "string" } },
                required: ["marker"],
              },
            },
          ],
        },
      ],
      toolConfig: {
        functionCallingConfig: { mode: "ANY", allowedFunctionNames: ["cache_probe"] },
      },
      ttl: "3600s",
    };
    const created = await nativeRequest(
      baseURL,
      apiKey,
      "/v1beta/cachedContents",
      "POST",
      suiteSignal,
      source,
    );
    const name = requiredString(
      created.body["name"],
      "native cachedContents create response missing name",
    );
    const nameHash = sha256(name);
    const createdTokenCount = asRecord(created.body["usageMetadata"])?.["totalTokenCount"];
    assertPositiveTokenCount(
      createdTokenCount,
      "native cachedContents create must report totalTokenCount > 0",
    );
    let cleanupSucceeded = false;
    try {
      assert.equal(
        typeof created.body["expireTime"],
        "string",
        "native cachedContents must report expireTime",
      );
      const counted = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/models/${encodeURIComponent(model)}:countTokens`,
        "POST",
        suiteSignal,
        {
          generateContentRequest: {
            model: `models/${model}`,
            cachedContent: name,
            contents: [{ role: "user", parts: [{ text: "Count the cached prefix." }] }],
          },
        },
      );
      const cachedTokenCount = counted.body["cachedContentTokenCount"];
      assert.ok(
        typeof cachedTokenCount === "number" && cachedTokenCount >= minimumTokens,
        `native cached source must contain at least ${minimumTokens} tokens for ${model}`,
      );
      const listed = await findListedCache(baseURL, apiKey, name, suiteSignal);
      assert.ok(listed, "native cachedContents list must include the newly created cache");
      const fetched = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/${encodeURI(name)}`,
        "GET",
        suiteSignal,
      );
      assert.equal(fetched.status, 200);
      assertPositiveTokenCount(
        asRecord(fetched.body["usageMetadata"])?.["totalTokenCount"],
        "native cachedContents get must report totalTokenCount > 0",
      );
      const generated = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        "POST",
        suiteSignal,
        {
          cachedContent: name,
          contents: [
            {
              role: "user",
              parts: [{ text: `Call cache_probe exactly once with marker ${marker}.` }],
            },
          ],
        },
      );
      const usage = asRecord(generated.body["usageMetadata"]);
      assertPositiveTokenCount(
        usage?.["cachedContentTokenCount"],
        "native Gemini generate must report cachedContentTokenCount > 0",
      );
      assert.equal(
        firstFunctionCallName(generated.body),
        "cache_probe",
        "native Gemini must invoke the function declaration stored in cachedContents",
      );
      const updated = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/${encodeURI(name)}?updateMask=ttl`,
        "PATCH",
        suiteSignal,
        {
          ttl: "3600s",
        },
      );
      assert.equal(
        typeof updated.body["expireTime"],
        "string",
        "native TTL update must return expireTime",
      );
      safeReport({
        protocol: "gemini-native",
        countTokens: counted.safe,
        list: listed.safe,
        create: created.safe,
        get: fetched.safe,
        generate: generated.safe,
        update: updated.safe,
        nameHash,
      });

      const deleted = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/${encodeURI(name)}`,
        "DELETE",
        suiteSignal,
      );
      assert.ok(
        deleted.status === 200 || deleted.status === 204,
        "native cachedContents delete must succeed",
      );
      cleanupSucceeded = true;
      safeReport({ protocol: "gemini-native", delete: deleted.safe, nameHash });

      const deletedGet = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/${encodeURI(name)}`,
        "GET",
        suiteSignal,
        undefined,
        true,
      );
      const deletedGenerate = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        "POST",
        suiteSignal,
        {
          cachedContent: name,
          contents: [{ role: "user", parts: [{ text: "Reply exactly DELETED_CACHE_PROBE." }] }],
        },
        true,
      );
      const deletedAgain = await nativeRequest(
        baseURL,
        apiKey,
        `/v1beta/${encodeURI(name)}`,
        "DELETE",
        suiteSignal,
        undefined,
        true,
      );
      assert.equal(deletedGet.status, 404, "GET after cachedContents delete must return 404");
      assert.ok(
        deletedGenerate.status === 400 || deletedGenerate.status === 404,
        "generateContent with a deleted cache must return 400 or 404",
      );
      assert.equal(deletedAgain.status, 404, "repeated cachedContents delete must return 404");
      safeReport({
        protocol: "gemini-native",
        deletedCacheSemantics: {
          get: safeStatus(deletedGet),
          generate: safeStatus(deletedGenerate),
          delete: safeStatus(deletedAgain),
        },
        nameHash,
        productionGateId: geminiPromptCacheGateId(baseURL, model),
      });
    } finally {
      if (!cleanupSucceeded) {
        // Cleanup deliberately does not reuse an already-aborted suite signal. It is bounded by a
        // shorter independent timeout and never masks the lifecycle failure.
        try {
          const deleted = await nativeRequest(
            baseURL,
            apiKey,
            `/v1beta/${encodeURI(name)}`,
            "DELETE",
            AbortSignal.timeout(CLEANUP_TIMEOUT_MS),
            undefined,
            true,
          );
          safeReport({ protocol: "gemini-native", cleanupDelete: deleted.safe, nameHash });
        } catch {
          safeReport({
            protocol: "gemini-native",
            cleanupDelete: { status: null, outcome: "transport_failed" },
            nameHash,
          });
        }
      }
    }
  },
);

interface SafeNativeResult {
  readonly status: number;
  readonly latencyMs: number;
  readonly body: Record<string, unknown>;
  readonly safe: Record<string, unknown>;
}

async function findListedCache(
  baseURL: string,
  apiKey: string,
  name: string,
  suiteSignal: AbortSignal,
): Promise<SafeNativeResult | undefined> {
  let pageToken: string | undefined;
  for (let page = 0; page < 20; page++) {
    const query = new URLSearchParams({ pageSize: "100" });
    if (pageToken) query.set("pageToken", pageToken);
    const result = await nativeRequest(
      baseURL,
      apiKey,
      `/v1beta/cachedContents?${query.toString()}`,
      "GET",
      suiteSignal,
    );
    const entries = Array.isArray(result.body["cachedContents"])
      ? result.body["cachedContents"]
      : [];
    if (entries.some((entry) => asRecord(entry)?.["name"] === name)) return result;
    pageToken =
      typeof result.body["nextPageToken"] === "string" && result.body["nextPageToken"]
        ? result.body["nextPageToken"]
        : undefined;
    if (!pageToken) return undefined;
  }
  throw new Error("native cachedContents list exceeded 20 pages; response omitted");
}

async function nativeRequest(
  baseURL: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  suiteSignal: AbortSignal,
  payload?: Readonly<Record<string, unknown>>,
  allowHttpError = false,
): Promise<SafeNativeResult> {
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`${normalizeBaseURL(baseURL)}${path}`, {
      method,
      headers: {
        "x-goog-api-key": apiKey,
        ...(payload ? { "Content-Type": "application/json" } : {}),
      },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: requestSignal(suiteSignal, REQUEST_TIMEOUT_MS),
    });
  } catch {
    suiteSignal.throwIfAborted();
    throw new Error(`native Gemini ${method} transport failed; request omitted`);
  }
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    if (allowHttpError) {
      return {
        status: response.status,
        latencyMs,
        body: {},
        safe: { status: response.status, latencyMs },
      };
    }
    throw new Error(`native Gemini ${method} failed; status=${response.status}; response omitted`);
  }
  const raw = response.status === 204 ? {} : await readNativeJson(response, method);
  const body = asRecord(raw) ?? {};
  return {
    status: response.status,
    latencyMs,
    body,
    safe: { status: response.status, latencyMs, ...safeBody(body) },
  };
}

function requestSignal(suiteSignal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([suiteSignal, AbortSignal.timeout(timeoutMs)]);
}

async function readNativeJson(response: Response, method: string): Promise<unknown> {
  let text: string;
  try {
    text = await response.text();
  } catch {
    throw new Error(`native Gemini ${method} response transfer failed; response omitted`);
  }
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`native Gemini ${method} returned invalid JSON; response omitted`);
  }
}

function safeStatus(result: SafeNativeResult): Readonly<Record<string, number>> {
  return { status: result.status, latencyMs: result.latencyMs };
}

function safeBody(body: Record<string, unknown>): Record<string, unknown> {
  const usage = asRecord(body["usageMetadata"]);
  return {
    ...(typeof body["name"] === "string" ? { nameHash: sha256(body["name"]) } : {}),
    ...(typeof body["expireTime"] === "string" ? { expireTime: body["expireTime"] } : {}),
    ...(typeof body["totalTokens"] === "number" ? { totalTokens: body["totalTokens"] } : {}),
    ...(typeof body["cachedContentTokenCount"] === "number"
      ? { cachedContentTokenCount: body["cachedContentTokenCount"] }
      : {}),
    ...(usage && typeof usage["cachedContentTokenCount"] === "number"
      ? { cachedContentTokenCount: usage["cachedContentTokenCount"] }
      : {}),
  };
}

function firstFunctionCallName(body: Record<string, unknown>): string | undefined {
  const candidates = Array.isArray(body["candidates"]) ? body["candidates"] : [];
  for (const candidate of candidates) {
    const content = asRecord(asRecord(candidate)?.["content"]);
    const parts = Array.isArray(content?.["parts"]) ? content.parts : [];
    for (const part of parts) {
      const call = asRecord(asRecord(part)?.["functionCall"]);
      if (typeof call?.["name"] === "string") return call.name;
    }
  }
  return undefined;
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
    throw new Error("native Gemini base URL must be HTTP(S) without credentials/query");
  }
  url.pathname = url.pathname.replace(/\/+$/u, "");
  return url.toString().replace(/\/$/u, "");
}

function isolatedCorpus(marker: string): string {
  const corpus = Array.from(
    { length: 384 },
    () => "alpha beta gamma delta epsilon zeta eta theta",
  ).join(" ");
  return `${marker} ${corpus}`;
}

function minimumCacheTokens(model: string): number {
  const configured = process.env.GEMINI_CACHE_SPIKE_MIN_TOKENS?.trim();
  if (configured) {
    const parsed = Number(configured);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      throw new Error("GEMINI_CACHE_SPIKE_MIN_TOKENS must be a positive integer");
    }
    return parsed;
  }
  const normalized = model.replace(/^models\//u, "").toLowerCase();
  if (normalized === "gemini-2.5-flash" || normalized === "gemini-2.5-pro") {
    return 2_048;
  }
  if (normalized === "gemini-3.1-pro-preview" || normalized === "gemini-3.5-flash") {
    return 4_096;
  }
  throw new Error(
    `native Gemini cache spike requires GEMINI_CACHE_SPIKE_MIN_TOKENS for model ${model}`,
  );
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`native Gemini cache spike missing ${name}`);
  return value;
}

function requiredString(value: unknown, message: string): string {
  if (typeof value !== "string" || !value) throw new Error(message);
  return value;
}

function assertPositiveTokenCount(value: unknown, message: string): asserts value is number {
  assert.ok(typeof value === "number" && Number.isFinite(value) && value > 0, message);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function safeReport(value: unknown): void {
  console.info(JSON.stringify(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
