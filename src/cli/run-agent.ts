/**
 * Legacy CLI/TUI import surface. Runtime implementation intentionally lives outside src/cli.
 */
export {
  AgentRuntime,
  CostTrackedModelFallbackProvider,
  buildApprovalMiddleware,
  executeAgentRuntime as runAgentFromCli,
  loadImage,
} from "../runtime/agent-runtime.js";

export type {
  AgentRuntimeDependencies,
  AgentRuntimeRequest,
  AgentRuntimeResult,
  RunAgentCliDependencies,
  RunAgentCliOptions,
  RunAgentCliResult,
  RunAgentEnv,
  RunAgentProviderFactory,
  RunAgentUsage,
  RuntimeLifecycleEvent,
  RuntimeHost,
} from "../runtime/agent-runtime.js";
