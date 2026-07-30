import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  FileGeminiPromptCacheStore,
  GeminiPromptCacheController,
  MemoryGeminiPromptCacheStore,
  stableDigest,
  type GeminiPromptCacheTransport,
} from "../../src/provider/gemini-prompt-cache.js";
import { GeminiProvider } from "../../src/provider/gemini.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";

function controller(options: {
  readonly store?: MemoryGeminiPromptCacheStore | FileGeminiPromptCacheStore;
  readonly transport: GeminiPromptCacheTransport;
  readonly model?: string;
  readonly now?: () => number;
}) {
  return new GeminiPromptCacheController({
    store: options.store,
    transport: options.transport,
    baseURL: "https://gemini.example.test",
    model: options.model ?? "gemini-2.5-flash",
    ttlSeconds: 100,
    now: options.now,
  });
}

test("Gemini explicit cache persists metadata across controller restart without prompt or credential", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-gemini-cache-"));
  const path = join(root, "control", "gemini-prompt-cache.json");
  context.after(() => rm(root, { recursive: true, force: true }));
  const created: string[] = [];
  const transport: GeminiPromptCacheTransport = {
    async create() {
      const name = `cachedContents/${created.length + 1}`;
      created.push(name);
      return { name, expireAt: Date.now() + 100_000, tokenCount: 99 };
    },
    async delete() {},
  };
  const source = { systemInstruction: { parts: [{ text: "stable confidential prompt" }] } };
  const first = controller({ store: new FileGeminiPromptCacheStore(path), transport });
  assert.equal(await first.getOrCreate(source), "cachedContents/1");
  const restarted = controller({ store: new FileGeminiPromptCacheStore(path), transport });
  assert.equal(await restarted.getOrCreate(source), "cachedContents/1");
  assert.equal(created.length, 1);
  const saved = await readFile(path, "utf8");
  assert.equal(saved.includes("stable confidential prompt"), false);
  assert.equal(saved.includes("test-key"), false);
  assert.match(saved, /cachedContents\/1/);
});

test("Gemini explicit cache deduplicates concurrent create and renews below remaining 20 percent", async () => {
  let now = 1_000;
  let creates = 0;
  const deleted: string[] = [];
  const transport: GeminiPromptCacheTransport = {
    async create() {
      creates++;
      return { name: `cachedContents/${creates}`, expireAt: now + 100_000 };
    },
    async delete(name) {
      deleted.push(name);
    },
  };
  const store = new MemoryGeminiPromptCacheStore();
  const cache = controller({ store, transport, now: () => now });
  const sibling = controller({ store, transport, now: () => now });
  const source = { tools: [{ functionDeclarations: [{ name: "lookup" }] }] };
  const concurrent = await Promise.all(
    Array.from({ length: 8 }, (_, index) =>
      (index % 2 === 0 ? cache : sibling).getOrCreate(source),
    ),
  );
  assert.deepEqual(new Set(concurrent), new Set(["cachedContents/1"]));
  assert.equal(creates, 1);
  now = 82_000;
  assert.equal(await cache.getOrCreate(source), "cachedContents/2");
  assert.equal(creates, 2);
  assert.deepEqual(deleted, ["cachedContents/1"]);
  assert.equal(
    await cache.getOrCreate({ tools: [{ functionDeclarations: [{ name: "lookup_changed" }] }] }),
    "cachedContents/3",
  );
  assert.equal(creates, 3);
  assert.deepEqual(deleted, ["cachedContents/1", "cachedContents/2"]);
});

test("Gemini explicit cache separates models, removes expired metadata, and fails open on permission/delete errors", async () => {
  let now = 1_000;
  const store = new MemoryGeminiPromptCacheStore();
  let createMode: "ok" | "forbidden" = "ok";
  const deleted: string[] = [];
  const transport: GeminiPromptCacheTransport = {
    async create() {
      if (createMode === "forbidden") throw new Error("forbidden");
      return { name: `cachedContents/${deleted.length + 1}`, expireAt: now + 1_000 };
    },
    async delete(name) {
      deleted.push(name);
      throw new Error("delete forbidden");
    },
  };
  const source = { systemInstruction: { parts: [{ text: "stable" }] } };
  const flash = controller({ store, transport, now: () => now });
  const pro = controller({ store, transport, model: "gemini-2.5-pro", now: () => now });
  assert.ok(await flash.getOrCreate(source));
  now = 1_500;
  assert.ok(await pro.getOrCreate(source));
  assert.equal((await store.list()).length, 2, "model switch must not reuse a remote object");
  now = 2_100;
  createMode = "forbidden";
  assert.equal(await flash.getOrCreate(source), undefined, "permission failure must use normal request");
  assert.equal((await store.list()).length, 1, "expired local record is removed despite remote delete failure");
  assert.ok(deleted.length >= 1);
});

