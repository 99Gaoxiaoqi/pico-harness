import { randomUUID } from "node:crypto";
import { mkdir, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { AgentEngine, isPlanProviderTool } from "../engine/loop.js";
import { PlanHandoffController } from "../engine/plan-handoff.js";
import type { GoalManager } from "../engine/goal-manager.js";
import { globalSessionManager, type Session } from "../engine/session.js";
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
import { SkillLoader, type Skill } from "../context/skill.js";
import { ToolDisclosure, type ToolGroupLoadedEventLike } from "../tools/tool-disclosure.js";
import { isToolSupportedForHost, type ToolHostKind } from "../tools/tool-surface.js";
import { RUNTIME_EVENT_SCHEMA_VERSION } from "../engine/session-runtime-event.js";
import { createRuntimeEventId } from "../storage/runtime-event-store-contracts.js";
import {
  createRawProvider,
  type ProviderKind,
  type ProviderRuntimeDependencies,
} from "../provider/factory.js";
import { PromptCachePrewarmCoordinator } from "../provider/prompt-cache-prewarm.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import type { ProviderConfig } from "../provider/config.js";
import type { CredentialResolver } from "../provider/credential-vault.js";
import type { LLMProvider } from "../provider/interface.js";
import { CredentialPool } from "../provider/credential-pool.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { ToolRegistry } from "../tools/registry-impl.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { AskUserHandler } from "../tools/ask-user.js";
import { WorkspaceRoots, workspaceAccessesFromCall } from "../tools/workspace-roots.js";
import type { DefaultToolRegistryOptions } from "../tools/default-registry.js";
import { FetchURLTool } from "../tools/web.js";
import {
  DelegationManager,
  DelegateStatusTool,
  aggregateDelegationStatus,
} from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import type { AgentProfile } from "../tools/agent-profile.js";
import { loadAgentCatalog, type AgentExternalCatalogSource } from "../agents/catalog.js";
import {
  DelegateTaskTool,
  type DelegatePlanStepCoordinator,
  SpawnSubagentTool,
  type SubagentModelSelectionRequest,
} from "../tools/subagent.js";
import {
  AddWorkTool,
  CloseGraphTool,
  ViewGraphTool,
  type GraphToolContext,
} from "../tools/graph-tools.js";
import { normalizeDelegateTasks } from "../tools/delegation-contract.js";
import { GRAPH_EVENT_KINDS, projectGraphEntries } from "../graph/graph-reducer.js";
import { computeReadyWorks, missingInputIdsFor } from "../graph/graph-reconcile.js";
import { CostTracker, type CostTrackerOptions } from "../observability/tracker.js";
import { ensureSessionUsageBaseline } from "../observability/usage-baseline.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";
import { ModelRouter } from "../provider/model-router.js";
import { Tracer } from "../observability/trace.js";
import { logger } from "../observability/logger.js";
import {
  globalApprovalManager,
  classifyHardlineCommand,
  isAgentOpsDangerousCommand,
  isDangerousCommand,
  type ApprovalManager,
  type ApprovalNotifier,
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
import { computeApprovalDiff } from "../approval/diff.js";
import { classifyBashCommand } from "../approval/bash-safety.js";
import { classifyPowerShellCommand } from "../approval/powershell-safety.js";
import { hostShellDialect } from "../os/shell.js";
import { createSessionRuntime, type SessionRuntime } from "./session-runtime.js";
import {
  buildSubagentModelCatalog,
  createInheritOnlySubagentModelCatalog,
  type SubagentModelCatalog,
} from "./subagent-model-catalog.js";
import type { MiddlewareFunc } from "../tools/registry.js";
import {
  McpConnectionManager,
  type McpConfigSource,
  type McpStatusSnapshot,
} from "../mcp/manager.js";
import { isMcpToolName } from "../mcp/types.js";
import { createBackgroundMcpClient } from "../safety/background-mcp-client.js";
import { configuredMcpServerNames, filterPluginMcpSources } from "../mcp/effective-config.js";
import type { ScheduleDraftCoordinator } from "../tasks/cron-draft.js";
import { looksLikeScheduleCreationIntent, ScheduleTaskTool } from "../tools/schedule-task.js";
import { BackgroundManager } from "../tools/background-manager.js";
import type { HookService } from "../hooks/service.js";
import {
  getOrCreateSessionSettings,
  DEFAULT_INTERACTION_MODE,
  setSessionAdditionalDirectories,
  toolStatusFromRegistry,
  type SessionToolStatus,
  type SessionSettings,
} from "../input/session-settings.js";
import { createIsolatedPicoConfig, loadPicoConfig } from "../input/pico-config.js";
import type { YoloSandboxConfig } from "../safety/yolo-sandbox.js";
import { resolveCliSession, type CliSessionSelection } from "../cli/session-resolver.js";
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";
import { SqliteRuntimeControlStore } from "../storage/sqlite/sqlite-runtime-control-store.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import {
  BackgroundPolicyViolationError,
  buildBackgroundYoloMiddleware,
  prepareBackgroundYoloPolicy,
  type BackgroundWorkspaceTrustVerifier,
  type PreparedBackgroundYoloPolicy,
} from "../safety/background-yolo-policy.js";
import { resolveSubagentModelSelection } from "./subagent-model-selection.js";
import { createSubagentModelRuntime } from "./subagent-model-runtime.js";
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
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";
import { currentRuntimeRun, isRuntimeRunLive, RuntimeRun } from "./runtime-run.js";
import { PlanCoordinator } from "../plan/coordinator.js";
import { PLAN_EVENT_KINDS } from "../plan/events.js";
import { projectActivePlanEntries } from "../plan/reducer.js";
import { PlanConflictError, type PlanProjection, type PlanProposal } from "../plan/contract.js";
import { RuntimeCleanupScope } from "./runtime-cleanup.js";
import {
  emitRuntimeLifecycleEvent,
  RuntimeRunExecutor,
  type PrestartedRuntimeRun,
} from "./runtime-run-executor.js";
import {
  invalidateMemoryReviewRecoverySuccess,
  recoverMemoryReviewJobs,
} from "./memory-review-recovery.js";
import { createEngineRuntimePort } from "./engine-runtime-port-adapter.js";
import { createSessionForkRuntimePort } from "./session-fork-runtime-port-adapter.js";

const livePlanAdmissions = new Set<string>();
const PLAN_REVISION_FEEDBACK_MAX_CHARS = 4_000;
const PLAN_REVISION_CONTEXT_FIELD_MAX_CHARS = 256;
import {
  assembleRuntimeProvider,
  billingRouteForProvider,
  type RuntimeProviderFactory,
} from "./runtime-assembly.js";
import type {
  RunAgentCliOptions,
  RunAgentCliResult,
  RuntimeExecution,
  RuntimeLifecycleEvent,
} from "./runtime-contract.js";
import { MemoryContextBuilder } from "../memory/context-builder.js";
import { buildMemoryTriggerTools, type MemoryTriggerSlot } from "../memory/memory-trigger-tools.js";
import { SqliteMemoryRepository } from "../storage/sqlite/sqlite-memory-repository.js";
import {
  MemoryReviewScheduler,
  type MemoryReviewSchedulerPort,
} from "../memory/runtime-scheduler.js";
import {
  kickMemoryReviewWorker,
  MemoryReviewWorker,
  ProviderMemoryProposalModel,
  type MemoryProposalModelFactory,
  type MemoryProposalPublishedSink,
} from "../memory/worker.js";
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

/**
 * Host-provided effects. The runtime never renders an Ink component or assumes a terminal.
 * Missing approval delivery fails closed when a dangerous tool is requested.
 */
export interface RuntimeHost {
  reporter?: Reporter;
  approvalNotifier?: ApprovalNotifier;
  onEvent?: (event: RuntimeLifecycleEvent) => void;
  /** Metadata-only observer for newly committed pending memory proposals. */
  memoryProposalSink?: MemoryProposalPublishedSink;
  /** Structured fail-closed safety/permission denial observer for non-interactive hosts. */
  onPolicyDenied?: (event: RuntimePolicyDenial) => void;
}

export type RuntimePolicyDenialReasonKind =
  | "plan_mode"
  | HardlineReasonKind
  | "hook_denied"
  | "approval_denied";

export interface RuntimePolicyDenial {
  readonly source: "safety" | "permission";
  readonly code: "plan_mode" | "hardline" | "hook" | "approval";
  readonly reasonKind: RuntimePolicyDenialReasonKind;
  readonly toolName: string;
}

export interface RunAgentCliDependencies extends RuntimeHost {
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
  /** 仅由可展示结构化问题的 TUI bundle 提供。 */
  askUserHandler?: AskUserHandler;
  /** Host-owned approval state, required when decisions are settled outside the TUI process. */
  approvalManager?: ApprovalManager;
  /** Receives the complete registry after late delegation/MCP registration. */
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
  /** @internal 继续已存在的未完成轮次，不新增 user 消息或 rewind point。 */
  resumeExistingSession?: boolean;
  /** @internal 恢复 adapter 已在 canonical ledger 发布的唯一 RuntimeRun admission。 */
  prestartedRun?: PrestartedRuntimeRun;
  /** 仅用于后台执行的实时信任校验；生产默认读取用户级 WorkspaceTrustStore。 */
  backgroundTrustStore?: BackgroundWorkspaceTrustVerifier;
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
  /** Long-lived hosts with injected providers supply a fresh, self-owned worker model per claim. */
  memoryProposalModelFactory?: MemoryProposalModelFactory;
  /** Test/host override; production automatic reviews wait for a short workspace debounce. */
  memoryReviewDebounceMs?: number;
  /** @internal Ignore project/user extension catalogs and host compatibility resources. */
  isolatedHeadless?: boolean;
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
      planMode: true,
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
      );
      const approved =
        approvalStatus === "matching"
          ? await coordinator.project()
          : await coordinator.approve({
              operationId,
              expectedSessionSequence: input.approval.expectedSessionSequence,
              ...approvalSemantic,
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
        })) === "matching"
      ) {
        await reconcileOrphanedPlanExecution(session.runtimeEventStore, session.id);
        return replayedPlanControlResult(session.id, workDir, operationId);
      }
      const admission = planAdmissionKey(session.id, executionOperationId);
      livePlanAdmissions.add(admission);
      try {
        return await this.execute(
          {
            ...input.execution,
            dir: workDir,
            session: session.id,
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

  async readPlanProjection(input: PlanSessionRequest): Promise<PlanProjection> {
    const picoHome = resolvePicoHome({ picoHome: input.picoHome, env: input.env ?? process.env });
    const workDir = await resolveWorkDir(input.dir);
    const store = new SqliteRuntimeEventStore({
      storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
    });
    try {
      const result = await reconcileOrphanedPlanExecution(store, input.sessionId);
      return result;
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
      const coordinator = new PlanCoordinator(
        session.runtimeEventStore,
        planControlContext(session.id, input.operationId),
      );
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
      const coordinator = new PlanCoordinator(
        session.runtimeEventStore,
        planControlContext(session.id, input.operationId),
      );
      const semantic = { planId: input.planId };
      if (
        (await coordinator.operationStatus(
          input.operationId,
          "plan.execution.resumed",
          semantic,
        )) === "matching"
      ) {
        await reconcileOrphanedPlanExecution(session.runtimeEventStore, session.id);
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
            session: session.id,
            prompt: resumedPlanExecutionPrompt(projection),
            approvedPlan: {
              planId: input.planId,
              revision: projection.execution.revision,
              expectedSessionSequence: input.expectedSessionSequence,
              operationId: input.operationId,
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
      return await new PlanCoordinator(
        session.runtimeEventStore,
        planControlContext(session.id, input.operationId),
      ).cancel({
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
      const coordinator = new PlanCoordinator(
        session.runtimeEventStore,
        planControlContext(session.id, input.operationId),
      );
      const semantic = {
        planId: input.planId,
        ...(input.reason ? { reason: input.reason } : {}),
      };
      if (
        (await coordinator.operationStatus(
          input.operationId,
          "plan.execution.replanned",
          semantic,
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
        ...(input.reason ? { reason: input.reason } : {}),
      });
      return await this.execute(
        {
          ...input.execution,
          dir: workDir,
          session: session.id,
          prompt: input.prompt,
          planMode: true,
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
  };
  readonly execution: Omit<RunAgentCliOptions, "prompt" | "session" | "dir" | "approvedPlan">;
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
  readonly reason?: string;
}

export interface PlanRevisionRequest extends PlanSessionRequest {
  readonly planId: string;
  readonly expectedRevision: number;
  readonly expectedSessionSequence: number;
  readonly operationId: string;
  readonly feedback: string;
}

export interface PlanResumeExecutionRequest extends PlanInterruptedControlRequest {
  readonly execution: Omit<RunAgentCliOptions, "prompt" | "session" | "dir" | "approvedPlan">;
}

export interface PlanReplanExecutionRequest extends PlanInterruptedControlRequest {
  readonly prompt: string;
  readonly execution: Omit<RunAgentCliOptions, "prompt" | "session" | "dir" | "approvedPlan">;
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
    "只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
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
    "只要 execution 仍为 active，就不得仅返回文字或结束本轮；必须继续处理未完成步骤，直到 update_plan 返回 execution 已 completed。确实无法继续时调用 cancel_plan。",
  ].join("\n\n");
}

function planControlContext(sessionId: string, operationId: string) {
  return {
    sessionId,
    invocationId: `plan-control:${operationId}`,
    runId: `plan-control:${operationId}`,
    turnId: `turn:plan-control:${operationId}`,
  };
}

async function reconcileOrphanedPlanExecution(
  store: SqliteRuntimeEventStore,
  sessionId: string,
): Promise<PlanProjection> {
  // plan.* + run.started 事件切片(票 04):本函数只消费 plan 事件与
  // transition 之后的 run.started 准入事实,不再全量读。
  const { entries } = await store.readSessionEntriesOfKinds(sessionId, [
    ...PLAN_EVENT_KINDS,
    "run.started",
  ]);
  const coordinator = new PlanCoordinator(store, planControlContext(sessionId, "reconcile"));
  const projection = await coordinator.project();
  if (projection.execution?.status !== "active") return projection;
  const transition = projectActivePlanEntries(entries)
    .filter(
      ({ event }) =>
        event.kind === "plan.execution.started" || event.kind === "plan.execution.resumed",
    )
    .at(-1);
  if (!transition) return projection;
  const transitionOperationId =
    "operationId" in transition.event.data ? transition.event.data.operationId : undefined;
  if (
    typeof transitionOperationId === "string" &&
    livePlanAdmissions.has(planAdmissionKey(sessionId, transitionOperationId))
  ) {
    return projection;
  }
  const admittedRun = entries.find(
    ({ sequence, event }) => sequence > transition.sequence && event.kind === "run.started",
  );
  if (admittedRun && isRuntimeRunLive(sessionId, admittedRun.event.runId)) return projection;
  const current = await coordinator.project();
  if (current.execution?.status !== "active") return current;
  return await coordinator.interrupt({
    operationId: `reconcile-plan-execution:${transition.event.eventId}`,
    expectedSessionSequence: current.sessionSequence,
    planId: current.execution.planId,
    reason: admittedRun
      ? "RuntimeRun ended without closing the active plan execution"
      : "Plan execution transition has no durable RuntimeRun admission",
  });
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
    planMode: false,
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
  if (dependencies.prestartedRun && !resumeExistingSession) {
    throw new Error("prestartedRun requires resumeExistingSession");
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
    : await loadPicoConfig(workDir);
  const claudeCompatibility = picoConfig.compatibility.claude;
  const configuredAdditionalDirectories = picoConfig.additionalDirectories;
  const sessionSelection =
    options.sessionSelection ??
    (await resolveCliSession({
      workDir,
      picoHome,
      ...(options.session ? { session: options.session } : {}),
      ...(options.continueSession ? { continueSession: true } : {}),
      ...(options.resumeSession ? { resumeSession: options.resumeSession } : {}),
      ...(options.forkSession ? { forkSession: options.forkSession } : {}),
    }));
  const defaultConfigModel = options.model ?? defaultModel(kind);

  // 阶段 2：获取持久化 Session，并推导会话级有效配置。
  const sessionLease = await acquireRuntimeSession({
    sessionSelection,
    workDir,
    picoHome,
    resumeExistingSession,
    planMode: options.planMode === true,
  });
  const session = sessionLease.session;
  let executionCoordinator: PlanCoordinator | undefined;
  let activeExecutionPlanId: string | undefined;
  let planRun = false;
  let livePlanAdmission: string | undefined;
  const ownsRuntimeState = dependencies.runtimeState === undefined;
  let sessionLeaseTransferred = false;
  let cleanupRuntimeState: SessionRuntime | undefined;
  let ownedUsageStore: SqliteRuntimeControlStore | undefined;
  let ownsMcpManager = false;
  let cleanupMcpManager: McpConnectionManager | undefined;
  let memoryRepository: SqliteMemoryRepository | undefined;
  let memoryContextBuilder: MemoryContextBuilder | undefined;
  let memoryReviewScheduler: MemoryReviewSchedulerPort | undefined;
  let memoryReviewMode: string | undefined;
  let kickMemoryWorker = (): void => undefined;
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
    if (resumeExistingSession && dependencies.runtimeState === undefined) {
      throw new Error("resumeExistingSession requires an existing runtimeState.");
    }
    dependencies.runtimeState?.assertCompatible(session);
    if (dependencies.runtimeState) {
      sessionLease.release();
      sessionLeaseTransferred = true;
    }
    const settings = getOrCreateSessionSettings(
      {
        sessionId: sessionSelection.sessionId,
        sessionMode: sessionSelection.mode,
        ...(sessionSelection.sourceSessionId !== undefined
          ? { forkFrom: sessionSelection.sourceSessionId }
          : {}),
        cwd: workDir,
        picoHome: session.picoHome,
        provider: kind,
        ...(backgroundPolicy
          ? { mode: "yolo" as const }
          : options.interactionMode !== undefined
            ? { mode: options.interactionMode }
            : {}),
        model: defaultConfigModel,
        ...(options.modelRouteId !== undefined ? { modelRouteId: options.modelRouteId } : {}),
        ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
      },
      { persistence: session, ...(backgroundPolicy ? { restore: false } : {}) },
    );
    if (!settings.collaborationMode) throw new Error("Session collaborationMode is unavailable");
    const collaborationMode = (): "agent" | "plan" => settings.collaborationMode!;
    planRun = collaborationMode() === "plan";
    const orchestrationMode = (): "default" | "graph" =>
      options.orchestrationMode ?? settings.orchestrationMode ?? "default";
    const permissionMode = (): "default" | "auto" | "yolo" => settings.permissionMode;
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
      });
      const operationId =
        options.approvedPlan.operationId ??
        `${options.approvedPlan.transition === "resume" ? "resume" : "start"}-plan:${randomUUID()}`;
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
        });
      } else {
        await executionCoordinator.startExecution({
          operationId,
          expectedSessionSequence: options.approvedPlan.expectedSessionSequence,
          planId: options.approvedPlan.planId,
          revision: options.approvedPlan.revision,
        });
      }
      activeExecutionPlanId = options.approvedPlan.planId;
    }
    const memoryTrustStore =
      dependencies.memoryTrustStore ?? new WorkspaceTrustStore({ userStateDirectory: picoHome });
    if (!backgroundPolicy && !dependencies.isolatedHeadless && collaborationMode() !== "plan") {
      try {
        const canonicalMemoryWorkspace = await memoryTrustStore.canonicalize(workDir);
        if (await memoryTrustStore.isTrusted(canonicalMemoryWorkspace)) {
          const memoryPaths = resolvePicoPaths(canonicalMemoryWorkspace, { picoHome });
          memoryRepository = new SqliteMemoryRepository({
            storageRoot: memoryPaths.workspace.root,
            workspaceId: memoryPaths.workspace.id,
          });
          memoryContextBuilder = new MemoryContextBuilder(memoryRepository);
          const memorySettings = memoryRepository.getSettings();
          memoryReviewMode = memorySettings.reviewMode;
          if (memorySettings.enabled && memorySettings.autoPropose) {
            memoryReviewScheduler = {
              enqueue: (input) => {
                // This callback runs in RuntimeRunExecutor's detached host task, after the
                // foreground result is available. Own the connection so AgentRuntime cleanup
                // cannot close it before the durable enqueue begins.
                const schedulerRepository = new SqliteMemoryRepository({
                  storageRoot: memoryPaths.workspace.root,
                  workspaceId: memoryPaths.workspace.id,
                });
                try {
                  new MemoryReviewScheduler(schedulerRepository, {
                    debounceMs: dependencies.memoryReviewDebounceMs,
                  }).enqueue(input);
                } catch (error) {
                  invalidateMemoryReviewRecoverySuccess(memoryPaths.workspace.root);
                  throw error;
                } finally {
                  schedulerRepository.close();
                }
                kickMemoryWorker();
              },
            };
          }
        }
      } catch (error) {
        logger.warn(
          { workDir, error: error instanceof Error ? error.message : String(error) },
          "[Memory] workspace runtime unavailable; continuing without recall/review",
        );
        memoryRepository?.close();
        memoryRepository = undefined;
        memoryContextBuilder = undefined;
        memoryReviewScheduler = undefined;
      }
    }
    const workspaceRoots = await WorkspaceRoots.create(
      workDir,
      backgroundPolicy || sessionSelection.mode === "fork"
        ? []
        : [
            ...configuredAdditionalDirectories,
            ...(options.addDirs ?? []),
            ...settings.additionalDirectories,
          ],
    );
    setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));
    const traceEnabled = options.trace === true || isTruthyEnv(runtimeEnv.PICO_TRACE);
    const effectiveOptions: RunAgentCliOptions = {
      ...options,
      ...(backgroundApiKey !== undefined ? { apiKey: backgroundApiKey } : {}),
      dir: workDir,
      session: sessionSelection.sessionId,
      sessionSelection,
      model: options.model ?? settings.model,
      planMode: backgroundPolicy ? false : collaborationMode() === "plan",
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
    const pluginSnapshot = backgroundPolicy
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
    // headless/folder 装配不注入 taskHostRuntime：提前建 RuntimeStore，同时作为
    // graph work lease 源（注入 DelegationManager）与 usage ledger。
    if (dependencies.runtimeState === undefined && !ownedUsageStore) {
      try {
        ownedUsageStore = new SqliteRuntimeControlStore({
          storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
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
        lspEnabled: !backgroundPolicy && collaborationMode() !== "plan",
        lspServers: [...picoConfig.lspServers, ...(pluginSnapshot?.lspServers ?? [])],
        sessionStartSource:
          sessionSelection.mode === "resume" || sessionSelection.mode === "continue"
            ? "resume"
            : "startup",
        ...(backgroundPolicy || dependencies.isolatedHeadless || collaborationMode() === "plan"
          ? { hooks: false as const }
          : {}),
        ...(collaborationMode() !== "plan" && dependencies.hookService
          ? { hookService: dependencies.hookService }
          : {}),
        ...(collaborationMode() !== "plan" && pluginSnapshot?.hookSources
          ? { hookExtensionSources: pluginSnapshot.hookSources }
          : {}),
        ...(ownedUsageStore ? { runtimeStore: ownedUsageStore } : {}),
      }));
    if (ownsRuntimeState) sessionLeaseTransferred = true;
    cleanupRuntimeState = runtimeState;
    if (!ownsRuntimeState) {
      await runtimeState.setCodeIntelligenceEnabled(collaborationMode() !== "plan");
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
          storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
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
    const workspaceStatePaths = resolvePicoPaths(workDir, {
      picoHome: session.picoHome,
    }).workspace;
    const currentConfig: ProviderConfig = providerConfig;
    const routeCredentials =
      dependencies.provider === undefined && dependencies.modelRouter && currentConfig.routeId
        ? dependencies.modelRouter.credentialCandidates(currentConfig.routeId)
        : [];
    const credentialPool =
      routeCredentials.length > 1 ? new CredentialPool([...routeCredentials]) : undefined;
    const providerDependencies: ProviderRuntimeDependencies = {
      promptCachePrewarm: PromptCachePrewarmCoordinator.shared(workspaceStatePaths.root),
    };
    const providerFactory = dependencies.providerFactory ?? createRawProvider;
    const providerDecorator = (provider: LLMProvider): LLMProvider => {
      const activated = activatePluginProviderCapabilities(
        pluginSnapshot,
        dependencies.pluginCapabilityRegistry,
        provider,
        pluginActivationScope,
      );
      return dependencies.providerDecorator ? dependencies.providerDecorator(activated) : activated;
    };
    const subagentModelRouter =
      dependencies.modelRouter ??
      (effectiveOptions.modelRouteId && dependencies.provider === undefined
        ? activeRouteModelRouter(kind, providerConfig, effectiveOptions.modelRouteId)
        : undefined);
    const parentModelRouteId = effectiveOptions.modelRouteId;
    const parentModelDisplayId =
      parentModelRouteId ?? dependencies.provider?.modelName ?? providerConfig.model;
    const allowSubagentModelRouteOverride =
      dependencies.modelRouter !== undefined &&
      dependencies.provider === undefined &&
      !backgroundPolicy;
    const subagentModelCatalog =
      subagentModelRouter && parentModelRouteId
        ? buildSubagentModelCatalog({
            router: subagentModelRouter,
            parentRouteId: parentModelRouteId,
            aliases: claudeCompatibility.enabled ? claudeCompatibility.modelAliases : {},
            allowRouteOverride: allowSubagentModelRouteOverride,
          })
        : createInheritOnlySubagentModelCatalog(parentModelDisplayId);
    const resolveSubagentModelRuntime =
      subagentModelRouter && parentModelRouteId && dependencies.provider === undefined
        ? (request?: SubagentModelSelectionRequest) => {
            const requestedModelRoute = request?.ephemeralRouteId ?? request?.profileRouteId;
            const selection = resolveSubagentModelSelection({
              router: subagentModelRouter,
              parentRouteId: parentModelRouteId,
              ...(request?.ephemeralRouteId !== undefined
                ? { ephemeralRouteId: request.ephemeralRouteId }
                : {}),
              ...(request?.profileRouteId !== undefined
                ? { profileRouteId: request.profileRouteId }
                : {}),
              ...(request?.ephemeralThinkingEffort !== undefined
                ? { ephemeralThinkingEffort: request.ephemeralThinkingEffort }
                : {}),
              ...(request?.profileThinkingEffort !== undefined
                ? { profileThinkingEffort: request.profileThinkingEffort }
                : {}),
              parentThinkingEffort: effectiveOptions.thinkingEffort ?? "off",
              modelAliases: picoConfig.compatibility.claude.modelAliases,
              claudeCompatibilityEnabled: picoConfig.compatibility.claude.enabled,
              allowRouteOverride: allowSubagentModelRouteOverride,
            });
            const runtime = createSubagentModelRuntime({
              router: subagentModelRouter,
              selection,
              session,
              providerFactory,
              providerDecorator,
              trackerOptions,
              providerDependencies,
            });
            return {
              provider: runtime.provider,
              compactor: runtime.compactor,
              usageSession: session,
              thinkingEffort: runtime.thinkingEffort ?? "off",
              ...(requestedModelRoute ? { requestedModelRoute } : {}),
              resolvedModelRoute: runtime.route.id,
              source: selection.source,
            };
          }
        : undefined;
    const providerAssembly = assembleRuntimeProvider({
      kind,
      config: currentConfig,
      session,
      trackerOptions,
      ...(dependencies.provider !== undefined ? { provider: dependencies.provider } : {}),
      providerFactory,
      providerDecorator,
      ...(credentialPool ? { credentialPool } : {}),
      providerDependencies,
    });
    const trackedProvider = providerAssembly.provider;
    const rebuildProvider = providerAssembly.rebuildProvider;
    const memoryModelFactory =
      dependencies.memoryProposalModelFactory ??
      (dependencies.provider === undefined
        ? async () => {
            const ledger = new SqliteRuntimeControlStore({
              storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
            });
            const billingRoute = billingRouteForProvider(kind, currentConfig);
            const provider = new CostTracker(
              providerFactory(kind, currentConfig, undefined, providerDependencies),
              billingRoute,
              undefined,
              {
                ledger,
                context: { purpose: "memory_review" },
              },
            );
            return {
              model: new ProviderMemoryProposalModel(provider, billingRoute),
              dispose: () => ledger.close(),
            };
          }
        : undefined);
    if (memoryReviewScheduler && memoryModelFactory) {
      const memoryPaths = resolvePicoPaths(workDir, { picoHome });
      kickMemoryWorker = () =>
        kickMemoryReviewWorker(
          memoryPaths.workspace.id,
          () =>
            new MemoryReviewWorker({
              workDir,
              workspaceId: memoryPaths.workspace.id,
              runtimeStorageRoot: memoryPaths.workspace.root,
              trustStore: memoryTrustStore,
              modelFactory: memoryModelFactory,
              ...(dependencies.memoryProposalSink
                ? { proposalSink: dependencies.memoryProposalSink }
                : {}),
            }),
        );
      // Rebuild jobs lost after a canonical terminal commit, then drain all durable work. Keep
      // this detached from the foreground path: recovery degradation must not delay streaming.
      void recoverMemoryReviewJobs({
        runtimeStorageRoot: memoryPaths.workspace.root,
        scheduler: memoryReviewScheduler,
      })
        .catch((error: unknown) =>
          logger.warn(
            { workDir, error: error instanceof Error ? error.message : String(error) },
            "[Memory] runtime-ledger recovery failed",
          ),
        )
        .finally(kickMemoryWorker);
    }
    let activeMcpManager = collaborationMode() === "plan" ? undefined : dependencies.mcpManager;
    runtimeState.bindHookRuntime({
      provider: trackedProvider,
      modelRuntime: {
        run: (execute, signal) => runHostOwnedRuntimeOperation(session, execute, signal),
      },
      mcpInvoker: {
        async invokeConnectedTool(server, tool, input, context) {
          if (!activeMcpManager) throw new Error("MCP manager 尚未连接");
          return await activeMcpManager.invokeConnectedTool(server, tool, input, context);
        },
      },
      agentVerifier: {
        async verify(request) {
          const verifierEngine = new AgentEngine({
            provider: hookPurposeProvider(trackedProvider),
            registry: new ToolRegistry(),
            workDir,
            runtimePort: createEngineRuntimePort(),
            workspaceRoots,
            usageSession: session,
            goalManager: runtimeState.goalManager,
            ...(dependencies.toolResultRedactionSecrets
              ? { toolResultRedactionSecrets: dependencies.toolResultRedactionSecrets }
              : {}),
          });
          const verifierRegistry = createSubagentRegistryFactory({
            workDir,
            workspaceRoots,
            runner: verifierEngine,
            manager: runtimeState.delegationManager,
            maxSpawnDepth: 0,
            yoloSandbox: { config: picoConfig.sandbox },
            ownerSessionId: session.id,
            env: runtimeEnv,
            codeIntelligence: runtimeState.codeIntelligence,
          })({ mode: "explore", role: "leaf", depth: 0, maxSpawnDepth: 0 });
          const task = [
            request.prompt,
            "",
            "只读核验以下 Hook input。最终只输出单个 JSON 对象：",
            '{"ok": boolean, "reason": string}',
            JSON.stringify(request.input),
          ].join("\n");
          const result = await verifierEngine.runSub(task, verifierRegistry, undefined, {
            maxTurns: request.maxTurns,
            role: "leaf",
            depth: 0,
            maxSpawnDepth: 0,
            signal: request.signal,
            workDir,
          });
          return result.summary;
        },
      },
      onAsyncRewake(handler, output) {
        runtimeState.hookRewakeQueue.enqueue(
          `[Hook asyncRewake ${handler.id}] ${output.reason ?? output.additionalContext ?? output.decision}`,
        );
      },
    });
    const { goalManager, todoStore, toolDisclosure, backgroundManager, delegationManager } =
      runtimeState;
    if (options.approvedPlan) {
      toolDisclosure.discloseTools(["update_plan", "cancel_plan"]);
    }
    // durable 披露恢复：从本 session 的 ledger 重播 tool.group.loaded 事实，
    // run 切换 / crash recovery 后已加载组自动恢复，模型无需重新 load_tools。
    if (session.runtimeEventStore) {
      try {
        // kind 切片(票 04):披露恢复只消费 tool.group.loaded 事实。
        const priorEntries = (
          await session.runtimeEventStore.readSessionEntriesOfKinds(session.id, [
            "tool.group.loaded",
          ])
        ).entries;
        toolDisclosure.seedFromEvents(
          priorEntries.map((entry) => entry.event as ToolGroupLoadedEventLike),
        );
      } catch {
        // 恢复失败不阻塞 run：最坏情况是模型需重新 load_tools。
      }
    }
    // load_tools 组级激活的 durable 写入：ledger 事实是 crash 恢复的唯一来源。
    // 写失败不阻塞激活（内存态已生效），只损失恢复能力。
    // background 宿主刻意不写：YOLO allowlist 语义下披露状态属于单次 Job
    // 生命周期，且 fire-and-forget append 会绕过 executor 的 run 事件序列
    // （可打断 recoverable-task 的 high-water CAS），不值得为不可恢复的
    // 场景引入该窗口。
    const onToolGroupLoaded: ((groupId: string, toolNames: readonly string[]) => void) | undefined =
      session.runtimeEventStore && !backgroundPolicy
        ? (groupId, toolNames) => {
            const store = session.runtimeEventStore;
            if (!store) return;
            const run = currentRuntimeRun();
            void store
              .append({
                schemaVersion: RUNTIME_EVENT_SCHEMA_VERSION,
                eventId: createRuntimeEventId("tool-group"),
                sessionId: session.id,
                invocationId: run?.invocationId ?? `tool-group:${session.id}`,
                runId: run?.runId ?? "tool-group",
                turnId: run ? `turn:${run.runId}` : "tool-group",
                at: new Date().toISOString(),
                partial: false,
                visibility: "internal",
                kind: "tool.group.loaded",
                data: { groupId, toolNames: [...toolNames] },
              })
              .catch((error) => {
                // durable 写失败不阻塞激活（内存态已生效），但必须可见——
                // 静默吞错曾让 assert 层拒绝完全不可发现。
                logger.warn(
                  { error: String(error), groupId },
                  "[ToolDisclosure] tool.group.loaded durable 写入失败",
                );
              });
          }
        : undefined;
    const approvalManager = dependencies.approvalManager ?? globalApprovalManager;
    const planHandoff = new PlanHandoffController();
    const planRegistryOptions: DefaultToolRegistryOptions["plan"] = {
      handoff: planHandoff,
      sessionId: session.id,
      mode: collaborationMode() === "plan" ? "planning" : "execution",
      ...(options.approvedPlan ? { planId: options.approvedPlan.planId } : {}),
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
        if (settings.mode === "yolo") return false;
        if (settings.mode === "plan" || path === undefined) return true;
        return !isSensitiveCredentialPath(workspaceRoots.resolveUnchecked(path));
      },
      backgroundPolicy
        ? {
            config: {
              network: backgroundPolicy.snapshot.toolNetworkPolicy === "allow" ? "allow" : "deny",
            },
          }
        : undefined,
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
      collaborationMode() === "plan" || options.approvedPlan ? planRegistryOptions : undefined,
      hostKind,
      onToolGroupLoaded,
    );
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
    // 记忆触发器工具只标记意图；executor 在 completed terminal 落盘后统一入队。
    const memoryTriggerSlot: MemoryTriggerSlot = { trigger: undefined };
    if (memoryReviewScheduler && memoryReviewMode !== "eco") {
      for (const tool of buildMemoryTriggerTools(memoryTriggerSlot)) {
        registry.register(tool);
      }
    }
    // 前台只使用会话级 HookService；legacy .claw source 也由它统一加载并校验信任。
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
          !!session.runtimeEventStore && !backgroundPolicy && orchestrationMode() === "graph",
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
      if (collaborationMode() === "plan" && session.runtimeEventStore) {
        const projection = await new PlanCoordinator(
          session.runtimeEventStore,
          planControlContext(session.id, "revision-turn-tail"),
        ).project();
        const revisionTail = planRevisionRequestTurnTail(projection);
        if (revisionTail) turnTailParts.push(revisionTail);
      }
      if (memoryContextBuilder) {
        try {
          const canonical = await memoryTrustStore.canonicalize(workDir);
          if (await memoryTrustStore.isTrusted(canonical)) {
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
        systemPrompt: composed.systemPrompt,
        turnTail: turnTailParts.join("\n\n"),
      };
    };
    const reporter = dependencies.reporter ?? new TerminalReporter();
    const approvalNotifier =
      dependencies.approvalNotifier ?? buildFailClosedApprovalNotifier(approvalManager);
    const contextRuntime = buildContextRuntime(kind, providerConfig.model);
    const engine = new AgentEngine({
      provider: trackedProvider,
      registry,
      workDir,
      runtimePort: createEngineRuntimePort(),
      workspaceRoots,
      usageSession: session,
      // turn 边界通知：子代理执行容量闸按轮换新——每 turn 满血配速，跨 turn
      // 在跑 child 不占新预算，多轮委派的会话不会被累积在飞子代理堵死。
      onTurnBoundary: () => delegationManager.resetTurnState(),
      ...(effectiveOptions.thinkingEffort !== undefined
        ? { thinkingEffort: effectiveOptions.thinkingEffort }
        : {}),
      ...(effectiveOptions.modelRouteId !== undefined
        ? { modelRouteId: effectiveOptions.modelRouteId }
        : {}),
      ...(resolveSubagentModelRuntime ? { resolveSubagentModelRuntime } : {}),
      planMode: effectiveOptions.planMode ?? false,
      collaborationMode,
      planHandoff,
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
      ...(session.runtimeEventStore && !backgroundPolicy && orchestrationMode() === "graph"
        ? {
            graphReconcile: async () => {
              try {
                // graph.* 事件切片 + 全会话水位(票 04):折叠输入只含 graph 事件。
                const slice = await session.runtimeEventStore!.readSessionEntriesOfKinds(
                  session.id,
                  GRAPH_EVENT_KINDS,
                );
                const projection = projectGraphEntries(
                  runtimeState.graphContext.graphId,
                  slice.entries,
                  slice.headSequence,
                );
                if (projection.status !== "active") return { pending: 0, ready: 0 };
                const pendingWorks = projection.works.filter(
                  (work) => work.status === "requested" || work.status === "dispatched",
                );
                const ready = computeReadyWorks(projection).length;
                // Surface deadlocked requested works whose input_ids reference
                // records that will never be produced (wrong id, or a failed
                // upstream). The continuation arbiter injects this into the
                // [Graph continuation] message so the model sees the deadlock
                // at stop-decision time, not only inside a view_graph call.
                const stuck = pendingWorks
                  .filter(
                    (work) =>
                      work.status === "requested" &&
                      missingInputIdsFor(projection, work).length > 0,
                  )
                  .map((work) => ({
                    workId: work.workId,
                    missingInputIds: [...missingInputIdsFor(projection, work)],
                  }));
                return { pending: pendingWorks.length, ready, stuck };
              } catch {
                return { pending: 0, ready: 0 };
              }
            },
          }
        : {}),
    });

    if (backgroundPolicy) {
      registry.useSafety?.(
        buildBackgroundYoloMiddleware({
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
        ),
      );
    }
    registerDelegationTools(
      registry,
      engine,
      workDir,
      dependencies.isolatedHeadless
        ? []
        : await loadProfiles(workDir, {
            externalSources: pluginSnapshot?.agentSources,
            includeClaudeProjectResources:
              claudeCompatibility.enabled && claudeCompatibility.projectResources,
            includeClaudeUserResources:
              claudeCompatibility.enabled && claudeCompatibility.userResources,
            env: runtimeEnv,
            picoHome,
          }),
      delegationManager,
      workspaceRoots,
      // 主会话的 mode 只控制主 Agent 权限。worker/explore 是独立的不可信执行边界，
      // 必须始终使用 worktree + OS 沙箱，不得因 default/auto 模式退化为无沙箱 Bash。
      { config: picoConfig.sandbox },
      session.id,
      !ownsRuntimeState,
      runtimeState.taskHostRuntime?.supervisor,
      reporter,
      skillLoaderFactory,
      activeHookService,
      subagentModelCatalog,
      runtimeEnv,
      runtimeState.codeIntelligence,
      activeHookService
        ? async (profile) => {
            if (!profile.sourcePath || profile.hooks === undefined) return async () => undefined;
            return await runtimeState.activateComponentHookLease({
              kind: "agent",
              path: profile.sourcePath,
              componentId: profile.name,
              inlineHooks: profile.hooks,
              ...(profile.hookTrustAuthority ? { trustAuthority: profile.hookTrustAuthority } : {}),
            });
          }
        : undefined,
      options.approvedPlan
        ? createDelegatePlanStepCoordinator(() => planRegistryOptions!.coordinator())
        : undefined,
      hostKind,
    );
    if (backgroundPolicy) pruneRegistryToBackgroundAllowlist(registry, backgroundPolicy);
    dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));

    // Graph Mode 工具：每个会话最多持有一个活跃 graph，graphId 由 sessionId 派生。
    // add_work 声明意图并尝试派发；view_graph 只读投影；close_graph 收尾。
    // 派发回调封装 DelegationManager.dispatch + engine.runSub，复用与 delegate_task
    // 相同的子代理执行边界（沙箱、worktree、profile 全部由 registryFactory 提供）。
    if (session.runtimeEventStore && !backgroundPolicy && orchestrationMode() === "graph") {
      const graphStore = session.runtimeEventStore;
      const resolveGraphContext = (): GraphToolContext => ({
        store: graphStore,
        sessionId: session.id,
        graphId: runtimeState.graphContext.graphId,
        invocationId: currentRuntimeRun()?.invocationId ?? "graph-mode",
        runId: currentRuntimeRun()?.runId ?? "graph-mode",
        turnId: "graph-mode",
      });
      const graphDispatcher = async (input: {
        readonly workId: string;
        readonly instruction: string;
        readonly mode: "explore" | "worker";
      }): Promise<string | undefined> => {
        const normalized = normalizeDelegateTasks({
          goal: input.instruction,
          mode: input.mode,
          role: "leaf",
        });
        if (normalized.length === 0) return undefined;
        const task = normalized[0]!;
        const childRegistry = createSubagentRegistryFactory({
          workDir,
          runner: engine,
          manager: delegationManager,
          yoloSandbox: { config: picoConfig.sandbox },
          ownerSessionId: session.id,
          allowAsyncCompletion: !ownsRuntimeState,
          skillLoaderFactory,
          ...(activeHookService ? { hookService: activeHookService } : {}),
          ...(subagentModelCatalog ? { modelCatalog: subagentModelCatalog } : {}),
          ...(runtimeEnv ? { env: runtimeEnv } : {}),
          ...(runtimeState.codeIntelligence
            ? { codeIntelligence: runtimeState.codeIntelligence }
            : {}),
        })({ mode: task.mode, role: task.role, depth: 0, maxSpawnDepth: 0 });
        const dispatch = delegationManager.dispatch(
          async (signal) => {
            // graph work 的 child 同样过 turn 域容量闸：此处直接调 engine.runSub
            // （不经 delegate_task 工具路径），需自挂闸，与工具路径共享同一执行预算。
            const permit = await delegationManager.childRunLimiter.acquire(signal);
            try {
              const subResult = await engine.runSub(task.goal, childRegistry, undefined, {
                depth: 0,
                maxSpawnDepth: 0,
                role: task.role,
                ...(signal ? { signal } : {}),
              });
              const results = [
                {
                  taskIndex: 0,
                  status: subResult.status,
                  ...(subResult.summary ? { summary: subResult.summary } : {}),
                  ...(subResult.error !== undefined ? { error: subResult.error } : {}),
                  ...(subResult.evidenceRefs.length > 0
                    ? { evidenceRefs: [...subResult.evidenceRefs] }
                    : {}),
                  durationMs: 0,
                },
              ];
              return {
                results,
                status: aggregateDelegationStatus(results),
                totalDurationMs: 0,
              };
            } finally {
              permit.release();
            }
          },
          {
            completionPolicy: "optional",
            description: task.goal.slice(0, 120),
            ownerSessionId: session.id,
            graphWorkId: input.workId,
          },
        );
        if (dispatch.status !== "dispatched" || !dispatch.delegationId) return undefined;
        return dispatch.delegationId;
      };
      runtimeState.setGraphWorkDispatcher(graphDispatcher);
      registry.register(new AddWorkTool(resolveGraphContext(), graphDispatcher));
      registry.register(new ViewGraphTool(resolveGraphContext()));
      registry.register(new CloseGraphTool(resolveGraphContext()));
      toolDisclosure.discloseTools(["add_work", "view_graph", "close_graph"]);
    } else {
      runtimeState.setGraphWorkDispatcher(undefined);
    }

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
      toolDisclosure.discloseTools([...backgroundPolicy.allowedTools]);
    }
    if (effectiveOptions.allowedTools !== undefined) {
      const requiredControlTools = [
        ...(collaborationMode() === "plan" ? ["submit_plan"] : []),
        ...(options.approvedPlan ? ["update_plan", "cancel_plan"] : []),
      ];
      const commandAllowlist = [...effectiveOptions.allowedTools, ...requiredControlTools];
      pruneRegistryToCommandAllowlist(registry, commandAllowlist);
      // 命令级 allowlist 是宿主/请求方的显式选择——存活工具必须对模型可见，
      // 不能被渐进披露层藏掉（否则 headless/skill 激活场景下白名单里的
      // deferred 工具无激活路径，连接器又可能已被剪掉）。
      toolDisclosure.discloseTools(commandAllowlist);
      dependencies.toolStatusSink?.(toolStatusFromRegistry(registry));
    }

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
      resumeExistingSession,
      ...(dependencies.prestartedRun ? { prestartedRun: dependencies.prestartedRun } : {}),
      traceEnabled,
      options: {
        ...(effectiveOptions.rewindPrompt !== undefined
          ? { rewindPrompt: effectiveOptions.rewindPrompt }
          : {}),
        ...(effectiveOptions.rewindTranscriptIndex !== undefined
          ? { rewindTranscriptIndex: effectiveOptions.rewindTranscriptIndex }
          : {}),
        ...(effectiveOptions.rewindInteractionMode !== undefined
          ? { rewindInteractionMode: effectiveOptions.rewindInteractionMode }
          : {}),
        ...(effectiveOptions.rewindPrePlanMode !== undefined
          ? { rewindPrePlanMode: effectiveOptions.rewindPrePlanMode }
          : {}),
        ...(effectiveOptions.imagePath !== undefined
          ? { imagePath: effectiveOptions.imagePath }
          : {}),
        ...(effectiveOptions.images !== undefined ? { images: effectiveOptions.images } : {}),
      },
      ...(dependencies.signal ? { signal: dependencies.signal } : {}),
      ...(dependencies.onEvent ? { onEvent: dependencies.onEvent } : {}),
      ...(dependencies.rewindPointSink ? { rewindPointSink: dependencies.rewindPointSink } : {}),
      ...(memoryReviewScheduler ? { memoryReviewScheduler } : {}),
      ...(memoryReviewScheduler ? { memoryTriggerSlot } : {}),
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
        });
      },
    }).execute();
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
    // 阶段 5：只释放本次调用持有的资源。
    // 非 TUI 调用仍按轮关闭；TUI 注入的 manager 由宿主在退出时统一关闭。
    await cleanupScope.dispose();
  }
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
  planMode,
}: {
  sessionSelection: CliSessionSelection;
  workDir: string;
  picoHome: string;
  resumeExistingSession: boolean;
  planMode: boolean;
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
      planMode,
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
    planMode,
  }: {
    sessionSelection: CliSessionSelection;
    workDir: string;
    picoHome: string;
    resumeExistingSession: boolean;
    planMode: boolean;
  },
): Promise<SessionManagerLease> {
  let targetManifest = await runtimeEventStore.readSessionManifest(sessionSelection.sessionId);
  if (sessionSelection.mode === "fork" && sessionSelection.sourceSessionId) {
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
            targetMode: planMode ? "plan" : DEFAULT_INTERACTION_MODE,
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
    await runtimeStore.initializeSession({ sessionId: lease.session.id, workDir });
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
  yoloSandbox?: { config?: Partial<YoloSandboxConfig> },
  activateSkillHooks?: (skill: Skill) => void | Promise<void>,
  skillLoader?: SkillLoader,
  env?: NodeJS.ProcessEnv,
  bashTimeoutMs?: number,
  plan?: DefaultToolRegistryOptions["plan"],
  hostKind?: ToolHostKind,
  onToolGroupLoaded?: (groupId: string, toolNames: readonly string[]) => void,
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
    ...(yoloSandbox !== undefined ? { yoloSandbox } : {}),
    ...(activateSkillHooks !== undefined ? { activateSkillHooks } : {}),
    ...(skillLoader !== undefined ? { skillLoader } : {}),
    ...(plan !== undefined ? { plan } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(bashTimeoutMs !== undefined ? { bashTimeoutMs } : {}),
    ...(hostKind !== undefined ? { hostKind } : {}),
    ...(onToolGroupLoaded !== undefined ? { onToolGroupLoaded } : {}),
  });
}

