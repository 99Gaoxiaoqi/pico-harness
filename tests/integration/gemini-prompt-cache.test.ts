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
  type GeminiPromptCacheStore,
  type GeminiPromptCacheTransport,
} from "../../src/provider/gemini-prompt-cache.js";
import { GeminiProvider } from "../../src/provider/gemini.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";

function controller(options: {
  readonly store?: GeminiPromptCacheStore;
  readonly transport: GeminiPromptCacheTransport;
  readonly model?: string;
  readonly createFailureCooldownMs?: number;
  readonly now?: () => number;
}) {
  return new GeminiPromptCacheController({
    store: options.store,
    transport: options.transport,
    baseURL: "https://gemini.example.test",
    model: options.model ?? "gemini-2.5-flash",
    ttlSeconds: 100,
    createFailureCooldownMs: options.createFailureCooldownMs,
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
  assert.deepEqual(await first.getOrCreate(source), {
    name: "cachedContents/1",
    cacheWriteTokens: 99,
  });
  const restarted = controller({ store: new FileGeminiPromptCacheStore(path), transport });
  assert.deepEqual(await restarted.getOrCreate(source), { name: "cachedContents/1" });
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
  assert.deepEqual(
    new Set(concurrent.map((result) => result?.name)),
    new Set(["cachedContents/1"]),
  );
  assert.equal(creates, 1);
  now = 82_000;
  assert.equal((await cache.getOrCreate(source))?.name, "cachedContents/2");
  assert.equal(creates, 2);
  assert.deepEqual(deleted, ["cachedContents/1"]);
  assert.equal(
    (
      await cache.getOrCreate({
        tools: [{ functionDeclarations: [{ name: "lookup_changed" }] }],
      })
    )?.name,
    "cachedContents/3",
  );
  assert.equal(creates, 3);
  assert.deepEqual(deleted, ["cachedContents/1"], "a new revision must preserve the old revision");
  assert.equal((await store.list()).length, 2);
  assert.equal((await cache.getOrCreate(source))?.name, "cachedContents/2");
});

test("Gemini renewal preserves the still-valid cache when replacement creation fails", async () => {
  let now = 1_000;
  let creates = 0;
  const deleted: string[] = [];
  const store = new MemoryGeminiPromptCacheStore();
  const cache = controller({
    store,
    now: () => now,
    transport: {
      async create() {
        creates++;
        if (creates > 1) throw new Error("renewal unavailable");
        return { name: "cachedContents/still-valid", expireAt: now + 100_000 };
      },
      async delete(name) {
        deleted.push(name);
      },
    },
  });
  const source = { systemInstruction: { parts: [{ text: "stable" }] } };
  assert.equal((await cache.getOrCreate(source))?.name, "cachedContents/still-valid");

  now = 82_000;
  assert.equal((await cache.getOrCreate(source))?.name, "cachedContents/still-valid");
  assert.equal((await store.list())[0]?.name, "cachedContents/still-valid");
  assert.deepEqual(deleted, []);
});

test("Gemini renewal updates TTL in place when the native transport supports PATCH", async () => {
  let now = 1_000;
  let creates = 0;
  let updates = 0;
  const store = new MemoryGeminiPromptCacheStore();
  const cache = controller({
    store,
    now: () => now,
    transport: {
      async create() {
        creates++;
        return { name: "cachedContents/renewed", expireAt: now + 100_000 };
      },
      async updateTtl(name, ttlSeconds) {
        updates++;
        assert.equal(name, "cachedContents/renewed");
        assert.equal(ttlSeconds, 100);
        return { expireAt: now + ttlSeconds * 1_000 };
      },
      async delete() {},
    },
  });
  const source = { systemInstruction: { parts: [{ text: "stable" }] } };
  await cache.getOrCreate(source);
  now = 82_000;

  assert.equal((await cache.getOrCreate(source))?.name, "cachedContents/renewed");
  assert.equal(creates, 1);
  assert.equal(updates, 1);
  assert.equal((await store.list())[0]?.expireAt, 182_000);
});

test("Gemini create dedupe never shares a remote name across workspace stores", async () => {
  let creates = 0;
  const transport: GeminiPromptCacheTransport = {
    async create() {
      creates++;
      return { name: `cachedContents/${creates}`, expireAt: Date.now() + 100_000 };
    },
    async delete() {},
  };
  const source = { systemInstruction: { parts: [{ text: "same stable prefix" }] } };
  const firstWorkspace = controller({
    store: new MemoryGeminiPromptCacheStore(),
    transport,
  });
  const secondWorkspace = controller({
    store: new MemoryGeminiPromptCacheStore(),
    transport,
  });
  const results = await Promise.all([
    firstWorkspace.getOrCreate(source),
    secondWorkspace.getOrCreate(source),
  ]);

  assert.equal(creates, 2);
  assert.notEqual(results[0]?.name, results[1]?.name);
});

test("Gemini shared file store reuses one process lock identity per metadata path", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-gemini-shared-store-"));
  const path = join(root, "control", "gemini-prompt-cache.json");
  context.after(() => rm(root, { recursive: true, force: true }));

  assert.equal(FileGeminiPromptCacheStore.shared(path), FileGeminiPromptCacheStore.shared(path));
});

