import assert from "node:assert/strict";
import { test } from "node:test";
import { parseModelProviderConfigs } from "../../../src/input/pico-config.js";
import { resolveModelRouteCapabilities } from "../../../src/provider/model-capabilities.js";

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
  assert.deepEqual(
    resolveModelRouteCapabilities("openai", "gpt-test", {
      cache: true,
      promptCache: { mode: "implicit", retention: "24h", keyShards: 4 },
    }).promptCache,
    {
      mode: "implicit",
      retention: "24h",
      keyShards: 4,
      shardThresholdRpm: 15,
      prewarm: false,
    },
  );
  assert.throws(
    () =>
      resolveModelRouteCapabilities("openai", "gpt-test", {
        cache: true,
        promptCache: { mode: "explicit", retention: "in_memory" },
      }),
    /retention requires promptCache\.mode=implicit/u,
  );
  assert.throws(
    () =>
      resolveModelRouteCapabilities("openai", "gpt-test", {
        cache: true,
        promptCache: { mode: "explicit", shardThresholdRpm: 15 },
      }),
    /requires keyShards greater than 1/u,
  );
});

test("provider parser validates prompt-cache policy against its protocol", () => {
  const parsed = parseModelProviderConfigs(
    {
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
    "prompt-cache-test",
  );
  assert.deepEqual(parsed["claude"]?.modelCapabilities?.["claude-test"]?.promptCache, {
    mode: "explicit",
    ttl: "1h",
    prewarm: true,
  });

  assert.throws(
    () =>
      parseModelProviderConfigs(
        {
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
        "prompt-cache-test",
      ),
    /promptCache\.mode.*explicit for claude/u,
  );

  const openAIParsed = parseModelProviderConfigs(
    {
      openai: {
        protocol: "openai",
        baseURL: "https://api.openai.com/v1",
        apiKeyEnv: "OPENAI_API_KEY",
        models: {
          "gpt-legacy": {
            cache: true,
            promptCache: { mode: "implicit", retention: "in_memory", keyShards: 2 },
          },
        },
      },
    },
    "prompt-cache-test",
  );
  assert.deepEqual(openAIParsed["openai"]?.modelCapabilities?.["gpt-legacy"]?.promptCache, {
    mode: "implicit",
    retention: "in_memory",
    keyShards: 2,
  });

  assert.throws(
    () =>
      parseModelProviderConfigs(
        {
          openai: {
            protocol: "openai",
            baseURL: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            models: {
              "gpt-invalid": {
                cache: true,
                promptCache: { mode: "explicit", retention: "24h" },
              },
            },
          },
        },
        "prompt-cache-test",
      ),
    /promptCache\.retention.*requires promptCache\.mode=implicit/u,
  );

  assert.throws(
    () =>
      parseModelProviderConfigs(
        {
          openai: {
            protocol: "openai",
            baseURL: "https://api.openai.com/v1",
            apiKeyEnv: "OPENAI_API_KEY",
            models: { "gpt-retired-reasoning": { reasoning: true } },
          },
        },
        "prompt-cache-test",
      ),
    /reasoning.*must be a reasoning capability object/u,
  );

  assert.throws(
    () =>
      parseModelProviderConfigs(
        {
          removed: {
            protocol: "gemini",
            baseURL: "https://provider.invalid/v1",
            apiKeyEnv: "REMOVED_PROVIDER_API_KEY",
            models: {
              "removed-model": {},
            },
          },
        },
        "prompt-cache-test",
      ),
    /protocol.*must be openai, claude or responses/u,
  );
});
