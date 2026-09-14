import type { RuntimeEvent } from "@pico/core";
import type {
  AgentGraphExactRunInspection,
  AgentGraphExactRunPort,
  AgentGraphRunLaunchState,
  StartExactAgentGraphRunInput,
} from "@pico/runtime";
import {
  agentGraphInputMessageId,
  inspectAgentGraphExactRun,
} from "@pico/runtime/agent-graph-exact-run-inspection";
import { canonicalizeWorkspacePath } from "@pico/storage/workspace-path";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";

export interface AgentGraphExactRunSessionOptions {
  readonly picoHome?: string;
  readonly runtimeStorageRoot?: string;
}

export interface AgentGraphExactRunSession {
  readonly id: string;
  readonly workDir: string;
  readonly hasPendingTasks: boolean;
  readonly runtimeEventCapability?: object;
  readonly runtimeEventStore?: Pick<SqliteRuntimeEventStore, "storageRoot">;
}

export interface AgentGraphExactRunSessionLease {
  readonly session: AgentGraphExactRunSession;
  release(): void;
}

/** Engine Session lifecycle is injected at the Pico Host boundary. */
export interface AgentGraphExactRunSessionManagerPort {
  getOrCreatePinned(
    id: string,
    workDir: string,
    options?: AgentGraphExactRunSessionOptions,
  ): Promise<AgentGraphExactRunSessionLease>;
}

export interface AgentGraphExactRunRuntimePort {
  isRunLive(sessionId: string, runId: string): boolean;
  admitExact(input: {
    readonly session: AgentGraphExactRunSession;
    readonly run: StartExactAgentGraphRunInput;
  }): Promise<void>;
}

export interface AgentGraphPrestartedRuntimeRun {
  readonly runId: string;
  readonly turnId?: string;
  readonly invocationId: string;
  readonly runStartedEventId: string;
  readonly runStartedAt: string;
  readonly parentRunId?: string;
  readonly presentation?: "internal";
  readonly agentSwarmAuthorization: StartExactAgentGraphRunInput["agentSwarmAuthorization"];
}

export interface AgentGraphPrestartedRuntimeUserInput {
  readonly messageId: string;
  readonly presentation?: "internal";
}

export interface ExecuteAgentGraphExactRunInput {
  readonly claimId: string;
  readonly session: AgentGraphExactRunSession;
  readonly prompt: string;
  readonly prestartedRun: AgentGraphPrestartedRuntimeRun;
  readonly prestartedUserInput: AgentGraphPrestartedRuntimeUserInput;
}

export interface CreateAgentGraphExactRunPortOptions {
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly sessionManager: AgentGraphExactRunSessionManagerPort;
  readonly sessionOptions?:
    | AgentGraphExactRunSessionOptions
    | ((input: StartExactAgentGraphRunInput) => AgentGraphExactRunSessionOptions | undefined);
  readonly validateStart?: (input: StartExactAgentGraphRunInput) => void | Promise<void>;
  execute(input: ExecuteAgentGraphExactRunInput): Promise<void>;
  readonly runtimePort: AgentGraphExactRunRuntimePort;
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
 * SQLite-ledger implementation of Graph's exact RuntimeRun admission boundary.
 *
 * This port never constructs providers or tools. It admits one immutable start,
 * proves that an existing run is safe to attach, then delegates host assembly.
 * Any durable dispatch fact without a terminal result is observed fail-closed.
 */
export class SqliteAgentGraphExactRunPort implements AgentGraphExactRunPort {
  private readonly starts = new Map<string, Promise<"started" | "observed">>();

  constructor(private readonly options: CreateAgentGraphExactRunPortOptions) {}

  readRunEvents(sessionId: string, runId: string): Promise<readonly RuntimeEvent[]> {
    return this.options.runtimeEventStore.readRun(sessionId, runId);
  }

  async inspectLaunch(input: {
    readonly sessionId: string;
    readonly runId: string;
  }): Promise<AgentGraphRunLaunchState> {
    const hostState = await this.options.inspectLaunch?.(input);
    if (hostState && hostState.status !== "unknown") return hostState;
    return this.options.runtimePort.isRunLive(input.sessionId, input.runId)
      ? { status: "running" }
      : (hostState ?? { status: "unknown" });
  }

