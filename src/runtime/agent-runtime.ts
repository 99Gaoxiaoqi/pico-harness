import { AgentRuntime as HostAgentRuntime, executeAgentRuntime as executeHostAgentRuntime, type RunAgentCliDependencies, type RunAgentCliOptions, type RunAgentCliResult } from "@pico/pico-host/agent-runtime";
import { TerminalReporter } from "@pico/cli/terminal-reporter";
export * from "@pico/pico-host/agent-runtime";
/** Legacy embedded entrypoint preserves terminal output; Host defaults to silent reporting. */
export class AgentRuntime extends HostAgentRuntime {
  override execute(options: RunAgentCliOptions, host: RunAgentCliDependencies = {}): Promise<RunAgentCliResult> {
    return executeAgentRuntime(options, host);
  }
}
export function executeAgentRuntime(options: RunAgentCliOptions, host: RunAgentCliDependencies = {}): Promise<RunAgentCliResult> {
  return executeHostAgentRuntime(options, { ...host, reporter: host.reporter ?? new TerminalReporter() });
}
