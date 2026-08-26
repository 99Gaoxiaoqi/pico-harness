import { createHash } from "node:crypto";

import type {
  AgentGraphRootWakePort,
  RootSupervisorRunIdentity,
  RootSupervisorRunState,
} from "../daemon/agent-graph-supervisor-service.js";
import type {
  AgentGraphExactRunInspection,
  SqliteAgentGraphExactRunPort,
} from "./agent-graph-exact-run-port.js";
import type { StartExactAgentGraphRunInput } from "./agent-graph-runtime-adapter.js";

export const AGENT_GRAPH_ROOT_WAKE_PAYLOAD_MAX_BYTES = 32 * 1024;

export interface AgentGraphRootWakeRuntimePortOptions {
  readonly exactRuns: Pick<
    SqliteAgentGraphExactRunPort,
    "inspectExactRun" | "startExactRun"
  >;
  readonly workDir: string;
}

/** Maps durable Supervisor wake attempts onto exact root-session RuntimeRuns. */
export class AgentGraphRootWakeRuntimePort implements AgentGraphRootWakePort {
  constructor(private readonly options: AgentGraphRootWakeRuntimePortOptions) {
    if (!options.workDir.trim()) throw new Error("Graph root wake workDir must not be empty");
  }

  async inspect(input: RootSupervisorRunIdentity): Promise<RootSupervisorRunState> {
    return rootWakeState(await this.options.exactRuns.inspectExactRun(this.exactInput(input)));
  }

  async startOrResume(
    input: RootSupervisorRunIdentity & { readonly payload: unknown },
  ): Promise<RootSupervisorRunState> {
    const exact = this.exactInput(input, renderRootWakePrompt(input));
    try {
      await this.options.exactRuns.startExactRun(exact);
    } catch (error) {
      if (isPermissionBoundaryError(error)) {
        return { status: "waiting_permission", error: errorMessage(error) };
      }
      return { status: "failed", error: errorMessage(error) };
    }
    return rootWakeState(await this.options.exactRuns.inspectExactRun(exact));
  }

  private exactInput(
    input: RootSupervisorRunIdentity,
    prompt = renderRootWakePrompt({ ...input, payload: undefined }),
  ): StartExactAgentGraphRunInput {
    const identity = stableRootWakeIdentity(input);
    return {
      claimId: `root-wake:${input.wakeId}`,
      sessionId: input.rootSessionId,
      turnId: input.targetTurnId,
      runId: input.targetRunId,
      invocationId: `graph-root-invocation:${identity}`,
      runStartedEventId: `graph-root-run-started:${identity}`,
      workDir: this.options.workDir,
      prompt,
    };
  }
}

export function rootWakeState(
  inspection: AgentGraphExactRunInspection,
): RootSupervisorRunState {
  switch (inspection.status) {
    case "not_started":
      return { status: "not_started" };
    case "attachable":
    case "live":
      return { status: "running" };
    case "terminal":
      return inspection.terminalEvent.data.status === "completed"
        ? { status: "completed" }
        : {
            status: "failed",
            error:
              inspection.terminalEvent.data.reason ??
              `Root Supervisor Run ended as ${inspection.terminalEvent.data.status}`,
          };
    case "indeterminate":
      // An exact Run with a durable provider/tool dispatch cannot be retried safely.
      // Park it behind the existing manual-resume boundary instead of creating a retry loop.
      return {
        status: "waiting_permission",
        error: `Root Supervisor Run requires operator review: ${inspection.reason} (${inspection.blockingEventIds.join(", ")})`,
      };
  }
}

export function renderRootWakePrompt(
  input: RootSupervisorRunIdentity & { readonly payload?: unknown },
): string {
  const payload = JSON.stringify(input.payload ?? null);
  if (Buffer.byteLength(payload, "utf8") > AGENT_GRAPH_ROOT_WAKE_PAYLOAD_MAX_BYTES) {
    throw new Error(
      `Graph root wake payload exceeds ${AGENT_GRAPH_ROOT_WAKE_PAYLOAD_MAX_BYTES} bytes`,
    );
  }
  return [
    "[Graph Supervisor wake]",
    `Graph ${input.graphId} has a new durable scheduling fact (wake ${input.wakeId}).`,
    "Call view_agent_graph first. Then submit the next atomic update, or finish the Graph. If work remains, call yield_agent_graph again.",
    `Wake payload: ${payload}`,
  ].join("\n");
}

function stableRootWakeIdentity(input: RootSupervisorRunIdentity): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        "agent-graph-root-wake-v1",
        input.wakeId,
        input.graphId,
        input.rootSessionId,
        input.targetTurnId,
        input.targetRunId,
      ]),
    )
    .digest("hex");
}

function isPermissionBoundaryError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  return /permission|approval|审批|权限/i.test(`${error.name}: ${error.message}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
