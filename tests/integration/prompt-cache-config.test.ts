import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadPicoProjectConfig } from "../../src/input/pico-config.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";

test("prompt-cache policies resolve provider defaults and configured behavior", () => {
  assert.deepEqual(resolveModelRouteCapabilities("claude", "claude-test", undefined).promptCache, {
    mode: "explicit",
    ttl: "5m",
    keyShards: 1,
    prewarm: false,
  });
  assert.deepEqual(resolveModelRouteCapabilities("openai", "gpt-test", undefined).promptCache, {
    mode: "implicit",
    keyShards: 1,
    prewarm: false,
  });
  assert.deepEqual(
    resolveModelRouteCapabilities("openai", "gpt-test", {
      cache: true,
      promptCache: {
        mode: "explicit",
        ttl: "30m",
        explicitBreakpoints: true,
        keyShards: 4,
      },
    }).promptCache,
    {
      mode: "explicit",
      ttl: "30m",
      explicitBreakpoints: true,
      keyShards: 4,
      shardThresholdRpm: 15,
      prewarm: false,
    },
  );
  assert.throws(
    () =>
      resolveModelRouteCapabilities("openai", "gpt-test", {
        cache: true,
        promptCache: { mode: "explicit", ttl: "30m" },
      }),
    /ttl requires explicitBreakpoints=true/u,
  );
  assert.throws(
    () =>
      resolveModelRouteCapabilities("openai", "gpt-test", {
        cache: true,
        promptCache: { mode: "implicit", keyShards: 4 },
      }),
    /key sharding requires promptCache\.mode=explicit/u,
  );
  assert.throws(
    () =>
      resolveModelRouteCapabilities("openai", "gpt-test", {
        cache: true,
        promptCache: { mode: "explicit", shardThresholdRpm: 15 },
      }),
    /requires keyShards greater than 1/u,
  );
  assert.deepEqual(
    resolveModelRouteCapabilities("gemini", "gemini-test", {
      cache: true,
      promptCache: { mode: "explicit" },
    }).promptCache,
    {
      mode: "explicit",
      ttl: "3600s",
      keyShards: 1,
      prewarm: false,
    },
  );
});

test("project config validates prompt-cache policy against its provider protocol", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "pico-prompt-cache-config-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, ".pico"), { recursive: true });
  const configPath = join(root, ".pico", "config.json");

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: {
        claude: {
          protocol: "claude",
          baseURL: "https://api.anthropic.com/v1",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          models: {
            "claude-test": {
              cache: true,
              promptCache: { mode: "explicit", ttl: "1h", prewarm: true },
            },
          },
        },
      },
    }),
    "utf8",
  );
  const parsed = await loadPicoProjectConfig(root);
  assert.deepEqual(parsed.providers["claude"]?.modelCapabilities?.["claude-test"]?.promptCache, {
    mode: "explicit",
    ttl: "1h",
    prewarm: true,
  });

  await writeFile(
    configPath,
    JSON.stringify({
      version: 1,
      providers: {
        claude: {
          protocol: "claude",
          baseURL: "https://api.anthropic.com/v1",
          apiKeyEnv: "ANTHROPIC_API_KEY",
          models: {
            "claude-test": {
              cache: true,
              promptCache: { mode: "implicit", ttl: "30m" },
            },
          },
        },
      },
    }),
    "utf8",
  );
  await assert.rejects(loadPicoProjectConfig(root), /promptCache\.mode.*explicit for claude/u);
});