async function prepareBackgroundExecution(
  execution: Extract<RuntimeExecution, { kind: "background" }>,
  workDir: string,
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies,
  picoHome: string,
): Promise<PreparedBackgroundYoloPolicy> {
  if (options.planMode === true) {
    throw new BackgroundPolicyViolationError("invalid_policy", "后台 YOLO 不支持 planMode。");
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
  return prepareBackgroundYoloPolicy({
    workDir,
    policy: execution.policy,
    trustStore:
      dependencies.backgroundTrustStore ??
      new WorkspaceTrustStore({ userStateDirectory: picoHome }),
  });
}

function pruneRegistryToBackgroundAllowlist(
  registry: ToolRegistry,
  policy: PreparedBackgroundYoloPolicy,
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

/** 加载原生 Profile 与 Claude 兼容输入合并后的统一 Agent 目录。 */
async function loadProfiles(
  workDir: string,
  options: {
    externalSources?: readonly AgentExternalCatalogSource[];
    includeClaudeProjectResources: boolean;
    includeClaudeUserResources: boolean;
    env: Readonly<Record<string, string | undefined>>;
    picoHome?: string;
  },
): Promise<AgentProfile[]> {
  try {
    return await loadAgentCatalog({ workDir, includeBuiltins: true, ...options });
  } catch {
    return [];
  }
}

function createDelegatePlanStepCoordinator(
  factory: () => PlanCoordinator,
): DelegatePlanStepCoordinator {
  return {
    async markStarted(stepId: string) {
      const coordinator = factory();
      const projection = await coordinator.project();
      const execution = projection.execution;
      if (!execution || execution.status !== "active") return;
      const step = execution.steps.find((s) => s.id === stepId);
      if (!step || step.status !== "pending") return;
      try {
        await coordinator.updateStep({
          operationId: `delegate-step-start:${stepId}:${Date.now()}`,
          expectedSessionSequence: projection.sessionSequence,
          planId: execution.planId,
          stepId,
          status: "in_progress",
        });
      } catch {
        // Dependency gating rejected the transition — silently skip
      }
    },
    async markSettled(stepId: string, completed: boolean) {
      const coordinator = factory();
      const projection = await coordinator.project();
      const execution = projection.execution;
      if (!execution || execution.status !== "active") return;
      const step = execution.steps.find((s) => s.id === stepId);
      if (!step || step.status !== "in_progress") return;
      try {
        await coordinator.updateStep({
          operationId: `delegate-step-settle:${stepId}:${Date.now()}`,
          expectedSessionSequence: projection.sessionSequence,
          planId: execution.planId,
          stepId,
          status: completed ? "completed" : "pending",
        });
      } catch {
        // CAS conflict or state changed — best-effort, don't hide delegation result
      }
    },
  };
}

function registerDelegationTools(
  registry: ToolRegistry,
  engine: AgentEngine,
  workDir: string,
  profiles: AgentProfile[],
  manager: DelegationManager,
  workspaceRoots: WorkspaceRoots,
  yoloSandbox: { config?: Partial<YoloSandboxConfig> },
  ownerSessionId: string,
  allowAsyncCompletion: boolean,
  worktreeSupervisor?: WorktreeSupervisor,
  reporter?: Reporter,
  skillLoaderFactory?: (workDir: string) => SkillLoader,
  hookService?: HookService,
  modelCatalog?: SubagentModelCatalog,
  env?: Readonly<Record<string, string | undefined>>,
  codeIntelligence?: SessionRuntime["codeIntelligence"],
  activateAgentHooks?: (profile: AgentProfile) => Promise<() => void | Promise<void>>,
  planStepCoordinator?: DelegatePlanStepCoordinator,
  hostKind: ToolHostKind = "desktop",
): void {
  const registryFactory = createSubagentRegistryFactory({
    workDir,
    workspaceRoots,
    runner: engine,
    manager,
    yoloSandbox,
    ownerSessionId,
    allowAsyncCompletion,
    ...(skillLoaderFactory ? { skillLoaderFactory } : {}),
    ...(hookService ? { hookService } : {}),
    ...(modelCatalog ? { modelCatalog } : {}),
    ...(env ? { env } : {}),
    ...(codeIntelligence ? { codeIntelligence } : {}),
    ...(activateAgentHooks ? { activateAgentHooks } : {}),
    ...(worktreeSupervisor ? { worktreeSupervisor } : {}),
    ...(profiles.length > 0 ? { profiles } : {}),
  });
  const delegateTaskOptions = {
    workDir,
    ...(profiles.length > 0 ? { profiles } : {}),
    ...(worktreeSupervisor ? { worktreeSupervisor } : {}),
    ...(reporter ? { reporter } : {}),
    ownerSessionId,
    allowAsyncCompletion,
    ...(activateAgentHooks ? { activateAgentHooks } : {}),
    ...(hookService ? { hookService } : {}),
    ...(modelCatalog ? { modelCatalog } : {}),
    ...(planStepCoordinator ? { planStepCoordinator } : {}),
  };
  // 委派工具走 surface 亲和性声明：background/headless 宿主不注册
  // （原 UNSAFE_BACKGROUND_TOOLS / HEADLESS_TOOL_NAMES 的注册侧防线）。
  if (isToolSupportedForHost("delegate_task", hostKind)) {
    registry.register(new DelegateTaskTool(engine, registryFactory, manager, delegateTaskOptions));
  }
  if (isToolSupportedForHost("delegate_status", hostKind)) {
    registry.register(new DelegateStatusTool(manager));
  }
  if (isToolSupportedForHost("spawn_subagent", hostKind)) {
    registry.register(
      new SpawnSubagentTool(
        engine,
        registryFactory({ mode: "explore", role: "leaf", depth: 0, maxSpawnDepth: 1 }),
        // 按调用时取 manager 当前 turn 实例（turn 重置会换实例，构造期捕获会失效）。
        { childRunLimiter: () => manager.childRunLimiter },
      ),
    );
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

/** Hook verifier 的所有模型调用都显式覆盖为 purpose=hook。 */
function hookPurposeProvider(provider: LLMProvider): LLMProvider {
  return {
    ...(provider.modelName ? { modelName: provider.modelName } : {}),
    get requestCapabilities() {
      return provider.requestCapabilities;
    },
    generate: (messages, tools, options) =>
      provider.generate(messages, tools, { ...options, purpose: "hook" }),
    ...(provider.generateStream
      ? {
          generateStream: (messages, tools, onDelta, options) =>
            provider.generateStream!(messages, tools, onDelta, {
              ...options,
              purpose: "hook",
            }),
        }
      : {}),
  };
}

async function runHostOwnedRuntimeOperation<Result>(
  session: Session,
  execute: () => Promise<Result>,
  signal: AbortSignal,
): Promise<Result> {
  const ambient = currentRuntimeRun();
  if (ambient) {
    if (!ambient.claimsSession(session) || ambient.runtimeEventWriteGuard !== session) {
      throw new Error(
        `Hook model handler cannot reuse RuntimeRun ${ambient.runId} for Session ${session.id}`,
      );
    }
    return execute();
  }

  return session.serialize(async () => {
    const runtimeCapability = session.runtimeEventCapability;
    if (!runtimeCapability) {
      throw new Error(`Hook model handler requires a durable Session: ${session.id}`);
    }
    await RuntimeRun.reconcileIncompleteRuns({
      capability: runtimeCapability,
    });
    await RuntimeRun.repairSessionProjection(session, {
      capability: runtimeCapability,
    });
    const runtimeRun = await RuntimeRun.start({
      capability: runtimeCapability,
    });
    return runtimeRun.run(execute, signal);
  });
}

function activeRouteModelRouter(
  kind: ProviderKind,
  config: ProviderConfig,
  routeId: string,
): ModelRouter {
  const apiKeyEnv = "PICO_ACTIVE_MODEL_API_KEY";
  return new ModelRouter(
    [
      {
        id: routeId,
        providerId: routeId.split("/", 1)[0] || "active",
        provider: kind,
        model: config.model,
        baseURL: config.baseURL,
        apiKeyEnv,
        source: "config",
        capabilities:
          config.capabilities ??
          resolveModelRouteCapabilities(kind, config.model, undefined, {
            baseURL: config.baseURL,
          }),
      },
    ],
    { [apiKeyEnv]: config.apiKey },
    routeId,
  );
}

export function buildApprovalMiddleware(
  notifier: ApprovalNotifier,
  workDir: string,
  signal?: AbortSignal,
  approvalManager: ApprovalManager = globalApprovalManager,
  settings?: Pick<SessionSettings, "sessionId" | "mode"> &
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
  settings?: Pick<SessionSettings, "mode">,
  workspaceRoots?: WorkspaceRoots,
  denialSink?: (event: RuntimePolicyDenial) => void,
  collaborationMode?: () => "agent" | "plan",
): MiddlewareFunc {
  return async (call) => {
    const mode = collaborationMode?.() ?? (settings?.mode === "plan" ? "plan" : "agent");
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
  settings?: Pick<SessionSettings, "sessionId" | "mode"> &
    Partial<Pick<SessionSettings, "additionalDirectories">>,
  workspaceRoots?: WorkspaceRoots,
  hookService?: HookService,
  picoHome?: string,
  denialSink?: (event: RuntimePolicyDenial) => void,
  permissionMode?: () => "default" | "auto" | "yolo",
): MiddlewareFunc {
  return async (call, context) => {
    const mode =
      permissionMode?.() ?? (settings?.mode === "plan" ? "default" : (settings?.mode ?? "default"));
    const sessionId = settings?.sessionId ?? "cli";
    const workspaceAccesses = workspaceAccessesFromCall(call);

    // 主 TUI 的 YOLO 是全程放权：普通工具不审批，也不施加工作区、网络或
    // 敏感写沙箱。直接文件工具仍需给自身的 WorkspaceRoots 一次性通行证；
    // worker 使用独立 registry/worktree，继续保留显式沙箱隔离。
    if (mode === "yolo" && context?.forceApproval !== true) {
      if (workspaceRoots) {
        for (const access of workspaceAccesses) workspaceRoots.authorizeOnce(access.path);
      }
      return { allowed: true, reason: "YOLO 模式全程放行" };
    }

    const externalAccesses = workspaceRoots
      ? workspaceAccesses.filter((access) => !workspaceRoots.isAllowedPath(access.path))
      : [];
    const externalDirectories = workspaceRoots
      ? await externalAuthorizationDirectories(externalAccesses, workspaceRoots)
      : [];
    const safetyPath = bypassImmuneSafetyPath(call, workDir, workspaceRoots);
    const hasSessionGrant = globalSessionPermissionGrants.allows(
      sessionId,
      call,
      workDir,
      workspaceRoots,
      picoHome,
    );
    const hasExplicitSafetyGrant = globalSessionPermissionGrants.allowsSafetyOverride(
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

    const needsApproval =
      context?.forceApproval === true ||
      safetyPath !== undefined ||
      externalDirectories.length > 0 ||
      bashNeedsApproval(call) ||
      isMcpToolName(call.name) ||
      (mode === "default" && isAgentOpsDangerousCommand(call.name, call.arguments)) ||
      (mode === "auto" && isDangerousCommand(call.name, call.arguments));
    if (!needsApproval) return { allowed: true, reason: `${mode} 模式自动放行` };

    if (hookService) {
      const hookDecision = await hookService.dispatch(
        "PermissionRequest",
        {
          tool_name: call.name,
          tool_input: parseHookToolInput(call.arguments),
          tool_call_id: call.id,
          reason: "工具调用需要交互审批",
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
        { sessionScope: scope, providerCallId: call.id },
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

    if (result.allowForSession) {
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
    } else {
      for (const access of externalAccesses) workspaceRoots.authorizeOnce(access.path);
    }
    return result;
  };
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
      .filter((access) => !workspaceRoots.isAllowedPath(access.path))
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

function bashNeedsApproval(call: { name: string; arguments: string }): boolean {
  if (call.name !== "bash") return false;
  const command = parseJsonStringField(call.arguments, "command");
  if (command === undefined) return true;
  // 只读判定按宿主方言分派;方言无法解析时按需审批 fail-closed
  try {
    return hostShellDialect() === "powershell"
      ? classifyPowerShellCommand(command).kind !== "read-only"
      : classifyBashCommand(command).kind !== "read-only";
  } catch {
    return true;
  }
}

function parseJsonStringField(args: string, field: string): string | undefined {
  try {
    const parsed = JSON.parse(args) as Record<string, unknown>;
    const value = parsed[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
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
  const apiKey = options.apiKey;
  const model = options.model ?? defaultModel(options.provider ?? "openai");

  if (!allowMissingNetworkConfig && (!baseURL || !apiKey)) {
    throw new Error("缺少 Provider 配置:宿主必须从用户模型路由注入 baseURL 和 apiKey");
  }

  return {
    baseURL: baseURL ?? "",
    apiKey: apiKey ?? "",
    model,
    ...(options.modelRouteId ? { routeId: options.modelRouteId } : {}),
    ...(options.modelCapabilities ? { capabilities: options.modelCapabilities } : {}),
    ...(options.thinkingEffort !== undefined ? { thinkingEffort: options.thinkingEffort } : {}),
  };
}

/**
 * @deprecated Compatibility helper for explicit test/host assembly. Production Runtime no longer
 * calls it or derives a model route from bare LLM environment variables.
 */
export function createRuntimeCredentialPool(env: RunAgentEnv): CredentialPool | undefined {
  const keys = env.LLM_API_KEYS?.split(",")
    .map((key) => key.trim())
    .filter(Boolean);
  return keys && keys.length > 1 ? new CredentialPool(keys) : undefined;
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
    case "openai":
      return "glm-5.2";
    case "claude":
      return "claude-3-5-sonnet";
  }
}

function isTruthyEnv(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true" || value?.toLowerCase() === "on";
}