  startExactRun(input: StartExactAgentGraphRunInput): Promise<"started" | "observed"> {
    const key = `${input.sessionId}\u0000${input.runId}`;
    const pending = this.starts.get(key);
    if (pending) return pending;
    const started = this.startExactRunOnce(input).finally(() => {
      if (this.starts.get(key) === started) this.starts.delete(key);
    });
    this.starts.set(key, started);
    return started;
  }

  async inspectExactRun(
    input: StartExactAgentGraphRunInput,
  ): Promise<AgentGraphExactRunInspection> {
    const events = await this.readRunEvents(input.sessionId, input.runId);
    return inspectAgentGraphExactRun(
      input,
      events,
      this.options.runtimePort.isRunLive(input.sessionId, input.runId),
    );
  }

  async stopExactRun(input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly reason: string;
  }): Promise<"requested" | "already_terminal" | "not_started"> {
    const events = await this.readRunEvents(input.sessionId, input.runId);
    if (events.length === 0) return "not_started";
    if (events.some((event) => event.kind === "run.terminal")) return "already_terminal";
    if (!this.options.requestStop) {
      throw new Error(
        `Graph RuntimeRun ${input.runId} is active but the host has no stop boundary`,
      );
    }
    const requested = await this.options.requestStop(input);
    if (!requested) {
      const latest = await this.readRunEvents(input.sessionId, input.runId);
      if (latest.some((event) => event.kind === "run.terminal")) return "already_terminal";
      throw new Error(`Graph RuntimeRun ${input.runId} is not owned by this host`);
    }
    return "requested";
  }

  private async startExactRunOnce(
    input: StartExactAgentGraphRunInput,
  ): Promise<"started" | "observed"> {
    assertStartInput(input);
    await this.options.validateStart?.(input);
    const sessionOptions =
      typeof this.options.sessionOptions === "function"
        ? this.options.sessionOptions(input)
        : this.options.sessionOptions;
    const lease = await this.options.sessionManager.getOrCreatePinned(
      input.sessionId,
      input.workDir,
      sessionOptions,
    );
    try {
      const session = lease.session;
      assertSessionAuthority(session, input, this.options.runtimeEventStore);
      const before = await this.inspectExactRun(input);
      if (
        before.status === "terminal" ||
        before.status === "live" ||
        before.status === "indeterminate"
      ) {
        return "observed";
      }
      if (session.hasPendingTasks) return "observed";

      if (before.status === "not_started") {
        await this.options.runtimePort.admitExact({ session, run: input });
      }

      const admitted = await this.inspectExactRun(input);
      if (admitted.status !== "attachable") return "observed";
      const prestartedRun: AgentGraphPrestartedRuntimeRun = {
        runId: input.runId,
        turnId: input.turnId,
        invocationId: input.invocationId,
        runStartedEventId: input.runStartedEventId,
        runStartedAt: admitted.startEvent.at,
        agentSwarmAuthorization: admitted.startEvent.data.agentSwarmAuthorization,
        ...(admitted.startEvent.data.presentation ? { presentation: "internal" as const } : {}),
      };
      await this.options.execute({
        claimId: input.claimId,
        session,
        prompt: input.prompt,
        prestartedRun,
        prestartedUserInput: {
          messageId: agentGraphInputMessageId(input.claimId),
          // A pre-existing input may come from a build before presentation provenance existed.
          // Preserve that exact payload on attach; fresh Graph control input is internal.
          ...(admitted.input === "missing" ? { presentation: "internal" as const } : {}),
        },
      });
      return "started";
    } finally {
      lease.release();
    }
  }
}

function assertStartInput(input: StartExactAgentGraphRunInput): void {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Graph exact RuntimeRun ${field} must not be empty`);
    }
  }
  if (!isAgentSwarmAuthorization(input.agentSwarmAuthorization)) {
    throw new Error("Graph exact RuntimeRun agentSwarmAuthorization is invalid");
  }
}

function isAgentSwarmAuthorization(value: unknown): boolean {
  return value === "none" || value === "session_mode" || value === "turn_override";
}

function assertSessionAuthority(
  session: AgentGraphExactRunSession,
  input: StartExactAgentGraphRunInput,
  runtimeEventStore: SqliteRuntimeEventStore,
): void {
  if (
    session.id !== input.sessionId ||
    canonicalizeWorkspacePath(session.workDir) !== canonicalizeWorkspacePath(input.workDir) ||
    !session.runtimeEventCapability ||
    session.runtimeEventStore?.storageRoot !== runtimeEventStore.storageRoot
  ) {
    throw new Error(`Graph exact RuntimeRun ${input.runId} resolved to another Session authority`);
  }
}
