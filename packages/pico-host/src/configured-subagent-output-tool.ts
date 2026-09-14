import { ConfiguredSubagentOutputTool as RuntimeConfiguredSubagentOutputTool } from "@pico/runtime/configured-subagent-output-tool";
import type { BaseTool, ToolExecutionContext } from "./tool-registry-contract.js";
import { NO_FILE_SIDE_EFFECTS } from "./tool-registry-contract.js";

export type {
  ConfiguredSubagentOutputPort,
  ConfiguredSubagentOutputQuery,
} from "@pico/runtime/configured-subagent-output-tool";
import type { ConfiguredSubagentOutputPort } from "@pico/runtime/configured-subagent-output-tool";

/** @deprecated 输入投影已迁至 @pico/runtime；父子授权和读取仍由宿主端口实现。 */
class LegacyConfiguredSubagentOutputTool extends RuntimeConfiguredSubagentOutputTool<ToolExecutionContext> {
  override readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
}

/** 保留源码工具注册契约。 */
export function createConfiguredSubagentOutputTool(options: {
  readonly port: ConfiguredSubagentOutputPort;
}): BaseTool {
  return new LegacyConfiguredSubagentOutputTool(options.port);
}
