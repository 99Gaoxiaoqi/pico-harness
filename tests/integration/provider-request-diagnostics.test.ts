import assert from "node:assert/strict";
import { test } from "node:test";
import { CostTracker, type ProviderCallLedger } from "../../src/observability/tracker.js";
import type { LLMProvider, LLMProviderRequestOptions } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import type { ProviderCallRecord } from "../../src/tasks/runtime-types.js";

class PreparedClaudeProvider implements LLMProvider {
  readonly modelName = "claude-cache-test";

  constructor(private readonly maxTokens: number) {}

  async generate(
    messages: Message[],
    tools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const system = messages.find((message) => message.role === "system")?.content;
    const body: Record<string, unknown> = {
      model: this.modelName,
      max_tokens: this.maxTokens,
      messages: messages
        .filter((message) => message.role !== "system")
        .map((message) => ({
          role: message.role,
          content: [{ type: "text", text: message.content }],
        })),
      ...(system ? { system } : {}),
      tools: tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.inputSchema,
      })),
    };
    options?.onRequestPrepared?.({
      provider: "claude",
      model: this.modelName,
      body,
    });
    return {
      role: "assistant",
      content: "ok",
      usage: { promptTokens: 10, completionTokens: 1 },
    };
  }
}

test("CostTracker 跨实例恢复请求指纹并定位首个变化段且不持久化 prompt 明文", async () => {
  const records: ProviderCallRecord[] = [];
  const ledger: ProviderCallLedger = {
    recordProviderCall(record) {
      const stored = { ...record, createdAt: records.length + 1 };
      records.push(stored);
      return { record: stored, inserted: true };
    },
    listProviderCalls() {
      return records.map((record) => structuredClone(record));
    },
  };
  let call = 0;
  const trackerOptions = {
    ledger,
    context: { purpose: "main" as const, sessionId: "session-cache-diagnostic" },
    callId: () => `call-${++call}`,
  };
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "Read a file",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];
  const secretPrompt = "PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED";
  const firstMessages: Message[] = [
    { role: "system", content: "stable-system" },
    { role: "user", content: secretPrompt },
  ];
  const secondMessages: Message[] = [
    { role: "system", content: "stable-system" },
    { role: "user", content: "changed-current-user" },
  ];

  await new CostTracker(
    new PreparedClaudeProvider(64),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    trackerOptions,
  ).generate(firstMessages, tools);
  await new CostTracker(
    new PreparedClaudeProvider(64),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    trackerOptions,
  ).generate(secondMessages, tools);
  await new CostTracker(
    new PreparedClaudeProvider(128),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    trackerOptions,
  ).generate(secondMessages, tools);

  const first = requestDiagnostic(records[0]);
  assert.equal(first["changeReason"], "first_request");
  assert.equal(String(first["requestHash"]).length, 64);
  assert.ok(Number(first["requestBytes"]) > 0);

  const changedPrefix = requestDiagnostic(records[1]);
  assert.equal(changedPrefix["changeReason"], "cacheable_prefix_changed");
  assert.deepEqual(changedPrefix["firstChangedCacheableSegment"], {
    kind: "message",
    index: 0,
    role: "user",
  });

  const changedOptions = requestDiagnostic(records[2]);
  assert.equal(changedOptions["changeReason"], "request_changed");
  assert.equal(changedOptions["firstChangedCacheableSegment"], undefined);
  assert.equal(JSON.stringify(records).includes(secretPrompt), false);
});

function requestDiagnostic(record: ProviderCallRecord | undefined): Record<string, unknown> {
  assert.ok(record);
  const diagnostic = record.reported?.["requestDiagnostic"];
  assert.equal(typeof diagnostic, "object");
  assert.ok(diagnostic);
  return diagnostic as Record<string, unknown>;
}
