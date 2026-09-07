import assert from "node:assert/strict";
import { test } from "node:test";
import {
  memoryRequestFits,
  type MemoryRequestBudgetInput,
} from "../../src/memory/atomic/extraction-budget.js";
import { CapabilityPreflightProvider } from "../../src/provider/capability-preflight.js";
import { ModelCapabilityError } from "../../src/provider/errors.js";
import { resolveModelRouteCapabilities } from "../../src/provider/model-capabilities.js";
import { ProviderAtomicMemoryModel } from "../../src/runtime/atomic-memory-runtime.js";
import type { MemoryModelRequest } from "../../src/memory/atomic/runtime-contracts.js";

test("memory budget agrees with actual auxiliary requests for history, Chinese, tools and canonicalization", async () => {
  const contextWindowTokens = 4096;
  const reservedOutputTokens = 256;
  const prompt = 'Extract memory from this evidence: {"text":"I prefer concise answers."}';
  const chinese = "请记住，我的团队使用 PostgreSQL 存储业务数据，偏好清晰直接的实现方案。".repeat(
    200,
  );
  assert.ok(
    Math.ceil(chinese.length / 4) + reservedOutputTokens + 1024 < contextWindowTokens,
    "the Chinese fixture would incorrectly fit with a chars/4 estimate",
  );
  const sourceTools = [
    { name: "lookup", description: chinese, inputSchema: { type: "object", properties: {} } },
  ];
  const scenarios: readonly {
    name: string;
    stage: MemoryModelRequest["stage"];
    input: MemoryRequestBudgetInput;
    fits: boolean;
  }[] = [
    {
      name: "small evidence does not hide an oversized history",
      stage: "proposal",
      input: {
        sourceMessages: [{ role: "user", content: "factual conversation context ".repeat(1200) }],
      },
      fits: false,
    },
    {
      name: "Chinese source text uses the warmed tokenizer",
      stage: "localized",
      input: { sourceMessages: [{ role: "user", content: chinese }] },
      fits: false,
    },
    {
      name: "tool catalog consumes request capacity",
      stage: "proposal",
      input: { sourceTools },
      fits: false,
    },
    {
      name: "canonicalization sends neither source history nor tools",
      stage: "canonicalize",
      input: { sourceMessages: [{ role: "user", content: chinese }], sourceTools },
      fits: true,
    },
    { name: "a short proposal fits", stage: "proposal", input: {}, fits: true },
  ];
  const capabilities = resolveModelRouteCapabilities("openai", "memory-test", {
    context: contextWindowTokens,
    output: reservedOutputTokens,
    reasoning: false,
    toolCall: true,
  });
  for (const scenario of scenarios) {
    const input = { ...scenario.input, contextWindowTokens, reservedOutputTokens };
    assert.equal(
      await memoryRequestFits(input, prompt, scenario.stage),
      scenario.fits,
      scenario.name,
    );
    let providerCalls = 0;
    const model = new ProviderAtomicMemoryModel(
      new CapabilityPreflightProvider(
        {
          requestCapabilities: { toolChoiceNoneWithTools: true },
          async generate(messages, tools) {
            providerCalls++;
            if (scenario.stage === "canonicalize") {
              assert.deepEqual(messages, [{ role: "system", content: prompt }]);
              assert.deepEqual(tools, []);
            }
            return { role: "assistant", content: "{}" };
          },
        },
        "memory-test",
        capabilities,
        "off",
      ),
    );
    const request = { ...scenario.input, stage: scenario.stage, prompt };
    if (scenario.fits) assert.equal(await model.call(request), "{}", scenario.name);
    else {
      await assert.rejects(
        model.call(request),
        (error: unknown) =>
          error instanceof ModelCapabilityError && error.code === "context_window",
        scenario.name,
      );
    }
    assert.equal(providerCalls, scenario.fits ? 1 : 0, scenario.name);
  }
  assert.equal(
    await memoryRequestFits(
      { sourceMessages: [{ role: "user", content: chinese }] },
      prompt,
      "proposal",
    ),
    true,
    "an unknown context window must defer to the Provider instead of inventing a limit",
  );
});
