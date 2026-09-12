import assert from "node:assert/strict";
import test from "node:test";
import { LLMStatusError } from "../../../src/provider/errors.js";
import type { LLMProvider } from "../../../src/provider/interface.js";
import {
  classifyProviderError,
  defaultIsRetryableError,
  generateWithRetry,
} from "../../../src/provider/retry.js";

test("default retry classification accepts current structured failures only", () => {
  const timeout = new Error("provider timed out");
  timeout.name = "TimeoutError";

  assert.equal(defaultIsRetryableError(new LLMStatusError(429, "rate limited")), true);
  assert.equal(defaultIsRetryableError(new LLMStatusError(503, "unavailable")), true);
  assert.equal(defaultIsRetryableError(new TypeError("fetch failed")), true);
  assert.deepEqual(classifyProviderError(timeout), { status: "timed_out", retryable: true });
  assert.equal(defaultIsRetryableError(new Error("request failed [429] rate limited")), false);
});

test("ordinary Error messages containing HTTP-like codes do not trigger retries", async () => {
  const failure = new Error("request failed [429] rate limited");
  let attempts = 0;
  const provider: LLMProvider = {
    modelName: "current-error-contract",
    generate: async () => {
      attempts++;
      throw failure;
    },
  };

  await assert.rejects(
    generateWithRetry(provider, [{ role: "user", content: "hello" }], [], { maxAttempts: 3 }),
    (error: unknown) => error === failure,
  );
  assert.equal(attempts, 1);
});
