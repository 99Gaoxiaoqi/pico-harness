import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Compactor } from "../../src/context/compactor.js";
import { projectRuntimeToolResultMessage } from "../../src/engine/runtime-model-message.js";
import type { RuntimeToolResultRecordedEvent } from "../../src/engine/session-runtime-event.js";
import type { ToolCall, ToolResult } from "../../src/schema/message.js";
import { buildRuntimeToolResultProjection } from "../../src/tools/tool-result-observation.js";

test("ToolResult projection hashes raw UTF-8 bytes and keeps small model output intact", () => {
  const rawOutput = "原始结果😀\n";
  const toolCall = call("fixture_tool");
  const result = toolResult(toolCall, rawOutput);
  const projected = buildRuntimeToolResultProjection({
    toolCall,
    result,
    modelOutput: rawOutput,
    thresholdTokens: 100,
  });

  assert.equal(projected.shouldArchive, false);
  assert.equal(projected.rawSizeBytes, Buffer.byteLength(rawOutput, "utf8"));
  assert.equal(
    projected.rawSha256,
    createHash("sha256").update(Buffer.from(rawOutput, "utf8")).digest("hex"),
  );
  assert.deepEqual(projected.projection, {
    version: 1,
    mode: "full",
    text: rawOutput,
    strategy: "original",
    truncated: false,
  });

  const recoveryOutput = `${rawOutput}[Recovery] 请先检查输入。`;
  const recovered = buildRuntimeToolResultProjection({
    toolCall,
    result,
    modelOutput: recoveryOutput,
    thresholdTokens: 100,
  });
  assert.equal(recovered.rawSha256, projected.rawSha256);
  assert.equal(recovered.rawSizeBytes, projected.rawSizeBytes);
  assert.deepEqual(recovered.projection, {
    version: 1,
    mode: "full",
    text: recoveryOutput,
    strategy: "recovery-injected",
    truncated: false,
  });
});

test("ToolResult projection creates a bounded deterministic preview above an injectable threshold", () => {
  const canary = "MIDDLE_CANARY_MUST_NOT_APPEAR";
  const rawOutput = `HEAD\n${"A".repeat(800)}\n${canary}\n${"Z".repeat(800)}\nTAIL`;
  const toolCall = call("fixture_tool");
  const result = toolResult(toolCall, rawOutput);
  const input = {
    toolCall,
    result,
    modelOutput: rawOutput,
    thresholdTokens: 0,
    maxPreviewChars: 240,
  } as const;

  const first = buildRuntimeToolResultProjection(input);
  const second = buildRuntimeToolResultProjection(input);
  assert.deepEqual(second, first);
  assert.equal(first.shouldArchive, true);
  assert.equal(first.projection.mode, "preview");
  assert.equal(first.projection.strategy, "head-tail");
  assert.equal(first.projection.truncated, true);
  assert.ok(first.projection.text.length <= input.maxPreviewChars);
  assert.doesNotMatch(first.projection.text, new RegExp(canary, "u"));

  const recoveredPreview = buildRuntimeToolResultProjection({
    ...input,
    modelOutput: `${rawOutput}\n[Recovery] 请按错误提示继续。`,
  });
  assert.equal(recoveredPreview.projection.mode, "preview");
  assert.equal(recoveredPreview.projection.strategy, "recovery:head-tail");

  const belowHighThreshold = buildRuntimeToolResultProjection({
    ...input,
    thresholdTokens: 100_000,
  });
  assert.equal(belowHighThreshold.shouldArchive, false);
  assert.equal(belowHighThreshold.projection.mode, "full");
  assert.equal(belowHighThreshold.projection.text, rawOutput);

  const defaultThresholdOutput = Array.from({ length: 3_000 }, (_, index) => `token-${index}`).join(
    " ",
  );
  const defaultThreshold = buildRuntimeToolResultProjection({
    toolCall,
    result: toolResult(toolCall, defaultThresholdOutput),
    modelOutput: defaultThresholdOutput,
    maxPreviewChars: 240,
  });
  assert.equal(defaultThreshold.shouldArchive, true);
});

test("bounded evidence readers always return full projections without recursive archiving", () => {
  const output = `PAGE\n${"有界回读😀".repeat(3_000)}`;
  const toolCall = call("read_evidence");
  const result = buildRuntimeToolResultProjection({
    toolCall,
    result: toolResult(toolCall, output),
    modelOutput: output,
    thresholdTokens: 0,
    maxPreviewChars: 1,
  });

  assert.equal(result.shouldArchive, false);
  assert.deepEqual(result.projection, {
    version: 1,
    mode: "full",
    text: output,
    strategy: "bounded-readback",
    truncated: false,
  });
});

test("micro compaction preserves structured Evidence ToolResult projections", () => {
  const evidenceUri = `pico://evidence/projection-session/${"a".repeat(64)}`;
  const event: RuntimeToolResultRecordedEvent = {
    schemaVersion: 2,
    eventId: "tool-result:evidence",
    sessionId: "projection-session",
    invocationId: "invocation:projection",
    runId: "run:projection",
    turnId: "turn:projection",
    at: new Date(0).toISOString(),
    partial: false,
    visibility: "model",
    refs: {
      toolCallId: "call:evidence",
      evidence: {
        schemaVersion: 2,
        contentHash: "a".repeat(64),
        sessionId: "projection-session",
        kind: "tool-exchange",
      },
    },
    kind: "tool.result.recorded",
    data: {
      toolName: "bash",
      status: "succeeded",
      body: {
        storage: "evidence",
        sha256: "b".repeat(64),
        sizeBytes: 10_000,
      },
      projection: {
        version: 1,
        mode: "preview",
        text: "preview\n".repeat(80),
        strategy: "head-tail",
        truncated: true,
      },
    },
  };
  const projected = projectRuntimeToolResultMessage(event);
  assert.equal(projected.toolResultEvidenceUri, evidenceUri);
  assert.match(projected.content, new RegExp(evidenceUri, "u"));

  const compacted = new Compactor({
    maxChars: 1_000,
    retainLastMsgs: 2,
  }).compactOldToolResults(
    [
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call:evidence", name: "bash", arguments: "{}" }],
      },
      projected,
      { role: "user", content: "latest request" },
      { role: "assistant", content: "latest response" },
    ],
    { protectFromIndex: 2, targetTokens: 1 },
  );

  assert.equal(compacted[1]?.toolResultEvidenceUri, evidenceUri);
  assert.match(compacted[1]?.content ?? "", new RegExp(evidenceUri, "u"));
});

function call(name: string): ToolCall {
  return { id: `call:${name}`, name, arguments: "{}" };
}

function toolResult(toolCall: ToolCall, output: string): ToolResult {
  return { toolCallId: toolCall.id, output, isError: false };
}
