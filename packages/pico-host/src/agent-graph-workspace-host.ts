import type { PersistedSessionSettingsWrite } from "@pico/core";
import type {
  AgentGraphProfileSnapshot,
  AgentGraphWorkspacePolicy,
} from "@pico/core/agent-graph-contracts";
import type {
  AgentOutputCommitPort,
  GraphOperatorActivationContext,
} from "@pico/core/agent-output-contracts";
import type { AgentGraphOperatorProfileCatalog } from "@pico/core/agent-graph-profile-contracts";
import type { AgentGraphRootToolContext } from "@pico/core/agent-graph-supervisor-contracts";
import {
  AgentGraphResourceAuthority,
  AgentGraphRootWakeRuntimePort,
  AgentGraphRuntimeAdapter,
  provisionWorkspacePolicy,
  requireValidProvisionProfile,
  rootWakeIdFromClaim,
  SqliteAgentGraphOutputLedger,
  type AgentGraphRunLaunchState,
  type AgentGraphSupervisorToolPort,
  type ResolveAgentGraphOperatorWorkspaceInput,
  type ResolvedAgentGraphOperatorWorkspace,
} from "@pico/runtime";
import {
  createAgentGraphApplicationService,
  type AgentGraphApplicationService,
} from "@pico/runtime/agent-graph-service";
import { reconcilePlanExecution } from "@pico/runtime/plan-execution-recovery";
import { PlanCoordinator } from "@pico/runtime/plan-coordinator";
import { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import {
  bindAgentGraphOperatorExecutionBoundary,
  type AgentGraphOperatorSession,
} from "./agent-graph-execution-boundary.js";
import {
  SqliteAgentGraphExactRunPort,
  type AgentGraphExactRunRuntimePort,
  type AgentGraphExactRunSession,
  type AgentGraphExactRunSessionOptions,
  type ExecuteAgentGraphExactRunInput,
} from "./agent-graph-exact-run-port.js";
import { retireAgentGraphRootSession } from "./agent-graph-root-retirement.js";
import { AgentGraphWorkspaceResourceAuthority } from "./agent-graph-workspace-resource-authority.js";
import { resolvePicoPaths } from "./pico-paths.js";

/** Session capabilities the Graph Host needs from the outer Engine adapter. */
export interface AgentGraphWorkspaceHostSession
  extends AgentGraphExactRunSession, AgentGraphOperatorSession {
  assertRuntimeEventWriteAllowed(): Promise<{
    readonly sessionId: string;
    readonly epoch: number;
  }>;
}

export interface AgentGraphWorkspaceHostSessionLease {
  readonly session: AgentGraphWorkspaceHostSession;
  release(): void;
}

/** Engine Session lifecycle injected into Pico Host without a reverse dependency. */
export interface AgentGraphWorkspaceHostSessionManagerPort {
  get(
    id: string,
    workDir?: string,
    options?: AgentGraphExactRunSessionOptions,
  ): AgentGraphWorkspaceHostSession | undefined;
  getOrCreatePinned(
    id: string,
    workDir: string,
    options?: AgentGraphExactRunSessionOptions,
  ): Promise<AgentGraphWorkspaceHostSessionLease>;
}

export type AgentGraphRunToolBinding =
  | {
      readonly kind: "root";
      readonly graph?: { readonly graphId: string; readonly epoch: number };
      readonly retireGraph?: (
        graph: { readonly graphId: string; readonly epoch: number },
        reason: string,
      ) => Promise<unknown>;
      readonly getRootContext: () => AgentGraphRootToolContext | undefined;
      readonly toolPort: AgentGraphSupervisorToolPort;
    }
  | {
      readonly kind: "operator";
      /** Host-derived parent authority; model/profile payloads never supply this identity. */
      readonly rootSessionId: string;
      /** Durable workspace policy resolved by the Graph Host, never by model input. */
      readonly workspacePolicy: AgentGraphWorkspacePolicy;
      /** Parent-derived runtime mode; the frozen operator profile cannot widen this authority. */
      readonly executionPermissionMode: "ask" | "full-access";
      readonly getActivationContext: () => GraphOperatorActivationContext | undefined;
      readonly outputPort: AgentOutputCommitPort;
      readonly profileSnapshot: AgentGraphProfileSnapshot;
    };

export interface ExecuteHostedAgentGraphRunInput extends Omit<
  ExecuteAgentGraphExactRunInput,
  "session"
> {
  readonly session: AgentGraphWorkspaceHostSession;
  readonly binding: AgentGraphRunToolBinding;
  readonly orchestrationMode: "default" | "graph" | "swarm";
  readonly requestedModel?: string;
  readonly allowedTools?: readonly string[];
  /** Installs detached execution and returns; it must not wait for the whole model Run. */
  readonly onTerminal: () => void;
  readonly onCheckpoint?: () => void;
}

export interface CreateAgentGraphWorkspaceHostOptions {
  readonly workDir: string;
  readonly repoRoot?: string;
  readonly storageRoot: string;
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly sessionManager: AgentGraphWorkspaceHostSessionManagerPort;
  readonly runtimePort: AgentGraphExactRunRuntimePort;
  readonly sessionOptions?: AgentGraphExactRunSessionOptions;
  readonly operatorProfileCatalog?: AgentGraphOperatorProfileCatalog;
  /** Resolve a complete current settings snapshot before production exact-run admission. */
  readonly resolveOperatorSessionSettings?: (input: {
    readonly workDir: string;
    readonly profileSnapshot: AgentGraphProfileSnapshot;
  }) =>
    | Omit<PersistedSessionSettingsWrite, "permissionMode">
    | Promise<Omit<PersistedSessionSettingsWrite, "permissionMode">>;
  execute(input: ExecuteHostedAgentGraphRunInput): Promise<void>;
  readonly resolveOperatorWorkspace?: (
    input: ResolveAgentGraphOperatorWorkspaceInput,
  ) => Promise<ResolvedAgentGraphOperatorWorkspace> | ResolvedAgentGraphOperatorWorkspace;
  readonly isRootSourceActive?: (rootSessionId: string) => boolean;
  readonly isWorkspaceBusy?: () => boolean;
  readonly inspectLaunch?: (input: {
    readonly sessionId: string;
    readonly runId: string;
  }) => Promise<AgentGraphRunLaunchState> | AgentGraphRunLaunchState;
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
  openRootEpoch(rootSessionId: string): ReturnType<AgentGraphApplicationService["openRootEpoch"]>;
  rootBinding(input: {
    readonly graphId: string;
    readonly epoch: number;
    readonly rootSessionId: string;
    readonly rootTurnId: string;
    readonly rootRunId: string;
    readonly rootModelRouteId?: string;
  }): AgentGraphRunToolBinding;
  retireRootSession(
    rootSessionId: string,
    reason: string,
    expectedGraph?: { readonly graphId: string; readonly epoch: number },
  ): Promise<boolean>;
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
  const activeSessions = new Map<string, AgentGraphWorkspaceHostSession>();
  const workspaceAuthority = options.repoRoot
    ? new AgentGraphWorkspaceResourceAuthority({
        repoRoot: options.repoRoot,
        storageRoot: options.storageRoot,
        store,
      })
    : undefined;

  const outputLedger = new SqliteAgentGraphOutputLedger({
    store: options.runtimeEventStore,
    ownerFencePort: {
      assertAgentOutputWriteAllowed: async (sessionId) => {
        const session = activeSessions.get(sessionId);
        if (!session) throw new Error(`Graph operator Session is not live: ${sessionId}`);
        return session.assertRuntimeEventWriteAllowed();
      },
    },
  });

  const exactRuns = new SqliteAgentGraphExactRunPort({
    runtimeEventStore: options.runtimeEventStore,
    sessionManager: options.sessionManager,
    sessionOptions: {
      ...options.sessionOptions,
      runtimeStorageRoot: options.storageRoot,
    },
    runtimePort: options.runtimePort,
    ...(options.requestStop ? { requestStop: options.requestStop } : {}),
    ...(options.inspectLaunch ? { inspectLaunch: options.inspectLaunch } : {}),
    validateStart: async (input) => {
      const claim = store.getActivationClaim(input.claimId);
      const provision = claim ? requireValidProvisionProfile(store, claim) : undefined;
      const graphId =
        claim?.graphId ?? store.getSupervisorWake(rootWakeIdFromClaim(input.claimId))?.graphId;
      if (!graphId || store.getGraph(graphId)?.phase !== "open") {
        throw new Error("Cannot start a Run for a finished Graph");
      }
      if (claim && provision) {
        const graph = store.getGraph(claim.graphId);
        if (!graph) throw new Error(`Graph does not exist: ${claim.graphId}`);
        const settings = await options.resolveOperatorSessionSettings?.({
          workDir: input.workDir,
          profileSnapshot: provision.profileSnapshot,
        });
        await bindAgentGraphOperatorExecutionBoundary({
          sessionManager: options.sessionManager,
          rootSessionId: graph.rootSessionId,
          childSessionId: provision.childSessionId,
          parentWorkDir: options.workDir,
          childWorkDir: input.workDir,
          workspacePolicy: provisionWorkspacePolicy(provision).kind,
          sessionOptions: {
            ...options.sessionOptions,
            runtimeStorageRoot: options.storageRoot,
          },
          ...(settings
            ? {
                createChildSettings: ({ permissionMode }) => ({
                  ...settings,
                  permissionMode,
                }),
              }
            : {}),
        });
      }
    },
    execute: async (input) => {
      const app = requireApplication(application);
      const claim = store.getActivationClaim(input.claimId);
      let binding: AgentGraphRunToolBinding;
      let orchestrationMode: "default" | "graph" | "swarm";
      let requestedModel: string | undefined;
      let allowedTools: readonly string[] | undefined;
      let wakeId: string | undefined;
      const session = requireWorkspaceHostSession(input.session);

      if (claim) {
        if (store.getGraph(claim.graphId)?.phase !== "open") {
          throw new Error("Cannot execute an Operator for a finished Graph");
        }
        const provision = requireValidProvisionProfile(store, claim);
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
        const profileSnapshot = provision.profileSnapshot;
        const graph = store.getGraph(claim.graphId);
        if (!graph) throw new Error(`Graph does not exist: ${claim.graphId}`);
        const childBoundary = session.getRuntimeStateSnapshot().boundary;
        if (!childBoundary || childBoundary.kind === "external") {
          throw new Error("Graph Operator is missing its inherited execution boundary");
        }
        binding = {
          kind: "operator",
          rootSessionId: graph.rootSessionId,
          workspacePolicy: provisionWorkspacePolicy(provision),
          executionPermissionMode: childBoundary.kind === "bypass" ? "full-access" : "ask",
          getActivationContext: () => activation,
          outputPort: runtime,
          profileSnapshot,
        };
        orchestrationMode = "default";
        requestedModel = profileSnapshot.modelRouteId;
        allowedTools = [...profileSnapshot.tools, "agent_output"];
      } else {
        wakeId = rootWakeIdFromClaim(input.claimId);
        const recoverable = await store.getRecoverableSupervisorWake(wakeId);
        if (!recoverable) throw new Error(`Graph root wake does not exist: ${wakeId}`);
        if (recoverable.graph.phase !== "open") {
          throw new Error("Cannot execute a wake for a finished Graph");
        }
        const authorization = input.prestartedRun.agentSwarmAuthorization;
        const supervision =
          authorization === "none" ? undefined : { mode: "swarm" as const, authorization };
        const root: AgentGraphRootToolContext = {
          kind: "graph_root_supervisor",
          ...(supervision ? { supervision } : {}),
          graphId: recoverable.graph.graphId,
          epoch: recoverable.graph.epoch,
          rootSessionId: session.id,
          rootTurnId: input.prestartedRun.turnId ?? recoverable.attempt!.targetTurnId,
          rootRunId: input.prestartedRun.runId,
        };
        binding = {
          kind: "root",
          retireGraph: (graph, reason) => host.retireRootSession(root.rootSessionId, reason, graph),
          graph: { graphId: root.graphId, epoch: root.epoch },
          getRootContext: () => root,
          toolPort: app.toolPort,
        };
        orchestrationMode = root.supervision ? "swarm" : "graph";
        allowedTools = root.supervision
          ? undefined
          : ["view_agent_graph", "update_agent_graph", "yield_agent_graph"];
      }

      liveLaunches.add(input.prestartedRun.runId);
      activeSessions.set(session.id, session);
      let terminalNotified = false;
      const onTerminal = () => {
        if (terminalNotified) return;
        terminalNotified = true;
        liveLaunches.delete(input.prestartedRun.runId);
        activeSessions.delete(session.id);
        if (wakeId) void app.supervisor.notifyRootRunChanged(wakeId);
        else void app.supervisor.notifyGraph(claim!.graphId);
      };
      try {
        await options.execute({
          ...input,
          session,
          binding,
          orchestrationMode,
          ...(requestedModel ? { requestedModel } : {}),
          ...(allowedTools ? { allowedTools } : {}),
          onTerminal,
          onCheckpoint: () => {
            if (claim && app.graphSupervision(claim.graphId)?.mode === "swarm") {
              void app.supervisor.notifyGraph(claim.graphId);
            }
          },
        });
      } catch (error) {
        if (!terminalNotified) {
          liveLaunches.delete(input.prestartedRun.runId);
          activeSessions.delete(session.id);
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
    resourceAuthority: new AgentGraphResourceAuthority({
      storageRoot: options.storageRoot,
      evidenceBaseDir: resolvePicoPaths(options.workDir, {
        ...(options.sessionOptions?.picoHome ? { picoHome: options.sessionOptions.picoHome } : {}),
      }).workspace.evidence,
      store,
    }),
  });
  const rootWakePort = new AgentGraphRootWakeRuntimePort({
    exactRuns,
    workDir: options.workDir,
    isLaunchLive: ({ targetRunId }) => liveLaunches.has(targetRunId),
    resolveAgentSwarmAuthorization: async (identity) => {
      const wake = store.getSupervisorWake(identity.wakeId);
      const interest = wake?.yieldPermitId ? store.getYieldInterest(wake.yieldPermitId) : undefined;
      if (
        !wake ||
        wake.graphId !== identity.graphId ||
        !interest ||
        interest.graphId !== identity.graphId ||
        interest.rootSessionId !== identity.rootSessionId
      ) {
        throw new Error(`Graph root wake ${identity.wakeId} is missing its durable source binding`);
      }
      const events = await options.runtimeEventStore.readRun(
        identity.rootSessionId,
        interest.rootRunId,
      );
      const start = events.find((event) => event.kind === "run.started");
      if (!start) {
        throw new Error(
          `Graph root wake ${identity.wakeId} source Run ${interest.rootRunId} is missing run.started`,
        );
      }
      return start.data.agentSwarmAuthorization;
    },
    preflight: ({ rootSessionId }) =>
      options.isRootSourceActive?.(rootSessionId)
        ? "source_root_active"
        : options.isWorkspaceBusy?.()
          ? "workspace_busy"
          : "ready",
  });
  const application = createAgentGraphApplicationService({
    store,
    runtime,
    rootWakePort,
    ...(options.operatorProfileCatalog
      ? { operatorProfileCatalog: options.operatorProfileCatalog }
      : {}),
    validateWorkspacePolicy: (policy) => {
      if (
        policy.kind === "isolated-worktree" &&
        !workspaceAuthority &&
        !options.resolveOperatorWorkspace
      ) {
        throw new Error("isolated-worktree requires a Git workspace resource authority");
      }
    },
    resolveOperatorWorkspace:
      options.resolveOperatorWorkspace ??
      (async (input) => {
        if (input.operator.workspacePolicy.kind === "shared") {
          return {
            workDir: options.workDir,
            sessionOptions: {
              ...options.sessionOptions,
              runtimeStorageRoot: options.storageRoot,
            },
          };
        }
        if (!workspaceAuthority) {
          throw new Error("isolated-worktree requires a Git workspace resource authority");
        }
        const resolved = await workspaceAuthority.resolve(input.provision);
        return {
          ...resolved,
          sessionOptions: { ...options.sessionOptions, ...resolved.sessionOptions },
        };
      }),
    ...(options.now ? { now: options.now } : {}),
    ...(options.onError ? { onError: options.onError } : {}),
  });

  let closed = false;
  const host: AgentGraphWorkspaceHost = {
    application,
    store,
    openRootEpoch: (rootSessionId) => requireApplication(application).openRootEpoch(rootSessionId),
    rootBinding: (input) => ({
      kind: "root",
      graph: { graphId: input.graphId, epoch: input.epoch },
      retireGraph: (graph, reason) => host.retireRootSession(input.rootSessionId, reason, graph),
      getRootContext: () => ({ kind: "graph_root_supervisor", ...input }),
      toolPort: requireApplication(application).toolPort,
    }),
    retireRootSession: (rootSessionId, reason, expectedGraph) =>
      retireAgentGraphRootSession({
        store,
        runtimeEventStore: options.runtimeEventStore,
        application: requireApplication(application),
        rootSessionId,
        reason,
        ...(expectedGraph ? { expectedGraph } : {}),
        ...(options.requestStop ? { requestStop: options.requestStop } : {}),
      }),
    start: async () => {
      const cancelled: { rootSessionId: string; graphId: string; epoch: number; reason: string }[] =
        [];
      for (const graph of store.listGraphs()) {
        const projection = await new PlanCoordinator(options.runtimeEventStore, {
          sessionId: graph.rootSessionId,
          invocationId: "graph-recovery",
          runId: "graph-recovery",
          turnId: "graph-recovery",
        }).project();
        const execution = projection.execution;
        if (
          execution?.status === "active" &&
          execution.graph?.graphId === graph.graphId &&
          execution.graph.epoch === graph.epoch
        ) {
          const lease = await options.sessionManager.getOrCreatePinned(
            graph.rootSessionId,
            options.workDir,
            options.sessionOptions,
          );
          try {
            await reconcilePlanExecution(
              options.runtimeEventStore,
              graph.rootSessionId,
              lease.session,
              () => false,
              options.runtimePort.isRunLive,
            );
          } finally {
            lease.release();
          }
        }
        if (
          execution?.status === "cancelled" &&
          execution.graph?.graphId === graph.graphId &&
          execution.graph.epoch === graph.epoch
        ) {
          const reason = execution.reason ?? "Recover cancelled plan";
          cancelled.push({ rootSessionId: graph.rootSessionId, ...execution.graph, reason });
          await host.retireRootSession(graph.rootSessionId, reason, execution.graph);
        }
      }
      await workspaceAuthority?.recover();
      await requireApplication(application).start();
      for (const graph of cancelled) {
        await host.retireRootSession(graph.rootSessionId, graph.reason, graph);
      }
    },
    close: async () => {
      if (closed) return;
      closed = true;
      try {
        await requireApplication(application).close();
      } finally {
        store.close();
      }
    },
  };
  return host;
}

function requireApplication(
  application: AgentGraphApplicationService | undefined,
): AgentGraphApplicationService {
  if (!application) throw new Error("Agent Graph workspace host is not assembled");
  return application;
}

function requireWorkspaceHostSession(
  session: AgentGraphExactRunSession,
): AgentGraphWorkspaceHostSession {
  if (
    typeof (session as Partial<AgentGraphWorkspaceHostSession>).assertRuntimeEventWriteAllowed !==
      "function" ||
    typeof (session as Partial<AgentGraphWorkspaceHostSession>).getRuntimeStateSnapshot !==
      "function" ||
    typeof (session as Partial<AgentGraphWorkspaceHostSession>).updateRuntimeState !== "function" ||
    typeof (session as Partial<AgentGraphWorkspaceHostSession>).flushPersistence !== "function"
  ) {
    throw new Error("Graph exact RuntimeRun Session lacks the required Host capabilities");
  }
  return session as AgentGraphWorkspaceHostSession;
}
