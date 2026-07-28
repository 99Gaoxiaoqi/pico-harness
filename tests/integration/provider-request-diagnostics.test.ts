import assert from "node:assert/strict";
import { test } from "node:test";
import {
  capturePreparedProviderRequest,
  diagnosePreparedProviderRequest,
  parsePreparedRequestCapture,
  type PreparedRequestCacheBreakpointComparison,
} from "../../src/observability/provider-request-diagnostics.js";
import { CostTracker, type ProviderCallLedger } from "../../src/observability/tracker.js";
import { applyAnthropicCacheControl } from "../../src/provider/anthropic-cache.js";
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
    applyAnthropicCacheControl(body);
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
      return records.toReversed().map((record) => structuredClone(record));
    },
  };
  let call = 0;
  const trackerOptions = {
    ledger,
    context: {
      purpose: "main" as const,
      sessionId: "session-cache-diagnostic",
      conversationId: "conversation-a",
      attemptId: "attempt-a",
    },
    callId: () => `call-${++call}`,
  };
  const tools: ToolDefinition[] = [
    {
      name: "read_file",
      description: "PRIVATE_TOOL_SCHEMA_MUST_NOT_BE_PERSISTED",
      inputSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
    },
  ];
  const secretPrompt = "PRIVATE_PROMPT_MUST_NOT_BE_PERSISTED";
  const secretSystem = "PRIVATE_SYSTEM_MUST_NOT_BE_PERSISTED";
  const secretHistory = "PRIVATE_HISTORY_MUST_NOT_BE_PERSISTED";
  const firstMessages: Message[] = [
    { role: "system", content: secretSystem },
    { role: "user", content: secretHistory },
    { role: "assistant", content: "stable-answer" },
    { role: "user", content: secretPrompt },
  ];
  const changedLatestMessages: Message[] = [
    { role: "system", content: secretSystem },
    { role: "user", content: secretHistory },
    { role: "assistant", content: "stable-answer" },
    { role: "user", content: "changed-current-user" },
  ];
  const changedPrefixMessages: Message[] = [
    { role: "system", content: secretSystem },
    { role: "user", content: "changed-history" },
    { role: "assistant", content: "stable-answer" },
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
  ).generate(changedLatestMessages, tools);
  await new CostTracker(
    new PreparedClaudeProvider(64),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    trackerOptions,
  ).generate(changedPrefixMessages, tools);
  await new CostTracker(
    new PreparedClaudeProvider(128),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    trackerOptions,
  ).generate(changedPrefixMessages, tools);
  await new CostTracker(
    new PreparedClaudeProvider(128),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    {
      ...trackerOptions,
      context: {
        ...trackerOptions.context,
        conversationId: "conversation-b",
        attemptId: "attempt-b",
      },
    },
  ).generate(changedPrefixMessages, tools);
  await new CostTracker(
    new PreparedClaudeProvider(128),
    { provider: "claude", model: "claude-cache-test" },
    undefined,
    trackerOptions,
  ).generate(changedPrefixMessages, tools);

  const first = requestDiagnostic(records[0]);
  assert.equal(first["changeReason"], "first_request");
  assert.equal(String(first["requestHash"]).length, 64);
  assert.ok(Number(first["requestBytes"]) > 0);
  const firstBreakpoints = cacheBreakpoints(first);
  assert.deepEqual(
    firstBreakpoints.map((cacheBreakpoint) => cacheBreakpoint["layer"]),
    ["tools", "tools+system", "history"],
  );
  for (const cacheBreakpoint of firstBreakpoints) {
    assert.equal(String(cacheBreakpoint["hash"]).length, 64);
    assert.ok(Number(cacheBreakpoint["bytes"]) > 0);
  }
  assert.ok(Number(firstBreakpoints[0]?.["bytes"]) < Number(firstBreakpoints[1]?.["bytes"]));
  assert.ok(Number(firstBreakpoints[1]?.["bytes"]) < Number(firstBreakpoints[2]?.["bytes"]));
  assert.equal(first["cachePrefixHash"], firstBreakpoints[2]?.["hash"]);
  assert.deepEqual(
    cacheBreakpointComparisons(first).map((comparison) => comparison["changeReason"]),
    ["first_request", "first_request", "first_request"],
  );

  const changedLatest = requestDiagnostic(records[1]);
  assert.equal(changedLatest["changeReason"], "request_changed");
  assert.equal(changedLatest["firstChangedCacheableSegment"], undefined);
  const latestMessageSegment = (changedLatest["segments"] as Array<Record<string, unknown>>).find(
    (segment) => segment["kind"] === "message" && segment["index"] === 2,
  );
  assert.equal(latestMessageSegment?.["cacheable"], false);
  assert.deepEqual(
    cacheBreakpointComparisons(changedLatest).map((comparison) => comparison["changeReason"]),
    ["stable", "stable", "stable"],
  );

  const changedPrefix = requestDiagnostic(records[2]);
  assert.equal(changedPrefix["changeReason"], "cacheable_prefix_changed");
  assert.deepEqual(changedPrefix["firstChangedCacheableSegment"], {
    kind: "message",
    index: 0,
    role: "user",
  });
  const changedPrefixComparisons = cacheBreakpointComparisons(changedPrefix);
  assert.deepEqual(
    changedPrefixComparisons.map((comparison) => [comparison["layer"], comparison["changeReason"]]),
    [
      ["tools", "stable"],
      ["tools+system", "stable"],
      ["history", "changed"],
    ],
  );
  assert.deepEqual(
    changedPrefixComparisons[0]?.["prior"],
    changedPrefixComparisons[0]?.["current"],
  );
  assert.deepEqual(
    changedPrefixComparisons[1]?.["prior"],
    changedPrefixComparisons[1]?.["current"],
  );
  assert.notDeepEqual(
    changedPrefixComparisons[2]?.["prior"],
    changedPrefixComparisons[2]?.["current"],
  );

  const changedOptions = requestDiagnostic(records[3]);
  assert.equal(changedOptions["changeReason"], "request_changed");
  assert.equal(changedOptions["firstChangedCacheableSegment"], undefined);
  assert.equal(requestDiagnostic(records[4])["changeReason"], "first_request");
  assert.equal(requestDiagnostic(records[5])["changeReason"], "stable");
  const persisted = JSON.stringify(records);
  for (const secret of [
    secretPrompt,
    secretSystem,
    secretHistory,
    "PRIVATE_TOOL_SCHEMA_MUST_NOT_BE_PERSISTED",
  ]) {
    assert.equal(persisted.includes(secret), false);
  }
});

