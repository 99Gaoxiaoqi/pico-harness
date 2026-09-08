import type { Message, ToolCall, ToolResult } from "../schema/message.js";
import type {
  EngineRuntimeToolResultInput,
  EngineRuntimeToolResultStatus,
} from "./runtime-port.js";
import { createToolResultEnvelope, type ToolResultEnvelope } from "./tool-result-contract.js";
import {
  buildRuntimeToolResultProjection,
  MAX_TOOL_RESULT_BYTES,
} from "../tools/tool-result-observation.js";
import { logger } from "../observability/logger.js";
const TOOL_RESULT_REDACTION_MARKER = "[REDACTED]";
export function redactToolResult(result: ToolResult, secrets: readonly string[]): ToolResult {
  if (secrets.length === 0) return result;
  let output = result.output;
  for (const secret of secrets) {
    output = output.replaceAll(secret, TOOL_RESULT_REDACTION_MARKER);
  }
  return output === result.output ? result : { ...result, output };
}

/**
 * ADR 26(票 E1):工具结果全文 inline 入库,无 Evidence 归档分叉。
 * 超过 MAX_TOOL_RESULT_BYTES 的结果在门口拒绝——inline 正文与投影替换为
 * 合成错误(指引模型用 grep/head/tail 管道或 read_file 分段重取),事件
 * 状态记为 rejected,调用本身照常入账。
 */
export function buildRuntimeToolResultInput(
  toolCall: ToolCall,
  result: ToolResult,
  modelOutput: string,
  status: EngineRuntimeToolResultStatus,
): { input: EngineRuntimeToolResultInput; envelope: ToolResultEnvelope } {
  const built = buildRuntimeToolResultProjection({
    toolCall,
    result,
    modelOutput,
  });
  if (built.overLimit) {
    logger.warn(
      {
        tool: toolCall.name,
        toolCallId: toolCall.id,
        rawSizeBytes: Buffer.byteLength(result.output, "utf8"),
        maxToolResultBytes: MAX_TOOL_RESULT_BYTES,
      },
      "[ToolResult] 输出超限,结果已被入口上限门拒绝并替换为合成错误",
    );
  }
  const input: EngineRuntimeToolResultInput = {
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    status: built.overLimit ? "rejected" : status,
    body: {
      storage: "inline",
      content: built.inlineContent,
      sha256: built.rawSha256,
      sizeBytes: built.rawSizeBytes,
    },
    projection: built.projection,
  };
  return {
    input,
    envelope: createToolResultEnvelope(input),
  };
}

export function buildEphemeralToolResult(
  toolCall: ToolCall,
  result: ToolResult,
  modelOutput: string,
  status: EngineRuntimeToolResultStatus,
): { message: Message; envelope: ToolResultEnvelope } {
  const built = buildRuntimeToolResultInput(toolCall, result, modelOutput, status);
  return {
    message: {
      role: "user",
      content: built.input.projection.text,
      toolCallId: toolCall.id,
    },
    envelope: built.envelope,
  };
}
