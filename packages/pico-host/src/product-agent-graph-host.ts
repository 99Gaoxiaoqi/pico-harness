import type { Session, SessionOptions } from "@pico/pico-host/session";
import type { SessionManager } from "@pico/pico-host/session-manager";
import {
  createAgentGraphWorkspaceHost as createPicoHostAgentGraphWorkspaceHost,
  type AgentGraphWorkspaceHost as PicoHostAgentGraphWorkspaceHost,
  type AgentGraphRunToolBinding,
  type CreateAgentGraphWorkspaceHostOptions as PicoHostCreateAgentGraphWorkspaceHostOptions,
  type ExecuteHostedAgentGraphRunInput as PicoHostExecuteHostedAgentGraphRunInput,
} from "@pico/pico-host/agent-graph-workspace-host";
import { createEngineAgentGraphExactRunRuntimePort } from "@pico/pico-host/product-agent-graph-exact-run-port";

export type { AgentGraphRunToolBinding };
export type AgentGraphWorkspaceHost = PicoHostAgentGraphWorkspaceHost;

/** Engine-facing callback input retained for legacy Runtime callers. */
export interface ExecuteHostedAgentGraphRunInput extends Omit<
  PicoHostExecuteHostedAgentGraphRunInput,
  "session"
> {
  readonly session: Session;
}

/**
 * Engine compatibility adapter for Pico Host's Graph workspace composition.
 * New package consumers inject narrow Session ports directly; this legacy entry
 * keeps existing SessionManager and detached-execution callers unchanged.
 */
export interface CreateAgentGraphWorkspaceHostOptions extends Omit<
  PicoHostCreateAgentGraphWorkspaceHostOptions,
  "sessionManager" | "runtimePort" | "sessionOptions" | "execute"
> {
  readonly sessionManager: SessionManager;
  readonly sessionOptions?: SessionOptions;
  execute(input: ExecuteHostedAgentGraphRunInput): Promise<void>;
}

export { assertAgentGraphRootRunSettled } from "@pico/runtime/agent-graph-root-run-settlement";

export function createAgentGraphWorkspaceHost(
  options: CreateAgentGraphWorkspaceHostOptions,
): AgentGraphWorkspaceHost {
  return createPicoHostAgentGraphWorkspaceHost({
    ...options,
    sessionManager: options.sessionManager,
    ...(options.sessionOptions ? { sessionOptions: options.sessionOptions } : {}),
    runtimePort: createEngineAgentGraphExactRunRuntimePort(),
    execute: (input) => options.execute(input as unknown as ExecuteHostedAgentGraphRunInput),
  });
}
