import { createHash } from "node:crypto";

import type { SessionManager } from "../engine/session-manager.js";
import type { Session, SessionOptions } from "../engine/session.js";
import { canonicalizeWorkspacePath } from "../paths/pico-paths.js";
import type { RuntimeEvent, RuntimeRunStartedEvent } from "../storage/runtime-event.js";
import { RuntimeEventStoreIntegrityError } from "../storage/runtime-event-store-contracts.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type {
  AgentGraphExactRunInspection,
  AgentGraphExactRunPort,
  StartExactAgentGraphRunInput,
} from "./agent-graph-runtime-adapter.js";
import type { AgentGraphRunLaunchState } from "../agent-graph/runtime-activation-projection.js";
import type { PrestartedRuntimeRun, PrestartedRuntimeUserInput } from "./runtime-run-executor.js";
import { isRuntimeRunLive, RuntimeRun } from "./runtime-run.js";

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
    return isRuntimeRunLive(input.sessionId, input.runId)
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
    return inspectAgentGraphExactRun(input, events, isRuntimeRunLive(input.sessionId, input.runId));
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
        await RuntimeRun.admitExact({
          capability: session.runtimeEventCapability!,
          runId: input.runId,
          turnId: input.turnId,
          invocationId: input.invocationId,
          runStartedEventId: input.runStartedEventId,
          presentation: {
            audience: "internal",
            source: "agent_graph_control",
          },
        });
      }

      const admitted = await this.inspectExactRun(input);
      if (admitted.status !== "attachable") return "observed";
      const prestartedRun: PrestartedRuntimeRun = {
        runId: input.runId,
        turnId: input.turnId,
        invocationId: input.invocationId,
        runStartedEventId: input.runStartedEventId,
        runStartedAt: admitted.startEvent.at,
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

export function inspectAgentGraphExactRun(
  input: StartExactAgentGraphRunInput,
  events: readonly RuntimeEvent[],
  live = false,
): AgentGraphExactRunInspection {
  if (events.length === 0) return { status: "not_started" };
  const start = requireExactStart(input, events);
  const terminals = events.filter(
    (event): event is Extract<RuntimeEvent, { kind: "run.terminal" }> =>
      event.kind === "run.terminal",
  );
  if (terminals.length > 1) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph RuntimeRun ${input.runId} has conflicting terminal facts`,
    );
  }
  if (terminals[0]) {
    return { status: "terminal", startEvent: start, terminalEvent: terminals[0] };
  }
  if (live) return { status: "live", startEvent: start };

  const providerDispatches = events.filter((event) => event.kind === "model.call.started");
  if (providerDispatches.length > 0) {
    return {
      status: "indeterminate",
      reason: "provider_dispatch_recorded",
      startEvent: start,
      blockingEventIds: providerDispatches.map((event) => event.eventId),
    };
  }
  const toolDispatches = events.filter((event) => event.kind === "tool.started");
  if (toolDispatches.length > 0) {
    return {
      status: "indeterminate",
      reason: "tool_dispatch_recorded",
      startEvent: start,
      blockingEventIds: toolDispatches.map((event) => event.eventId),
    };
  }

  const inputEventId = agentGraphInputRuntimeEventId(input.claimId);
  const allowedInput = events.find((event) => event.eventId === inputEventId);
  if (
    allowedInput &&
    (allowedInput.kind !== "message.committed" || allowedInput.data.message.role !== "user")
  ) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph input event ${inputEventId} is bound to an incompatible Runtime fact`,
    );
  }
  const unexpected = events.filter(
    (event) => event.kind !== "run.started" && event.eventId !== inputEventId,
  );
  if (unexpected.length > 0) {
    return {
      status: "indeterminate",
      reason: "unexpected_runtime_fact",
      startEvent: start,
      blockingEventIds: unexpected.map((event) => event.eventId),
    };
  }
  return {
    status: "attachable",
    startEvent: start,
    input: allowedInput ? "committed" : "missing",
  };
}

export function agentGraphInputMessageId(claimId: string): string {
  return `agent-graph-input:${createHash("sha256").update(claimId).digest("hex")}`;
}

export function agentGraphInputRuntimeEventId(claimId: string): string {
  return `user-message:${agentGraphInputMessageId(claimId)}`;
}

function requireExactStart(
  input: StartExactAgentGraphRunInput,
  events: readonly RuntimeEvent[],
): RuntimeRunStartedEvent {
  for (const event of events) {
    if (
      event.sessionId !== input.sessionId ||
      event.runId !== input.runId ||
      event.invocationId !== input.invocationId
    ) {
      throw new RuntimeEventStoreIntegrityError(
        `Graph RuntimeRun ${input.runId} contains a conflicting event identity`,
      );
    }
  }
  const starts = events.filter(
    (event): event is RuntimeRunStartedEvent => event.kind === "run.started",
  );
  if (starts.length !== 1) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph RuntimeRun ${input.runId} must contain exactly one run.started fact`,
    );
  }
  const start = starts[0]!;
  if (
    start.eventId !== input.runStartedEventId ||
    start.turnId !== input.turnId ||
    canonicalizeWorkspacePath(start.data.workDir) !== canonicalizeWorkspacePath(input.workDir)
  ) {
    throw new RuntimeEventStoreIntegrityError(
      `Graph RuntimeRun ${input.runId} does not match its preallocated Claim identity`,
    );
  }
  return start;
}

function assertStartInput(input: StartExactAgentGraphRunInput): void {
  for (const [field, value] of Object.entries(input)) {
    if (typeof value !== "string" || !value.trim()) {
      throw new Error(`Graph exact RuntimeRun ${field} must not be empty`);
    }
  }
}

function assertSessionAuthority(
  session: Session,
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