test("Gemini provider sends cachedContent only for explicit routes and falls back to full body", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const requests: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url, body });
    if (url.includes("cachedContents")) {
      return Response.json({
        name: "cachedContents/unit-test",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
        usageMetadata: { totalTokenCount: 42 },
      });
    }
    return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  };
  const explicit = new GeminiProvider({
    baseURL: "https://gemini.example.test",
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
      cache: true,
      promptCache: { mode: "explicit", ttl: "3600s" },
    }),
  }, undefined, { enableExplicitPromptCache: true });
  await explicit.generate(
    [{ role: "system", content: "stable system" }, { role: "user", content: "question" }],
    [{ name: "lookup", description: "stable tool", inputSchema: { type: "object" } }],
  );
  const generated = requests.at(-1)?.["body"] as Record<string, unknown>;
  assert.equal(generated["cachedContent"], "cachedContents/unit-test");
  assert.equal("system_instruction" in generated, false);
  assert.equal("tools" in generated, false);

  const cacheRequest = requests.find((request) => String(request["url"]).includes("cachedContents"));
  assert.ok(cacheRequest);
  assert.equal(String(cacheRequest["url"]).includes("test-key"), false);

  requests.length = 0;
  globalThis.fetch = async (input, init) => {
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    requests.push({ url: String(input), body });
    return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  };
  const implicit = new GeminiProvider({
    baseURL: "https://gemini.example.test",
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
      cache: true,
      promptCache: { mode: "implicit" },
    }),
  });
  await implicit.generate([{ role: "system", content: "stable system" }, { role: "user", content: "q" }], []);
  const full = requests.at(-1)?.["body"] as Record<string, unknown>;
  assert.equal("cachedContent" in full, false);
  assert.ok(full["system_instruction"]);
});

test("Gemini cachedContent rejection retries once with the complete non-cached request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const generated: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes("cachedContents")) {
      return Response.json({ name: "cachedContents/rejected", expireTime: new Date(Date.now() + 3_600_000).toISOString() });
    }
    generated.push(body);
    if (body["cachedContent"] !== undefined) return new Response("stale cached content", { status: 404 });
    return Response.json({ candidates: [{ content: { parts: [{ text: "RECOVERED" }] } }] });
  };
  const provider = new GeminiProvider({
    baseURL: "https://gemini.example.test",
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
      cache: true,
      promptCache: { mode: "explicit", ttl: "3600s" },
    }),
  }, undefined, { enableExplicitPromptCache: true });
  const response = await provider.generate(
    [{ role: "system", content: "stable system" }, { role: "user", content: "question" }],
    [],
  );
  assert.equal(response.content, "RECOVERED");
  assert.equal(generated.length, 2);
  assert.equal(generated[0]?.["cachedContent"], "cachedContents/rejected");
  assert.equal("cachedContent" in (generated[1] ?? {}), false);
  assert.ok(generated[1]?.["system_instruction"]);
});

test("Gemini explicit cachedContents remains disabled until the native production gate is enabled", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const urls: string[] = [];
  globalThis.fetch = async (input) => {
    urls.push(String(input));
    return Response.json({ candidates: [{ content: { parts: [{ text: "OK" }] } }] });
  };
  const provider = new GeminiProvider({
    baseURL: "https://gemini.example.test",
    apiKey: "test-key",
    model: "gemini-2.5-flash",
    capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
      cache: true,
      promptCache: { mode: "explicit", ttl: "3600s" },
    }),
  });
  await provider.generate([{ role: "system", content: "stable system" }, { role: "user", content: "question" }], []);
  assert.equal(urls.some((url) => url.includes("cachedContents")), false);
});

test("stable Gemini cache digest recursively normalizes object keys while preserving arrays", () => {
  assert.equal(
    stableDigest({ tools: [{ z: 1, a: { b: 2, a: 1 } }] }),
    stableDigest({ tools: [{ a: { a: 1, b: 2 }, z: 1 }] }),
  );
  assert.notEqual(stableDigest({ values: ["first", "second"] }), stableDigest({ values: ["second", "first"] }));
});
