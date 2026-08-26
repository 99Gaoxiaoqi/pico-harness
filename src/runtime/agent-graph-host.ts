import type { Session, SessionOptions } from "../engine/session.js";
import type { SessionManager } from "../engine/session-manager.js";
import {
  createAgentGraphApplicationService,
  type AgentGraphApplicationService,
} from "../agent-graph/service.js";
import type {
  ResolveAgentGraphOperatorWorkspaceInput,
  ResolvedAgentGraphOperatorWorkspace,
} from "../agent-graph/runtime-adapter-bridge.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type {
  AgentGraphRootToolContext,
  AgentGraphSupervisorToolPort,
} from "../tools/agent-graph-tools.js";
import type {
  AgentOutputCommitPort,
  GraphOperatorActivationContext,
} from "../tools/agent-output-tool.js";
import { AgentGraphRuntimeAdapter } from "./agent-graph-runtime-adapter.js";
import {
  SqliteAgentGraphExactRunPort,
  type ExecuteAgentGraphExactRunInput,
} from "./agent-graph-exact-run-port.js";
import { SqliteAgentGraphOutputLedger } from "./agent-graph-output-ledger.js";
import { AgentGraphRootWakeRuntimePort } from "./agent-graph-root-wake-port.js";

export type AgentGraphRunToolBinding =
  | {
      readonly kind: "root";
      readonly getRootContext: () => AgentGraphRootToolContext | undefined;
      readonly toolPort: AgentGraphSupervisorToolPort;
    }
  | {
      readonly kind: "operator";
      readonly getActivationContext: () => GraphOperatorActivationContext | undefined;
      readonly outputPort: AgentOutputCommitPort;
    };

export interface ExecuteHostedAgentGraphRunInput extends ExecuteAgentGraphExactRunInput {
  readonly binding: AgentGraphRunToolBinding;
  readonly orchestrationMode: "default" | "graph";
  readonly requestedModel?: string;
  readonly allowedTools?: readonly string[];
  /** Installs detached execution and returns; it must not wait for the whole model Run. */
  readonly onTerminal: () => void;
}

export interface CreateAgentGraphWorkspaceHostOptions {
  readonly workDir: string;
  readonly storageRoot: string;
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly sessionManager: SessionManager;
  readonly sessionOptions?: SessionOptions;
  execute(input: ExecuteHostedAgentGraphRunInput): Promise<void>;
  readonly resolveOperatorWorkspace?: (
    input: ResolveAgentGraphOperatorWorkspaceInput,
  ) => Promise<ResolvedAgentGraphOperatorWorkspace> | ResolvedAgentGraphOperatorWorkspace;
  readonly isRootSourceActive?: (rootSessionId: string) => boolean;
  readonly isWorkspaceBusy?: () => boolean;
  readonly requestStop?: (input: {
    readonly sessionId: string;
    readonly runId: string;
    readonly reason: string;
  }) => boolean | Promise<boolean>;
  readonly now?: () => number;
  readonly onError?: (error: unknown, context: { graphId?: string; wakeId?: string }) => void;
}

export interface AgentGraphWorkspaceHost {
  readonly application: AgentGraphApplicationService;
  readonly store: SqliteAgentGraphControlStore;
  rootBinding(input: {
    readonly graphId: string;
    readonly rootSessionId: string;
    readonly rootTurnId: string;
    readonly rootRunId: string;
  }): AgentGraphRunToolBinding;
  start(): Promise<void>;
  close(): Promise<void>;
}

