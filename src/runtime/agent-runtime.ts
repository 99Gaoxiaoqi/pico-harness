import { createConfiguredSubagentOutputTool } from "../tools/configured-subagent-output.js";
import { readConfiguredSubagentDefinition } from "./configured-subagent-session.js";
import {
  createConfiguredSubagentOutputStore,
  ConfiguredSubagentOutputNotFoundError,
} from "./configured-subagent-output-store.js";
import { WebSearchTool } from "../tools/web.js";
import { UserConfigStore } from "../input/user-config-store.js";
import { resolveNativeWebSearchCapability } from "../provider/model-web-search.js";
import {
  DEFAULT_WEB_SEARCH_SETTINGS,
  guardNativeSearchRequests,
  routeRuntimeWebSearch,
  webSearchUnavailableReason,
  type RuntimeWebSearchSettings,
} from "./web-search.js";
import {
  ConfiguredAgentListTool,
  ConfiguredAgentSpawnTool,
  type ConfiguredSubagentExecutor,
} from "../tools/configured-subagent-tools.js";
import type {
  ConfiguredSubagentCatalogPort,
  SubagentCapabilityDefinition,
} from "../agents/subagent-profiles.js";
import type { RuntimeSubagentPreset } from "@pico/protocol";
import {
  configuredSubagentExecutionBoundary,
  createConfiguredSubagentExecutor,
} from "./configured-subagent-executor.js";
import {
  CHILD_AGENT_TOOL_CONSTRUCTORS,
  buildChildAgentSafetyMiddleware,
} from "../tools/child-agent-policy.js";
import { type AtomicMemoryLifecycle } from "./atomic-memory-lifecycle.js";
import { createAgentSwarmStatusTool } from "../tools/agent-swarm-status-tool.js";
import { AGENT_SWARM_SUPERVISOR_TOOL_NAMES } from "../agent-graph/core/tool-names.js";
import { isPlanGraphWaiting, reconcilePlanExecution } from "./plan-execution-recovery.js";
import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AgentEngine, isPlanProviderTool } from "../engine/loop.js";
import { PlanHandoffController } from "../engine/plan-handoff.js";
import type { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import { sessionEntryKey } from "../engine/session-manager-state.js";
import type { SessionManagerLease } from "../engine/session-manager.js";
import {
  reconcileUnfinishedSessionForksOrThrow,
  SessionForkService,
} from "../engine/session-fork-service.js";
import { TerminalReporter, type Reporter } from "../engine/reporter.js";
import { Compactor } from "../context/compactor.js";
import { FullCompactor } from "../context/full-compactor.js";
import {
  createContextBudget,
  estimateTokenBudgetAsChars,
  type ContextBudget,
} from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import type { TodoStore } from "../context/todo-store.js";
import type { AgentGraphProfileSnapshot } from "../agent-graph/core/contracts.js";
import { SkillLoader, type Skill } from "../context/skill.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import { createCodeModeTool } from "../tools/code-mode-tool.js";
import { codeCellAdmissionFor } from "../tools/code-cell-admission.js";
import type { ToolHostKind } from "../tools/tool-surface.js";
import { type ProviderKind } from "../provider/factory.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import type { ProviderConfig } from "../provider/config.js";
import type { CredentialResolver } from "../provider/credential-vault.js";
import type { LLMProvider } from "../provider/interface.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { ToolRegistry } from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import { WorkspaceRoots, workspaceAccessesFromCall } from "../tools/workspace-roots.js";
import type { DefaultToolRegistryOptions } from "../tools/default-registry.js";
import { FetchURLTool } from "../tools/web.js";
import {
  AGENT_GRAPH_SUPERVISOR_TOOL_NAMES,
  createAgentGraphSupervisorTools,
  type AgentGraphRootToolContext,
  type AgentGraphSupervisorToolPort,
} from "../tools/agent-graph-tools.js";
import {
  createAgentOutputTool,
  type AgentOutputCommitPort,
  type GraphOperatorActivationContext,
} from "../tools/agent-output-tool.js";
import { CostTracker, type CostTrackerOptions } from "../observability/tracker.js";
import { ensureSessionUsageBaseline } from "../observability/usage-baseline.js";
import type { ModelRouter } from "../provider/model-router.js";
import { Tracer } from "../observability/trace.js";
import { logger } from "../observability/logger.js";
import { RuntimeEventStoreIntegrityError } from "../storage/runtime-event-store-contracts.js";
import {
  globalApprovalManager,
  classifyHardlineCommand,
  type ApprovalManager,
  type ApprovalNotifier,
  type ApprovalResult,
  type HardlineReasonKind,
} from "../approval/manager.js";
import {
  applySessionPermissionScope,
  bypassImmuneSafetyPath,
  globalSessionPermissionGrants,
  isSensitiveCredentialPath,
  permissionScopeForCall,
  type PermissionRuntimeSettings,
} from "../approval/session-permissions.js";
import { bashCommandFromArgs } from "../approval/bash-paths.js";
import { computeApprovalDiff } from "../approval/diff.js";
import {
  classifyToolPermission,
  evaluateToolPermission,
  permissionReasonForCategory,
  type RuntimePermissionMode,
  type ToolPermissionCategory,
} from "../approval/tool-permission-policy.js";
import { createSessionRuntime, type SessionRuntime } from "./session-runtime.js";
import type {
  PersistedSessionSettings,
  PersistedSessionSettingsWrite,
} from "../engine/session-runtime.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import {
  McpConnectionManager,
  type McpConfigSource,
  type McpRemoteNetworkRequest,
  type McpStatusSnapshot,
} from "../mcp/manager.js";
import { isMcpToolName } from "../mcp/types.js";
import type { ToolCall } from "../schema/message.js";
import { createBackgroundMcpClient } from "../safety/background-mcp-client.js";
import { configuredMcpServerNames, filterPluginMcpSources } from "../mcp/effective-config.js";
import type { ScheduleDraftCoordinator } from "../tasks/cron-draft.js";
import { looksLikeScheduleCreationIntent, ScheduleTaskTool } from "../tools/schedule-task.js";
import { BackgroundManager } from "../tools/background-manager.js";
import type { HookService } from "../hooks/service.js";
import {
  getOrCreateSessionSettings,
  setSessionAdditionalDirectories,
  toolStatusFromRegistry,
  type SessionToolStatus,
  type SessionSettings,
} from "../input/session-settings.js";
import { createIsolatedPicoConfig, loadPicoProjectConfig } from "../input/pico-config.js";
import { hasExplicitNetworkIntent } from "../safety/workspace-sandbox.js";
import { createSandboxPolicy, normalizeRoots } from "../safety/process-sandbox/index.js";
import { compileRuntimeProcessSandbox } from "../safety/runtime-process-sandbox.js";
import {
  applyExecutionBoundaryExpansion,
  canReadPath,
  canWritePath,
  executionBoundaryContains,
  type ExecutionBoundary,
} from "../safety/permission-profile.js";
import { canonicalizeSandboxBoundaryExpansion } from "../safety/sandbox-boundary-path.js";
import type { CliSessionSelection } from "../cli/session-resolver.js";
import { SqliteRuntimeControlStore } from "../storage/sqlite/sqlite-runtime-control-store.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import {
  BackgroundPolicyViolationError,
  buildBackgroundAutonomousMiddleware,
  prepareBackgroundAutonomousPolicy,
  type BackgroundWorkspaceTrustVerifier,
  type PreparedBackgroundAutonomousPolicy,
} from "../safety/background-autonomous-policy.js";
import {
  loadPluginRuntimeSnapshot,
  type PluginRuntimeSnapshot,
} from "../plugins/plugin-runtime-snapshot.js";
import {
  PluginCapabilityActivationScope,
  type PluginCapabilityRegistry,
} from "../plugins/plugin-capability.js";
import { registerPluginCapabilityTools } from "../plugins/plugin-tool-activation.js";
import { activatePluginProviderCapabilities } from "../plugins/plugin-provider-activation.js";
import { resolvePicoHome, resolvePicoPaths } from "../paths/pico-paths.js";
import { SqliteSessionWorkbarRepository } from "../storage/sqlite/sqlite-session-workbar-repository.js";
import { buildSessionTaskPromptBlock } from "../tools/session-tasks.js";
import {
  createBrowserAgentTools,
  type BoundBrowserAgentAuthority,
} from "../tools/browser-agent.js";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { currentRuntimeRun, RuntimeRun } from "./runtime-run.js";
import { PlanCoordinator } from "../plan/coordinator.js";
import { PlanConflictError, type PlanProjection, type PlanProposal } from "../plan/contract.js";
import { RuntimeCleanupScope } from "./runtime-cleanup.js";
import {
  emitRuntimeLifecycleEvent,
  RuntimeRunExecutor,
  DEFAULT_CONTINUATION_TERMINAL_MIN_AGE_MS,
  type PrestartedRuntimeRun,
  type PrestartedRuntimeUserInput,
  type RuntimeRunExecutorInput,
} from "./runtime-run-executor.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "./session-fork-runtime-port-adapter.js";
import { bindRuntimeHookCapabilities } from "./runtime-hook-assembly.js";
import type { HookHostNetworkRequest } from "../hooks/executors/index.js";
import type { RequestSandboxBoundaryHandler } from "../tools/request-sandbox-boundary.js";

const livePlanAdmissions = new Set<string>();
const liveConfiguredChildAdmissions = new Set<string>();
const PLAN_REVISION_FEEDBACK_MAX_CHARS = 4_000;
const PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS = 256;
import {
  assembleRuntimeModels,
  billingRouteForProvider,
  type RuntimeProviderFactory,
} from "./runtime-assembly.js";
import type {
  RunAgentCliOptions,
  RunAgentCliResult,
  RuntimeExecution,
  RuntimeLifecycleEvent,
} from "./runtime-contract.js";
import { AtomicMemoryContextBuilder } from "../memory/atomic/context-builder.js";
import { buildMemoryTriggerTools } from "../memory/memory-trigger-tools.js";
import { SqliteMemoryItemStore } from "../storage/sqlite/sqlite-memory-item-store.js";
import {
  AtomicMemoryRuntime,
  ProviderAtomicMemoryModel,
  atomicMemoryDatabasePath,
  type AtomicMemoryModelLease,
} from "./atomic-memory-runtime.js";
export type {
  RunAgentCliOptions,
  RunAgentCliResult,
  RunAgentUsage,
  RuntimeExecution,
  RuntimeLifecycleEvent,
} from "./runtime-contract.js";

export { loadImage } from "../input/prepare-prompt.js";
export * from "./agent-recoverable-task-adapter.js";

export type RunAgentEnv = Record<string, string | undefined>;
export type RunAgentProviderFactory = RuntimeProviderFactory;
export const MIN_HOST_AGENT_MAX_TURNS = 1;
export const MAX_HOST_AGENT_MAX_TURNS = 200;

export function resolveHostAgentMaxTurns(value?: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < MIN_HOST_AGENT_MAX_TURNS ||
    value > MAX_HOST_AGENT_MAX_TURNS
  ) {
    throw new Error(
      `maxTurns 必须是 ${MIN_HOST_AGENT_MAX_TURNS}..${MAX_HOST_AGENT_MAX_TURNS} 范围内的整数`,
    );
  }
  return value;
}

export interface RuntimeSessionResourceChangedNotice {
  readonly workspacePath: string;
  readonly sessionId: string;
  readonly resource: "tasks";
  readonly revision: number;
}

/**
 * Host-provided effects. The runtime never renders an Ink component or assumes a terminal.
 * Missing approval delivery fails closed when a dangerous tool is requested.
 */
export interface RuntimeHost {
  reporter?: Reporter;
  approvalNotifier?: ApprovalNotifier;
  onEvent?: (event: RuntimeLifecycleEvent) => void;
  memoryChangedSink?: () => void;
  /** Metadata-only signal emitted after a Session Workbar authority changes. */
  sessionResourceChangedSink?: (notice: RuntimeSessionResourceChangedNotice) => void;
  /** Structured fail-closed safety/permission denial observer for non-interactive hosts. */
  onPolicyDenied?: (event: RuntimePolicyDenial) => void;
}

export type RuntimePolicyDenialReasonKind =
  | "plan_mode"
  | HardlineReasonKind
  | "policy_denied"
  | "hook_denied"
  | "approval_denied";

export interface RuntimePolicyDenial {
  readonly source: "safety" | "permission";
  readonly code: "plan_mode" | "hardline" | "policy" | "hook" | "approval";
  readonly reasonKind: RuntimePolicyDenialReasonKind;
  readonly toolName: string;
}

export interface RunAgentCliDependencies extends RuntimeHost {
  configuredSubagentCatalog?: ConfiguredSubagentCatalogPort;
  configuredSubagentExecutor?: ConfiguredSubagentExecutor;
  /** Trusted child identity; disables extensions and enforces fixed capability tools. */
  configuredSubagentChild?: {
    readonly definition: SubagentCapabilityDefinition;
    readonly preset?: RuntimeSubagentPreset;
    readonly executionBoundaryCeiling: ExecutionBoundary;
  };

  env?: RunAgentEnv;
  /** Trusted host-owned main-loop budget; omitted callers retain AgentEngine's 50-turn default. */
  maxTurns?: number;
  /** Trusted host override for foreground Bash calls; validated to 1..900 seconds. */
  bashTimeoutMs?: number;
  /**
   * Trusted host-owned exact values removed from every ToolResult before transcript/persistence.
   * Tool calls and tool arguments cannot modify this list.
   */
  toolResultRedactionSecrets?: readonly string[];
  /** Host-owned Pico state root. Omitted callers keep the process default. */
  picoHome?: string;
  provider?: LLMProvider;
  providerFactory?: RunAgentProviderFactory;
  /** Host-owned request policy wrapper applied after plugin provider capabilities. */
  providerDecorator?: (provider: LLMProvider) => LLMProvider;
  /** Trusted parent Run snapshot; children cannot widen its configured search source. */
  webSearchSettings?: RuntimeWebSearchSettings;
  /** 前台宿主持有的完整可信模型目录；子代理不得自行读取 endpoint 或凭证。 */
  modelRouter?: ModelRouter;
  toolDisclosure?: ToolDisclosure;
  /**
   * 宿主类型（surface 亲和性 + economy 组过滤用）。
   * desktop=daemon 前台交互宿主（TUI 与 Desktop 共享 execute 闭包）；
   * background=Cron/Automation；headless=one-shot 程序化运行；cli=默认兜底。
   */
  hostKind?: ToolHostKind;
  /** Session-scoped services owned by the caller and reused across prompts. */
  runtimeState?: SessionRuntime;
  /** @internal Trusted host-selected Session; exact Graph runs must not resolve it from cwd again. */
  runtimeSession?: Session;
  /** 仅由可展示结构化问题的 TUI bundle 提供。 */
  askUserHandler?: AskUserHandler;
  /** Host-owned approval state, required when decisions are settled outside the TUI process. */
  approvalManager?: ApprovalManager;
  /** Receives the complete registry after late Agent/MCP registration. */
  toolStatusSink?: (tools: readonly SessionToolStatus[]) => void;
  mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
  /** TUI 宿主持有的 MCP manager；注入时本轮只换 registry，不重连或关闭 server。 */
  mcpManager?: McpConnectionManager;
  /** Trusted foreground hosts may inject a collision-free user/project MCP snapshot. */
  mcpConfigSources?: readonly McpConfigSource[];
  /** 宿主本轮运行的中止信号。 */
  signal?: AbortSignal;
  /** Host-owned gate used by desktop Pause at tool-safe execution boundaries. */
  waitAtSafeBoundary?: () => Promise<void>;
  /** Receives the exact durable rewind point created for this top-level prompt. */
  rewindPointSink?: (checkpointId: string) => void;
  /** @internal Trusted host assertion evaluated before a Runtime Run commits success. */
  runCompletionGuard?: () => Promise<void> | void;
  onRunAdmission?: (run: RuntimeRun) => Promise<void> | void;
  /** @internal Trusted host recovery hook evaluated before a failed Runtime Run is sealed. */
  runFailureGuard?: NonNullable<RuntimeRunExecutorInput["failureGuard"]>;
  /** @internal 继续已存在的未完成轮次，不新增 user 消息或 rewind point。 */
  resumeExistingSession?: boolean;
  /** @internal 恢复 adapter 已在 canonical ledger 发布的唯一 RuntimeRun admission。 */
  prestartedRun?: PrestartedRuntimeRun;
  /** @internal Graph exact Run 首次输入的确定性消息身份。 */
  prestartedUserInput?: PrestartedRuntimeUserInput;
  /** 宿主持有的 Graph 身份与最小工具端口；模型参数不能创建或修改该绑定。 */
  agentGraph?:
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
        readonly getActivationContext: () => GraphOperatorActivationContext | undefined;
        readonly outputPort: AgentOutputCommitPort;
        readonly profileSnapshot: AgentGraphProfileSnapshot;
        /** Trusted host projection of the inherited durable execution boundary. */
        readonly executionPermissionMode: "ask" | "full-access";
      };
  /** 仅用于后台执行的实时信任校验；生产默认读取用户级 WorkspaceTrustStore。 */
  backgroundTrustStore?: BackgroundWorkspaceTrustVerifier;
  retirePlanGraph?: (
    graph: { readonly graphId: string; readonly epoch: number },
    reason: string,
  ) => Promise<unknown>;
  /** daemon/Cron 注入的系统凭证库读取边界；前台 BYOK 不需要。 */
  credentialResolver?: CredentialResolver;
  /** 宿主装配的会话级 HookService；TUI 后续消息必须复用同一实例。 */
  hookService?: HookService;
  /** 仅结构化 TUI 前台可提供；后台与兼容行模式不得注入。 */
  scheduleDraftCoordinator?: ScheduleDraftCoordinator;
  /** TUI/宿主已冻结的受信 Plugin 快照；未注入时前台运行自行加载。 */
  pluginSnapshot?: PluginRuntimeSnapshot;
  /** Host-owned restricted capability factories used for snapshot resolution and activation. */
  pluginCapabilityRegistry?: PluginCapabilityRegistry;
  /** Explicit user-level trust authority for memory recall and review. */
  memoryTrustStore?: WorkspaceTrustStore;
  atomicMemoryLifecycle?: AtomicMemoryLifecycle;
  atomicMemoryModelFactory?: () => Promise<AtomicMemoryModelLease>;
  /** @internal Ignore project/user extension catalogs and host compatibility resources. */
  isolatedHeadless?: boolean;
  /** Visible Electron browser authority. Omitted for CLI, background and headless hosts. */
  browserAgent?: BoundBrowserAgentAuthority;
}

