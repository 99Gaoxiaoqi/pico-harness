import {
  createChildAgentToolConstructors,
  createHookVerifierRegistry as createHostHookVerifierRegistry,
} from "@pico/pico-host/child-agent-policy";
import { logger } from "../observability/logger.js";

export * from "@pico/pico-host/child-agent-policy";

/** @deprecated 子代理工具装配已迁至 Host；旧入口保留日志注入。 */
export const CHILD_AGENT_TOOL_CONSTRUCTORS = createChildAgentToolConstructors(logger);

/** @deprecated Hook verifier 工具装配已迁至 Host；旧入口保留日志注入。 */
export function createHookVerifierRegistry(
  options: Omit<
    Parameters<typeof createHostHookVerifierRegistry>[0],
    "diagnostics" | "skillLogger" | "grepDiagnostics"
  >,
): ReturnType<typeof createHostHookVerifierRegistry> {
  return createHostHookVerifierRegistry({
    ...options,
    diagnostics: logger,
    skillLogger: logger,
    grepDiagnostics: logger,
  });
}