test("逐断点诊断安全处理缺失层、旧记录以及新增和移除的断点", () => {
  const fullBody: Record<string, unknown> = {
    model: "claude-cache-test",
    max_tokens: 64,
    tools: [
      {
        name: "read_file",
        description: "PRIVATE_DIRECT_TOOL",
        input_schema: { type: "object" },
      },
    ],
    system: "PRIVATE_DIRECT_SYSTEM",
    messages: [
      { role: "user", content: [{ type: "text", text: "PRIVATE_DIRECT_HISTORY" }] },
      { role: "assistant", content: [{ type: "text", text: "stable answer" }] },
      { role: "user", content: [{ type: "text", text: "latest question" }] },
    ],
  };
  applyAnthropicCacheControl(fullBody);
  const full = capturePreparedProviderRequest({
    provider: "claude",
    model: "claude-cache-test",
    body: fullBody,
  });

  const toolsOnlyBody: Record<string, unknown> = {
    model: "claude-cache-test",
    max_tokens: 64,
    tools: [
      {
        name: "read_file",
        description: "PRIVATE_DIRECT_TOOL",
        input_schema: { type: "object" },
      },
    ],
    messages: [{ role: "user", content: [{ type: "text", text: "latest question" }] }],
  };
  applyAnthropicCacheControl(toolsOnlyBody);
  const toolsOnly = capturePreparedProviderRequest({
    provider: "claude",
    model: "claude-cache-test",
    body: toolsOnlyBody,
  });

  assert.deepEqual(
    full.cacheBreakpoints?.map(({ layer }) => layer),
    ["tools", "tools+system", "history"],
  );
  assert.deepEqual(
    toolsOnly.cacheBreakpoints?.map(({ layer }) => layer),
    ["tools"],
  );
  assert.equal(JSON.stringify(full).includes("PRIVATE_DIRECT_"), false);
  assert.equal(JSON.stringify(toolsOnly).includes("PRIVATE_DIRECT_"), false);
  assert.deepEqual(parsePreparedRequestCapture(structuredClone(full)), full);

  const removed = diagnosePreparedProviderRequest(toolsOnly, full);
  assert.deepEqual(summarizeComparisons(removed.cacheBreakpointComparisons), [
    ["tools", "stable"],
    ["tools+system", "removed"],
    ["history", "removed"],
  ]);
  assert.equal(removed.cacheBreakpointComparisons?.[1]?.current, undefined);
  assert.ok(removed.cacheBreakpointComparisons?.[1]?.prior);

  const added = diagnosePreparedProviderRequest(full, toolsOnly);
  assert.deepEqual(summarizeComparisons(added.cacheBreakpointComparisons), [
    ["tools", "stable"],
    ["tools+system", "added"],
    ["history", "added"],
  ]);
  assert.equal(added.cacheBreakpointComparisons?.[1]?.prior, undefined);
  assert.ok(added.cacheBreakpointComparisons?.[1]?.current);

  const legacyRecord = { ...full };
  delete legacyRecord.cacheBreakpoints;
  const parsedLegacy = parsePreparedRequestCapture(legacyRecord);
  assert.ok(parsedLegacy);
  assert.equal(parsedLegacy.cacheBreakpoints, undefined);
  assert.deepEqual(
    summarizeComparisons(
      diagnosePreparedProviderRequest(full, parsedLegacy).cacheBreakpointComparisons,
    ),
    [
      ["tools", "prior_unavailable"],
      ["tools+system", "prior_unavailable"],
      ["history", "prior_unavailable"],
    ],
  );
});

function requestDiagnostic(record: ProviderCallRecord | undefined): Record<string, unknown> {
  assert.ok(record);
  const diagnostic = record.reported?.["requestDiagnostic"];
  assert.equal(typeof diagnostic, "object");
  assert.ok(diagnostic);
  return diagnostic as Record<string, unknown>;
}

function cacheBreakpoints(diagnostic: Record<string, unknown>): Array<Record<string, unknown>> {
  const cacheBreakpoints = diagnostic["cacheBreakpoints"];
  assert.ok(Array.isArray(cacheBreakpoints));
  return cacheBreakpoints as Array<Record<string, unknown>>;
}

function cacheBreakpointComparisons(
  diagnostic: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const comparisons = diagnostic["cacheBreakpointComparisons"];
  assert.ok(Array.isArray(comparisons));
  return comparisons as Array<Record<string, unknown>>;
}

function summarizeComparisons(
  comparisons: PreparedRequestCacheBreakpointComparison[] | undefined,
): Array<[string, string]> {
  assert.ok(comparisons);
  return comparisons.map(({ layer, changeReason }) => [layer, changeReason]);
}