test("Gemini removes a created remote object when metadata commit fails", async () => {
  const deleted: string[] = [];
  const failingStore: GeminiPromptCacheStore = {
    async list() {
      return [];
    },
    async put() {
      throw new Error("metadata unavailable");
    },
    async remove() {},
  };
  const cache = controller({
    store: failingStore,
    transport: {
      async create() {
        return { name: "cachedContents/orphan", expireAt: Date.now() + 100_000 };
      },
      async delete(name) {
        deleted.push(name);
      },
    },
  });

  assert.equal(await cache.getOrCreate({ tools: [] }), undefined);
  assert.deepEqual(deleted, ["cachedContents/orphan"]);
});

test("Gemini startup cleanup cannot remove a replacement and remote delete does not block it", async () => {
  let now = 1_000;
  let creates = 0;
  let releaseDelete: (() => void) | undefined;
  let markDeleteStarted: (() => void) | undefined;
  const deleteStarted = new Promise<void>((resolve) => {
    markDeleteStarted = resolve;
  });
  const deleteBlocked = new Promise<void>((resolve) => {
    releaseDelete = resolve;
  });
  const transport: GeminiPromptCacheTransport = {
    async create() {
      creates++;
      return { name: `cachedContents/${creates}`, expireAt: now + 1_000 };
    },
    async delete() {
      markDeleteStarted?.();
      await deleteBlocked;
    },
  };
  const store = new MemoryGeminiPromptCacheStore();
  const source = { systemInstruction: { parts: [{ text: "stable" }] } };
  const initial = controller({ store, transport, now: () => now });
  assert.equal((await initial.getOrCreate(source))?.name, "cachedContents/1");

  now = 3_000;
  const startupCleanup = controller({ store, transport, now: () => now }).cleanupExpiredEntries();
  await deleteStarted;
  const firstRequest = controller({ store, transport, now: () => now }).getOrCreate(source);
  await startupCleanup;
  assert.equal((await firstRequest)?.name, "cachedContents/2");
  assert.equal((await store.list())[0]?.name, "cachedContents/2");
  releaseDelete?.();
});

test("Gemini cached-content creation receives the caller abort signal", async () => {
  const signal = new AbortController().signal;
  let receivedSignal: AbortSignal | undefined;
  const cache = controller({
    transport: {
      async create(input) {
        receivedSignal = input.signal;
        return { name: "cachedContents/signal", expireAt: Date.now() + 100_000 };
      },
      async delete() {},
    },
  });

  assert.equal((await cache.getOrCreate({ tools: [] }, signal))?.name, "cachedContents/signal");
  assert.equal(receivedSignal, signal);
});