/** Runtime-first entry point. CLI/TUI compatibility wrappers call this method. */
export class AgentRuntime {
  async execute(
    options: RunAgentCliOptions,
    host: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    return executeAgentRuntime(options, host);
  }

  async approvePlanAndExecute(
    input: PlanApprovalExecutionRequest,
    host: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    const picoHome = resolvePicoHome({ picoHome: host.picoHome, env: host.env ?? process.env });
    const workDir = await resolveWorkDir(input.approval.dir);
    const lease = await acquireRuntimeSession({
      sessionSelection: { mode: "resume", sessionId: input.approval.sessionId },
      workDir,
      picoHome,
      resumeExistingSession: false,
    });
    try {
      const session = lease.session;
      if (!session.runtimeEventStore) throw new Error("Plan approval requires durable storage");
      const settings = session.getRuntimeStateSnapshot().settings;
      if (!settings) throw new Error("Plan approval requires persisted session settings");
      const operationId = input.approval.operationId ?? `approve-plan:${randomUUID()}`;
      const coordinator = new PlanCoordinator(session.runtimeEventStore, {
        sessionId: session.id,
        invocationId: `approval:${operationId}`,
        runId: `approval:${operationId}`,
        turnId: `turn:approval:${operationId}`,
        writeGuard: session,
      });
      const approvalSemantic = {
        planId: input.approval.planId,
        expectedRevision: input.approval.expectedRevision,
        reviewedBy: "user" as const,
      };
      const approvalStatus = await coordinator.operationStatus(
        operationId,
        "plan.approved",
        approvalSemantic,
        input.approval.claimOperationId,
      );
      const approved =
        approvalStatus === "matching"
          ? await coordinator.project()
          : await coordinator.approve({
              operationId,
              expectedSessionSequence: input.approval.expectedSessionSequence,
              ...approvalSemantic,
              ...(input.approval.claimOperationId
                ? { claimOperationId: input.approval.claimOperationId }
                : {}),
              settings,
            });
      await session.refreshRuntimeProjection();
      const proposal = approved.proposals.find(
        (candidate) =>
          candidate.planId === input.approval.planId &&
          candidate.revision === input.approval.expectedRevision &&
          candidate.status === "approved",
      );
      if (!proposal) throw new Error("Approved plan projection is unavailable");
      const executionOperationId = `plan-execution:${operationId}`;
      if (
        (await coordinator.operationStatus(executionOperationId, "plan.execution.started", {
          planId: proposal.planId,
          revision: proposal.revision,
          ...(approved.execution?.graph ? { graph: approved.execution.graph } : {}),
        })) === "matching"
      ) {
        await reconcileOrphanedPlanExecution(session.runtimeEventStore, session.id, session);
        return replayedPlanControlResult(session.id, workDir, operationId);
      }
      const admission = planAdmissionKey(session.id, executionOperationId);
      livePlanAdmissions.add(admission);
      try {
        return await this.execute(
          {
            ...input.execution,
            dir: workDir,
            sessionSelection: { mode: "resume", sessionId: session.id },
            prompt: approvedPlanExecutionPrompt(proposal),
            approvedPlan: {
              planId: proposal.planId,
              revision: proposal.revision,
              expectedSessionSequence: approved.sessionSequence,
              operationId: executionOperationId,
            },
          },
          host,
        );
      } finally {
        livePlanAdmissions.delete(admission);
      }
    } finally {
      lease.release();
    }
  }

  async recoverPlanExecution(input: PlanSessionRequest): Promise<PlanProjection> {
    const { session, lease } = await acquirePlanControlSession(input, {});
    try {
      if (!session.runtimeEventStore) throw new Error("Plan recovery requires durable storage");
      return await reconcileOrphanedPlanExecution(session.runtimeEventStore, session.id, session);
    } finally {
      lease.release();
    }
  }

