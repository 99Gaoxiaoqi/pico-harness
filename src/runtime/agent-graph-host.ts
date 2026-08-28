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
import {
  assertValidAgentGraphOperatorProfileSnapshot,
  type AgentGraphOperatorProfileCatalog,
} from "../agent-graph/operator-profile-catalog.js";
import type { AgentGraphProfileSnapshot } from "../agent-graph/core/contracts.js";
import { SqliteAgentGraphControlStore } from "../storage/sqlite/sqlite-agent-graph-control-store.js";
import type {
  AgentGraphActivationClaimRecord,
  AgentGraphOperatorProvisionRecord,
} from "../storage/sqlite/agent-graph-store-types.js";
import type { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import type {
  AgentGraphRootToolContext,
  AgentGraphSupervisorToolPort,
} from "../tools/agent-graph-tools.js";
import { AGENT_GRAPH_SUPERVISOR_TOOL_NAMES } from "../tools/agent-graph-tools.js";
import type {
  AgentOutputCommitPort,
  GraphOperatorActivationContext,
} from "../tools/agent-output-tool.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { AgentGraphRuntimeAdapter } from "./agent-graph-runtime-adapter.js";
import { AgentGraphResourceAuthority } from "./agent-graph-resource-authority.js";
import { AgentGraphWorkspaceResourceAuthority } from "./agent-graph-workspace-resource-authority.js";
import type { AgentGraphRunLaunchState } from "./agent-graph-runtime-adapter.js";
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
      readonly profileSnapshot: AgentGraphProfileSnapshot;
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
  readonly repoRoot?: string;
  readonly storageRoot: string;
  readonly runtimeEventStore: SqliteRuntimeEventStore;
  readonly sessionManager: SessionManager;
  readonly sessionOptions?: SessionOptions;
  readonly operatorProfileCatalog?: AgentGraphOperatorProfileCatalog;
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
  retireRootSession(rootSessionId: string, reason: string): Promise<boolean>;
  start(): Promise<void>;
  close(): Promise<void>;
}

export function assertAgentGraphRootRunSettled(
  store: SqliteAgentGraphControlStore,
  input: {
    readonly graphId: string;
    readonly rootSessionId: string;
    readonly rootRunId: string;
  },
): void {
  const graph = store.getGraph(input.graphId);
  if (!graph || graph.rootSessionId !== input.rootSessionId) {
    throw new Error(`Graph root Run is no longer bound to graph ${input.graphId}`);
  }
  if (graph.phase === "finished") return;
  const yielded = store
    .listYieldInterests(input.graphId)
    .some((interest) => interest.rootRunId === input.rootRunId && interest.state !== "cancelled");
  if (yielded) return;
  throw new Error(
    "Graph root Run cannot complete before it finishes the Graph or registers a durable yield",
  );
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
        const fence = await session.assertRuntimeEventWriteAllowed();
        if (!fence) throw new Error(`Graph operator Session has no owner fence: ${sessionId}`);
        return fence;
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
    ...(options.requestStop ? { requestStop: options.requestStop } : {}),
    ...(options.inspectLaunch ? { inspectLaunch: options.inspectLaunch } : {}),
    validateStart: (input) => {
      const claim = store.getActivationClaim(input.claimId);
      if (claim) requireValidProvisionProfile(store, claim);
    },
    execute: async (input) => {
      const app = requireApplication(application);
      const claim = store.getActivationClaim(input.claimId);
      let binding: AgentGraphRunToolBinding;
      let orchestrationMode: "default" | "graph";
      let requestedModel: string | undefined;
      let allowedTools: readonly string[] | undefined;
      let wakeId: string | undefined;

      if (claim) {
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
        binding = {
          kind: "operator",
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
        const root: AgentGraphRootToolContext = {
          kind: "graph_root_supervisor",
          graphId: recoverable.graph.graphId,
          epoch: recoverable.graph.epoch,
          rootSessionId: input.session.id,
          rootTurnId: input.prestartedRun.turnId ?? recoverable.attempt!.targetTurnId,
          rootRunId: input.prestartedRun.runId,
        };
        binding = { kind: "root", getRootContext: () => root, toolPort: app.toolPort };
        orchestrationMode = "graph";
        allowedTools = AGENT_GRAPH_SUPERVISOR_TOOL_NAMES;
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
    resourceAuthority: new AgentGraphResourceAuthority({
      storageRoot: options.storageRoot,
      evidenceBaseDir: resolvePicoPaths(options.workDir, {
        picoHome: options.sessionOptions?.picoHome,
      }).workspace.evidence,
      store,
    }),
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
  return {
    application,
    store,
    openRootEpoch: (rootSessionId) => requireApplication(application).openRootEpoch(rootSessionId),
    rootBinding: (input) => ({
      kind: "root",
      getRootContext: () => ({ kind: "graph_root_supervisor", ...input }),
      toolPort: requireApplication(application).toolPort,
    }),
    retireRootSession: async (rootSessionId, reason) => {
      const graph = store.getOpenRootEpoch(rootSessionId);
      if (!graph) return false;
      const retired = await requireApplication(application).retireRootSession(
        rootSessionId,
        reason,
      );
      if (retired && options.requestStop) {
        for (const wake of store.listSupervisorWakes(graph.graphId)) {
          for (const attempt of store.listSupervisorWakeAttempts(wake.wakeId)) {
            if (attempt.status !== "running") continue;
            await options.requestStop({
              sessionId: attempt.rootSessionId,
              runId: attempt.targetRunId,
              reason,
            });
          }
        }
      }
      return retired;
    },
    start: async () => {
      await workspaceAuthority?.recover();
      await requireApplication(application).start();
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

function requireValidProvisionProfile(
  store: SqliteAgentGraphControlStore,
  claim: AgentGraphActivationClaimRecord,
): AgentGraphOperatorProvisionRecord & { readonly profileSnapshot: AgentGraphProfileSnapshot } {
  const provision = store
    .listOperatorProvisions(claim.graphId)
    .find(
      (candidate) =>
        candidate.operatorId === claim.operatorId &&
        candidate.generation === claim.operatorGeneration,
    );
  if (!provision) throw new Error(`Graph activation ${claim.claimId} has no provision`);
  assertValidAgentGraphOperatorProfileSnapshot(provision.profileSnapshot);
  return provision as AgentGraphOperatorProvisionRecord & {
    readonly profileSnapshot: AgentGraphProfileSnapshot;
  };
}
