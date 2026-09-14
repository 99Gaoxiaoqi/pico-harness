import { AgentOutputTool as RuntimeAgentOutputTool } from "@pico/runtime/agent-output-tool";
import type {
  BaseTool,
  ToolExecutionContext,
} from "@pico/pico-host/tool-registry-contract";
import { NO_FILE_SIDE_EFFECTS } from "@pico/pico-host/tool-registry-contract";

export type {
  AgentOutputCommitPort,
  AgentOutputEventPayload,
  AgentOutputStatus,
  CommitAgentOutputInput,
  CommitAgentOutputReceipt,
  GraphOperatorActivationContext,
} from "@pico/core/agent-output-contracts";
export {
  AGENT_OUTPUT_MAX_BYTES,
  AGENT_OUTPUT_MAX_REFS,
  AGENT_OUTPUT_MAX_REF_BYTES,
  agentOutputFingerprint,
  agentOutputIdempotencyKey,
} from "@pico/runtime/agent-output-tool";
export type {
  AgentOutputToolResult,
  CreateAgentOutputToolOptions,
} from "@pico/runtime/agent-output-tool";
import type { CreateAgentOutputToolOptions } from "@pico/runtime/agent-output-tool";

/** @deprecated 输入、身份与回执校验已迁至 @pico/runtime。 */
class LegacyAgentOutputTool extends RuntimeAgentOutputTool<ToolExecutionContext> {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}

/** 保留源码工具注册契约，提交端口仍由宿主注入。 */
export function createAgentOutputTool(options: CreateAgentOutputToolOptions): BaseTool {
  return new LegacyAgentOutputTool(options);
}
