import { logger } from "../observability/logger.js";
import { GrepTool as PicoHostGrepTool, type GrepToolOptions } from "@pico/pico-host/grep-tool";
import type { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

export * from "@pico/pico-host/grep-tool";

/** @deprecated Grep 实现已迁至 @pico/pico-host；旧入口保留 diagnostics 装配。 */
export class GrepTool extends PicoHostGrepTool {
  constructor(workDirOrRoots: string | WorkspaceRoots, options: GrepToolOptions = {}) {
    super(workDirOrRoots, { ...options, diagnostics: options.diagnostics ?? logger });
  }
}
