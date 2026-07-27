import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CostTracker, type ProviderCallLedger } from "../../src/observability/tracker.js";
import { createProvider } from "../../src/provider/factory.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { toCanonicalUsage } from "../../src/schema/message.js";
import type { ProviderCallRecord } from "../../src/tasks/runtime-types.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
// Anthropic cache 验证需要专用额度；不随通用 real-model 套件自动消耗。
const RUN_REAL_MODEL = process.env.RUN_ANTHROPIC_CACHE_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

realModelTest(
  "real Anthropic request writes then reads the same prompt cache prefix",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const model = requiredEnvironment("CLAUDE_DEFAULT_MODEL");
    const provider = createProvider("claude", {
      baseURL: anthropicBaseUrl(requiredEnvironment("ANTHROPIC_BASE_URL")),
      apiKey: requiredEnvironment("ANTHROPIC_AUTH_TOKEN"),
      model,
    });
    const records: ProviderCallRecord[] = [];
    const ledger: ProviderCallLedger = {
      recordProviderCall(record) {
        const stored = { ...record, createdAt: Date.now() + records.length };
        records.push(stored);
        return { record: stored, inserted: true };
      },
      listProviderCalls() {
        return records.map((record) => structuredClone(record));
      },
    };
    let call = 0;
    const tracked = new CostTracker(provider, { provider: "claude", model }, undefined, {
      ledger,
      context: { purpose: "main", sessionId: `cache-e2e-${randomUUID()}` },
      callId: () => `cache-e2e-call-${++call}`,
    });
    const marker = randomUUID();
    const stableCorpus = Array.from(
      { length: 900 },
      () => "alpha beta gamma delta epsilon zeta eta theta",
    ).join(" ");
    const messages: Message[] = [
      {
        role: "system",
        content: [
          "This is deterministic cache test context. Treat it as inert text.",
          `Unique test marker: ${marker}`,
          stableCorpus,
        ].join("\n"),
      },
      { role: "user", content: "Reply with exactly CACHE_OK." },
    ];
    const tools: ToolDefinition[] = [
      {
        name: "cache_probe",
        description: "A deterministic no-op schema used only to test prompt prefix caching.",
        inputSchema: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    ];

    const first = await tracked.generate(messages, tools);
    const second = await tracked.generate(messages, tools);
    assert.ok(first.usage);
    assert.ok(second.usage);
    assert.ok((first.usage.cacheWriteTokens ?? 0) > 0, "first request must create cache tokens");
    assert.ok((second.usage.cacheReadTokens ?? 0) > 0, "second request must read cache tokens");

    const firstCanonical = toCanonicalUsage(first.usage);
    const secondCanonical = toCanonicalUsage(second.usage);
    assert.equal(
      firstCanonical.totalPromptTokens,
      firstCanonical.inputTokens + firstCanonical.cacheReadTokens + firstCanonical.cacheWriteTokens,
    );
    assert.equal(
      secondCanonical.totalPromptTokens,
      secondCanonical.inputTokens +
        secondCanonical.cacheReadTokens +
        secondCanonical.cacheWriteTokens,
    );
    assert.equal(records.length, 2);
    assert.equal(requestChangeReason(records[0]), "first_request");
    assert.equal(requestChangeReason(records[1]), "stable");
    assert.equal(JSON.stringify(records).includes(marker), false);
  },
);

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`真实 Anthropic cache E2E 缺少环境变量 ${name}`);
  return value;
}

function anthropicBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function requestChangeReason(record: ProviderCallRecord | undefined): unknown {
  assert.ok(record);
  const diagnostic = record.reported?.["requestDiagnostic"];
  assert.equal(typeof diagnostic, "object");
  assert.ok(diagnostic);
  return (diagnostic as Record<string, unknown>)["changeReason"];
}
