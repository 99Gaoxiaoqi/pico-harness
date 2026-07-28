import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { CostTracker, type ProviderCallLedger } from "../../src/observability/tracker.js";
import { LLMStatusError } from "../../src/provider/errors.js";
import { createProvider } from "../../src/provider/factory.js";
import { toCanonicalUsage } from "../../src/schema/message.js";
import type { Message, ToolDefinition, Usage } from "../../src/schema/message.js";
import type { ProviderCallRecord } from "../../src/tasks/runtime-types.js";

const TEST_TIMEOUT_MS = 5 * 60_000;
// Anthropic cache 验证需要专用额度；不随通用 real-model 套件自动消耗。
const RUN_REAL_MODEL = process.env.RUN_ANTHROPIC_CACHE_E2E === "1";
const realModelTest = RUN_REAL_MODEL ? test : test.skip;

realModelTest(
  "real Anthropic multi-turn requests write, read, and extend the prompt cache prefix",
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
      { role: "user", content: "Reply with exactly CACHE_R1_READY. Do not call tools." },
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
    const r1ToolLoopMessages: Message[] = [
      ...messages,
      {
        role: "assistant",
        content: "",
        toolCalls: [
          {
            id: "cache-probe-r1",
            name: "cache_probe",
            arguments: '{"value":"r1"}',
          },
        ],
      },
      {
        role: "user",
        content: "CACHE_PROBE_RESULT_R1",
        toolCallId: "cache-probe-r1",
      },
    ];
    const r2Messages: Message[] = [
      ...r1ToolLoopMessages,
      { role: "assistant", content: "CACHE_R1_COMPLETE" },
      { role: "user", content: "Reply with exactly CACHE_R2_READY. Do not call tools." },
    ];

    const first = await realAnthropicRequest("r1-write", () => tracked.generate(messages, tools));
    const second = await realAnthropicRequest("r1-tool-loop", () =>
      tracked.generate(r1ToolLoopMessages, tools),
    );
    const third = await realAnthropicRequest("r2-external-turn", () =>
      tracked.generate(r2Messages, tools),
    );

    const firstUsage = requiredUsage(first.usage, "R1 first request");
    const secondUsage = requiredUsage(second.usage, "R1 tool loop");
    const thirdUsage = requiredUsage(third.usage, "R2 external turn");
    assert.ok(
      (firstUsage.cacheWriteTokens ?? 0) > 0,
      "cache assertion: R1 first request must write the stable prefix",
    );
    assert.ok(
      (secondUsage.cacheReadTokens ?? 0) > 0,
      "cache assertion: the R1 tool loop must read the stable tools/system prefix",
    );
    assert.ok(
      (secondUsage.cacheWriteTokens ?? 0) > 0,
      "cache assertion: the R1 tool loop must write its deeper history prefix",
    );
    assert.ok(
      (thirdUsage.cacheReadTokens ?? 0) > 0,
      "cache assertion: R2 must read a prefix written by R1",
    );
    assert.ok(
      (thirdUsage.cacheWriteTokens ?? 0) > 0,
      "cache assertion: R2 must reheat the newly extended history prefix",
    );
    for (const usage of [firstUsage, secondUsage, thirdUsage]) {
      assertCanonicalPromptTotal(usage);
    }

    assert.equal(records.length, 3);
    assert.equal(requestChangeReason(records[0]), "first_request");
    assert.equal(requestChangeReason(records[1]), "cacheable_prefix_changed");
    assert.equal(requestChangeReason(records[2]), "cacheable_prefix_changed");
    assert.equal(JSON.stringify(records).includes(marker), false);
  },
);

type RealAnthropicRequestPhase = "r1-write" | "r1-tool-loop" | "r2-external-turn";
type RealAnthropicFailureKind =
  | "credential"
  | "credential_or_quota"
  | "quota"
  | "protocol"
  | "transport";

class RealAnthropicRequestFailure extends Error {
  constructor(
    readonly kind: RealAnthropicFailureKind,
    phase: RealAnthropicRequestPhase,
    statusCode?: number,
  ) {
    super(
      [
        `真实 Anthropic cache E2E 请求失败 [${kind}]`,
        `phase=${phase}`,
        ...(statusCode === undefined ? [] : [`status=${statusCode}`]),
        "请求明文与凭证已省略",
      ].join("; "),
    );
    this.name = "RealAnthropicRequestFailure";
  }
}

async function realAnthropicRequest<T>(
  phase: RealAnthropicRequestPhase,
  request: () => Promise<T>,
): Promise<T> {
  try {
    return await request();
  } catch (error) {
    const statusCode = error instanceof LLMStatusError ? error.statusCode : undefined;
    const kind = classifyRealAnthropicFailure(error, statusCode);
    throw new RealAnthropicRequestFailure(kind, phase, statusCode);
  }
}

function classifyRealAnthropicFailure(
  error: unknown,
  statusCode: number | undefined,
): RealAnthropicFailureKind {
  const detail = error instanceof Error ? error.message : "";
  if (
    statusCode === 402 ||
    statusCode === 429 ||
    /\b(?:quota|billing|credits?|insufficient[_ -]?(?:quota|credits?|balance)|balance)\b|额度(?:不足|用尽)|余额不足|欠费|配额(?:不足|用尽)/iu.test(
      detail,
    )
  ) {
    return "quota";
  }
  if (statusCode === 401 || statusCode === 403) {
    return /\b(?:authentication|unauthorized|forbidden|invalid[_ -]?(?:api[_ -]?)?key)\b|鉴权失败|认证失败|无效(?:密钥|凭证)/iu.test(
      detail,
    )
      ? "credential"
      : "credential_or_quota";
  }
  return statusCode === undefined ? "transport" : "protocol";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`真实 Anthropic cache E2E 缺少环境变量 ${name}`);
  return value;
}

function anthropicBaseUrl(value: string): string {
  const normalized = value.replace(/\/+$/u, "");
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
}

function requiredUsage(usage: Usage | undefined, phase: string): Usage {
  assert.ok(usage, `cache assertion: ${phase} must report Anthropic usage`);
  return usage;
}

function assertCanonicalPromptTotal(usage: Usage): void {
  const canonical = toCanonicalUsage(usage);
  assert.equal(
    canonical.totalPromptTokens,
    canonical.inputTokens + canonical.cacheReadTokens + canonical.cacheWriteTokens,
    "cache assertion: prompt token buckets must reconcile",
  );
}

function requestChangeReason(record: ProviderCallRecord | undefined): unknown {
  assert.ok(record);
  const diagnostic = record.reported?.["requestDiagnostic"];
  assert.equal(typeof diagnostic, "object");
  assert.ok(diagnostic);
  return (diagnostic as Record<string, unknown>)["changeReason"];
}