/** Production-neutral composition of Graph control, exact Runs and tool identities. */
export function createAgentGraphWorkspaceHost(
  options: CreateAgentGraphWorkspaceHostOptions,
): AgentGraphWorkspaceHost {
  const store = new SqliteAgentGraphControlStore({
    storageRoot: options.storageRoot,
    ...(options.now ? { now: options.now } : {}),
  });
  const liveLaunches = new Set<string>();
  const activeSessions = new Map<string, Session>();
  let application: AgentGraphApplicationService | undefined;

  const outputLedger = new SqliteAgentGraphOutputLedger({
    store: options.runtimeEventStore,
    ownerFencePort: {
      assertAgentOutputWriteAllowed: async (sessionId) => {
        const session = activeSessions.get(sessionId);
        if (!session) throw new Error(`Graph operator Session is not live: ${sessionId}`);
        const fence = await session.assertRuntimeEventWriteAllowed();
        if (!fence) throw new Error(`Graph operator Session has no owner fence: ${sessionId}`);
        return fence;
      },
    },
  });

  const exactRuns = new SqliteAgentGraphExactRunPort({
    runtimeEventStore: options.runtimeEventStore,
    sessionManager: options.sessionManager,
    ...(options.sessionOptions ? { sessionOptions: options.sessionOptions } : {}),
    ...(options.requestStop ? { requestStop: options.requestStop } : {}),
    execute: async (input) => {
      const app = requireApplication(application);
      const claim = store.getActivationClaim(input.claimId);
      let binding: AgentGraphRunToolBinding;
      let orchestrationMode: "default" | "graph";
      let requestedModel: string | undefined;
      let allowedTools: readonly string[] | undefined;
      let wakeId: string | undefined;

      if (claim) {
        const provision = store
          .listOperatorProvisions(claim.graphId)
          .find(
            (candidate) =>
              candidate.operatorId === claim.operatorId &&
              candidate.generation === claim.operatorGeneration,
          );
        if (!provision) throw new Error(`Graph activation ${claim.claimId} has no provision`);
        const activation: GraphOperatorActivationContext = {
          kind: "graph_operator_activation",
          graphId: claim.graphId,
          operatorId: claim.operatorId,
          operatorGeneration: claim.operatorGeneration,
          activationId: claim.claimId,
          sessionId: claim.targetSessionId,
          turnId: claim.targetTurnId,
          runId: claim.targetRunId,
        };
        binding = { kind: "operator", getActivationContext: () => activation, outputPort: runtime };
        orchestrationMode = "default";
        requestedModel = optionalString(provision.profileSnapshot, "model");
        allowedTools = [...stringArray(provision.profileSnapshot, "tools"), "agent_output"];
      } else {
        wakeId = rootWakeIdFromClaim(input.claimId);
        const recoverable = await store.getRecoverableSupervisorWake(wakeId);
        if (!recoverable) throw new Error(`Graph root wake does not exist: ${wakeId}`);
        const root: AgentGraphRootToolContext = {
          kind: "graph_root_supervisor",
          graphId: recoverable.graph.graphId,
          rootSessionId: input.session.id,
          rootTurnId: input.prestartedRun.turnId ?? recoverable.attempt!.targetTurnId,
          rootRunId: input.prestartedRun.runId,
        };
        binding = { kind: "root", getRootContext: () => root, toolPort: app.toolPort };
        orchestrationMode = "graph";
      }

      liveLaunches.add(input.prestartedRun.runId);
      activeSessions.set(input.session.id, input.session);
      let terminalNotified = false;
      const onTerminal = () => {
        if (terminalNotified) return;
        terminalNotified = true;
        liveLaunches.delete(input.prestartedRun.runId);
        activeSessions.delete(input.session.id);
        if (wakeId) void app.supervisor.notifyRootRunChanged(wakeId);
        else void app.supervisor.notifyGraph(claim!.graphId);
      };
      try {
        await options.execute({
          ...input,
          binding,
          orchestrationMode,
          ...(requestedModel ? { requestedModel } : {}),
          ...(allowedTools ? { allowedTools } : {}),
          onTerminal,
        });
      } catch (error) {
        if (!terminalNotified) {
          liveLaunches.delete(input.prestartedRun.runId);
          activeSessions.delete(input.session.id);
        }
        throw error;
      }
    },
  });
  const runtime = new AgentGraphRuntimeAdapter({
    sessionManager: options.sessionManager,
    runPort: exactRuns,
    outputLedger,
    recordStore: store,
  });
  const rootWakePort = new AgentGraphRootWakeRuntimePort({
    exactRuns,
    workDir: options.workDir,
    isLaunchLive: ({ targetRunId }) => liveLaunches.has(targetRunId),
    preflight: ({ rootSessionId }) =>
      options.isRootSourceActive?.(rootSessionId)
        ? "source_root_active"
        : options.isWorkspaceBusy?.()
          ? "workspace_busy"
          : "ready",
  });
  application = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort,
    resolveOperatorWorkspace:
      options.resolveOperatorWorkspace ??
      ((input) => {
        if (input.operator.workspacePolicy.kind !== "shared") {
          throw new Error("isolated-worktree Graph operators require a host workspace resolver");
        }
        return {
          workDir: options.workDir,
          ...(options.sessionOptions ? { sessionOptions: options.sessionOptions } : {}),
        };
      }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  let closed = false;
  return {
    application,
    store,
    rootBinding: (input) => ({
      kind: "root",
      getRootContext: () => ({ kind: "graph_root_supervisor", ...input }),
      toolPort: requireApplication(application).toolPort,
    }),
    start: () => requireApplication(application).start(),
    close: async () => {
      if (closed) return;
      closed = true;
      await requireApplication(application).close();
      store.close();
    },
  };
}

function requireApplication(
  application: AgentGraphApplicationService | undefined,
): AgentGraphApplicationService {
  if (!application) throw new Error("Agent Graph workspace host is not assembled");
  return application;
}

function rootWakeIdFromClaim(claimId: string): string {
  if (!claimId.startsWith("root-wake:")) throw new Error(`Unknown Graph exact claim: ${claimId}`);
  const wakeId = claimId.slice("root-wake:".length);
  if (!wakeId) throw new Error("Graph root wake claim is empty");
  return wakeId;
}

function optionalString(value: unknown, key: string): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" && candidate.trim() ? candidate : undefined;
}

function stringArray(value: unknown, key: string): readonly string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) && candidate.every((item) => typeof item === "string")
    ? candidate
    : [];
}