test("Gemini same-key lock wait honors caller cancellation", async () => {
  let releaseCreate: (() => void) | undefined;
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const createBlocked = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  const store = new MemoryGeminiPromptCacheStore();
  const cache = controller({
    store,
    transport: {
      async create() {
        markCreateStarted?.();
        await createBlocked;
        return { name: "cachedContents/locked", expireAt: Date.now() + 100_000 };
      },
      async delete() {},
    },
  });
  const source = { tools: [{ functionDeclarations: [{ name: "lookup" }] }] };
  const first = cache.getOrCreate(source);
  await createStarted;

  const abort = new AbortController();
  const waiting = cache.getOrCreate(source, abort.signal);
  abort.abort(new DOMException("cancelled", "AbortError"));
  await assert.rejects(waiting, { name: "AbortError" });

  releaseCreate?.();
  assert.equal((await first)?.name, "cachedContents/locked");
});

test("Gemini cached-content creation propagates a host abort instead of failing open", async () => {
  let markCreateStarted: (() => void) | undefined;
  const createStarted = new Promise<void>((resolve) => {
    markCreateStarted = resolve;
  });
  const abort = new AbortController();
  const cache = controller({
    transport: {
      async create(input): Promise<never> {
        markCreateStarted?.();
        return await new Promise<never>((_resolve, reject) => {
          const onAbort = () =>
            reject(
              input.signal?.reason instanceof Error
                ? input.signal.reason
                : new DOMException("cancelled", "AbortError"),
            );
          input.signal?.addEventListener("abort", onAbort, { once: true });
        });
      },
      async delete() {},
    },
  });
  const creating = cache.getOrCreate({ tools: [] }, abort.signal);
  await createStarted;
  abort.abort(new DOMException("cancelled", "AbortError"));

  await assert.rejects(creating, { name: "AbortError" });
});

