/** @deprecated Claude Tool compatibility mapping has moved to @pico/core. */
import { logger } from "../observability/logger.js";
import { mapClaudeToolNames as mapCoreClaudeToolNames } from "@pico/core/claude-tool-compat";
export type { ClaudeToolMappingResult } from "@pico/core/claude-tool-compat";

/** Preserve the outer observability hook while Core owns the deterministic mapping. */
export function mapClaudeToolNames(
  declaredTools: readonly string[],
  context?: { readonly resource: string; readonly sourcePath?: string },
) {
  const result = mapCoreClaudeToolNames(declaredTools);
  if (result.unknown.length > 0) {
    logger.warn(
      {
        resource: context?.resource,
        sourcePath: context?.sourcePath,
        tools: result.unknown,
      },
      "[catalog] Claude 资源声明了未知工具，已按 fail-closed 处理",
    );
  }
  return result;
}
