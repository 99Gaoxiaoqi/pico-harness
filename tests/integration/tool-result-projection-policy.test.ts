import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
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
  assert.equal(first.projection.strategy, "fallback-head-tail");
  assert.equal(first.projection.truncated, true);
  assert.ok(first.projection.text.length <= input.maxPreviewChars);
  assert.doesNotMatch(first.projection.text, new RegExp(canary, "u"));

  const recoveredPreview = buildRuntimeToolResultProjection({
    ...input,
    modelOutput: `${rawOutput}\n[Recovery] 请按错误提示继续。`,
  });
  assert.equal(recoveredPreview.projection.mode, "preview");
  assert.equal(recoveredPreview.projection.strategy, "recovery:fallback-head-tail");

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

function call(name: string): ToolCall {
  return { id: `call:${name}`, name, arguments: "{}" };
}

function toolResult(toolCall: ToolCall, output: string): ToolResult {
  return { toolCallId: toolCall.id, output, isError: false };
}
