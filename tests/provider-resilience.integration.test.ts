import { describe, expect, it, vi } from "vitest";
import { CostTrackedModelFallbackProvider } from "../src/cli/run-agent.js";
import { Session } from "../src/engine/session.js";
import type { ProviderConfig } from "../src/provider/config.js";
import { CredentialPool } from "../src/provider/credential-pool.js";
import { CredentialRotationCoordinator } from "../src/provider/credential-rotation.js";
import { isTimeoutError, LLMStatusError } from "../src/provider/errors.js";
import type { LLMProvider } from "../src/provider/interface.js";
import {
  classifyProviderError,
  generateWithRetry,
  type RateLimitFailure,
  type RetryInfo,
} from "../src/provider/retry.js";
import type { Message } from "../src/schema/message.js";

const tools = [];

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function nodeTimeoutError(): Promise<Error> {
  const signal = AbortSignal.timeout(1);
  if (!signal.aborted) {
    await new Promise<void>((resolve) =>
      signal.addEventListener("abort", () => resolve(), { once: true }),
    );
  }
  if (!(signal.reason instanceof Error)) throw new Error("AbortSignal.timeout did not abort");
  return signal.reason;
}

describe("Provider resilience integration", () => {
  it("classifies Node TimeoutError as timed_out/retryable and retries it only once", async () => {
    const timeout = await nodeTimeoutError();
    const generate = vi.fn().mockRejectedValue(timeout);
    const provider: LLMProvider = {
      generate: generate as LLMProvider["generate"],
    };
    const retries: RetryInfo[] = [];

    await expect(
      generateWithRetry(provider, [{ role: "user", content: "hello" }], tools, {
        maxAttempts: 5,
        onRetry: (info) => retries.push(info),
      }),
    ).rejects.toBe(timeout);

    expect(isTimeoutError(timeout)).toBe(true);
    expect(classifyProviderError(timeout)).toEqual({ status: "timed_out", retryable: true });
    expect(generate).toHaveBeenCalledTimes(2);
    expect(retries).toHaveLength(1);
    expect(retries[0]?.failureStatus).toBe("timed_out");

    const cancelled = new DOMException("parent cancelled", "AbortError");
    expect(classifyProviderError(cancelled)).toEqual({ status: "cancelled", retryable: false });
  });

  it("reuses one credential switch when concurrent 429 responses come from the same key", async () => {
    const pool = new CredentialPool(["key-A", "key-B", "key-C"]);
    const config: ProviderConfig = {
      baseURL: "https://llm.example/v1",
      apiKey: pool.getNext(),
      model: "stable-model",
      routeId: "openai/stable-model",
    };
    const bothStarted = deferred();
    const releaseFailures = deferred();
    const builds: string[] = [];
    const failures: RateLimitFailure[] = [];
    let keyAStarted = 0;
    let keyBCalls = 0;

    const rotation = new CredentialRotationCoordinator(pool, config, (route) => {
      builds.push(route.apiKey);
      return {
        modelName: route.model,
        async generate(messages): Promise<Message> {
          if (route.apiKey === "key-A") {
            keyAStarted++;
            if (keyAStarted === 2) bothStarted.resolve();
            await releaseFailures.promise;
            throw new LLMStatusError(429, "key A rate limited");
          }
          if (route.apiKey === "key-B") {
            keyBCalls++;
            return { role: "assistant", content: `ok:${messages.at(-1)?.content ?? ""}` };
          }
          throw new Error(`unexpected credential: ${route.apiKey}`);
        },
      };
    });
    const initialProvider = rotation.provider;
    const run = (content: string) =>
      generateWithRetry(rotation.provider, [{ role: "user", content }], tools, {
        // 复刻 Engine 现有无参 rebuildProvider 桥接，验证它仍能取到失败路由。
        onRateLimited: (failure) => {
          failures.push(failure);
          return rotation.rotate();
        },
      });

    const first = run("first");
    const second = run("second");
    await bothStarted.promise;
    releaseFailures.resolve();

    await expect(Promise.all([first, second])).resolves.toEqual([
      { role: "assistant", content: "ok:first" },
      { role: "assistant", content: "ok:second" },
    ]);
    expect(builds).toEqual(["key-A", "key-B"]);
    expect(keyBCalls).toBe(2);
    expect(failures).toHaveLength(2);
    expect(
      failures.every(
        (failure) =>
          failure.failedProvider === initialProvider &&
          failure.failedCredential === "key-A" &&
          failure.failedRouteId === "openai/stable-model" &&
          failure.failedModel === "stable-model",
      ),
    ).toBe(true);
    expect(pool.getRateLimitStatus("key-A").rateLimited).toBe(true);
    expect(pool.getRateLimitStatus("key-B").rateLimited).toBe(false);
    expect(pool.getRateLimitStatus("key-C").rateLimited).toBe(false);
  });

  it("lets all in-flight primary failures await and reuse one fallback switch", async () => {
    const session = new Session(`provider-fallback-${Date.now()}`, "/tmp", {
      persistence: false,
    });
    const bothStarted = deferred();
    const releaseFailures = deferred();
    const createdModels: string[] = [];
    let primaryStarted = 0;
    let fallbackCalls = 0;

    try {
      const provider = new CostTrackedModelFallbackProvider(
        "openai",
        {
          baseURL: "https://llm.example/v1",
          apiKey: "test-key",
          model: "glm-5.2",
        },
        "kimi-k2.5",
        (_kind, route) => {
          createdModels.push(route.model);
          if (route.model === "glm-5.2") {
            return {
              async generate(): Promise<Message> {
                primaryStarted++;
                if (primaryStarted === 2) bothStarted.resolve();
                await releaseFailures.promise;
                throw new Error("model glm-5.2 is unavailable");
              },
            };
          }
          return {
            async generate(messages): Promise<Message> {
              fallbackCalls++;
              return {
                role: "assistant",
                content: `fallback:${messages.at(-1)?.content ?? ""}`,
                usage: { promptTokens: 1, completionTokens: 1 },
              };
            },
          };
        },
        session,
      );

      const first = provider.generate([{ role: "user", content: "first" }], tools);
      const second = provider.generate([{ role: "user", content: "second" }], tools);
      await bothStarted.promise;
      releaseFailures.resolve();

      await expect(Promise.all([first, second])).resolves.toEqual([
        expect.objectContaining({ content: "fallback:first" }),
        expect.objectContaining({ content: "fallback:second" }),
      ]);
      expect(createdModels).toEqual(["glm-5.2", "kimi-k2.5"]);
      expect(fallbackCalls).toBe(2);
      expect(session.totalProviderCalls).toBe(2);
    } finally {
      await session.close();
    }
  });
});
