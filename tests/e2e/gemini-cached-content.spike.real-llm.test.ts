import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";

const enabled = process.env.RUN_GEMINI_CACHE_SPIKE === "1";
const geminiSpike = enabled ? test : test.skip;
const TIMEOUT_MS = 5 * 60_000;

/**
 * Native Gemini-only gate for production cachedContents. An OpenAI-compatible gateway result is
 * deliberately not evidence for this API because lifecycle semantics and wire fields differ.
 */
geminiSpike("native Gemini cachedContents lifecycle spike", { timeout: TIMEOUT_MS }, async () => {
  const baseURL = requiredEnv("GEMINI_CACHE_SPIKE_BASE_URL");
  const apiKey = requiredEnv("GEMINI_CACHE_SPIKE_API_KEY");
  const model = process.env.GEMINI_CACHE_SPIKE_MODEL?.trim() || "gemini-2.5-flash";
  const marker = `pico-gemini-native-${randomUUID()}`;
  const source = {
    model: `models/${model}`,
    systemInstruction: { parts: [{ text: isolatedCorpus(marker) }] },
    tools: [
      {
        functionDeclarations: [
          { name: "cache_probe", description: "native cached content compatibility probe", parameters: { type: "object" } },
        ],
      },
    ],
    ttl: "3600s",
  };
  const created = await nativeRequest(baseURL, apiKey, "/v1beta/cachedContents", "POST", source);
  const name = requiredString(created.body["name"], "native cachedContents create response missing name");
  try {
    assert.equal(typeof created.body["expireTime"], "string", "native cachedContents must report expireTime");
    const fetched = await nativeRequest(baseURL, apiKey, `/v1beta/${encodeURI(name)}`, "GET");
    assert.equal(fetched.status, 200);
    const generated = await nativeRequest(
      baseURL,
      apiKey,
      `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      "POST",
      { cachedContent: name, contents: [{ role: "user", parts: [{ text: "Reply exactly NATIVE_CACHE_READY." }] }] },
    );
    const usage = asRecord(generated.body["usageMetadata"]);
    assert.ok(
      typeof usage?.["cachedContentTokenCount"] === "number",
      "native Gemini generate must report cachedContentTokenCount",
    );
    const updated = await nativeRequest(baseURL, apiKey, `/v1beta/${encodeURI(name)}?updateMask=ttl`, "PATCH", {
      ttl: "3600s",
    });
    assert.equal(typeof updated.body["expireTime"], "string", "native TTL update must return expireTime");
    safeReport({
      protocol: "gemini-native",
      create: created.safe,
      get: fetched.safe,
      generate: generated.safe,
      update: updated.safe,
      nameHash: sha256(name),
    });
  } finally {
    const deleted = await nativeRequest(baseURL, apiKey, `/v1beta/${encodeURI(name)}`, "DELETE");
    assert.ok(deleted.status === 200 || deleted.status === 204, "native cachedContents delete must succeed");
    safeReport({ protocol: "gemini-native", delete: deleted.safe, nameHash: sha256(name) });
  }
});

interface SafeNativeResult {
  readonly status: number;
  readonly latencyMs: number;
  readonly body: Record<string, unknown>;
  readonly safe: Record<string, unknown>;
}

async function nativeRequest(
  baseURL: string,
  apiKey: string,
  path: string,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  payload?: Readonly<Record<string, unknown>>,
): Promise<SafeNativeResult> {
  const started = performance.now();
  const response = await fetch(`${baseURL.replace(/\/+$/u, "")}${path}`, {
    method,
    headers: {
      "x-goog-api-key": apiKey,
      ...(payload ? { "Content-Type": "application/json" } : {}),
    },
    ...(payload ? { body: JSON.stringify(payload) } : {}),
  });
  const latencyMs = Math.round(performance.now() - started);
  if (!response.ok) {
    throw new Error(`native Gemini ${method} failed; status=${response.status}; response omitted`);
  }
  const raw = response.status === 204 ? {} : ((await response.json()) as unknown);
  const body = asRecord(raw) ?? {};
  return { status: response.status, latencyMs, body, safe: { status: response.status, latencyMs, ...safeBody(body) } };
}

function safeBody(body: Record<string, unknown>): Record<string, unknown> {
  const usage = asRecord(body["usageMetadata"]);
  return {
    ...(typeof body["name"] === "string" ? { nameHash: sha256(body["name"]) } : {}),
    ...(typeof body["expireTime"] === "string" ? { expireTime: body["expireTime"] } : {}),
    ...(usage && typeof usage["cachedContentTokenCount"] === "number"
      ? { cachedContentTokenCount: usage["cachedContentTokenCount"] }
      : {}),
  };
}

function isolatedCorpus(marker: string): string {
  return Array.from({ length: 384 }, (_, index) => `${marker} stable-${index} alpha beta gamma delta epsilon zeta eta`).join(" ");
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
