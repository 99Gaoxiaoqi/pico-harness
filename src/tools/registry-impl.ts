import {
  ToolRegistry as PicoHostToolRegistry,
  type ToolRegistryDiagnostics,
} from "@pico/pico-host/tool-registry";
import {
  sharedToolResourceAuthority,
  type ToolResourceAuthority,
} from "@pico/runtime/tool-resource-authority";
import { logger } from "../observability/logger.js";

const diagnostics: ToolRegistryDiagnostics = {
  info(contextOrMessage, message) {
    if (typeof contextOrMessage === "string") logger.info(contextOrMessage);
    else logger.info(contextOrMessage, message);
  },
  warn(contextOrMessage, message) {
    if (typeof contextOrMessage === "string") logger.warn(contextOrMessage);
    else logger.warn(contextOrMessage, message);
  },
};

/** @deprecated ToolRegistry 实现已迁至 @pico/pico-host；旧入口保留日志装配。 */
export class ToolRegistry extends PicoHostToolRegistry {
  constructor(resourceAuthority: Pick<ToolResourceAuthority, "run"> = sharedToolResourceAuthority) {
    super(resourceAuthority, diagnostics);
  }
}

export { createToolRegistrationOwner } from "@pico/pico-host/tool-registry";
export type { ToolRegistrationOwner, ToolRegistryDiagnostics } from "@pico/pico-host/tool-registry";

// Legacy aggregate exports remain here until the concrete tools move to Host packages.
export { ReadFileTool } from "@pico/pico-host/read-file-tool";
export { WriteFileTool } from "@pico/pico-host/write-file-tool";
export { EditFileTool, generateSimpleDiff } from "@pico/pico-host/edit-file-tool";
export { TaskListTool, TaskOutputTool, TaskStopTool } from "@pico/runtime/background-task-tools";
export {
  BashTool,
  DEFAULT_BASH_TIMEOUT_MS,
  MIN_BASH_TIMEOUT_MS,
  MAX_BASH_TIMEOUT_MS,
  resolveBashTimeoutMs,
} from "@pico/pico-host/bash-tool";
export { safeResolve } from "@pico/pico-host/file-tool-helpers";
