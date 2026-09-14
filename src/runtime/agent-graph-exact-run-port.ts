import type { SessionManager } from "../engine/session-manager.js";
import type { Session, SessionOptions } from "../engine/session.js";
import type { RuntimeEvent } from "../storage/runtime-event.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type {
  AgentGraphExactRunInspection,
  AgentGraphExactRunPort,
  StartExactAgentGraphRunInput,
} from "./agent-graph-runtime-adapter.js";
import type { AgentGraphRunLaunchState } from "../agent-graph/runtime-activation-projection.js";
import type {
  PrestartedRuntimeRun,
  PrestartedRuntimeUserInput,
} from "@pico/pico-host/runtime-run-executor";
import { isRuntimeRunLive, RuntimeRun } from "./runtime-run.js";
import {
  SqliteAgentGraphExactRunPort as PicoHostAgentGraphExactRunPort,
  type AgentGraphExactRunRuntimePort,
} from "@pico/pico-host/agent-graph-exact-run-port";

export {
  agentGraphInputMessageId,
  agentGraphInputRuntimeEventId,
  inspectAgentGraphExactRun,
} from "@pico/runtime/agent-graph-exact-run-inspection";

export type {
  AgentGraphExactRunIndeterminateReason,
  AgentGraphExactRunInspection,
} from "./agent-graph-runtime-adapter.js";

export interface ExecuteAgentGraphExactRunInput {
  readonly claimId: string;
  readonly session: Session;
  readonly prompt: string;
  readonly prestartedRun: PrestartedRuntimeRun;
  readonly prestartedUserInput: PrestartedRuntimeUserInput;
}

export interface CreateAgentGraphExactRunPortOptions {
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly sessionManager: SessionManager;
  readonly sessionOptions?:
    | SessionOptions
    | ((input: StartExactAgentGraphRunInput) => SessionOptions | undefined);
  /** Fail-closed authority validation that runs before Session pinning or run.started admission. */
  readonly validateStart?: (input: StartExactAgentGraphRunInput) => void | Promise<void>;
  /** Host-owned assembly of SessionRuntime, AgentEngine, providers, tools and observers. */
  execute(input: ExecuteAgentGraphExactRunInput): Promise<void>;
  readonly requestStop?: (input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly reason: string;
  }) => boolean | Promise<boolean>;
  readonly inspectLaunch?: (input: {
    readonly sessionId: string;
    readonly runId: string;
  }) => Promise<AgentGraphRunLaunchState> | AgentGraphRunLaunchState;
}

/**
 * Engine compatibility adapter for Pico Host's exact Graph Run boundary.
 *
 * It is the only place that turns an Engine Session capability into the narrow
 * Runtime admission Port; the ledger and retry arbitration live in Pico Host.
 */
export class SqliteAgentGraphExactRunPort
  extends PicoHostAgentGraphExactRunPort
  implements AgentGraphExactRunPort
{
  constructor(options: CreateAgentGraphExactRunPortOptions) {
    super({
      ...options,
      execute: (input) => options.execute(input as unknown as ExecuteAgentGraphExactRunInput),
      runtimePort: createEngineAgentGraphExactRunRuntimePort(),
    });
  }

  override readRunEvents(sessionId: string, runId: string): Promise<readonly RuntimeEvent[]> {
    return super.readRunEvents(sessionId, runId) as Promise<readonly RuntimeEvent[]>;
  }

  override inspectExactRun(
    input: StartExactAgentGraphRunInput,
  ): Promise<AgentGraphExactRunInspection> {
    return super.inspectExactRun(input);
  }
}

/** Engine-only adapter for Pico Host's narrow exact-run admission Port. */
export function createEngineAgentGraphExactRunRuntimePort(): AgentGraphExactRunRuntimePort {
  return {
    isRunLive: isRuntimeRunLive,
    admitExact: async ({ session, run }) => {
      const sourceSession = session as Session;
      const capability = sourceSession.runtimeEventCapability;
      if (!capability) {
        throw new Error(
          `Graph exact RuntimeRun ${run.runId} resolved without a Runtime capability`,
        );
      }
      await RuntimeRun.admitExact({
        capability,
        runId: run.runId,
        turnId: run.turnId,
        invocationId: run.invocationId,
        runStartedEventId: run.runStartedEventId,
        agentSwarmAuthorization: run.agentSwarmAuthorization,
        presentation: {
          audience: "internal",
          source: "agent_graph_control",
        },
      });
    },
  };
}