test("Gemini suppresses repeated deterministic create failures for a bounded cooldown", async () => {
  let now = 1_000;
  let creates = 0;
  const store = new MemoryGeminiPromptCacheStore();
  const transport: GeminiPromptCacheTransport = {
    async create() {
      creates++;
      throw new LLMStatusError(400, "cache source is below the model minimum");
    },
    async delete() {},
  };
  const options = {
    store,
    now: () => now,
    createFailureCooldownMs: 1_000,
    transport,
  };
  const cache = controller(options);
  const sibling = controller(options);
  const source = { systemInstruction: { parts: [{ text: "short stable prefix" }] } };

  assert.equal(await cache.getOrCreate(source), undefined);
  assert.equal(await sibling.getOrCreate(source), undefined);
  assert.equal(creates, 1);

  now += 1_001;
  assert.equal(await cache.getOrCreate(source), undefined);
  assert.equal(creates, 2, "the bounded negative cache must eventually retry");
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
  assert.equal(
    await flash.getOrCreate(source),
    undefined,
    "permission failure must use normal request",
  );
  assert.equal(
    (await store.list()).length,
    1,
    "expired local record is removed despite remote delete failure",
  );
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
  const explicit = new GeminiProvider(
    {
      baseURL: "https://gemini.example.test",
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
        cache: true,
        promptCache: { mode: "explicit", ttl: "3600s" },
      }),
    },
    undefined,
    { enableExplicitPromptCache: true },
  );
  const explicitResponse = await explicit.generate(
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "question" },
    ],
    [{ name: "lookup", description: "stable tool", inputSchema: { type: "object" } }],
    { toolChoice: "none" },
  );
  assert.equal(explicitResponse.usage?.cacheWriteTokens, 42);
  assert.equal(explicitResponse.usage?.promptTokens, 42);
  assert.deepEqual(explicitResponse.usage?.reportedFields, ["prompt", "cacheWrite"]);
  const generated = requests.at(-1)?.["body"] as Record<string, unknown>;
  assert.equal(generated["cachedContent"], "cachedContents/unit-test");
  assert.equal("system_instruction" in generated, false);
  assert.equal("tools" in generated, false);
  assert.equal("toolConfig" in generated, false);

  const cacheRequest = requests.find((request) =>
    String(request["url"]).includes("cachedContents"),
  );
  assert.ok(cacheRequest);
  assert.equal(String(cacheRequest["url"]).includes("test-key"), false);
  const cacheBody = cacheRequest["body"] as Record<string, unknown>;
  assert.deepEqual(cacheBody["toolConfig"], {
    functionCallingConfig: { mode: "NONE" },
  });

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
  await implicit.generate(
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "q" },
    ],
    [],
  );
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
  const store = new MemoryGeminiPromptCacheStore();
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
    if (url.includes("cachedContents")) {
      return Response.json({
        name: "cachedContents/rejected",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    generated.push(body);
    if (body["cachedContent"] !== undefined)
      return new Response("stale cached content", { status: 404 });
    return Response.json({ candidates: [{ content: { parts: [{ text: "RECOVERED" }] } }] });
  };
  const provider = new GeminiProvider(
    {
      baseURL: "https://gemini.example.test",
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
        cache: true,
        promptCache: { mode: "explicit", ttl: "3600s" },
      }),
    },
    undefined,
    { enableExplicitPromptCache: true, promptCacheStore: store },
  );
  const response = await provider.generate(
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "question" },
    ],
    [],
  );
  assert.equal(response.content, "RECOVERED");
  assert.equal(generated.length, 2);
  assert.equal(generated[0]?.["cachedContent"], "cachedContents/rejected");
  assert.equal("cachedContent" in (generated[1] ?? {}), false);
  assert.ok(generated[1]?.["system_instruction"]);
  assert.equal((await store.list()).length, 0, "a rejected cache name must not be reused");
});

test("Gemini cachedContent quota/server errors do not double-send a full-body fallback", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  let generated = 0;
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    if (url.includes("cachedContents")) {
      return Response.json({
        name: "cachedContents/rate-limited",
        expireTime: new Date(Date.now() + 3_600_000).toISOString(),
      });
    }
    generated++;
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body["cachedContent"], "cachedContents/rate-limited");
    return new Response("quota response with echoed content", { status: 429 });
  };
  const provider = new GeminiProvider(
    {
      baseURL: "https://gemini.example.test",
      apiKey: "test-key",
      model: "gemini-2.5-flash",
      capabilities: resolveModelRouteCapabilities("gemini", "gemini-2.5-flash", {
        cache: true,
        promptCache: { mode: "explicit", ttl: "3600s" },
      }),
    },
    undefined,
    { enableExplicitPromptCache: true },
  );

  await assert.rejects(
    provider.generate(
      [
        { role: "system", content: "stable system" },
        { role: "user", content: "question" },
      ],
      [],
    ),
    (error: unknown) =>
      error instanceof Error &&
      "statusCode" in error &&
      (error as { statusCode: unknown }).statusCode === 429 &&
      !error.message.includes("echoed content"),
  );
  assert.equal(generated, 1);
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
  await provider.generate(
    [
      { role: "system", content: "stable system" },
      { role: "user", content: "question" },
    ],
    [],
  );
  assert.equal(
    urls.some((url) => url.includes("cachedContents")),
    false,
  );
});

test("stable Gemini cache digest recursively normalizes object keys while preserving arrays", () => {
  assert.equal(
    stableDigest({ tools: [{ z: 1, a: { b: 2, a: 1 } }] }),
    stableDigest({ tools: [{ a: { a: 1, b: 2 }, z: 1 }] }),
  );
  assert.notEqual(
    stableDigest({ values: ["first", "second"] }),
    stableDigest({ values: ["second", "first"] }),
  );
});
