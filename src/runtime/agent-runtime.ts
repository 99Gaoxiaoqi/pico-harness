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
import { EvidenceArchive, formatEvidenceUri } from "../context/evidence-archive.js";
import {
  createContextBudget,
  estimateTokenBudgetAsChars,
  type ContextBudget,
} from "../context/context-budget.js";
import { PromptComposer } from "../context/composer.js";
import type { TodoStore } from "../context/todo-store.js";
import { SkillLoader, type Skill } from "../context/skill.js";
import { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  createProvider,
  createRawProvider,
  type ProviderKind,
  type ProviderRuntimeDependencies,
} from "../provider/factory.js";
import { PromptCachePrewarmCoordinator } from "../provider/prompt-cache-prewarm.js";
import { ContextOverflowError, isAbortError } from "../provider/errors.js";
import type { ProviderConfig } from "../provider/config.js";
import { resolveAuxProviderConfig } from "../provider/aux-provider.js";
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
import { DelegationManager, DelegateStatusTool } from "../tools/delegation-manager.js";
import { createSubagentRegistryFactory } from "../tools/delegation-registry.js";
import type { AgentProfile } from "../tools/agent-profile.js";
import { loadAgentCatalog, type AgentExternalCatalogSource } from "../agents/catalog.js";
import {
  DelegateTaskTool,
  SpawnSubagentTool,
  type SubagentModelSelectionRequest,
  type SubagentReportEvidenceWriter,
} from "../tools/subagent.js";
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
import { RuntimeStore } from "../tasks/runtime-store.js";
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
import { RuntimeEventStore } from "../storage/runtime-event-store.js";
import { currentRuntimeRun, isRuntimeRunLive, RuntimeRun } from "./runtime-run.js";
import { PlanCoordinator } from "../plan/coordinator.js";
import { DiscoveryCoordinator } from "../discovery/coordinator.js";
import {
  DISCOVERY_MAX_CANDIDATES,
  type DiscoveryCandidate,
  type DiscoveryPhase,
} from "../discovery/contract.js";
import { DISCOVERY_TOOL_NAMES } from "../tools/discovery.js";
import type { ToolCall } from "../schema/message.js";
import type { ToolResultEnvelope } from "../engine/tool-result-contract.js";
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
import { MemoryRepository } from "../memory/memory-repository.js";
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
    const store = new RuntimeEventStore({
      storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
    });
    try {
      return await reconcileOrphanedPlanExecution(store, input.sessionId);
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
    "每完成或跳过一步，必须调用 update_plan 持久化步骤状态；需要停止执行时调用 cancel_plan。",
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
    "每完成或跳过一步，必须调用 update_plan；需要停止时调用 cancel_plan。",
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
  store: RuntimeEventStore,
  sessionId: string,
): Promise<PlanProjection> {
  const entries = await store.readSessionEntries(sessionId);
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
  const defaultConfigModel = options.model ?? runtimeEnv.LLM_MODEL ?? defaultModel(kind);

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
  let ownedUsageStore: RuntimeStore | undefined;
  let ownsMcpManager = false;
  let cleanupMcpManager: McpConnectionManager | undefined;
  let memoryRepository: MemoryRepository | undefined;
  let memoryContextBuilder: MemoryContextBuilder | undefined;
  let memoryReviewScheduler: MemoryReviewSchedulerPort | undefined;
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
          memoryRepository = new MemoryRepository({
            storageRoot: memoryPaths.workspace.memory,
            workspaceId: memoryPaths.workspace.id,
          });
          memoryContextBuilder = new MemoryContextBuilder(memoryRepository);
          const memorySettings = memoryRepository.getSettings();
          if (memorySettings.enabled && memorySettings.autoPropose) {
            memoryReviewScheduler = {
              enqueue: (input) => {
                // This callback runs in RuntimeRunExecutor's detached host task, after the
                // foreground result is available. Own the connection so AgentRuntime cleanup
                // cannot close it before the durable enqueue begins.
                const schedulerRepository = new MemoryRepository({
                  storageRoot: memoryPaths.workspace.memory,
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
      runtimeEnv,
      dependencies.provider !== undefined,
    );
    const credentialPool =
      effectiveOptions.apiKey === undefined && dependencies.provider === undefined
        ? createRuntimeCredentialPool(runtimeEnv)
        : undefined;
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
    const runtimeState =
      dependencies.runtimeState ??
      (await createSessionRuntime({
        session,
        sessionLease,
        env: runtimeEnv,
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
    if (!runtimeState.taskHostRuntime) {
      try {
        ownedUsageStore = new RuntimeStore({
          workDir,
          picoHome,
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
    const evidenceBaseDir = workspaceStatePaths.evidence;
    const evidenceArchive = new EvidenceArchive({ baseDir: evidenceBaseDir });
    const subagentReportEvidenceWriter = buildSubagentReportEvidenceWriter(
      session.id,
      evidenceArchive,
    );
    // 凭证轮换(4.2):多 key 时从池取首个 key 覆盖 config.apiKey,并构建轮换回调。
    // 单 key / 注入 provider 时跳过(向后兼容)。pool 注入点集中在此,便于追踪 currentKey。
    let currentConfig: ProviderConfig = providerConfig;
    if (credentialPool && credentialPool.size > 1 && dependencies.provider === undefined) {
      currentConfig = { ...providerConfig, apiKey: credentialPool.getNext() };
    }
    const providerDependencies: ProviderRuntimeDependencies = {
      promptCachePrewarm: PromptCachePrewarmCoordinator.shared(workspaceStatePaths.control),
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
      providerDependencies,
      ...(credentialPool ? { credentialPool } : {}),
    });
    const trackedProvider = providerAssembly.provider;
    const rebuildProvider = providerAssembly.rebuildProvider;
    const memoryModelFactory =
      dependencies.memoryProposalModelFactory ??
      (dependencies.provider === undefined
        ? async () => {
            const ledger = new RuntimeStore({ workDir, picoHome });
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
              memoryStorageRoot: memoryPaths.workspace.memory,
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
            runtimeEvidenceArchive: evidenceArchive,
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
            evidenceBaseDir,
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
      toolDisclosure.disclose(["update_plan", "cancel_plan"]);
    }
    if (!backgroundPolicy) {
      toolDisclosure.disclose([...DISCOVERY_TOOL_NAMES]);
    }
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
    const discoveryRegistryOptions: DefaultToolRegistryOptions["discovery"] | undefined =
      backgroundPolicy
        ? undefined
        : {
            coordinator: () => {
              const run = currentRuntimeRun();
              if (!run || !session.runtimeEventStore) {
                throw new Error("Discovery requires an active durable RuntimeRun");
              }
              return new DiscoveryCoordinator(session.runtimeEventStore, {
                sessionId: session.id,
                invocationId: run.invocationId,
                runId: run.runId,
                turnId: `turn:${run.runId}:discovery`,
              });
            },
          };
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
      evidenceBaseDir,
      runtimeEnv,
      dependencies.bashTimeoutMs,
      collaborationMode() === "plan" || options.approvedPlan ? planRegistryOptions : undefined,
      discoveryRegistryOptions,
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
    // 辅助(廉价)模型:用于 FullCompactor 生成摘要,省主模型成本。
    // 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 才启用;缺则用主 provider。
    const auxProvider = loadAuxProvider(runtimeEnv, session, trackerOptions, providerDecorator);
    const reporter = dependencies.reporter ?? new TerminalReporter();
    const automaticDiscovery = discoveryRegistryOptions
      ? createAutomaticDiscoveryTracker({
          coordinator: discoveryRegistryOptions.coordinator,
          objective: prompt,
          autoStart: collaborationMode() === "plan",
        })
      : undefined;
    if (automaticDiscovery) {
      registry.useExecution(async (call, next) => {
        if (call.name === "submit_plan") await automaticDiscovery.prepareForCompletion();
        return next(call);
      });
    }
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
      // 优先用辅助廉价模型(AUX_LLM_*)生成摘要省主模型成本;未配置则用主 provider。
      fullCompactor: new FullCompactor({
        provider: trackedProvider,
        workDir,
        ...(auxProvider ? { auxProvider } : {}),
        ...(activeHookService ? { hookService: activeHookService } : {}),
      }),
      runtimeEvidenceArchive: evidenceArchive,
      subagentReportEvidenceWriter,
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
        : automaticDiscovery
          ? { postToolResultHook: automaticDiscovery.onToolResult }
          : {}),
      ...(automaticDiscovery ? { onRunComplete: automaticDiscovery.complete } : {}),
      skillLoaderFactory,
      ...(rebuildProvider ? { rebuildProvider } : {}),
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
      evidenceBaseDir,
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
    );
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
    }
    if (effectiveOptions.allowedTools !== undefined) {
      const requiredControlTools = [
        ...(collaborationMode() === "plan" ? ["submit_plan"] : []),
        ...(options.approvedPlan ? ["update_plan", "cancel_plan"] : []),
      ];
      pruneRegistryToCommandAllowlist(registry, [
        ...effectiveOptions.allowedTools,
        ...requiredControlTools,
      ]);
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
  const runtimeEventStore = new RuntimeEventStore({
    storageRoot: resolvePicoPaths(workDir, { picoHome }).workspace.root,
  });
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
        await new SessionForkService({
          workDir,
          picoHome,
          runtimePort: createSessionForkRuntimePort(),
        }).fork({
          sourceSessionId: sessionSelection.sourceSessionId,
          targetSessionId: sessionSelection.sessionId,
          targetMode: planMode ? "plan" : DEFAULT_INTERACTION_MODE,
        });
        targetManifest = await runtimeEventStore.readSessionManifest(sessionSelection.sessionId);
      } finally {
        sourceLease.release();
      }
    }
    const forkEvent = (await runtimeEventStore.readSession(sessionSelection.sessionId)).findLast(
      (event) => event.kind === "session.forked",
    );
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
  evidenceBaseDir?: string,
  env?: NodeJS.ProcessEnv,
  bashTimeoutMs?: number,
  plan?: DefaultToolRegistryOptions["plan"],
  discovery?: DefaultToolRegistryOptions["discovery"],
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
    ...(discovery !== undefined ? { discovery } : {}),
    ...(evidenceBaseDir !== undefined ? { evidenceBaseDir } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(bashTimeoutMs !== undefined ? { bashTimeoutMs } : {}),
  });
}

const AUTOMATIC_DISCOVERY_TOOLS = new Set([
  "read_file",
  "read_evidence",
  "glob",
  "grep",
  "repo_map",
  "code_definition",
  "code_references",
  "code_symbols",
  "code_diagnostics",
  "code_call_hierarchy",
]);

interface AutomaticDiscoveryTracker {
  readonly onToolResult: (call: ToolCall, result: ToolResultEnvelope) => Promise<void>;
  readonly prepareForCompletion: () => Promise<void>;
  readonly complete: () => Promise<void>;
}

function createAutomaticDiscoveryTracker(input: {
  readonly coordinator: () => DiscoveryCoordinator;
  readonly objective: string;
  readonly autoStart: boolean;
}): AutomaticDiscoveryTracker {
  const discoveryId = `auto-discovery:${randomUUID()}`;
  const completionKey = randomUUID();

  const prepareForCompletion = async (): Promise<void> => {
    const coordinator = input.coordinator();
    const projection = await coordinator.project();
    const active = projection.active;
    if (!active || active.evidenceRefs.length === 0 || active.phase === "verify") return;
    await coordinator.checkpoint({
      operationId: `auto-discovery:verify:${completionKey}`,
      expectedSessionSequence: projection.sessionSequence,
      discoveryId: active.discoveryId,
      checkpoint: {
        phase: "verify",
        cycle: active.cycle,
        candidates: [],
        evidenceRefs: [],
        hypotheses: [],
        openQuestions: [],
        toolCallsUsed: 0,
        inspectedFiles: [],
      },
    });
  };

  return {
    async onToolResult(call, result) {
      if (result.status !== "succeeded" || !AUTOMATIC_DISCOVERY_TOOLS.has(call.name)) return;
      const coordinator = input.coordinator();
      let projection = await coordinator.project();
      if (!projection.active) {
        if (!input.autoStart) return;
        projection = await coordinator.start({
          operationId: `auto-discovery:start:${call.id}`,
          expectedSessionSequence: projection.sessionSequence,
          discoveryId,
          objective: boundedDiscoveryText(input.objective),
          depth: "balanced",
          roots: ["."],
        });
      }
      const active = projection.active;
      if (!active) return;

      const evidenceRef =
        result.evidence?.uri ??
        `runtime://tool-result/${encodeURIComponent(call.id)}?sha256=${result.sha256}`;
      const candidates = discoveryCandidatesFromToolResult(call, result, evidenceRef);
      const remainingFiles = Math.max(0, active.budget.maxFiles - active.budget.consumedFiles);
      const inspectedFiles = candidates
        .map((candidate) => candidate.path)
        .filter((path) => !active.inspectedFiles.includes(path))
        .slice(0, remainingFiles);
      const phase = automaticDiscoveryPhase(active.phase, call.name);
      await coordinator.checkpoint({
        operationId: `auto-discovery:checkpoint:${call.id}`,
        expectedSessionSequence: projection.sessionSequence,
        discoveryId: active.discoveryId,
        checkpoint: {
          phase,
          cycle: active.cycle,
          candidates,
          evidenceRefs: [evidenceRef],
          hypotheses: [],
          openQuestions: phase === "verify" ? [] : ["需要读取候选目标以确认实现位置"],
          toolCallsUsed: 1,
          inspectedFiles,
        },
      });
    },
    prepareForCompletion,
    async complete() {
      await prepareForCompletion();
      const coordinator = input.coordinator();
      const projection = await coordinator.project();
      const active = projection.active;
      if (!active || active.phase !== "verify" || active.evidenceRefs.length === 0) return;
      await coordinator.complete({
        operationId: `auto-discovery:complete:${completionKey}`,
        expectedSessionSequence: projection.sessionSequence,
        discoveryId: active.discoveryId,
        report: {
          summary: `已基于 ${active.budget.consumedToolCalls} 次成功的只读调查完成目标定位。`,
          confirmedTargets: active.candidates,
          evidenceRefs: active.evidenceRefs,
          remainingRisks:
            active.candidates.length > 0 ? [] : ["调查已形成直接证据，但未提取到明确文件候选。"],
        },
      });
    },
  };
}

function automaticDiscoveryPhase(current: DiscoveryPhase, toolName: string): DiscoveryPhase {
  if (current === "verify" || toolName === "read_file" || toolName === "read_evidence") {
    return "verify";
  }
  if (current === "forage") return "focus";
  return "deepen";
}

function discoveryCandidatesFromToolResult(
  call: ToolCall,
  result: ToolResultEnvelope,
  evidenceRef: string,
): DiscoveryCandidate[] {
  const paths = new Map<string, { score: number; reasons: string[] }>();
  const toolInput = parseToolObject(call.arguments);
  const directPath =
    typeof toolInput["file_path"] === "string"
      ? toolInput["file_path"]
      : typeof toolInput["path"] === "string" && call.name === "read_file"
        ? toolInput["path"]
        : undefined;
  if (directPath?.trim()) {
    paths.set(directPath.trim(), { score: 100, reasons: [`${call.name}:direct_target`] });
  }

  for (const line of result.projection.text.split(/\r?\n/u)) {
    const candidate = discoveryCandidateLine(call.name, line);
    if (!candidate || paths.has(candidate.path)) continue;
    paths.set(candidate.path, { score: candidate.score, reasons: candidate.reasons });
    if (paths.size >= DISCOVERY_MAX_CANDIDATES) break;
  }

  return [...paths.entries()]
    .map(([candidatePath, metadata]) => ({
      path: candidatePath,
      score: metadata.score,
      reasons: metadata.reasons,
      evidenceRefs: [evidenceRef],
    }))
    .sort((left, right) => right.score - left.score || left.path.localeCompare(right.path))
    .slice(0, DISCOVERY_MAX_CANDIDATES);
}

function discoveryCandidateLine(
  toolName: string,
  line: string,
): { readonly path: string; readonly score: number; readonly reasons: string[] } | undefined {
  if (toolName === "repo_map") {
    const match = /^(.+?) score=(-?\d+(?:\.\d+)?) reasons=([^:]*)/u.exec(line);
    const candidatePath = match?.[1]?.trim();
    if (!candidatePath) return undefined;
    return {
      path: candidatePath,
      score: Number(match?.[2] ?? 0),
      reasons: (match?.[3] ?? "repo_map")
        .split(",")
        .map((reason) => `repo_map:${reason.trim()}`)
        .filter((reason) => reason !== "repo_map:"),
    };
  }
  if (toolName === "grep") {
    const match = /^(.+?):\d+:/u.exec(line);
    return match?.[1] ? { path: match[1], score: 80, reasons: ["grep:content_match"] } : undefined;
  }
  if (toolName === "glob" && line && !line.startsWith("...") && !line.startsWith("未找到")) {
    return { path: line, score: 70, reasons: ["glob:path_match"] };
  }
  return undefined;
}

function parseToolObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function boundedDiscoveryText(value: string): string {
  const normalized = value.trim();
  return normalized.length <= 4_000 ? normalized : `${normalized.slice(0, 3_999)}…`;
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
  evidenceBaseDir?: string,
  env?: Readonly<Record<string, string | undefined>>,
  codeIntelligence?: SessionRuntime["codeIntelligence"],
  activateAgentHooks?: (profile: AgentProfile) => Promise<() => void | Promise<void>>,
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
    ...(evidenceBaseDir ? { evidenceBaseDir } : {}),
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
  };
  registry.register(new DelegateTaskTool(engine, registryFactory, manager, delegateTaskOptions));
  registry.register(new DelegateStatusTool(manager));
  registry.register(
    new SpawnSubagentTool(
      engine,
      registryFactory({ mode: "explore", role: "leaf", depth: 0, maxSpawnDepth: 1 }),
    ),
  );
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

/**
 * 加载辅助(廉价)模型 provider,供 FullCompactor 生成摘要。
 * 配齐 AUX_LLM_BASE_URL / AUX_LLM_API_KEY / AUX_LLM_MODEL 三项才启用;
 * 缺任意一项则返回 undefined(FullCompactor 回退到主 provider)。
 */
function loadAuxProvider(
  env: RunAgentEnv,
  session: Session,
  trackerOptions: CostTrackerOptions,
  decorateProvider: (provider: LLMProvider) => LLMProvider,
): LLMProvider | undefined {
  const resolved = resolveAuxProviderConfig(env);
  if (!resolved) return undefined;
  return new CostTracker(
    decorateProvider(createProvider(resolved.kind, resolved.config)),
    billingRouteForProvider(resolved.kind, resolved.config),
    session,
    trackerOptions,
  );
}

function buildSubagentReportEvidenceWriter(
  sessionId: string,
  archive: EvidenceArchive,
): SubagentReportEvidenceWriter {
  return async (input) => {
    const reference = await archive.archiveSubagentReport({
      sessionId,
      taskPrompt: input.taskPrompt,
      report: input.report,
      status: input.status,
    });
    return formatEvidenceUri(reference);
  };
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
    (call.name === "read_file" || call.name === "grep") &&
    bypassImmuneSafetyPath(call, workDir, workspaceRoots) !== undefined
  ) {
    return "Plan Mode 守卫：密钥与凭据文件不属于计划阶段的可读边界。";
  }
  return undefined;
}

function bashNeedsApproval(call: { name: string; arguments: string }): boolean {
  if (call.name !== "bash") return false;
  const command = parseJsonStringField(call.arguments, "command");
  return command === undefined || classifyBashCommand(command).kind !== "read-only";
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
  env: RunAgentEnv,
  allowMissingNetworkConfig: boolean,
): ProviderConfig {
  const baseURL = options.baseURL ?? env.LLM_BASE_URL;
  const apiKey = options.apiKey ?? firstApiKey(env.LLM_API_KEYS) ?? env.LLM_API_KEY;
  const model = options.model ?? env.LLM_MODEL ?? defaultModel(options.provider ?? "openai");

  if (!allowMissingNetworkConfig && (!baseURL || !apiKey)) {
    throw new Error("缺少 Provider 配置:请提供 LLM_BASE_URL / LLM_API_KEY 或对应 CLI 参数");
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

function firstApiKey(value: string | undefined): string | undefined {
  return value
    ?.split(",")
    .map((key) => key.trim())
    .find(Boolean);
}

/** @internal Pure runtime-env boundary used by executeAgentRuntime. */
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