  async readPlanProjection(input: PlanSessionRequest): Promise<PlanProjection> {
    const picoHome = resolvePicoHome({ picoHome: input.picoHome, env: input.env ?? process.env });
    const workDir = await resolveWorkDir(input.dir);
    const store = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
    });
    try {
      return await new PlanCoordinator(
        store,
        planControlContext(input.sessionId, "read-projection"),
      ).project();
    } finally {
      store.close();
    }
  }

  async requestPlanRevision(
    input: PlanRevisionRequest,
    host: RunAgentCliDependencies = {},
  ): Promise<{ projection: PlanProjection; replayed: boolean }> {
    const { session, lease } = await acquirePlanControlSession(input, host);
    try {
      if (!session.runtimeEventStore) throw new Error("Plan revision requires durable storage");
      const coordinator = new PlanCoordinator(session.runtimeEventStore, {
        ...planControlContext(session.id, input.operationId, session),
        ...(host.retirePlanGraph ? { retireGraph: host.retirePlanGraph } : {}),
      });
      const semantic = {
        planId: input.planId,
        expectedRevision: input.expectedRevision,
        feedback: input.feedback.trim(),
      };
      const replayed =
        (await coordinator.operationStatus(
          input.operationId,
          "plan.revision.requested",
          semantic,
        )) === "matching";
      const projection = replayed
        ? await coordinator.project()
        : await coordinator.requestRevision({
            operationId: input.operationId,
            expectedSessionSequence: input.expectedSessionSequence,
            ...semantic,
            ...(input.claimOperationId ? { claimOperationId: input.claimOperationId } : {}),
          });
      return { projection, replayed };
    } finally {
      lease.release();
    }
  }

  async resumePlanExecution(
    input: PlanResumeExecutionRequest,
    host: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    const { session, lease, workDir } = await acquirePlanControlSession(input, host);
    try {
      if (!session.runtimeEventStore) throw new Error("Plan resume requires durable storage");
      const coordinator = new PlanCoordinator(session.runtimeEventStore, {
        ...planControlContext(session.id, input.operationId, session),
        ...(host.retirePlanGraph ? { retireGraph: host.retirePlanGraph } : {}),
      });
      const semantic = { planId: input.planId };
      if (
        (await coordinator.operationStatus(
          input.operationId,
          "plan.execution.resumed",
          semantic,
          input.claimOperationId,
        )) === "matching"
      ) {
        await reconcileOrphanedPlanExecution(session.runtimeEventStore, session.id, session);
        return replayedPlanControlResult(session.id, workDir, input.operationId);
      }
      const projection = await coordinator.project();
      if (
        projection.execution?.planId !== input.planId ||
        projection.execution.status !== "interrupted"
      ) {
        throw new PlanConflictError("Plan execution is not interrupted");
      }
      const admission = planAdmissionKey(session.id, input.operationId);
      livePlanAdmissions.add(admission);
      try {
        return await this.execute(
          {
            ...input.execution,
            dir: workDir,
            sessionSelection: { mode: "resume", sessionId: session.id },
            prompt: resumedPlanExecutionPrompt(projection),
            approvedPlan: {
              planId: input.planId,
              revision: projection.execution.revision,
              expectedSessionSequence: input.expectedSessionSequence,
              operationId: input.operationId,
              ...(input.claimOperationId ? { claimOperationId: input.claimOperationId } : {}),
              transition: "resume",
            },
          },
          planControlExecutionHost(input, host),
        );
      } finally {
        livePlanAdmissions.delete(admission);
      }
    } finally {
      lease.release();
    }
  }

  async cancelInterruptedPlan(
    input: PlanInterruptedControlRequest,
    host: RunAgentCliDependencies = {},
  ): Promise<PlanProjection> {
    const { session, lease } = await acquirePlanControlSession(input, host);
    try {
      if (!session.runtimeEventStore) throw new Error("Plan cancel requires durable storage");
      return await new PlanCoordinator(session.runtimeEventStore, {
        ...planControlContext(session.id, input.operationId, session),
        ...(host.retirePlanGraph ? { retireGraph: host.retirePlanGraph } : {}),
      }).cancel({
        operationId: input.operationId,
        expectedSessionSequence: input.expectedSessionSequence,
        planId: input.planId,
        ...(input.reason ? { reason: input.reason } : {}),
      });
    } finally {
      lease.release();
    }
  }

  async replanInterruptedExecution(
    input: PlanReplanExecutionRequest,
    host: RunAgentCliDependencies = {},
  ): Promise<RunAgentCliResult> {
    const { session, lease, workDir } = await acquirePlanControlSession(input, host);
    try {
      if (!session.runtimeEventStore) throw new Error("Plan replan requires durable storage");
      const coordinator = new PlanCoordinator(session.runtimeEventStore, {
        ...planControlContext(session.id, input.operationId, session),
        ...(host.retirePlanGraph ? { retireGraph: host.retirePlanGraph } : {}),
      });
      const semantic = {
        planId: input.planId,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      if (
        (await coordinator.operationStatus(
          input.operationId,
          "plan.execution.replanned",
          semantic,
          input.claimOperationId,
        )) === "matching"
      ) {
        return replayedPlanControlResult(session.id, workDir, input.operationId);
      }
      const settings = session.getRuntimeStateSnapshot().settings;
      if (!settings) throw new Error("Plan replan requires persisted session settings");
      await coordinator.replan({
        operationId: input.operationId,
        expectedSessionSequence: input.expectedSessionSequence,
        planId: input.planId,
        settings,
        ...(input.claimOperationId ? { claimOperationId: input.claimOperationId } : {}),
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return await this.execute(
        {
          ...input.execution,
          dir: workDir,
          sessionSelection: { mode: "resume", sessionId: session.id },
          prompt: input.prompt,
        },
        planControlExecutionHost(input, host),
      );
    } finally {
      lease.release();
    }
  }
}

export interface PlanApprovalExecutionRequest {
  readonly approval: {
    readonly sessionId: string;
    readonly dir: string;
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
    readonly operationId?: string;
    readonly claimOperationId?: string;
  };
  readonly execution: Omit<
    RunAgentCliOptions,
    "prompt" | "dir" | "sessionSelection" | "approvedPlan"
  >;
}

export interface PlanSessionRequest {
  readonly sessionId: string;
  readonly dir: string;
  readonly picoHome?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface PlanInterruptedControlRequest extends PlanSessionRequest {
  readonly planId: string;
  readonly expectedSessionSequence: number;
  readonly operationId: string;
  readonly claimOperationId?: string;
  readonly reason?: string;
}

export interface PlanRevisionRequest extends PlanSessionRequest {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly expectedSessionSequence: number;
  readonly operationId: string;
  readonly claimOperationId?: string;
  readonly feedback: string;
}

export interface PlanResumeExecutionRequest extends PlanInterruptedControlRequest {
  readonly execution: Omit<
    RunAgentCliOptions,
    "prompt" | "dir" | "sessionSelection" | "approvedPlan"
  >;
}

export interface PlanReplanExecutionRequest extends PlanInterruptedControlRequest {
  readonly prompt: string;
  readonly execution: Omit<
    RunAgentCliOptions,
    "prompt" | "dir" | "sessionSelection" | "approvedPlan"
  >;
}

function approvedPlanExecutionPrompt(proposal: PlanProposal): string {
  return [
    "[APPROVED PLAN EXECUTION] 用户已批准以下计划。现在按当前权限模式执行；不要重新进入 Plan Mode。",
    `Plan: ${proposal.title} (${proposal.planId}@${proposal.revision})`,
    proposal.overview ? `Overview: ${proposal.overview}` : undefined,
    "Steps:",
    ...proposal.steps.map((step) => `- ${step.id}: ${step.title}\n  ${step.description}`),
    proposal.risks?.length
      ? `Risks:\n${proposal.risks.map((risk) => `- ${risk}`).join("\n")}`
      : undefined,
    "开始执行某一步前，先调用 update_plan 将它标记为 in_progress；实施并验证成功后，再调用 update_plan 将它标记为 completed（不再需要的步骤标记为 skipped）。",
    "Graph 模式允许通过 yield_agent_graph 持久化等待子任务，并在唤醒后继续。除此之外，只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
  ]
    .filter((part): part is string => part !== undefined)
    .join("\n\n");
}

function resumedPlanExecutionPrompt(projection: PlanProjection): string {
  const execution = projection.execution;
  if (!execution) throw new PlanConflictError("Plan execution is unavailable");
  return [
    "[RESUMED PLAN EXECUTION] 用户明确恢复此前中断的计划。只继续尚未完成的步骤。",
    `Plan: ${execution.planId}@${execution.revision}`,
    ...execution.steps.map(
      (step) => `- [${step.status}] ${step.id}: ${step.title}\n  ${step.description}`,
    ),
    "恢复某一步前，先调用 update_plan 将它标记为 in_progress；实施并验证成功后，再调用 update_plan 将它标记为 completed（不再需要的步骤标记为 skipped）。",
    "Graph 模式允许通过 yield_agent_graph 持久化等待子任务，并在唤醒后继续。除此之外，只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
  ].join("\n\n");
}

function planControlContext(sessionId: string, operationId: string, writeGuard?: Session) {
  return {
    sessionId,
    invocationId: `plan-control:${operationId}`,
    runId: `plan-control:${operationId}`,
    turnId: `turn:plan-control:${operationId}`,
    ...(writeGuard ? { writeGuard } : {}),
  };
}

function planAdmissionKey(sessionId: string, operationId: string): string {
  return `${sessionId}\u0000${operationId}`;
}

function planRevisionRequestTurnTail(projection: PlanProjection): string | undefined {
  const request = projection.revisionRequest;
  if (!request) return undefined;
  const context = {
    planId: request.planId.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    expectedRevision: request.expectedRevision,
    operationId: request.operationId.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    requestedAt: request.requestedAt.slice(0, PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS),
    feedback: boundedPlanRevisionFeedback(request.feedback),
  };
  return [
    "<plan-revision-request>",
    "这是从持久化事件恢复的用户修订要求。请按该反馈调查并调用 submit_plan 提交同一 planId 的下一修订版；不要批准或执行旧修订。",
    JSON.stringify(context),
    "</plan-revision-request>",
  ].join("\n");
}

function boundedPlanRevisionFeedback(feedback: string): string {
  if (feedback.length <= PLAN_REVISION_FEEDBACK_MAX_CHARS) return feedback;
  const omitted = feedback.length - PLAN_REVISION_FEEDBACK_MAX_CHARS;
  return `${feedback.slice(0, PLAN_REVISION_FEEDBACK_MAX_CHARS)}\n...[truncated ${omitted} chars]`;
}

async function acquirePlanControlSession(
  input: PlanSessionRequest,
  host: RunAgentCliDependencies,
): Promise<{ session: Session; lease: SessionManagerLease; workDir: string }> {
  const picoHome = resolvePicoHome({
    picoHome: input.picoHome ?? host.picoHome,
    env: input.env ?? host.env ?? process.env,
  });
  const workDir = await resolveWorkDir(input.dir);
  const lease = await acquireRuntimeSession({
    sessionSelection: { mode: "resume", sessionId: input.sessionId },
    workDir,
    picoHome,
    resumeExistingSession: false,
  });
  return { session: lease.session, lease, workDir };
}

function planControlExecutionHost(
  input: PlanSessionRequest,
  host: RunAgentCliDependencies,
): RunAgentCliDependencies {
  return {
    ...host,
    ...(input.picoHome ? { picoHome: input.picoHome } : {}),
    ...(input.env ? { env: input.env } : {}),
  };
}

function replayedPlanControlResult(
  sessionId: string,
  workDir: string,
  operationId: string,
): RunAgentCliResult {
  return {
    sessionId,
    sessionSelection: { mode: "resume", sessionId },
    workDir,
    finalMessage: "Plan control operation was already processed; no Run was repeated.",
    usage: { promptTokens: 0, completionTokens: 0, costCNY: 0 },
    messages: [],
    replayedOperationId: operationId,
  };
}

export type AgentRuntimeRequest = RunAgentCliOptions;
export type AgentRuntimeResult = RunAgentCliResult;
export type AgentRuntimeDependencies = RunAgentCliDependencies;

export async function executeAgentRuntime(
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies = {},
): Promise<RunAgentCliResult> {
  // 阶段 1：解析宿主请求与静态配置。
  dependencies.signal?.throwIfAborted();
  const maxTurns = resolveHostAgentMaxTurns(dependencies.maxTurns);
  const picoHome = resolvePicoHome({
    picoHome: dependencies.picoHome,
    env: dependencies.env ?? process.env,
  });
  const runtimeEnv: RunAgentEnv = Object.freeze({
    ...(dependencies.env ?? process.env),
    PICO_HOME: picoHome,
  });
  const resumeExistingSession = dependencies.resumeExistingSession === true;
  if (dependencies.prestartedRun && !resumeExistingSession && !dependencies.prestartedUserInput) {
    throw new Error("new-turn prestartedRun requires prestartedUserInput");
  }
  if (dependencies.prestartedUserInput && (!dependencies.prestartedRun || resumeExistingSession)) {
    throw new Error("prestartedUserInput requires a non-resume prestartedRun");
  }
  const prompt = resumeExistingSession ? options.prompt : normalizePrompt(options.prompt);
  const kind = options.provider ?? "openai";
  const workDir = await resolveWorkDir(options.dir);
  await reconcileUnfinishedSessionForksOrThrow(workDir, {
    picoHome,
    runtimePort: createSessionForkRuntimePort(),
  });
  const execution = options.execution ?? ({ kind: "foreground" } as const);
  const backgroundPolicy =
    execution.kind === "background"
      ? await prepareBackgroundExecution(execution, workDir, options, dependencies, picoHome)
      : undefined;
  const backgroundApiKey = await resolveBackgroundCredential(options, execution, dependencies);
  const picoConfig = dependencies.isolatedHeadless
    ? createIsolatedPicoConfig(workDir)
    : await loadPicoProjectConfig(workDir);
  const webSearchSettings = Object.freeze({
    ...(dependencies.webSearchSettings ??
      (dependencies.isolatedHeadless
        ? DEFAULT_WEB_SEARCH_SETTINGS
        : (await new UserConfigStore({ picoHome }).read()).config.defaults?.webSearch ??
          DEFAULT_WEB_SEARCH_SETTINGS)),
  });
  let searchUnavailableReason: string | undefined;
  const claudeCompatibility = picoConfig.compatibility.claude;
  const configuredAdditionalDirectories = picoConfig.additionalDirectories;
  const sessionSelection = options.sessionSelection;
  const defaultConfigModel = options.model ?? defaultModel(kind);
  if (
    dependencies.configuredSubagentChild &&
    liveConfiguredChildAdmissions.has(
      sessionEntryKey(
        sessionSelection.sessionId,
        workDir,
        picoHome,
        dependencies.runtimeSession?.runtimeStorageRoot,
      ),
    )
  ) {
    throw new Error("Configured child session already has an active admission");
  }

  // 阶段 2：获取持久化 Session，并推导会话级有效配置。
  const injectedSession = dependencies.runtimeSession;
  if (
    injectedSession &&
    (injectedSession.id !== sessionSelection.sessionId || injectedSession.workDir !== workDir)
  ) {
    throw new Error(
      `Host-selected Session does not match the runtime request: ${sessionSelection.sessionId}`,
    );
  }
  const sessionLease = injectedSession
    ? { session: injectedSession, release: globalSessionManager.pin(injectedSession) }
    : await acquireRuntimeSession({
        sessionSelection,
        workDir,
        picoHome,
        resumeExistingSession,
      });
  const session = sessionLease.session;
  const sessionStorageRoot = session.runtimeStorageRoot;
  let executionCoordinator: PlanCoordinator | undefined;
  let activeExecutionPlanId: string | undefined;
  let planRun = false;
  let livePlanAdmission: string | undefined;
  let liveConfiguredChildAdmission: string | undefined;
  let planExecutionPromptId: string | undefined;
  const ownsRuntimeState = dependencies.runtimeState === undefined;
  let sessionLeaseTransferred = false;
  let cleanupRuntimeState: SessionRuntime | undefined;
  let ownedUsageStore: SqliteRuntimeControlStore | undefined;
  let ownsMcpManager = false;
  let cleanupMcpManager: McpConnectionManager | undefined;
  let memoryRepository: SqliteMemoryItemStore | undefined;
  let memoryContextBuilder: AtomicMemoryContextBuilder | undefined;
  let atomicMemoryRuntime: AtomicMemoryRuntime | undefined;
  let unsubscribeMcpStatus: (() => void) | undefined;
  const cleanupScope = new RuntimeCleanupScope((resource, error) => {
    logger.warn(
      { resource, error: error instanceof Error ? error.message : String(error) },
      "[Runtime] 资源释放失败",
    );
  });
  cleanupScope.register("Session acquisition lease", () => {
    if (!sessionLeaseTransferred) sessionLease.release();
  });
  cleanupScope.register("Workspace memory repository", () => memoryRepository?.close());

  try {
    let configuredChildBoundaryCeiling: ExecutionBoundary | undefined;
    const childDefinition = session.runtimeEventStore
      ? await readConfiguredSubagentDefinition(session.runtimeEventStore, session.id, workDir)
      : undefined;
    if (childDefinition) {
      if (
        dependencies.configuredSubagentChild &&
        dependencies.configuredSubagentChild.definition.profile !== childDefinition.profile
      )
        throw new Error("Child session capability cannot change");
      if (!dependencies.configuredSubagentChild && childDefinition.workspace !== "shared")
        throw new Error("独立 worktree 子任务暂不支持续用，请从父任务启动新的子任务。");
      dependencies = {
        ...dependencies,
        configuredSubagentChild: {
          ...dependencies.configuredSubagentChild,
          definition: childDefinition,
          executionBoundaryCeiling:
            dependencies.configuredSubagentChild?.executionBoundaryCeiling ??
            configuredSubagentExecutionBoundary(childDefinition),
        },
      };
    }
    if (dependencies.configuredSubagentChild) {
      if (backgroundPolicy || dependencies.agentGraph || options.approvedPlan)
        throw new Error("Child session cannot switch execution policy");
      const capabilityBoundary = configuredSubagentExecutionBoundary(
        dependencies.configuredSubagentChild.definition,
      );
      const expectedBoundary = dependencies.configuredSubagentChild.executionBoundaryCeiling;
      if (
        expectedBoundary.kind !== "bypass" &&
        (!executionBoundaryContains(capabilityBoundary, expectedBoundary) ||
          !executionBoundaryContains(expectedBoundary, capabilityBoundary))
      ) {
        throw new Error("Configured child execution boundary ceiling changed");
      }
      const configuredChildAdmission = sessionEntryKey(
        session.id,
        session.workDir,
        session.picoHome,
        session.runtimeStorageRoot,
      );
      if (liveConfiguredChildAdmissions.has(configuredChildAdmission)) {
        throw new Error("Configured child session already has an active admission");
      }
      liveConfiguredChildAdmissions.add(configuredChildAdmission);
      liveConfiguredChildAdmission = configuredChildAdmission;
      configuredChildBoundaryCeiling = await reconcileConfiguredChildExecutionBoundary(
        session,
        expectedBoundary,
        sessionSelection.mode,
      );
      options = {
        ...options,
        collaborationMode: "agent",
        permissionMode: configuredChildBoundaryCeiling.kind === "bypass" ? "full-access" : "ask",
        orchestrationMode: "default",
        agentSwarmAuthorization: "none",
      };
    }
    if (resumeExistingSession && dependencies.runtimeState === undefined) {
      throw new Error("resumeExistingSession requires an existing runtimeState.");
    }
    dependencies.runtimeState?.assertCompatible(session);
    if (dependencies.runtimeState) {
      sessionLease.release();
      sessionLeaseTransferred = true;
    }
    if (
      sessionSelection.mode !== "new" &&
      session.getRuntimeStateSnapshot().settings === undefined
    ) {
      throw new Error(
        `Session ${sessionSelection.sessionId} has no persisted settings and cannot be resumed`,
      );
    }
    const sessionSettingDefaults = {
      sessionId: sessionSelection.sessionId,
      sessionMode: sessionSelection.mode,
      ...(sessionSelection.mode === "fork" ? { forkFrom: sessionSelection.sourceSessionId } : {}),
      cwd: workDir,
      picoHome: session.picoHome,
      provider: kind,
      ...(sessionSelection.mode === "fork"
        ? {}
        : backgroundPolicy
          ? { collaborationMode: "agent" as const, permissionMode: "full-access" as const }
          : {
              ...(options.collaborationMode !== undefined
                ? { collaborationMode: options.collaborationMode }
                : {}),
              ...(options.permissionMode !== undefined
                ? { permissionMode: options.permissionMode }
                : {}),
            }),
      model: defaultConfigModel,
      ...(options.modelRouteId !== undefined ? { modelRouteId: options.modelRouteId } : {}),
      ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
    };
    const settings = getOrCreateSessionSettings(sessionSettingDefaults, {
      persistence: session,
      ...(backgroundPolicy ? { restore: false } : {}),
    });
    if (configuredChildBoundaryCeiling) {
      const boundaryAfterSettingsRestore = session.getRuntimeStateSnapshot().boundary;
      if (
        !boundaryAfterSettingsRestore ||
        !sameExecutionBoundaryCapability(
          configuredChildBoundaryCeiling,
          boundaryAfterSettingsRestore,
        )
      ) {
        throw new Error("Configured child execution boundary changed during admission");
      }
    }
    // A configured child executes against the boundary admitted above for its entire Run.
    // External settings writes may update the durable Session concurrently, but must not
    // widen this Run's physical filesystem, subprocess, or network authority.
    const runtimeExecutionBoundary = (): ExecutionBoundary => {
      const boundary = configuredChildBoundaryCeiling ?? session.getRuntimeStateSnapshot().boundary;
      if (!boundary) {
        throw new Error(`Session ${session.id} has no durable execution boundary`);
      }
      return boundary;
    };
    const sideConversation = settings.sideConversation === true;
    const collaborationMode = (): "agent" | "plan" =>
      dependencies.configuredSubagentChild || dependencies.agentGraph?.kind === "operator"
        ? "agent"
        : settings.collaborationMode;
    planRun = collaborationMode() === "plan";
    const inheritedAuthorization = await readInheritedRunSwarmAuthorization(
      session,
      dependencies.prestartedRun,
      resumeExistingSession,
    );
    const requestedMode = options.orchestrationMode ?? settings.orchestrationMode;
    const agentSwarmAuthorization = dependencies.configuredSubagentChild
      ? "none"
      : (inheritedAuthorization ??
        options.agentSwarmAuthorization ??
        (requestedMode === "swarm"
          ? options.orchestrationMode === "swarm"
            ? "turn_override"
            : "session_mode"
          : "none"));
    const orchestrationMode = (): "default" | "graph" | "swarm" =>
      dependencies.configuredSubagentChild || collaborationMode() === "plan"
        ? "default"
        : inheritedAuthorization !== undefined
          ? inheritedAuthorization !== "none"
            ? "swarm"
            : requestedMode === "swarm"
              ? "default"
              : requestedMode
          : requestedMode;
    const permissionMode = (): "ask" | "auto" | "full-access" =>
      dependencies.configuredSubagentChild
        ? configuredChildBoundaryCeiling?.kind === "bypass"
          ? "full-access"
          : "ask"
        : dependencies.agentGraph?.kind === "operator"
          ? dependencies.agentGraph.executionPermissionMode
          : settings.permissionMode;
    if (options.approvedPlan) {
      if (settings.collaborationMode !== "agent") {
        throw new Error("Approved plan execution requires collaborationMode=agent");
      }
      if (!session.runtimeEventStore)
        throw new Error("Approved plan execution requires durable storage");
      executionCoordinator = new PlanCoordinator(session.runtimeEventStore, {
        sessionId: session.id,
        invocationId: `execution-start:${options.approvedPlan.planId}`,
        runId: `execution-start:${options.approvedPlan.planId}:${options.approvedPlan.revision}`,
        turnId: `turn:execution-start:${options.approvedPlan.planId}`,
        writeGuard: session,
      });
      const operationId =
        options.approvedPlan.operationId ??
        `${options.approvedPlan.transition === "resume" ? "resume" : "start"}-plan:${randomUUID()}`;
      planExecutionPromptId = `plan-execution-input:${operationId}`;
      livePlanAdmission = planAdmissionKey(session.id, operationId);
      livePlanAdmissions.add(livePlanAdmission);
      if (options.approvedPlan.transition === "resume") {
        const beforeResume = await executionCoordinator.project();
        if (beforeResume.execution?.status !== "interrupted") {
          throw new PlanConflictError(
            `Plan execution is not interrupted before resume: ${beforeResume.execution?.status ?? "missing"}`,
          );
        }
        await executionCoordinator.resume({
          operationId,
          expectedSessionSequence: options.approvedPlan.expectedSessionSequence,
          planId: options.approvedPlan.planId,
          ...(options.approvedPlan.claimOperationId
            ? { claimOperationId: options.approvedPlan.claimOperationId }
            : {}),
        });
      } else {
        await executionCoordinator.startExecution({
          operationId,
          expectedSessionSequence: options.approvedPlan.expectedSessionSequence,
          planId: options.approvedPlan.planId,
          revision: options.approvedPlan.revision,
          ...(dependencies.agentGraph?.kind === "root" && dependencies.agentGraph.graph
            ? { graph: dependencies.agentGraph.graph }
            : {}),
        });
      }
      activeExecutionPlanId = options.approvedPlan.planId;
    } else if (
      dependencies.agentGraph?.kind === "root" &&
      dependencies.agentGraph.graph &&
      session.runtimeEventStore
    ) {
      const coordinator = new PlanCoordinator(
        session.runtimeEventStore,
        planControlContext(session.id, "graph-attach", session),
      );
      const projection = await coordinator.project();
      const execution = projection.execution;
      if (
        execution?.graph?.graphId === dependencies.agentGraph.graph.graphId &&
        execution.graph.epoch === dependencies.agentGraph.graph.epoch
      ) {
        if (execution.status !== "active")
          throw new PlanConflictError(`Bound plan execution is ${execution.status}`);
        executionCoordinator = coordinator;
        activeExecutionPlanId = execution.planId;
      }
    }
    const memoryTrustStore =
      dependencies.memoryTrustStore ?? new WorkspaceTrustStore({ userStateDirectory: picoHome });
    // Maka separates prompt reads from extraction admission. Plan can read;
    // side conversations and scheduled runs use the ordinary memory policy.
    const memoryRecallAllowed = async () => {
      if (
        dependencies.isolatedHeadless ||
        dependencies.configuredSubagentChild ||
        dependencies.agentGraph?.kind === "operator"
      )
        return { allowed: false as const, reason: "runtime_profile_disabled" };
      const canonical = await memoryTrustStore.canonicalize(workDir);
      return (await memoryTrustStore.isTrusted(canonical))
        ? { allowed: true as const }
        : { allowed: false as const, reason: "workspace_untrusted" };
    };
    const memoryExtractionAllowed = async () =>
      collaborationMode() === "plan"
        ? { allowed: false as const, reason: "runtime_profile_disabled" }
        : memoryRecallAllowed();
    try {
      if ((await memoryRecallAllowed()).allowed) {
        const memoryPaths = resolvePicoPaths(workDir, { picoHome });
        memoryRepository = new SqliteMemoryItemStore(atomicMemoryDatabasePath(picoHome));
        memoryContextBuilder = new AtomicMemoryContextBuilder(
          memoryRepository,
          memoryPaths.workspace.id,
        );
      }
    } catch (error) {
      logger.warn({ workDir, error: String(error) }, "[Memory] atomic memory unavailable");
      memoryRepository?.close();
      memoryRepository = undefined;
    }
    const workspaceRoots = await WorkspaceRoots.create(
      workDir,
      backgroundPolicy ||
        dependencies.agentGraph?.kind === "operator" ||
        dependencies.configuredSubagentChild ||
        sessionSelection.mode === "fork"
        ? []
        : [
            ...configuredAdditionalDirectories,
            ...(options.addDirs ?? []),
            ...settings.additionalDirectories,
          ],
    );
    applyExecutionBoundaryToWorkspaceRoots(workspaceRoots, runtimeExecutionBoundary());
    setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));
    const processSandboxScratchRoot = join(picoHome, "sandboxes", session.id);
    const currentMainProcessSandbox = (): NonNullable<
      DefaultToolRegistryOptions["processSandbox"]
    > => {
      if (backgroundPolicy) {
        return compileRuntimeProcessSandbox({
          workspaceGeneration: workspaceRoots.generation(),
          scratchRoot: processSandboxScratchRoot,
          backgroundNetworkPolicy: backgroundPolicy.snapshot.toolNetworkPolicy,
        });
      }
      const executionBoundary = runtimeExecutionBoundary();
      return compileRuntimeProcessSandbox({
        collaborationMode: collaborationMode(),
        workspaceGeneration: workspaceRoots.generation(),
        scratchRoot: processSandboxScratchRoot,
        networkEnabled:
          !dependencies.configuredSubagentChild &&
          globalSessionPermissionGrants.allowsNetwork(session.id, workDir, session.picoHome),
        executionBoundary,
      });
    };
    const traceEnabled = options.trace === true || isTruthyEnv(runtimeEnv.PICO_TRACE);
    const effectiveOptions: RunAgentCliOptions = {
      ...options,
      ...(backgroundApiKey !== undefined ? { apiKey: backgroundApiKey } : {}),
      dir: workDir,
      sessionSelection,
      model: options.model ?? settings.model,
      collaborationMode: backgroundPolicy ? "agent" : collaborationMode(),
      orchestrationMode: backgroundPolicy ? "default" : orchestrationMode(),
      trace: traceEnabled,
      addDirs: backgroundPolicy ? [] : [...settings.additionalDirectories],
      ...(options.thinkingEffort !== undefined
        ? { thinkingEffort: options.thinkingEffort }
        : settings.thinkingEffortExplicit
          ? { thinkingEffort: settings.thinkingEffort }
          : {}),
    };
    const providerConfig = resolveProviderConfig(
      effectiveOptions,
      dependencies.provider !== undefined,
    );
    providerConfig.sessionId = session.id;
    const pluginSnapshot =
      backgroundPolicy ||
      dependencies.configuredSubagentChild ||
      dependencies.agentGraph?.kind === "operator"
        ? undefined
        : (dependencies.pluginSnapshot ??
          (await loadPluginRuntimeSnapshot({
            workDir,
            env: runtimeEnv,
            picoHome,
            ...(dependencies.pluginCapabilityRegistry
              ? { capabilityRegistry: dependencies.pluginCapabilityRegistry }
              : {}),
          })));
    const ownsPluginSnapshot =
      pluginSnapshot !== undefined && dependencies.pluginSnapshot === undefined;
    const pluginActivationScope = new PluginCapabilityActivationScope();
    cleanupScope.register("Session 组件 Hook", () => cleanupRuntimeState?.clearComponentHooks());
    cleanupScope.register("MCP 状态订阅", () => unsubscribeMcpStatus?.());
    cleanupScope.register("MCP manager", async () => {
      if (!cleanupMcpManager || !ownsMcpManager) return;
      await cleanupMcpManager.closeAll();
      dependencies.mcpStatusSink?.(cleanupMcpManager.getStatusSnapshot());
    });
    cleanupScope.register("SessionRuntime", () =>
      ownsRuntimeState ? cleanupRuntimeState?.dispose() : undefined,
    );
    cleanupScope.register("Plugin capability activations", () => pluginActivationScope.dispose());
    cleanupScope.register("Plugin runtime snapshot", () =>
      ownsPluginSnapshot ? pluginSnapshot?.dispose() : undefined,
    );
    cleanupScope.register("Runtime usage ledger", () => ownedUsageStore?.close());
    if (pluginSnapshot?.diagnostics.length) {
      logger.warn(
        {
          workDir,
          diagnostics: pluginSnapshot.diagnostics,
        },
        "[Plugin] Runtime snapshot contains unavailable contributions",
      );
    }
    const skillLoaderFactory = (root: string): SkillLoader =>
      new SkillLoader(root, {
        includeUserResources: !dependencies.isolatedHeadless,
        includeClaudeProjectResources:
          claudeCompatibility.enabled && claudeCompatibility.projectResources,
        includeClaudeUserResources:
          claudeCompatibility.enabled && claudeCompatibility.userResources,
        ...(dependencies.isolatedHeadless ? { catalogScope: "none" as const } : {}),
        ...(pluginSnapshot?.skillSources ? { externalSources: pluginSnapshot.skillSources } : {}),
        env: runtimeEnv,
        picoHome,
      });

    // 阶段 3：装配 Provider、工具、Hook 与 AgentEngine 能力图。
    // headless/folder 装配不注入 taskHostRuntime：提前创建独立 usage ledger。
    if (dependencies.runtimeState === undefined && !ownedUsageStore) {
      try {
        ownedUsageStore = new SqliteRuntimeControlStore({
          storageRoot: sessionStorageRoot,
        });
      } catch (error) {
        logger.error(
          { workDir, error: error instanceof Error ? error.message : String(error) },
          "[Tracker] runtime usage ledger 初始化失败",
        );
      }
    }
    const runtimeState =
      dependencies.runtimeState ??
      (await createSessionRuntime({
        session,
        sessionLease,
        env: runtimeEnv,
        workspaceTrustStore: memoryTrustStore,
        ...(dependencies.toolDisclosure !== undefined
          ? { toolDisclosure: dependencies.toolDisclosure }
          : {}),
        // LSP 是项目配置启动的子进程；后台策略尚未为其提供网络/写入沙箱。
        lspEnabled:
          !backgroundPolicy &&
          !dependencies.configuredSubagentChild &&
          dependencies.agentGraph?.kind !== "operator" &&
          collaborationMode() !== "plan",
        lspServers: [...picoConfig.lspServers, ...(pluginSnapshot?.lspServers ?? [])],
        processSandbox: {
          ...currentMainProcessSandbox(),
          workspaceRoots: workspaceRoots.list(),
        },
        sessionStartSource:
          sessionSelection.mode === "resume" || sessionSelection.mode === "continue"
            ? "resume"
            : "startup",
        ...(backgroundPolicy ||
        dependencies.configuredSubagentChild ||
        dependencies.isolatedHeadless ||
        collaborationMode() === "plan"
          ? { hooks: false as const }
          : {}),
        ...(collaborationMode() !== "plan" && dependencies.hookService
          ? { hookService: dependencies.hookService }
          : {}),
        ...(collaborationMode() !== "plan" && pluginSnapshot?.hookSources
          ? { hookExtensionSources: pluginSnapshot.hookSources }
          : {}),
      }));
    if (ownsRuntimeState) sessionLeaseTransferred = true;
    cleanupRuntimeState = runtimeState;
    if (!ownsRuntimeState) {
      const codeIntelligenceEnabled =
        dependencies.agentGraph?.kind !== "operator" && collaborationMode() !== "plan";
      // 关闭时先停进程再换边界；开启时先换边界再启动，确保一次切换且
      // LSP 从未短暂运行在上一种权限模式的进程沙箱中。
      if (!codeIntelligenceEnabled) {
        await runtimeState.setCodeIntelligenceEnabled(false);
      }
      await runtimeState.refreshProcessSandbox({
        ...currentMainProcessSandbox(),
        workspaceRoots: workspaceRoots.list(),
      });
      if (codeIntelligenceEnabled) {
        await runtimeState.setCodeIntelligenceEnabled(true);
      }
    }
    if (collaborationMode() !== "plan" && dependencies.hookService) {
      runtimeState.attachHookService(dependencies.hookService);
    }
    const activeHookService = collaborationMode() === "plan" ? undefined : runtimeState.hookService;
    if (
      dependencies.toolDisclosure !== undefined &&
      dependencies.toolDisclosure !== runtimeState.toolDisclosure
    ) {
      throw new Error("runtimeState.toolDisclosure must match dependencies.toolDisclosure");
    }
    if (!runtimeState.taskHostRuntime && !ownedUsageStore) {
      try {
        ownedUsageStore = new SqliteRuntimeControlStore({
          storageRoot: sessionStorageRoot,
        });
      } catch (error) {
        logger.error(
          { workDir, error: error instanceof Error ? error.message : String(error) },
          "[Tracker] runtime usage ledger 初始化失败",
        );
      }
    }
    const usageLedger = runtimeState.taskHostRuntime?.jobService ?? ownedUsageStore;
    if (usageLedger) {
      try {
        ensureSessionUsageBaseline(usageLedger, session);
      } catch (error) {
        logger.error(
          { sessionId: session.id, error: error instanceof Error ? error.message : String(error) },
          "[Tracker] Session usage baseline 导入失败",
        );
      }
    }
    const trackerOptions: CostTrackerOptions = {
      ...(usageLedger ? { ledger: usageLedger } : {}),
      context: () => {
        const goalId = runtimeState.goalManager.getActive()?.id;
        return {
          purpose: "main",
          sessionId: session.id,
          conversationId: session.conversationId,
          ...(goalId ? { goalId } : {}),
        };
      },
    };
    const currentConfig: ProviderConfig = providerConfig;
    const providerDecorator = (provider: LLMProvider): LLMProvider => {
      const activated = activatePluginProviderCapabilities(
        pluginSnapshot,
        dependencies.pluginCapabilityRegistry,
        provider,
        pluginActivationScope,
      );
      return dependencies.providerDecorator ? dependencies.providerDecorator(activated) : activated;
    };
    const modelAssembly = assembleRuntimeModels({
      kind,
      config: currentConfig,
      session,
      sessionStorageRoot,
      trackerOptions,
      ...(dependencies.provider !== undefined ? { provider: dependencies.provider } : {}),
      ...(dependencies.providerFactory ? { providerFactory: dependencies.providerFactory } : {}),
      providerDecorator,
      ...(effectiveOptions.modelRouteId ? { modelRouteId: effectiveOptions.modelRouteId } : {}),
      ...(dependencies.modelRouter ? { modelRouter: dependencies.modelRouter } : {}),
    });
    const { providerFactory, providerDependencies, subagentModelRouter, parentModelRouteId } =
      modelAssembly;
    const contextRuntime = buildContextRuntime(kind, providerConfig.model);
    const nativeSearchNetworkAllowed = () => backgroundPolicy
      ? backgroundPolicy.snapshot.toolNetworkPolicy === "allow"
      : currentBoundaryAllowsNetwork();
    const trackedProvider = guardNativeSearchRequests(modelAssembly.provider, nativeSearchNetworkAllowed);
    const rebuildProvider = modelAssembly.rebuildProvider
      ? (failure: Parameters<NonNullable<typeof modelAssembly.rebuildProvider>>[0]) => {
          const rebuilt = modelAssembly.rebuildProvider!(failure);
          return rebuilt ? guardNativeSearchRequests(rebuilt, nativeSearchNetworkAllowed) : undefined;
        }
      : undefined;
    if (memoryRepository && (await memoryExtractionAllowed()).allowed) {
      atomicMemoryRuntime = new AtomicMemoryRuntime({
        workDir,
        picoHome,
        sessionId: session.id,
        gate: memoryExtractionAllowed,
        ...(dependencies.atomicMemoryLifecycle
          ? { lifecycle: dependencies.atomicMemoryLifecycle }
          : {}),
        supported: kind !== "responses",
        preserveSourceTools: !!trackedProvider.requestCapabilities?.toolChoiceNoneWithTools,
        contextWindowTokens: contextRuntime.budget.contextWindowTokens,
        reservedOutputTokens: contextRuntime.budget.reservedOutputTokens,
        ...(dependencies.memoryChangedSink ? { onChanged: dependencies.memoryChangedSink } : {}),
        modelFactory:
          dependencies.atomicMemoryModelFactory ??
          (async () => {
            const ledger = new SqliteRuntimeControlStore({ storageRoot: sessionStorageRoot });
            try {
              const provider = new CostTracker(
                dependencies.provider ??
                  providerFactory(kind, currentConfig, undefined, providerDependencies),
                billingRouteForProvider(kind, currentConfig),
                undefined,
                {
                  ledger,
                  recordRuntimeEvents: false,
                  context: { purpose: "memory_review", sessionId: session.id },
                },
              );
              return {
                model: new ProviderAtomicMemoryModel(provider),
                dispose: () => ledger.close(),
              };
            } catch (error) {
              ledger.close();
              throw error;
            }
          }),
      });
    }
    const approvalManager = dependencies.approvalManager ?? globalApprovalManager;
    const approvalNotifier =
      dependencies.approvalNotifier ?? buildFailClosedApprovalNotifier(approvalManager);
    let activeMcpManager = collaborationMode() === "plan" ? undefined : dependencies.mcpManager;
    const oneShotMcpCalls = new Set<string>();
    const oneShotRemoteMcpCalls = new Set<string>();
    const admittedHookMcpCalls = new Set<string>();
    let refreshRuntimeBoundary: (options?: {
      updateMcp?: boolean;
    }) => Promise<void> = async () => {};

    const executionBoundaryContext = () => ({
      workspaceRoots: workspaceRoots.list(),
      tmpdir: tmpdir(),
      slashTmp: "/tmp",
    });
    const currentBoundaryAllowsNetwork = (): boolean => {
      if (backgroundPolicy) return true;
      if (collaborationMode() === "plan") return false;
      const boundary = runtimeExecutionBoundary();
      return (
        boundary?.kind === "bypass" ||
        (boundary?.kind === "managed" && boundary.profile.network.kind === "enabled") ||
        (!dependencies.configuredSubagentChild &&
          globalSessionPermissionGrants.allowsNetwork(session.id, workDir, session.picoHome))
      );
    };
    const ensureDurableNetworkBoundary = async (): Promise<boolean> => {
      if (dependencies.configuredSubagentChild) return false;
      let changed = false;
      await session.withSerializedExecution(async () => {
        const current = session.getRuntimeStateSnapshot().boundary;
        if (!current || current.kind !== "managed" || current.profile.network.kind === "enabled") {
          return;
        }
        const applied = applyExecutionBoundaryExpansion(
          current,
          current.revision,
          { network: { enabled: true } },
          executionBoundaryContext(),
        );
        if (applied.outcome !== "applied") return;
        session.updateRuntimeState({ boundary: applied.boundary });
        await session.flushPersistence();
        changed = true;
      });
      return changed;
    };
    const waitForRuntimeApproval = async (input: {
      readonly toolName: string;
      readonly providerCallId: string;
      readonly args: string;
      readonly reason: string;
      readonly signal?: AbortSignal;
      readonly sessionScope?: Parameters<ApprovalManager["waitForApproval"]>[6]["sessionScope"];
    }): Promise<{ readonly approvalId: string; readonly result: ApprovalResult }> => {
      const approvalId = `approval_${randomUUID()}`;
      const run = currentRuntimeRun();
      const record = run?.claimsSession(session) === true;
      if (record) {
        await run.recordApprovalRequested(approvalId, input.providerCallId, input.toolName);
      }
      let result: ApprovalResult;
      try {
        result = await approvalManager.waitForApproval(
          approvalId,
          input.toolName,
          input.args,
          approvalNotifier,
          undefined,
          input.signal ?? dependencies.signal,
          {
            providerCallId: input.providerCallId,
            reason: input.reason,
            ...(input.sessionScope ? { sessionScope: input.sessionScope } : {}),
          },
        );
      } catch (error) {
        if (record) await run.recordApprovalSettled(approvalId, "rejected");
        throw error;
      }
      if (record) {
        await run.recordApprovalSettled(approvalId, result.allowed ? "approved" : "rejected");
      }
      return { approvalId, result };
    };
    const requestHostNetworkApproval = async (input: {
      readonly toolName: string;
      readonly providerCallId: string;
      readonly args: string;
      readonly reason: string;
      readonly signal?: AbortSignal;
      /** MCP physical gates cannot restart/close the manager that is currently calling them. */
      readonly deferMcpRefresh?: boolean;
    }): Promise<boolean> => {
      const boundary = runtimeExecutionBoundary();
      if (boundary?.kind === "external") return false;
      if (
        (dependencies.configuredSubagentChild || dependencies.agentGraph?.kind === "operator") &&
        !currentBoundaryAllowsNetwork()
      ) {
        return false;
      }
      const { result } = await waitForRuntimeApproval({
        ...input,
        ...(input.deferMcpRefresh ? {} : { sessionScope: { type: "network" as const } }),
      });
      if (!result.allowed) return false;
      if (
        result.allowForSession &&
        !input.deferMcpRefresh &&
        !dependencies.configuredSubagentChild
      ) {
        globalSessionPermissionGrants.addNetwork(session.id, workDir, session.picoHome);
        if (await ensureDurableNetworkBoundary()) {
          await refreshRuntimeBoundary();
        }
      }
      return true;
    };
    const remoteNetworkGate = async (request: McpRemoteNetworkRequest): Promise<boolean> => {
      const toolCallId = request.toolCallId;
      if (
        toolCallId &&
        (oneShotRemoteMcpCalls.delete(toolCallId) || admittedHookMcpCalls.delete(toolCallId))
      ) {
        return true;
      }
      if (currentBoundaryAllowsNetwork()) return true;
      return requestHostNetworkApproval({
        toolName: request.tool ? `mcp__${request.server}__${request.tool}` : "mcp_network",
        providerCallId: toolCallId ?? `mcp-network:${request.server}:${request.operation}`,
        args: JSON.stringify({
          server: request.server,
          transport: request.transport,
          url: request.url,
          operation: request.operation,
          ...(request.tool ? { tool: request.tool } : {}),
        }),
        reason: `MCP ${request.server} 将通过公网执行 ${request.operation}`,
        ...(request.signal ? { signal: request.signal } : {}),
        deferMcpRefresh: true,
      });
    };
    const hostNetworkGate = async (request: HookHostNetworkRequest): Promise<boolean> => {
      if (currentBoundaryAllowsNetwork()) return true;
      const providerCallId =
        request.operation === "mcp_tool_call"
          ? request.toolCallId
          : `hook-network:${request.handlerId}:${request.redirect}`;
      const allowed = await requestHostNetworkApproval({
        toolName: "hook_network",
        providerCallId,
        args: JSON.stringify({
          operation: request.operation,
          handlerId: request.handlerId,
          event: request.event,
          source: {
            kind: request.source.kind,
            path: request.source.path,
            version: request.source.version,
          },
          ...(request.operation === "http_request"
            ? { url: request.url, redirect: request.redirect }
            : { server: request.server, tool: request.tool }),
        }),
        reason:
          request.operation === "http_request"
            ? `Hook ${request.handlerId} 将访问 ${request.url}`
            : `Hook ${request.handlerId} 将调用远程 MCP ${request.server}/${request.tool}`,
        signal: request.signal,
      });
      if (allowed && request.operation === "mcp_tool_call") {
        admittedHookMcpCalls.add(request.toolCallId);
      }
      return allowed;
    };
    bindRuntimeHookCapabilities({
      session,
      runtimeState,
      provider: trackedProvider,
      workDir,
      workspaceRoots,
      picoHome,
      runtimeEnv,
      sandboxConfig: { ...picoConfig.sandbox, network: "deny" },
      mcpManager: () => activeMcpManager,
      hostNetworkGate,
      ...(dependencies.toolResultRedactionSecrets
        ? { toolResultRedactionSecrets: dependencies.toolResultRedactionSecrets }
        : {}),
    });
    const { goalManager, todoStore, toolDisclosure, backgroundManager } = runtimeState;
    // Host-required tools are a baseline, not discoveries inherited from an old Turn.
    const baselineToolNames: string[] = [];
    const sessionTaskAuthority = {
      repository: new SqliteSessionWorkbarRepository({
        storageRoot: sessionStorageRoot,
      }),
      sessionId: session.id,
      onChanged: (revision: number) =>
        dependencies.sessionResourceChangedSink?.({
          workspacePath: workDir,
          sessionId: session.id,
          resource: "tasks",
          revision,
        }),
    };
    if (activeExecutionPlanId) {
      baselineToolNames.push("update_plan", "cancel_plan");
    }
    // Group-loaded events remain audit facts; new Turns never replay them as activation.
    // Audit-write failure does not broaden the current Turn's bound tool set.
    // background 宿主刻意不写：无人值守 allowlist 语义下披露状态属于单次 Job
    // 生命周期，且 fire-and-forget append 会绕过 executor 的 run 事件序列
    // （可打断 recoverable-task 的 high-water CAS），不值得为不可恢复的
    // 场景引入该窗口。
    const onToolGroupLoaded: ((groupId: string, toolNames: readonly string[]) => void) | undefined =
      session.runtimeEventStore && !backgroundPolicy
        ? (groupId, toolNames) => {
            const run = currentRuntimeRun();
            if (!run?.claimsSession(session)) {
              logger.warn(
                { groupId },
                "[ToolDisclosure] 没有 active RuntimeRun，跳过 tool.group.loaded durable 写入",
              );
              return;
            }
            void run.recordToolGroupLoaded(groupId, toolNames).catch((error) => {
              // durable 写失败不阻塞激活（内存态已生效），但必须可见——
              // 静默吞错曾让 assert 层拒绝完全不可发现。
              logger.warn(
                { error: String(error), groupId },
                "[ToolDisclosure] tool.group.loaded durable 写入失败",
              );
            });
          }
        : undefined;
    const planHandoff = new PlanHandoffController();
    const planRegistryOptions: DefaultToolRegistryOptions["plan"] = {
      handoff: planHandoff,
      sessionId: session.id,
      mode: collaborationMode() === "plan" ? "planning" : "execution",
      ...(activeExecutionPlanId ? { planId: activeExecutionPlanId } : {}),
      runId: () => currentRuntimeRun()?.runId ?? "unbound-plan-run",
      coordinator: () => {
        const run = currentRuntimeRun();
        if (!run || !session.runtimeEventStore) {
          throw new Error("submit_plan requires an active durable RuntimeRun");
        }
        return new PlanCoordinator(session.runtimeEventStore, {
          sessionId: session.id,
          invocationId: run.invocationId,
          runId: run.runId,
          turnId: `turn:${run.runId}:plan`,
          writeGuard: session,
          ...(dependencies.agentGraph?.kind === "root" && dependencies.agentGraph.retireGraph
            ? { retireGraph: dependencies.agentGraph.retireGraph }
            : {}),
        });
      },
    };
    // 宿主类型推导（优先级从高到低）：background 由 execution.kind 决定，
    // headless 由 isolatedHeadless 决定——这两个安全敏感身份不可被宿主
    // 参数覆盖；其余前台交互（TUI/Desktop 共享 execute 闭包）统一为
    // desktop，dependencies.hostKind 仅作为前台身份的显式声明。
    const hostKind: ToolHostKind = backgroundPolicy
      ? "background"
      : dependencies.isolatedHeadless
        ? "headless"
        : (dependencies.hostKind ?? "desktop");
    let mainProcessSandbox = currentMainProcessSandbox();
    let mainProcessPolicy = createSandboxPolicy({
      profile: mainProcessSandbox.profile,
      workspaceRoots: workspaceRoots.list(),
      scratchRoot: mainProcessSandbox.scratchRoot ?? processSandboxScratchRoot,
      ...(mainProcessSandbox.config ? { config: mainProcessSandbox.config } : {}),
      ...(mainProcessSandbox.readRoots ? { readRoots: mainProcessSandbox.readRoots } : {}),
      ...(mainProcessSandbox.writeRoots ? { writeRoots: mainProcessSandbox.writeRoots } : {}),
      ...(mainProcessSandbox.readFiles ? { readFiles: mainProcessSandbox.readFiles } : {}),
      ...(mainProcessSandbox.writeFiles ? { writeFiles: mainProcessSandbox.writeFiles } : {}),
      ...(mainProcessSandbox.generation !== undefined
        ? { generation: mainProcessSandbox.generation }
        : {}),
    });
    refreshRuntimeBoundary = async ({ updateMcp = true } = {}) => {
      applyExecutionBoundaryToWorkspaceRoots(workspaceRoots, runtimeExecutionBoundary());
      const roots = workspaceRoots.list();
      mainProcessSandbox = currentMainProcessSandbox();
      mainProcessPolicy = createSandboxPolicy({
        profile: mainProcessSandbox.profile,
        workspaceRoots: roots,
        scratchRoot: mainProcessSandbox.scratchRoot ?? processSandboxScratchRoot,
        generation: mainProcessSandbox.generation,
        ...(mainProcessSandbox.config ? { config: mainProcessSandbox.config } : {}),
        ...(mainProcessSandbox.readRoots ? { readRoots: mainProcessSandbox.readRoots } : {}),
        ...(mainProcessSandbox.writeRoots ? { writeRoots: mainProcessSandbox.writeRoots } : {}),
        ...(mainProcessSandbox.readFiles ? { readFiles: mainProcessSandbox.readFiles } : {}),
        ...(mainProcessSandbox.writeFiles ? { writeFiles: mainProcessSandbox.writeFiles } : {}),
      });
      await runtimeState.refreshProcessSandbox({
        ...mainProcessSandbox,
        workspaceRoots: roots,
      });
      if (updateMcp && activeMcpManager) {
        await activeMcpManager.updateProcessSandbox(mainProcessPolicy);
      }
    };
    const requestSandboxBoundaryHandler: RequestSandboxBoundaryHandler | undefined =
      !backgroundPolicy &&
      !dependencies.isolatedHeadless &&
      !dependencies.configuredSubagentChild &&
      dependencies.agentGraph?.kind !== "operator" &&
      !sideConversation &&
      collaborationMode() === "agent" &&
      runtimeExecutionBoundary()?.kind === "managed"
        ? async (rawExpansion, justification, context) => {
            const expansion = await canonicalizeSandboxBoundaryExpansion(rawExpansion);
            const base = runtimeExecutionBoundary();
            if (!base || base.kind !== "managed") {
              return {
                status: "conflict",
                ...(base ? { boundaryRevision: base.revision } : {}),
                reason: "当前 Session 不是可扩展的 managed boundary",
              };
            }
            const assessment = applyExecutionBoundaryExpansion(
              base,
              base.revision,
              expansion,
              executionBoundaryContext(),
            );
            if (assessment.outcome === "noop") {
              return { status: "noop", boundaryRevision: base.revision };
            }
            if (assessment.outcome === "conflict") {
              return {
                status: "conflict",
                boundaryRevision: base.revision,
                reason: assessment.reason,
              };
            }

            const { approvalId, result } = await waitForRuntimeApproval({
              toolName: "request_sandbox_boundary",
              providerCallId:
                context?.toolCallId ?? `sandbox-boundary:${session.id}:${base.revision}`,
              args: JSON.stringify({
                baseRevision: base.revision,
                expansion,
                justification,
              }),
              reason: justification,
              ...(context?.signal ? { signal: context.signal } : {}),
            });
            if (!result.allowed) {
              return {
                status: "denied",
                requestId: approvalId,
                boundaryRevision: base.revision,
                reason: result.reason,
              };
            }

            let settlement:
              | { status: "applied"; boundaryRevision: number }
              | { status: "noop"; boundaryRevision: number }
              | { status: "conflict"; boundaryRevision: number; reason: string };
            await session.withSerializedExecution(async () => {
              const latest = session.getRuntimeStateSnapshot().boundary;
              if (!latest) {
                settlement = {
                  status: "conflict",
                  boundaryRevision: base.revision,
                  reason: "execution_boundary_missing",
                };
                return;
              }
              const applied = applyExecutionBoundaryExpansion(
                latest,
                base.revision,
                expansion,
                executionBoundaryContext(),
              );
              if (applied.outcome === "conflict") {
                settlement = {
                  status: "conflict",
                  boundaryRevision: applied.boundary.revision,
                  reason: applied.reason,
                };
                return;
              }
              if (applied.outcome === "noop") {
                settlement = { status: "noop", boundaryRevision: applied.boundary.revision };
                return;
              }
              session.updateRuntimeState({ boundary: applied.boundary });
              await session.flushPersistence();
              settlement = { status: "applied", boundaryRevision: applied.boundary.revision };
            });
            if (settlement!.status === "applied") await refreshRuntimeBoundary();
            return { ...settlement!, requestId: approvalId };
          }
        : undefined;
    const registry = buildRegistry(
      workDir,
      backgroundManager,
      goalManager,
      todoStore,
      toolDisclosure,
      workspaceRoots,
      dependencies.askUserHandler,
      runtimeState.codeIntelligence,
      (path) => {
        if (permissionMode() === "full-access") return false;
        if (collaborationMode() === "plan" || path === undefined) return true;
        return !isSensitiveCredentialPath(workspaceRoots.resolveUnchecked(path));
      },
      {
        ...mainProcessSandbox,
        // Boundary approval is durable and may settle between two tool Steps.
        // Process-backed tools must sample the new descriptor at invocation
        // time instead of retaining the registry-construction snapshot.
        resolveSandbox: currentMainProcessSandbox,
        consumeNetworkAuthorization: (toolCallId) =>
          globalSessionPermissionGrants.consumeNetworkAuthorization(
            session.id,
            workDir,
            toolCallId,
            session.picoHome,
          ),
      },
      activeHookService
        ? async (skill) => {
            if (!skill.sourcePath || skill.hooks === undefined) return;
            await runtimeState.activateComponentHooks({
              kind: "skill",
              path: skill.sourcePath,
              componentId: skill.name,
              inlineHooks: skill.hooks,
              ...(skill.source?.hookTrustAuthority
                ? { trustAuthority: skill.source.hookTrustAuthority }
                : {}),
            });
          }
        : undefined,
      skillLoaderFactory(workDir),
      runtimeEnv,
      dependencies.bashTimeoutMs,
      collaborationMode() === "plan" || activeExecutionPlanId ? planRegistryOptions : undefined,
      hostKind,
      onToolGroupLoaded,
      sessionTaskAuthority,
      requestSandboxBoundaryHandler,
    );
    if (collaborationMode() !== "plan") {
      registry.register(
        createCodeModeTool({
          registry,
          admission: codeCellAdmissionFor(session),
          getRuntimeRun: currentRuntimeRun,
          redactionSecrets: dependencies.toolResultRedactionSecrets,
          hookService: activeHookService,
        }),
      );
      baselineToolNames.push("exec");
    }
    if (dependencies.agentGraph?.kind === "root") {
      if (backgroundPolicy || orchestrationMode() === "default") {
        throw new Error("Graph root tools require a foreground Graph Mode Runtime");
      }
      for (const tool of createAgentGraphSupervisorTools({
        getRootContext: dependencies.agentGraph.getRootContext,
        port: dependencies.agentGraph.toolPort,
        swarm: orchestrationMode() === "swarm",
        ...(dependencies.configuredSubagentCatalog
          ? { configuredSubagents: { catalog: dependencies.configuredSubagentCatalog } }
          : {}),
      })) {
        registry.register(tool);
      }
      if (orchestrationMode() === "swarm") {
        const binding = dependencies.agentGraph;
        const readSwarmStatus = binding.toolPort.readSwarmStatus;
        if (!readSwarmStatus) throw new Error("Swarm status application is unavailable");
        registry.register(
          createAgentSwarmStatusTool({
            getRootContext: binding.getRootContext,
            port: { readSwarmStatus: (input) => readSwarmStatus.call(binding.toolPort, input) },
          }),
        );
      }
      baselineToolNames.push(
        ...(orchestrationMode() === "swarm"
          ? AGENT_SWARM_SUPERVISOR_TOOL_NAMES
          : AGENT_GRAPH_SUPERVISOR_TOOL_NAMES),
      );
    } else if (dependencies.agentGraph?.kind === "operator") {
      registry.register(
        createAgentOutputTool({
          getActivationContext: dependencies.agentGraph.getActivationContext,
          port: dependencies.agentGraph.outputPort,
        }),
      );
      baselineToolNames.push("agent_output");
    }
    if (!backgroundPolicy && hostKind === "desktop" && dependencies.browserAgent) {
      for (const tool of createBrowserAgentTools(dependencies.browserAgent)) {
        registry.register(tool);
      }
    }
    registerPluginCapabilityTools(
      registry,
      pluginSnapshot,
      dependencies.pluginCapabilityRegistry,
      workDir,
      pluginActivationScope,
    );
    if (!backgroundPolicy && dependencies.scheduleDraftCoordinator) {
      registry.register(new ScheduleTaskTool(dependencies.scheduleDraftCoordinator));
    }
    // remember 同步提交；extract 在 completed terminal 落盘后入队。
    // Responses 保留工具入口，但明确返回 provider_unsupported，不执行提取。
    if (atomicMemoryRuntime) {
      for (const tool of buildMemoryTriggerTools(atomicMemoryRuntime)) {
        registry.register(tool);
      }
    }
    // 前台只使用会话级 HookService；所有项目 source 都由它统一加载并校验信任。
    if (activeHookService) {
      registry.setHookService?.(activeHookService);
    }
    // Inject steer text into the session-scoped queue before the next provider turn.
    const steerQueue = runtimeState.steerQueue;
    if (options.steer) {
      steerQueue.push(options.steer);
    }
    const promptLayersFactory = async ({
      currentUserPrompt,
    }: {
      readonly currentUserPrompt: string;
    }) => {
      const composed = await new PromptComposer(workDir, collaborationMode() === "plan", {
        goalManager,
        todoStore,
        isolatedHeadless: dependencies.isolatedHeadless,
        graphToolsAvailable:
          !!session.runtimeEventStore &&
          !backgroundPolicy &&
          orchestrationMode() !== "default" &&
          dependencies.agentGraph?.kind === "root",
        swarmMode: orchestrationMode() === "swarm",
        skillLoader: skillLoaderFactory(workDir),
        ...(dependencies.isolatedHeadless ? {} : { picoHome }),
        ...(activeHookService
          ? {
              onInstructionsLoaded: async (paths: readonly string[]) => {
                await activeHookService.dispatch(
                  "InstructionsLoaded",
                  { paths },
                  { signal: dependencies.signal },
                );
              },
            }
          : {}),
      }).buildLayers();
      const turnTailParts = composed.turnTail ? [composed.turnTail] : [];
      if (searchUnavailableReason) {
        turnTailParts.push(`[WEB SEARCH] ${searchUnavailableReason} 不得声称已经完成联网搜索。`);
      } else if (webSearchSettings.enabled && webSearchSettings.source === "model" && !nativeSearchNetworkAllowed()) {
        turnTailParts.push("[WEB SEARCH] 原生搜索受当前任务网络权限限制。确有需要时通过 request_sandbox_boundary 请求网络权限；获批后才会向模型提供原生搜索工具。后台受限域名策略不支持原生搜索。");
      }
      if (
        activeExecutionPlanId &&
        executionCoordinator &&
        dependencies.agentGraph?.kind === "root"
      ) {
        const projection = await executionCoordinator.project();
        turnTailParts.push(
          "[GRAPH PLAN EXECUTION] 当前 Graph 绑定用户已批准的计划。只继续未完成步骤；用 update_plan 跟踪进度。需要等待子任务时调用 yield_agent_graph，计划会保持 active，唤醒后继续。先通过 update_agent_graph 的 finish 汇总 Graph，再完成最后一个计划步骤。无法继续时调用 cancel_plan。",
          JSON.stringify(projection.execution),
        );
      }
      if (sideConversation) {
        turnTailParts.push(
          [
            "<side-conversation-boundary>",
            "This is a temporary side conversation. Inherited parent history is reference context only.",
            "Only instructions explicitly submitted by the user in this side conversation are active.",
            "Use tools or modify workspace state only when the current side-conversation request explicitly asks for it and the inherited permission profile allows it.",
            "Do not spawn or coordinate sub-agents and do not change the parent conversation itself.",
            "Messages and task state are not written back to the parent; workspace changes may be visible to both conversations.",
            "</side-conversation-boundary>",
          ].join("\n"),
        );
      }
      try {
        const taskBlock = buildSessionTaskPromptBlock(
          sessionTaskAuthority.repository,
          sessionTaskAuthority.sessionId,
        );
        if (taskBlock) turnTailParts.push(taskBlock);
      } catch (error) {
        logger.warn(
          { workDir, error: error instanceof Error ? error.message : String(error) },
          "[SessionTasks] prompt injection degraded",
        );
      }
      if (collaborationMode() === "plan" && session.runtimeEventStore) {
        const projection = await new PlanCoordinator(
          session.runtimeEventStore,
          planControlContext(session.id, "revision-turn-tail", session),
        ).project();
        const revisionTail = planRevisionRequestTurnTail(projection);
        if (revisionTail) turnTailParts.push(revisionTail);
      }
      if (memoryContextBuilder) {
        try {
          if ((await memoryRecallAllowed()).allowed) {
            const memory = await memoryContextBuilder.build(currentUserPrompt);
            if (memory.block) turnTailParts.push(memory.block);
          }
        } catch (error) {
          logger.warn(
            { workDir, error: error instanceof Error ? error.message : String(error) },
            "[Memory] recall injection degraded",
          );
        }
      }
      if (
        !backgroundPolicy &&
        dependencies.scheduleDraftCoordinator &&
        looksLikeScheduleCreationIntent(currentUserPrompt)
      ) {
        turnTailParts.push(
          "<schedule-task-intent>用户明确要求创建周期任务。请调用 schedule_task 提交结构化草案等待用户确认；不得仅用文字声称已经创建。</schedule-task-intent>",
        );
      }
      return {
        systemPrompt: dependencies.configuredSubagentChild
          ? dependencies.configuredSubagentChild.definition.systemPrompt
          : dependencies.agentGraph?.kind === "operator"
            ? [
                composed.systemPrompt,
                "<graph-operator-profile>",
                dependencies.agentGraph.profileSnapshot.systemPrompt.content,
                "</graph-operator-profile>",
              ].join("\n")
            : composed.systemPrompt,
        turnTail: turnTailParts.join("\n\n"),
      };
    };
    const reporter = dependencies.reporter ?? new TerminalReporter();
    const engine = new AgentEngine({
      ...(atomicMemoryRuntime ? { memoryHooks: atomicMemoryRuntime } : {}),
      provider: trackedProvider,
      registry,
      workDir,
      runtimePort: createEngineRuntimePort(),
      workspaceRoots,
      usageSession: session,
      ...(effectiveOptions.thinkingEffort !== undefined
        ? { thinkingEffort: effectiveOptions.thinkingEffort }
        : {}),
      ...(effectiveOptions.modelRouteId !== undefined
        ? { modelRouteId: effectiveOptions.modelRouteId }
        : {}),
      collaborationMode,
      planHandoff,
      ...(dependencies.agentGraph?.kind === "root"
        ? {
            stopAfterSuccessfulToolNames: ["yield_agent_graph"],
            controlPlanePresentation: true,
          }
        : dependencies.agentGraph?.kind === "operator"
          ? { stopAfterSuccessfulToolNames: ["agent_output"] }
          : {}),
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      promptLayersFactory,
      goalManager,
      todoStore,
      toolDisclosure,
      ...(dependencies.toolResultRedactionSecrets
        ? { toolResultRedactionSecrets: dependencies.toolResultRedactionSecrets }
        : {}),
      compactor: contextRuntime.compactor,
      contextBudget: contextRuntime.budget,
      // 模型摘要压缩:85% 水位主动整理 + Provider overflow 紧急重试。
      // 始终复用已由宿主从用户模型路由解析并注入的主 Provider。
      fullCompactor: new FullCompactor({
        provider: trackedProvider,
        workDir,
        ...(activeHookService ? { hookService: activeHookService } : {}),
      }),
      reporter,
      tracer: traceEnabled
        ? new Tracer({
            picoHome,
            ...(dependencies.isolatedHeadless ? { attributePolicy: "metadata-only" as const } : {}),
          })
        : undefined,
      steerQueue,
      ...(dependencies.waitAtSafeBoundary
        ? { waitAtSafeBoundary: dependencies.waitAtSafeBoundary }
        : {}),
      ...(activeHookService ? { hookService: activeHookService } : {}),
      ...(backgroundPolicy?.hookRunner
        ? {
            postToolResultHook: (call, result) =>
              backgroundPolicy.hookRunner!.runPostToolResult(
                call.name,
                parseHookToolInput(call.arguments),
                result,
                session.id,
              ),
          }
        : {}),
      skillLoaderFactory,
      ...(rebuildProvider ? { rebuildProvider } : {}),
    });

    if (backgroundPolicy) {
      registry.useSafety?.(
        buildBackgroundAutonomousMiddleware({
          policy: backgroundPolicy,
          workspaceRoots,
          sessionId: session.id,
        }),
      );
    } else {
      registry.useSafety?.(
        buildForegroundSafetyMiddleware(
          workDir,
          settings,
          workspaceRoots,
          dependencies.onPolicyDenied,
          collaborationMode,
        ),
      );
      registry.usePermission?.(
        buildPermissionMiddleware(
          approvalNotifier,
          workDir,
          dependencies.signal,
          approvalManager,
          settings,
          workspaceRoots,
          activeHookService,
          session.picoHome,
          dependencies.onPolicyDenied,
          permissionMode,
          {
            onSessionPolicyChanged: async () => {
              if (
                globalSessionPermissionGrants.allowsNetwork(session.id, workDir, session.picoHome)
              ) {
                await ensureDurableNetworkBoundary();
              }
              await refreshRuntimeBoundary();
            },
            onOneShotMcpAuthorization: async (call, directories) => {
              oneShotMcpCalls.add(call.id);
              oneShotRemoteMcpCalls.add(call.id);
              await activeMcpManager?.restartStdioServerForTool(call.name, {
                ...mainProcessPolicy,
                network: "allow",
                readRoots: normalizeRoots([...mainProcessPolicy.readRoots, ...directories]),
                writeRoots: normalizeRoots([...mainProcessPolicy.writeRoots, ...directories]),
              });
            },
            allowSessionGrants:
              !dependencies.configuredSubagentChild &&
              (dependencies.agentGraph?.kind !== "operator" ||
                dependencies.agentGraph.profileSnapshot.permissionPolicy.allowSessionGrants),
            ...(configuredChildBoundaryCeiling
              ? { executionBoundaryCeiling: configuredChildBoundaryCeiling }
              : {}),
            getToolPermissionCategory: (name) => registry.getPermissionCategory(name),
          },
        ),
      );
      registry.useExecution?.(async (call, next) => {
        try {
          return await next(call);
        } finally {
          oneShotRemoteMcpCalls.delete(call.id);
          admittedHookMcpCalls.delete(call.id);
          if (oneShotMcpCalls.delete(call.id)) {
            await activeMcpManager?.restartStdioServerForTool(call.name);
          }
        }
      });
    }
    if (
      !backgroundPolicy &&
      !sideConversation &&
      !dependencies.configuredSubagentChild &&
      dependencies.agentGraph?.kind !== "operator" &&
      dependencies.configuredSubagentCatalog &&
      hostKind === "desktop"
    ) {
      const configuredExecutor =
        dependencies.configuredSubagentExecutor ??
        (subagentModelRouter && parentModelRouteId
          ? createConfiguredSubagentExecutor({
              workDir,
              executeChild: (input, childDependencies) =>
                new AgentRuntime().execute(input, childDependencies),
              catalog: dependencies.configuredSubagentCatalog,
              modelRouter: subagentModelRouter,
              parentModelRouteId,
              parentExecutionBoundary: () => session.getRuntimeStateSnapshot().boundary,
              worktreeSupervisor: runtimeState.taskHostRuntime?.supervisor,
              reporter,
              childDependencies: {
                env: runtimeEnv,
                picoHome,
                webSearchSettings,
                providerFactory,
                providerDecorator,
                approvalNotifier,
                approvalManager,
                toolResultRedactionSecrets: dependencies.toolResultRedactionSecrets,
              },
            })
          : undefined);
      const toolOptions = {
        catalog: dependencies.configuredSubagentCatalog,
        ...(configuredExecutor ? { execute: configuredExecutor } : {}),
        capabilityUnavailableReason: (definition: SubagentCapabilityDefinition) =>
          !configuredExecutor
            ? "Persistent child executor unavailable"
            : definition.profile === "web_research" && !webSearchSettings.enabled
              ? "联网搜索已关闭"
              : definition.profile === "web_research" && webSearchSettings.source === "external" &&
                  webSearchUnavailableReason(webSearchSettings, undefined, runtimeEnv)
                ? webSearchUnavailableReason(webSearchSettings, undefined, runtimeEnv)
            : definition.workspace === "isolated-worktree" &&
                !runtimeState.taskHostRuntime?.supervisor &&
                !dependencies.configuredSubagentExecutor
              ? "Worktree child executor unavailable"
              : undefined,
      };
      if (!registry.getTool("agent_list"))
        registry.register(new ConfiguredAgentListTool(toolOptions));
      registry.register(new ConfiguredAgentSpawnTool(toolOptions));
      if (session.runtimeEventStore) {
        const childOutput = createConfiguredSubagentOutputTool({
          port: createConfiguredSubagentOutputStore({
            parentSessionId: session.id,
            workDir,
            picoHome,
            eventStore: session.runtimeEventStore,
          }),
        });
        const graphOutput = registry.getTool("agent_output");
        if (graphOutput) {
          const childDefinition = childOutput.definition();
          const graphDefinition = graphOutput.definition();
          registry.unregisterForHostPolicy("agent_output");
          registry.register({
            name: () => "agent_output",
            readOnly: true,
            fileSideEffects: childOutput.fileSideEffects,
            definition: () => ({
              ...childDefinition,
              description: `${childDefinition.description} Graph正式结果也支持view=result与work_ids。`,
              inputSchema: {
                ...childDefinition.inputSchema,
                properties: {
                  ...(graphDefinition.inputSchema["properties"] as Record<string, unknown>),
                  ...(childDefinition.inputSchema["properties"] as Record<string, unknown>),
                },
              },
            }),
            execute: async (args, context) => {
              const value = JSON.parse(args) as Record<string, unknown>;
              if (value && typeof value === "object" && "work_ids" in value)
                return graphOutput.execute(args, context);
              try {
                return await childOutput.execute(args, context);
              } catch (error) {
                if (!(error instanceof ConfiguredSubagentOutputNotFoundError)) throw error;
                return graphOutput.execute(JSON.stringify({ view: "result", ...value }), context);
              }
            },
          });
        } else registry.register(childOutput);
      }
      baselineToolNames.push("agent_list", "agent_spawn", "agent_output");
    }
    if (backgroundPolicy) pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
    dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));

    // MCP 服务器:加载配置 → 并行连接 → 自动注册工具到 registry。
    // per-server 失败隔离,一个 server 挂了不影响其他。
    const planMcpDisabled = collaborationMode() === "plan";
    const mcpConfigPath = planMcpDisabled
      ? undefined
      : (backgroundPolicy?.mcpConfigPath ?? options.mcpConfigPath);
    const hostMcpSources =
      backgroundPolicy || planMcpDisabled ? [] : (dependencies.mcpConfigSources ?? []);
    const pluginMcpSources = filterPluginMcpSources(
      planMcpDisabled ? [] : (pluginSnapshot?.mcpSources ?? []),
      configuredMcpServerNames(hostMcpSources),
    );
    ownsMcpManager = !planMcpDisabled && dependencies.mcpManager === undefined;
    const mcpManager = planMcpDisabled
      ? undefined
      : (dependencies.mcpManager ??
        (mcpConfigPath || hostMcpSources.length > 0 || pluginMcpSources.length > 0
          ? new McpConnectionManager(registry, {
              stdioCwd: workDir,
              remoteNetworkGate,
              ...(!backgroundPolicy ? { processSandbox: mainProcessPolicy } : {}),
              ...(backgroundPolicy?.snapshot.mcpConfigFingerprint
                ? { expectedConfigFingerprint: backgroundPolicy.snapshot.mcpConfigFingerprint }
                : {}),
              ...(backgroundPolicy
                ? {
                    clientFactory: (config) =>
                      createBackgroundMcpClient(
                        config,
                        workDir,
                        backgroundPolicy.snapshot.toolNetworkPolicy,
                        backgroundPolicy.allowedToolNetworkHosts,
                        join(processSandboxScratchRoot, "background-mcp", config.name),
                      ),
                  }
                : {}),
              ...(pluginMcpSources.length > 0 &&
              (hostMcpSources.length > 0 || mcpConfigPath !== undefined)
                ? { duplicateServerPolicy: "keep-first" as const }
                : {}),
            })
          : undefined));
    cleanupMcpManager = mcpManager;
    activeMcpManager = mcpManager;
    if (mcpManager && !backgroundPolicy) {
      await mcpManager.updateProcessSandbox(mainProcessPolicy);
    }
    unsubscribeMcpStatus =
      mcpManager && dependencies.mcpStatusSink
        ? mcpManager.subscribe(dependencies.mcpStatusSink)
        : undefined;
    if (mcpManager && !ownsMcpManager) {
      mcpManager.attachRegistry(registry);
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    } else if (
      mcpManager &&
      (mcpConfigPath || hostMcpSources.length > 0 || pluginMcpSources.length > 0)
    ) {
      if (
        mcpConfigPath &&
        (backgroundPolicy || (hostMcpSources.length === 0 && pluginMcpSources.length === 0))
      ) {
        await mcpManager.loadConfig(mcpConfigPath);
      } else {
        await mcpManager.replaceSources([
          ...hostMcpSources,
          ...(mcpConfigPath
            ? [{ id: "project", path: mcpConfigPath } satisfies McpConfigSource]
            : []),
          ...pluginMcpSources,
        ]);
      }
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
      await mcpManager.connectAll();
      dependencies.mcpStatusSink?.(mcpManager.getStatusSnapshot());
      if (backgroundPolicy) {
        pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
      }
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }
    if (backgroundPolicy) {
      pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
      const missingTools = [...backgroundPolicy.allowedTools].filter(
        (tool) => registry.getTool(tool) === undefined,
      );
      if (missingTools.length > 0) {
        const onlyMcp = missingTools.every(isMcpToolName);
        throw new BackgroundPolicyViolationError(
          onlyMcp ? "mcp_unavailable" : "tool_unavailable",
          `后台工具不可用: ${missingTools.join(", ")}`,
        );
      }
      // 与命令级 allowlist 对称：Job 显式授权的存活工具必须对模型可见——
      // 否则 deferred 组成员（web_search/task_list 等）会被
      // 渐进披露层藏掉，而 background 下 load_tools/search_tools 可能已被
      // 剪枝，模型没有激活路径，永远看不到它已授权的工具。
      baselineToolNames.push(...backgroundPolicy.allowedTools);
    }
    if (dependencies.configuredSubagentChild) {
      const definition = dependencies.configuredSubagentChild.definition;
      const processSandbox = {
        config: { ...picoConfig.sandbox, network: "deny" as const },
        scratchRoot: join(picoHome, "sandboxes", session.id, "subagents"),
      };
      for (const name of definition.tools) {
        const create = CHILD_AGENT_TOOL_CONSTRUCTORS[name];
        if (!create) throw new Error(`Unsupported child capability tool: ${name}`);
        registry.unregisterForHostPolicy(name);
        registry.register(
          name === "web_search"
            ? new WebSearchTool(runtimeEnv)
            : create(
                workDir,
                workspaceRoots,
                processSandbox,
                definition.workspace === "shared" ? "read-only" : "workspace-write",
              ),
        );
      }
      registry.useSafety(
        buildChildAgentSafetyMiddleware(definition.workspace === "shared" ? "explore" : "worker", {
          workDir,
          workspaceRoots,
          processSandbox,
        }),
      );
      pruneRegistryToCommandAllowlist(registry, definition.tools);
      baselineToolNames.push(...definition.tools);
    }
    if (effectiveOptions.allowedTools !== undefined) {
      const requiredControlTools = [
        ...(collaborationMode() === "plan" ? ["submit_plan"] : []),
        ...(activeExecutionPlanId ? ["update_plan", "cancel_plan"] : []),
      ];
      const commandAllowlist = [...effectiveOptions.allowedTools, ...requiredControlTools];
      pruneRegistryToCommandAllowlist(registry, commandAllowlist);
      // 命令级 allowlist 是宿主/请求方的显式选择——存活工具必须对模型可见，
      // 不能被渐进披露层藏掉（否则 headless/skill 激活场景下白名单里的
      // deferred 工具无激活路径，连接器又可能已被剪掉）。
      baselineToolNames.push(...commandAllowlist);
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }

    searchUnavailableReason = routeRuntimeWebSearch(
      registry,
      webSearchSettings,
      providerConfig.capabilities?.nativeWebSearch ?? resolveNativeWebSearchCapability({
        provider: kind,
        model: providerConfig.model,
        baseURL: providerConfig.baseURL,
      }),
      runtimeEnv,
    );
    if (registry.getTool("web_search")) baselineToolNames.push("web_search");
    dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    toolDisclosure.setBaselineTools(baselineToolNames);

    // 阶段 4：在当前 Session 内串行执行一次 RuntimeRun。
    // RuntimeRunExecutor 不拥有任何资源；本函数仍负责阶段 3 的装配和 finally 清理。
    const result = await new RuntimeRunExecutor({
      session,
      runtimeState,
      engine,
      sessionSelection,
      workDir,
      picoHome,
      prompt,
      agentSwarmAuthorization,
      expectedAgentSwarmAuthorization: agentSwarmAuthorization,
      resumeExistingSession,
      ...(resumeExistingSession && planExecutionPromptId
        ? { planExecutionPrompt: { messageId: planExecutionPromptId, content: prompt } }
        : {}),
      ...(dependencies.agentGraph ? { presentation: "internal" as const } : {}),
      ...(dependencies.prestartedRun ? { prestartedRun: dependencies.prestartedRun } : {}),
      ...(dependencies.prestartedUserInput
        ? { prestartedUserInput: dependencies.prestartedUserInput }
        : {}),
      traceEnabled,
      options: {
        ...(effectiveOptions.rewindPrompt !== undefined
          ? { rewindPrompt: effectiveOptions.rewindPrompt }
          : {}),
        ...(effectiveOptions.rewindTranscriptIndex !== undefined
          ? { rewindTranscriptIndex: effectiveOptions.rewindTranscriptIndex }
          : {}),
        ...(effectiveOptions.rewindCollaborationMode !== undefined
          ? { rewindCollaborationMode: effectiveOptions.rewindCollaborationMode }
          : {}),
        ...(effectiveOptions.rewindPermissionMode !== undefined
          ? { rewindPermissionMode: effectiveOptions.rewindPermissionMode }
          : {}),
        ...(effectiveOptions.imagePath !== undefined
          ? { imagePath: effectiveOptions.imagePath }
          : {}),
        ...(effectiveOptions.images !== undefined ? { images: effectiveOptions.images } : {}),
      },
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
      ...(dependencies.rewindPointSink ? { rewindPointSink: dependencies.rewindPointSink } : {}),
      ...(dependencies.onRunAdmission ? { onRunAdmission: dependencies.onRunAdmission } : {}),
      ...(dependencies.runCompletionGuard
        ? { completionGuard: dependencies.runCompletionGuard }
        : {}),
      ...(dependencies.runFailureGuard ? { failureGuard: dependencies.runFailureGuard } : {}),
      ...(atomicMemoryRuntime
        ? { atomicMemoryCompleted: (runId: string) => atomicMemoryRuntime!.completed(runId) }
        : {}),
      planHandoff,
      planCoordinator: () => {
        const submitted = planHandoff.result();
        if (!submitted || !session.runtimeEventStore) {
          throw new Error("Plan handoff projection refresh requires a submitted durable plan");
        }
        return new PlanCoordinator(session.runtimeEventStore, {
          sessionId: session.id,
          invocationId: `projection:${submitted.runId}`,
          runId: submitted.runId,
          turnId: `turn:${submitted.runId}:plan`,
          writeGuard: session,
        });
      },
    }).execute();
    if (
      !(
        executionCoordinator &&
        session.runtimeEventStore &&
        (await isPlanGraphWaiting(
          session.runtimeEventStore,
          session.id,
          await executionCoordinator.project(),
        ))
      )
    )
      await interruptOpenPlanExecution(
        executionCoordinator,
        activeExecutionPlanId,
        "Execution Run ended before every plan step reached a terminal status.",
      );
    return result;
  } catch (error) {
    await interruptOpenPlanExecution(
      executionCoordinator,
      activeExecutionPlanId,
      dependencies.signal?.aborted
        ? "Execution Run was cancelled."
        : `Execution Run failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    if (!planRun && cleanupRuntimeState?.hookService && !dependencies.signal?.aborted) {
      await cleanupRuntimeState.hookService
        .dispatch("StopFailure", {
          category: classifyStopFailure(error),
          error: error instanceof Error ? error.message : String(error),
        })
        .catch((hookError) =>
          logger.warn({ hookError: String(hookError) }, "[Hook] StopFailure 事件执行失败"),
        );
    }
    emitRuntimeLifecycleEvent(dependencies.onEvent, {
      type: "run.failed",
      sessionId: session.id,
      workDir,
      at: Date.now(),
      detail: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    if (livePlanAdmission) livePlanAdmissions.delete(livePlanAdmission);
    if (liveConfiguredChildAdmission) {
      liveConfiguredChildAdmissions.delete(liveConfiguredChildAdmission);
    }
    // 阶段 5：只释放本次调用持有的资源。
    // 非 TUI 调用仍按轮关闭；TUI 注入的 manager 由宿主在退出时统一关闭。
    await cleanupScope.dispose();
  }
}

async function reconcileConfiguredChildExecutionBoundary(
  session: Session,
  expectedBoundary: ExecutionBoundary,
  sessionMode: CliSessionSelection["mode"],
): Promise<ExecutionBoundary> {
  if (expectedBoundary.kind === "external") {
    throw new Error("Configured child cannot use an external execution boundary");
  }
  return session.withSerializedExecution(async () => {
    const snapshot = session.getRuntimeStateSnapshot();
    const current = snapshot.boundary;
    const permissionMode = expectedBoundary.kind === "bypass" ? "full-access" : "ask";
    const settings = snapshot.settings
      ? configuredChildSettingsWithPermissionMode(snapshot.settings, permissionMode)
      : undefined;
    const settingsChanged = snapshot.settings?.permissionMode !== permissionMode;
    if (!current) {
      if (sessionMode !== "new") {
        throw new Error("Configured child execution boundary is unavailable");
      }
      session.updateRuntimeState({
        boundary: expectedBoundary,
        ...(settings ? { settings } : {}),
      });
      await session.flushPersistence();
      return expectedBoundary;
    }
    const boundaryChanged = !sameExecutionBoundaryCapability(current, expectedBoundary);
    if (!boundaryChanged && !settingsChanged) return current;
    if (current.kind === "external") {
      throw new Error("Configured child durable execution boundary is externally owned");
    }
    const store = session.runtimeEventStore;
    if (!store) throw new Error("Configured child execution boundary requires durable storage");
    for (const runId of await store.listRunIds(session.id)) {
      const run = await store.readRunProjection(session.id, runId);
      if (run?.startedEventId && !run.terminalEventId) {
        throw new Error("Configured child execution boundary cannot change during an active run");
      }
    }
    const latest = session.getRuntimeStateSnapshot().boundary;
    if (
      !latest ||
      latest.revision !== current.revision ||
      !sameExecutionBoundaryCapability(latest, current)
    ) {
      throw new Error("Configured child execution boundary revision changed during admission");
    }
    if (boundaryChanged && current.revision >= Number.MAX_SAFE_INTEGER) {
      throw new Error("Configured child execution boundary revision is exhausted");
    }
    const aligned: ExecutionBoundary = boundaryChanged
      ? expectedBoundary.kind === "bypass"
        ? { kind: "bypass", revision: current.revision + 1 }
        : {
            kind: "managed",
            profile: expectedBoundary.profile,
            revision: current.revision + 1,
          }
      : current;
    session.updateRuntimeState({
      boundary: aligned,
      ...(settings ? { settings } : {}),
    });
    await session.flushPersistence();
    const committedSnapshot = session.getRuntimeStateSnapshot();
    const committed = committedSnapshot.boundary;
    if (
      !committed ||
      committed.revision !== aligned.revision ||
      !sameExecutionBoundaryCapability(committed, aligned) ||
      (settings && committedSnapshot.settings?.permissionMode !== permissionMode)
    ) {
      throw new Error("Configured child execution boundary did not commit atomically");
    }
    return committed;
  });
}

function configuredChildSettingsWithPermissionMode(
  settings: PersistedSessionSettings,
  permissionMode: "ask" | "full-access",
): PersistedSessionSettingsWrite {
  return {
    ...(settings.title !== undefined ? { title: settings.title } : {}),
    ...(settings.forkFrom !== undefined ? { forkFrom: settings.forkFrom } : {}),
    ...(settings.sideConversation === true ? { sideConversation: true } : {}),
    provider: settings.provider,
    model: settings.model,
    modelRouteId: settings.modelRouteId,
    collaborationMode: "agent",
    orchestrationMode: settings.orchestrationMode,
    permissionMode,
    thinkingEffort: settings.thinkingEffort,
    thinkingEffortExplicit: settings.thinkingEffortExplicit,
    additionalDirectories: settings.additionalDirectories,
  };
}

function sameExecutionBoundaryCapability(
  left: ExecutionBoundary,
  right: ExecutionBoundary,
): boolean {
  return executionBoundaryContains(left, right) && executionBoundaryContains(right, left);
}

function applyExecutionBoundaryToWorkspaceRoots(
  roots: WorkspaceRoots,
  boundary: ExecutionBoundary | undefined,
): void {
  roots.replaceBoundaryProfile(boundary?.kind === "managed" ? boundary.profile : undefined);
}

async function interruptOpenPlanExecution(
  coordinator: PlanCoordinator | undefined,
  planId: string | undefined,
  reason: string,
): Promise<void> {
  if (!coordinator || !planId) return;
  const projection = await coordinator.project();
  if (projection.execution?.planId !== planId || projection.execution.status !== "active") return;
  await coordinator.interrupt({
    operationId: `interrupt-plan:${randomUUID()}`,
    expectedSessionSequence: projection.sessionSequence,
    planId,
    reason,
  });
}

async function acquireRuntimeSession({
  sessionSelection,
  workDir,
  picoHome,
  resumeExistingSession,
}: {
  sessionSelection: CliSessionSelection;
  workDir: string;
  picoHome: string;
  resumeExistingSession: boolean;
}): Promise<SessionManagerLease> {
  const runtimeEventStore = new SqliteRuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
  // 临时探测 store:manifest/fork 校验完成后立即归还 lease(连接句柄随 lease
  // 存活,泄漏会占住 pico.sqlite;Session 自带独立 store)。
  try {
    return await acquireRuntimeSessionWithStore(runtimeEventStore, {
      sessionSelection,
      workDir,
      picoHome,
      resumeExistingSession,
    });
  } finally {
    runtimeEventStore.close();
  }
}

async function acquireRuntimeSessionWithStore(
  runtimeEventStore: SqliteRuntimeEventStore,
  {
    sessionSelection,
    workDir,
    picoHome,
    resumeExistingSession,
  }: {
    sessionSelection: CliSessionSelection;
    workDir: string;
    picoHome: string;
    resumeExistingSession: boolean;
  },
): Promise<SessionManagerLease> {
  let targetManifest = await runtimeEventStore.readSessionManifest(sessionSelection.sessionId);
  if (sessionSelection.mode === "fork") {
    const sourceManifest = await runtimeEventStore.readSessionManifest(
      sessionSelection.sourceSessionId,
    );
    if (!sourceManifest) {
      throw new Error(
        `无法 fork session ${sessionSelection.sourceSessionId}: RuntimeEvent 日志中不存在`,
      );
    }
    if (!targetManifest) {
      const sourceLease = await globalSessionManager.getOrCreatePinned(
        sessionSelection.sourceSessionId,
        workDir,
        {
          persistence: true,
          picoHome,
          runtimePort: createEngineRuntimePort(),
        },
      );
      try {
        const sourceCapability = sourceLease.session.runtimeEventCapability;
        if (!sourceCapability) {
          throw new Error(`Fork source requires a durable Session: ${sourceLease.session.id}`);
        }
        await RuntimeRun.repairSessionProjection(sourceLease.session, {
          capability: sourceCapability,
        });
        const forkService = new SessionForkService({
          workDir,
          picoHome,
          runtimePort: createSessionForkRuntimePort(),
        });
        try {
          await forkService.fork({
            sourceSessionId: sessionSelection.sourceSessionId,
            targetSessionId: sessionSelection.sessionId,
          });
        } finally {
          forkService.close();
        }
        targetManifest = await runtimeEventStore.readSessionManifest(sessionSelection.sessionId);
      } finally {
        sourceLease.release();
      }
    }
    // by_kind 末条点查(票 04):不再为找 fork 标记全量读会话事件。
    const forkEntry = await runtimeEventStore.readLastSessionEntryOfKind(
      sessionSelection.sessionId,
      "session.forked",
    );
    const forkEvent = forkEntry?.event.kind === "session.forked" ? forkEntry.event : undefined;
    if (!targetManifest || !forkEvent) {
      throw new Error(`fork target ${sessionSelection.sessionId} 缺少完整的 RuntimeEvent 历史`);
    }
    if (forkEvent.data.parentSessionId !== sessionSelection.sourceSessionId) {
      throw new Error(
        `fork target ${sessionSelection.sessionId} 记录的 parent ${forkEvent.data.parentSessionId} 与当前请求不一致`,
      );
    }
  }
  let lease: SessionManagerLease | undefined;
  if (resumeExistingSession) {
    const session = globalSessionManager.get(sessionSelection.sessionId, workDir, { picoHome });
    if (session) {
      lease = { session, release: globalSessionManager.pin(session) };
    }
  } else {
    lease = await globalSessionManager.getOrCreatePinned(sessionSelection.sessionId, workDir, {
      persistence: true,
      picoHome,
      runtimePort: createEngineRuntimePort(),
    });
  }
  if (!lease) {
    throw new Error(`Cannot resume missing session: ${sessionSelection.sessionId}`);
  }
  try {
    const runtimeCapability = lease.session.runtimeEventCapability;
    const runtimeStore = lease.session.runtimeEventStore;
    if (!runtimeCapability || !runtimeStore) {
      throw new Error(`AgentRuntime requires a durable Session: ${sessionSelection.sessionId}`);
    }
    await RuntimeRun.repairSessionProjection(lease.session, { capability: runtimeCapability });
    return lease;
  } catch (error) {
    lease.release();
    throw error;
  }
}

function classifyStopFailure(error: unknown): string {
  if (isAbortError(error)) return "abort";
  if (error instanceof ContextOverflowError) return "context";
  const message = error instanceof Error ? error.message : String(error);
  return /provider|model|429|rate limit|network/iu.test(message) ? "provider" : "internal";
}

function buildRegistry(
  workDir: string,
  backgroundManager: BackgroundManager,
  goalManager?: GoalManager,
  todoStore?: TodoStore,
  toolDisclosure?: ToolDisclosure,
  workspaceRoots?: WorkspaceRoots,
  askUserHandler?: AskUserHandler,
  codeIntelligence?: SessionRuntime["codeIntelligence"],
  excludeSensitiveGrepFiles?: boolean | ((path: string | undefined) => boolean),
  processSandbox?: DefaultToolRegistryOptions["processSandbox"],
  activateSkillHooks?: (skill: Skill) => void | Promise<void>,
  skillLoader?: SkillLoader,
  env?: NodeJS.ProcessEnv,
  bashTimeoutMs?: number,
  plan?: DefaultToolRegistryOptions["plan"],
  hostKind?: ToolHostKind,
  onToolGroupLoaded?: (groupId: string, toolNames: readonly string[]) => void,
  sessionTasks?: DefaultToolRegistryOptions["sessionTasks"],
  requestSandboxBoundaryHandler?: RequestSandboxBoundaryHandler,
): ToolRegistry {
  return buildDefaultToolRegistry(workDir, {
    deferWorkspaceBoundary: true,
    backgroundManager,
    ...(goalManager !== undefined ? { goalManager } : {}),
    ...(todoStore !== undefined ? { todoStore } : {}),
    ...(toolDisclosure !== undefined ? { toolDisclosure } : {}),
    ...(workspaceRoots !== undefined ? { workspaceRoots } : {}),
    ...(askUserHandler !== undefined ? { askUserHandler } : {}),
    ...(codeIntelligence !== undefined ? { codeIntelligence } : {}),
    ...(excludeSensitiveGrepFiles !== undefined ? { excludeSensitiveGrepFiles } : {}),
    ...(processSandbox !== undefined ? { processSandbox } : {}),
    ...(activateSkillHooks !== undefined ? { activateSkillHooks } : {}),
    ...(skillLoader !== undefined ? { skillLoader } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(bashTimeoutMs !== undefined ? { bashTimeoutMs } : {}),
    ...(hostKind !== undefined ? { hostKind } : {}),
    ...(onToolGroupLoaded !== undefined ? { onToolGroupLoaded } : {}),
    ...(sessionTasks !== undefined ? { sessionTasks } : {}),
    ...(requestSandboxBoundaryHandler !== undefined ? { requestSandboxBoundaryHandler } : {}),
  });
}

async function prepareBackgroundExecution(
  execution: Extract<RuntimeExecution, { kind: "background" }>,
  workDir: string,
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies,
  picoHome: string,
): Promise<PreparedBackgroundAutonomousPolicy> {
  if (options.collaborationMode === "plan") {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台无人值守执行不支持 Plan 协作模式。",
    );
  }
  if ((options.addDirs?.length ?? 0) > 0) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台执行只允许访问 Job 绑定的真实工作区，不接受 addDirs。",
    );
  }
  if (options.mcpConfigPath) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台 MCP 配置只能由 Job policySnapshot 绑定的工作区固定配置加载。",
    );
  }
  if (
    dependencies.mcpManager ||
    dependencies.mcpConfigSources ||
    dependencies.hookService ||
    dependencies.scheduleDraftCoordinator
  ) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台执行不得复用前台 MCP、Hook 或定时草案交互宿主。",
    );
  }
  if (dependencies.runtimeState || dependencies.resumeExistingSession) {
    throw new BackgroundPolicyViolationError(
      "invalid_policy",
      "后台执行不得复用可能携带前台 LSP、权限或未完成轮次的 runtimeState。",
    );
  }
  return prepareBackgroundAutonomousPolicy({
    workDir,
    policy: execution.policy,
    trustStore:
      dependencies.backgroundTrustStore ??
      new WorkspaceTrustStore({ userStateDirectory: picoHome }),
  });
}

function pruneRegistryToBackgroundAllowlist(
  registry: ToolRegistry,
  policy: PreparedBackgroundAutonomousPolicy,
): void {
  for (const tool of registry.getAvailableTools()) {
    if (!policy.allowedTools.has(tool.name)) registry.unregisterForHostPolicy(tool.name);
  }
  const fetchUrl = registry.getTool("fetch_url");
  if (policy.snapshot.toolNetworkPolicy === "allowlist" && fetchUrl instanceof FetchURLTool) {
    fetchUrl.setAuthorizeUrl((url) => {
      const hostname = url.hostname
        .replace(/^\[|\]$/g, "")
        .replace(/\.$/, "")
        .toLowerCase();
      if (!policy.allowedToolNetworkHosts.has(hostname)) {
        throw new Error(
          `[background:network_denied] 重定向主机 ${hostname} 不在 Job 工具网络 allowlist 中。`,
        );
      }
    });
  }
}

function pruneRegistryToCommandAllowlist(
  registry: ToolRegistry,
  requestedTools: readonly string[],
): void {
  const normalized = requestedTools.map((tool) => tool.trim());
  if (normalized.some((tool) => tool.length === 0)) {
    throw new Error("Markdown command allowed-tools 含空值，已拒绝执行。");
  }
  const available = new Set(registry.getAvailableTools().map((tool) => tool.name));
  const unknown = [...new Set(normalized.filter((tool) => !available.has(tool)))];
  if (unknown.length > 0) {
    throw new Error(`Markdown command allowed-tools 包含未知工具: ${unknown.join(", ")}`);
  }
  const allowed = new Set(normalized);
  for (const tool of registry.getAvailableTools()) {
    if (!allowed.has(tool.name)) registry.unregisterForHostPolicy(tool.name);
  }
}

function buildContextRuntime(
  kind: ProviderKind,
  model: string,
): { budget: ContextBudget; compactor: Compactor } {
  const protocol = kind === "openai" ? "openai" : kind;
  const profile = resolveProviderProfile(protocol, model);
  const budget = createContextBudget(profile);
  return {
    budget,
    compactor: new Compactor({
      maxChars: estimateTokenBudgetAsChars(budget.inputBudgetTokens),
      retainLastMsgs: 6,
    }),
  };
}

export function buildApprovalMiddleware(
  notifier: ApprovalNotifier,
  workDir: string,
  signal?: AbortSignal,
  approvalManager: ApprovalManager = globalApprovalManager,
  settings?: Pick<SessionSettings, "sessionId" | "collaborationMode" | "permissionMode"> &
    Partial<Pick<SessionSettings, "additionalDirectories">>,
  workspaceRoots?: WorkspaceRoots,
  picoHome?: string,
): MiddlewareFunc {
  const safety = buildForegroundSafetyMiddleware(workDir, settings, workspaceRoots);
  const permission = buildPermissionMiddleware(
    notifier,
    workDir,
    signal,
    approvalManager,
    settings,
    workspaceRoots,
    undefined,
    picoHome,
  );
  return async (call, context) => {
    const safetyResult = await safety(call);
    return safetyResult.allowed ? permission(safetyResult.call ?? call, context) : safetyResult;
  };
}

/** Hardline / Plan / Trust 属于不可审批绕过的前置安全门。 */
export function buildForegroundSafetyMiddleware(
  workDir: string,
  settings?: Pick<SessionSettings, "collaborationMode">,
  workspaceRoots?: WorkspaceRoots,
  denialSink?: (event: RuntimePolicyDenial) => void,
  collaborationMode?: () => "agent" | "plan",
): MiddlewareFunc {
  return async (call) => {
    const mode = collaborationMode?.() ?? settings?.collaborationMode ?? "agent";
    const planModeDenial = await planModeDenialReason(call, mode, workDir, workspaceRoots);
    if (planModeDenial !== undefined) {
      denialSink?.({
        source: "safety",
        code: "plan_mode",
        reasonKind: "plan_mode",
        toolName: call.name,
      });
      return {
        allowed: false,
        reason: planModeDenial,
      };
    }
    const hardlineReasonKind = classifyHardlineCommand(call.name, call.arguments, workDir);
    if (hardlineReasonKind !== undefined) {
      denialSink?.({
        source: "safety",
        code: "hardline",
        reasonKind: hardlineReasonKind,
        toolName: call.name,
      });
      return {
        allowed: false,
        reason: hardlineDenialReason(hardlineReasonKind),
      };
    }
    return { allowed: true };
  };
}

function hardlineDenialReason(reasonKind: HardlineReasonKind): string {
  const prefix = "Hardline 高危命令不可审批绕过,系统直接拒绝。";
  switch (reasonKind) {
    case "protected_redirect":
      return `${prefix} 请改用 write_file/edit_file 在工作区内写入，且不要通过 Bash 重定向写入受保护目标。`;
    case "dynamic_executable":
      return `${prefix} 请使用字面量可执行文件及字面量 argv 直接调用，且不要使用变量、eval 或间接 shell 启动。`;
    case "protected_destination":
      return `${prefix} 请将写入、安装或权限变更目标改为工作区内的本地前缀（例如 ./.local），且不要修改受保护目录。`;
    default:
      return prefix;
  }
}

/** PreToolUse 通过后的交互权限链；只在确实需要审批时发 PermissionRequest。 */
export function buildPermissionMiddleware(
  notifier: ApprovalNotifier,
  workDir: string,
  signal?: AbortSignal,
  approvalManager: ApprovalManager = globalApprovalManager,
  settings?: Pick<SessionSettings, "sessionId" | "permissionMode"> &
    Partial<Pick<SessionSettings, "additionalDirectories">>,
  workspaceRoots?: WorkspaceRoots,
  hookService?: HookService,
  picoHome?: string,
  denialSink?: (event: RuntimePolicyDenial) => void,
  permissionMode?: () => RuntimePermissionMode,
  options: {
    onSessionPolicyChanged?: () => Promise<void>;
    onOneShotMcpAuthorization?: (
      call: ToolCall,
      externalDirectories: readonly string[],
    ) => Promise<void>;
    allowSessionGrants?: boolean;
    /** Hard ceiling for a configured child; human approval cannot widen it. */
    executionBoundaryCeiling?: ExecutionBoundary;
    getToolPermissionCategory?: (name: string) => ToolPermissionCategory;
  } = {},
): MiddlewareFunc {
  return async (call, context) => {
    const mode = permissionMode?.() ?? settings?.permissionMode ?? "ask";
    const sessionId = settings?.sessionId ?? "cli";
    const workspaceAccesses = workspaceAccessesFromCall(call);
    const childCeilingDenial = configuredChildCeilingDenial(
      call,
      workspaceAccesses,
      options.executionBoundaryCeiling,
      workDir,
      workspaceRoots,
    );
    if (childCeilingDenial) {
      denialSink?.({
        source: "permission",
        code: "policy",
        reasonKind: "policy_denied",
        toolName: call.name,
      });
      return {
        allowed: false,
        reason: childCeilingDenial,
        denialSource: "permission",
      };
    }

    // 完全访问全程跳过人工审批：Hook ask/defer 也不能将它降级。
    // Hardline、Plan 和 Hook deny 依然位于审批链之前，命中时会直接拒绝。
    // 普通工具不施加工作区、网络或
    // 敏感写沙箱。直接文件工具仍需给自身的 WorkspaceRoots 一次性通行证；
    // worker 使用独立 registry/worktree，继续保留显式沙箱隔离。
    if (mode === "full-access") {
      if (workspaceRoots) {
        for (const access of workspaceAccesses) workspaceRoots.authorizeOnce(access.path);
      }
      return { allowed: true, reason: "完全访问权限跳过人工审批" };
    }

    const permissionCategory = classifyToolPermission(call, options.getToolPermissionCategory);
    const policyDecision = evaluateToolPermission(mode, permissionCategory);
    if (policyDecision.kind === "deny") {
      denialSink?.({
        source: "permission",
        code: "policy",
        reasonKind: "policy_denied",
        toolName: call.name,
      });
      return {
        allowed: false,
        reason: policyDecision.reason,
        denialSource: "permission",
      };
    }

    const externalAccesses = workspaceRoots
      ? workspaceAccesses.filter(
          (access) => !workspaceRoots.isAllowedPath(access.path, access.access),
        )
      : [];
    const externalDirectories = workspaceRoots
      ? await externalAuthorizationDirectories(externalAccesses, workspaceRoots)
      : [];
    const safetyPath = bypassImmuneSafetyPath(call, workDir, workspaceRoots);
    const allowSessionGrants = options.allowSessionGrants !== false;
    const hasSessionGrant =
      allowSessionGrants &&
      globalSessionPermissionGrants.allows(sessionId, call, workDir, workspaceRoots, picoHome);
    const hasExplicitSafetyGrant =
      allowSessionGrants &&
      globalSessionPermissionGrants.allowsSafetyOverride(
        sessionId,
        call,
        workDir,
        workspaceRoots,
        picoHome,
      );

    if (
      context?.forceApproval !== true &&
      hasSessionGrant &&
      externalDirectories.length === 0 &&
      (safetyPath === undefined || hasExplicitSafetyGrant)
    ) {
      return { allowed: true, reason: "本会话结构化权限规则放行" };
    }

    // ToolCategory 只选择审批策略与理由；真实能力仍由 workspace/process sandbox 执行。
    // Bash 分类器永远至少返回 shell_unsafe，因此漏掉危险语法不会造成自动放行。
    const needsApproval =
      context?.forceApproval === true ||
      safetyPath !== undefined ||
      externalDirectories.length > 0 ||
      policyDecision.kind === "prompt";
    if (!needsApproval) return { allowed: true, reason: `${mode} 模式自动放行` };

    const approvalReason = permissionApprovalReason({
      forceApproval: context?.forceApproval === true,
      safetyPath,
      externalDirectories,
      permissionCategory,
      policyReason: policyDecision.kind === "prompt" ? policyDecision.reason : undefined,
    });

    if (hookService) {
      const hookDecision = await hookService.dispatch(
        "PermissionRequest",
        {
          tool_name: call.name,
          tool_input: parseHookToolInput(call.arguments),
          tool_call_id: call.id,
          reason: approvalReason,
        },
        { signal },
      );
      if (hookDecision.decision === "deny") {
        denialSink?.({
          source: "permission",
          code: "hook",
          reasonKind: "hook_denied",
          toolName: call.name,
        });
        return {
          allowed: false,
          reason: hookDecision.reason ?? "PermissionRequest hook 拒绝了该工具调用。",
          denialSource: "hook",
        };
      }
    }

    const externalScope =
      externalDirectories.length > 0
        ? permissionScopeForCall(call, {
            externalDirectories,
            autoEditsAlreadyEnabled: mode === "auto",
          })
        : undefined;
    const scope = permissionScopeForCall(call, {
      ...(safetyPath !== undefined
        ? { safetyPath }
        : externalDirectories.length > 0
          ? { externalDirectories }
          : {}),
      autoEditsAlreadyEnabled: mode === "auto",
    });
    const diff = await computeApprovalDiff(call.name, call.arguments, workDir, workspaceRoots);
    const approvalId = `approval_${randomUUID()}`;
    const runtimeRun = currentRuntimeRun();
    let runtimeApprovalRecorded = false;
    if (runtimeRun) {
      await runtimeRun.recordApprovalRequested(approvalId, call.id, call.name);
      runtimeApprovalRecorded = true;
    }
    let result;
    try {
      result = await approvalManager.waitForApproval(
        approvalId,
        call.name,
        call.arguments,
        notifier,
        diff,
        signal,
        { sessionScope: scope, providerCallId: call.id, reason: approvalReason },
      );
    } catch (error) {
      if (runtimeApprovalRecorded) {
        await runtimeRun!.recordApprovalSettled(approvalId, "rejected");
      }
      throw error;
    }
    if (runtimeApprovalRecorded) {
      await runtimeRun!.recordApprovalSettled(approvalId, result.allowed ? "approved" : "rejected");
    }
    if (!result.allowed) {
      denialSink?.({
        source: "permission",
        code: "approval",
        reasonKind: "approval_denied",
        toolName: call.name,
      });
    }
    if (!result.allowed || !workspaceRoots || !settings) {
      return result.allowed ? result : { ...result, denialSource: "human" };
    }

    if (result.allowForSession && allowSessionGrants) {
      if (callRequiresProcessNetwork(call)) {
        globalSessionPermissionGrants.addNetwork(sessionId, workDir, picoHome);
      }
      await applySessionPermissionScope(scope, {
        sessionId,
        workDir,
        settings: settings as PermissionRuntimeSettings,
        workspaceRoots,
        picoHome,
      });
      if (safetyPath !== undefined && externalScope?.type === "directories") {
        await applySessionPermissionScope(
          { ...externalScope, enableAutoEdits: false },
          {
            sessionId,
            workDir,
            settings: settings as PermissionRuntimeSettings,
            workspaceRoots,
            picoHome,
          },
        );
      }
      await options.onSessionPolicyChanged?.();
    } else {
      for (const directory of externalDirectories) workspaceRoots.authorizeOnce(directory);
      if (call.name === "bash" && callRequiresProcessNetwork(call)) {
        globalSessionPermissionGrants.authorizeNetworkOnce(sessionId, workDir, call.id, picoHome);
      }
      if (isMcpToolName(call.name)) {
        await options.onOneShotMcpAuthorization?.(call, externalDirectories);
      }
    }
    return result;
  };
}

function configuredChildCeilingDenial(
  call: ToolCall,
  accesses: ReturnType<typeof workspaceAccessesFromCall>,
  ceiling: ExecutionBoundary | undefined,
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
): string | undefined {
  if (!ceiling || ceiling.kind === "bypass") return undefined;
  if (ceiling.kind !== "managed") {
    return "配置型子任务的 execution boundary 不允许本地工具执行。";
  }
  if (callRequiresNetworkAuthority(call) && ceiling.profile.network.kind !== "enabled") {
    return "配置型子任务请求的网络能力超出父任务 execution boundary，已直接拒绝。";
  }
  const context = {
    root: workDir,
    workspaceRoots: workspaceRoots?.list() ?? [workDir],
    tmpdir: tmpdir(),
    slashTmp: "/tmp",
  };
  for (const access of accesses) {
    let path: string;
    try {
      path = workspaceRoots?.resolveUnchecked(access.path) ?? resolve(workDir, access.path);
    } catch {
      return "配置型子任务请求的文件路径无法安全解析，已直接拒绝。";
    }
    const allowed =
      access.access === "write"
        ? canWritePath(ceiling.profile, path, context)
        : canReadPath(ceiling.profile, path, context);
    if (!allowed) {
      return "配置型子任务请求的文件能力超出父任务 execution boundary，已直接拒绝。";
    }
  }
  return undefined;
}

function callRequiresProcessNetwork(call: Pick<ToolCall, "name" | "arguments">): boolean {
  if (isMcpToolName(call.name)) return true;
  if (call.name !== "bash") return false;
  const command = bashCommandFromArgs(call.arguments);
  return command !== undefined && hasExplicitNetworkIntent(command);
}

function callRequiresNetworkAuthority(call: Pick<ToolCall, "name" | "arguments">): boolean {
  return (
    call.name === "fetch_url" || call.name === "web_search" || callRequiresProcessNetwork(call)
  );
}

function parseHookToolInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson) as unknown;
  } catch {
    return {};
  }
}

async function externalAuthorizationDirectories(
  accesses: ReturnType<typeof workspaceAccessesFromCall>,
  workspaceRoots: WorkspaceRoots,
): Promise<string[]> {
  const directories = await Promise.all(
    accesses
      .filter((access) => !workspaceRoots.isAllowedPath(access.path, access.access))
      .map((access) => workspaceRoots.authorizationDirectoryForPath(access.path)),
  );
  return [...new Set(directories)];
}

async function planModeDenialReason(
  call: { name: string; arguments: string },
  mode: "agent" | "plan",
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
): Promise<string | undefined> {
  if (mode !== "plan") return undefined;
  if (!isPlanProviderTool(call.name)) {
    return `Plan Mode 守卫：工具 ${call.name} 不在显式只读白名单中。`;
  }
  if (
    (call.name === "read_file" || call.name === "grep" || call.name === "glob") &&
    bypassImmuneSafetyPath(call, workDir, workspaceRoots) !== undefined
  ) {
    return "Plan Mode 守卫：密钥与凭据文件不属于计划阶段的可读边界。";
  }
  return undefined;
}

function permissionApprovalReason(input: {
  readonly forceApproval: boolean;
  readonly safetyPath: string | undefined;
  readonly externalDirectories: readonly string[];
  readonly permissionCategory: ToolPermissionCategory;
  readonly policyReason: string | undefined;
}): string {
  if (input.forceApproval) return "Hook 或宿主策略要求人工批准";
  if (input.safetyPath !== undefined) return `操作涉及敏感或控制面路径 ${input.safetyPath}`;
  if (input.externalDirectories.length > 0) {
    return `操作超出当前工作区：${input.externalDirectories.join(", ")}`;
  }
  return input.policyReason ?? permissionReasonForCategory(input.permissionCategory);
}

/** A headless runtime settles the same manager it asked, so it never waits for absent UI. */
function buildFailClosedApprovalNotifier(approvalManager: ApprovalManager): ApprovalNotifier {
  return (notice) => {
    queueMicrotask(() => {
      approvalManager.resolveApproval(
        notice.taskId,
        false,
        "当前 Runtime Host 未提供审批交互，已安全拒绝。",
      );
    });
  };
}

async function resolveBackgroundCredential(
  options: RunAgentCliOptions,
  execution: RuntimeExecution,
  dependencies: RunAgentCliDependencies,
): Promise<string | undefined> {
  if (execution.kind === "foreground" || dependencies.provider !== undefined) return undefined;
  // Background auth is injected by the host after resolving the trusted Provider and
  // checking its durable credentialRef identity, never from the Automation RPC input.
  if (options.auth === "none") return undefined;
  if (options.apiKey !== undefined) {
    throw new Error("后台执行拒绝直接传入 apiKey；请使用 credentialRef 和系统凭证库。");
  }
  if (options.credentialRef === undefined || dependencies.credentialResolver === undefined) {
    throw new Error("后台执行缺少 credentialRef 或系统凭证解析器，已按 fail-closed 拒绝。");
  }
  return dependencies.credentialResolver.resolve(options.credentialRef);
}

function resolveProviderConfig(
  options: RunAgentCliOptions,
  allowMissingNetworkConfig: boolean,
): ProviderConfig {
  const baseURL = options.baseURL;
  const apiKey = options.auth === "none" ? "" : options.apiKey;
  const model = options.model ?? defaultModel(options.provider ?? "openai");

  if (!allowMissingNetworkConfig && (!baseURL || (options.auth !== "none" && !apiKey))) {
    throw new Error("缺少 Provider 配置:宿主必须从用户模型路由注入 baseURL 和 apiKey");
  }

  return {
    baseURL: baseURL ?? "",
    apiKey: apiKey ?? "",
    ...(options.auth ? { auth: options.auth } : {}),
    model,
    ...(options.modelRouteId ? { routeId: options.modelRouteId } : {}),
    ...(options.modelCapabilities ? { capabilities: options.modelCapabilities } : {}),
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
  };
}

async function resolveWorkDir(dir: string | undefined): Promise<string> {
  const target = resolve(dir ?? process.cwd());

  await mkdir(target, { recursive: true });

  return realpath(target);
}

function normalizePrompt(prompt: string): string {
  if (prompt.trim() === "") {
    throw new Error("Prompt must not be empty.");
  }

  return prompt;
}

function defaultModel(kind: ProviderKind): string {
  switch (kind) {
    case "responses":
      return "gpt-4.1";
    case "openai":
      return "glm-5.2";
    case "claude":
      return "claude-3-5-sonnet";
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}

async function reconcileOrphanedPlanExecution(
  store: SqliteRuntimeEventStore,
  sessionId: string,
  writeGuard?: Session,
): Promise<PlanProjection> {
  return reconcilePlanExecution(store, sessionId, writeGuard, (operationId) =>
    livePlanAdmissions.has(planAdmissionKey(sessionId, operationId)),
  );
}

/** Resolve immutable provenance before assembling any model-visible tools. */
async function readInheritedRunSwarmAuthorization(
  session: Session,
  prestarted: PrestartedRuntimeRun | undefined,
  resume: boolean,
): Promise<RunAgentCliOptions["agentSwarmAuthorization"]> {
  const store = session.runtimeEventStore;
  if (!store) {
    if (prestarted) {
      throw new RuntimeEventStoreIntegrityError(
        `Prestarted Runtime run ${prestarted.runId} has no durable event store`,
      );
    }
    return undefined;
  }
  let sourceRunId = prestarted?.runId;
  if (!sourceRunId && resume) {
    const candidate = await store.findLatestInterruptedUnclaimedRun(session.id);
    if (
      candidate &&
      Date.now() - Date.parse(candidate.terminalAt) >= DEFAULT_CONTINUATION_TERMINAL_MIN_AGE_MS
    )
      sourceRunId = candidate.runId;
  }
  if (!sourceRunId) return undefined;
  const events = await store.readRun(session.id, sourceRunId);
  const start = events.find((event) => event.kind === "run.started");
  if (!start) {
    throw new RuntimeEventStoreIntegrityError(
      `Runtime authorization source ${sourceRunId} is missing its run.started fact`,
    );
  }
  if (prestarted && start.data.agentSwarmAuthorization !== prestarted.agentSwarmAuthorization) {
    throw new RuntimeEventStoreIntegrityError(
      `Prestarted Runtime run ${prestarted.runId} authorization does not match its persisted start`,
    );
  }
  return start.data.agentSwarmAuthorization;
}
