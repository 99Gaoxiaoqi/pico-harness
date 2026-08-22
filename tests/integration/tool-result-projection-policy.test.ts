import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { Compactor } from "../../src/context/compactor.js";
import { projectRuntimeToolResultMessage } from "../../src/engine/runtime-model-message.js";
import type { RuntimeToolResultRecordedEvent } from "../../src/engine/session-runtime-event.js";
import type { ToolCall, ToolResult } from "../../src/schema/message.js";
import {
  buildRuntimeToolResultProjection,
  MAX_TOOL_RESULT_BYTES,
} from "../../src/tools/tool-result-observation.js";

test("ToolResult projection hashes raw UTF-8 bytes and keeps the full model output inline", () => {
  const rawOutput = "原始结果😀\n";
  const toolCall = call("fixture_tool");
  const result = toolResult(toolCall, rawOutput);
  const projected = buildRuntimeToolResultProjection({
    toolCall,
    result,
    modelOutput: rawOutput,
  });

  assert.equal(projected.overLimit, false);
  assert.equal(projected.inlineContent, rawOutput);
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
  });
  // Recovery 文本只进投影;inline 正文与完整性元数据仍描述工具物理输出。
  assert.equal(recovered.inlineContent, rawOutput);
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

test("write-side projection stays full regardless of size — no archive fork below the entry gate", () => {
  // 远超旧 2048 token 阈值的大输出:写入侧不再有 preview/evidence 分叉,全文 inline。
  const canary = "MIDDLE_CANARY_MUST_NOT_APPEAR";
  const rawOutput = `HEAD\n${"A".repeat(800)}\n${canary}\n${"Z".repeat(800)}\nTAIL`;
  const toolCall = call("fixture_tool");
  const input = {
    toolCall,
    result: toolResult(toolCall, rawOutput),
    modelOutput: rawOutput,
  } as const;

  const first = buildRuntimeToolResultProjection(input);
  const second = buildRuntimeToolResultProjection(input);
  assert.deepEqual(second, first);
  assert.equal(first.overLimit, false);
  assert.equal(first.inlineContent, rawOutput);
  assert.equal(first.projection.mode, "full");
  assert.equal(first.projection.strategy, "original");
  assert.equal(first.projection.truncated, false);
  assert.equal(first.projection.text, rawOutput);
});

test("read_evidence results are no longer special-cased as bounded readback", () => {
  const output = `PAGE\n${"有界回读😀".repeat(3_000)}`;
  const toolCall = call("read_evidence");
  const result = buildRuntimeToolResultProjection({
    toolCall,
    result: toolResult(toolCall, output),
    modelOutput: output,
  });

  assert.equal(result.overLimit, false);
  assert.deepEqual(result.projection, {
    version: 1,
    mode: "full",
    text: output,
    strategy: "original",
    truncated: false,
  });
});

test("outputs above MAX_TOOL_RESULT_BYTES are rejected as a deterministic synthetic error", () => {
  const toolCall = call("bash");
  const rawOutput = `${"PICO_OVER_LIMIT_CANARY\n".repeat(50_000)}x`;
  assert.ok(Buffer.byteLength(rawOutput, "utf8") > MAX_TOOL_RESULT_BYTES);

  const gated = buildRuntimeToolResultProjection({
    toolCall,
    result: toolResult(toolCall, rawOutput),
    modelOutput: rawOutput,
  });

  assert.equal(gated.overLimit, true);
  // 原文永久丢弃:合成错误既进 inline 正文,��进 Provider 投影。
  assert.equal(gated.inlineContent.includes("PICO_OVER_LIMIT_CANARY"), false);
  assert.match(gated.inlineContent, /输出超限/u);
  assert.match(gated.inlineContent, new RegExp(String(MAX_TOOL_RESULT_BYTES), "u"));
  assert.match(gated.inlineContent, /grep .*head/u);
  assert.match(gated.inlineContent, /tail/u);
  assert.match(gated.inlineContent, /read_file/u);
  // 元数据描述 inline 合成事实本身,满足事件完整性校验(sha256/sizeBytes ↔ content)。
  assert.equal(gated.rawSizeBytes, Buffer.byteLength(gated.inlineContent, "utf8"));
  assert.equal(
    gated.rawSha256,
    createHash("sha256").update(gated.inlineContent, "utf8").digest("hex"),
  );
  assert.deepEqual(
    { ...gated.projection, text: "..." },
    {
      version: 1,
      mode: "synthetic",
      text: "...",
      strategy: "output-limit-gate",
      truncated: true,
    },
  );

  const again = buildRuntimeToolResultProjection({
    toolCall,
    result: toolResult(toolCall, rawOutput),
    modelOutput: rawOutput,
  });
  assert.deepEqual(again, gated);

  // 边界:恰好等于上限字节数的结果照常 inline 全文(> 才拒绝)。
  const boundaryOutput = "a".repeat(MAX_TOOL_RESULT_BYTES);
  const boundary = buildRuntimeToolResultProjection({
    toolCall,
    result: toolResult(toolCall, boundaryOutput),
    modelOutput: boundaryOutput,
  });
  assert.equal(boundary.overLimit, false);
  assert.equal(boundary.inlineContent, boundaryOutput);
  assert.equal(boundary.projection.mode, "full");
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
  // 旧 storage:"evidence" 事件 decode 不炸:预览与引用仍可投影(ADR 26 §2.5)。
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
