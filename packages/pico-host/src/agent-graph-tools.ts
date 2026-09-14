import {
  createAgentGraphSupervisorTools as createRuntimeAgentGraphSupervisorTools,
  type CreateAgentGraphSupervisorToolsOptions,
} from "@pico/runtime/agent-graph-tools";
import type { BaseTool } from "./tool-registry-contract.js";

export * from "@pico/runtime/agent-graph-tools";

/** Bind the Runtime projection tools to the physical Host Registry contract. */
export function createAgentGraphSupervisorTools(
  options: CreateAgentGraphSupervisorToolsOptions,
): readonly BaseTool[] {
  return createRuntimeAgentGraphSupervisorTools(options);
}
