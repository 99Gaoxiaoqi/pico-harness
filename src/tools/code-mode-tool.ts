import {
  createCodeModeTool as createHostCodeModeTool,
  type CodeModeToolOptions,
} from "@pico/pico-host/code-mode-tool";
import { logger } from "../observability/logger.js";

export type { CodeModeToolOptions, CodeModeRuntimeRun } from "@pico/pico-host/code-mode-tool";

/** Preserve the legacy structured diagnostics while Host owns the implementation. */
export function createCodeModeTool(options: CodeModeToolOptions) {
  return createHostCodeModeTool({ ...options, diagnostics: options.diagnostics ?? logger });
}
