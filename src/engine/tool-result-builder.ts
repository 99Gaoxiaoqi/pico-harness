import type { RuntimeToolResultStatus, ToolCall, ToolResult } from "@pico/core";
import {
  buildEphemeralToolResult as buildRuntimeEphemeralToolResult,
  buildRuntimeToolResultInput as buildRuntimeToolResultInputInRuntime,
  redactToolResult,
  type RuntimeToolResultLogger,
} from "@pico/runtime/tool-result-builder";
import { logger } from "../observability/logger.js";

export { redactToolResult, type RuntimeToolResultLogger };

/** @deprecated ToolResult 构造已迁至 @pico/runtime。 */
export function buildRuntimeToolResultInput(
  toolCall: ToolCall,
  result: ToolResult,
  modelOutput: string,
  status: RuntimeToolResultStatus,
) {
  return buildRuntimeToolResultInputInRuntime(toolCall, result, modelOutput, status, logger);
}

/** @deprecated ToolResult 构造已迁至 @pico/runtime。 */
export function buildEphemeralToolResult(
  toolCall: ToolCall,
  result: ToolResult,
  modelOutput: string,
  status: RuntimeToolResultStatus,
) {
  return buildRuntimeEphemeralToolResult(toolCall, result, modelOutput, status, logger);
}
