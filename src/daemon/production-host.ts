import { createHash } from "node:crypto";
import { join } from "node:path";
import { createCliSessionId } from "../cli/session-resolver.js";
import { globalSessionManager } from "../engine/session.js";
import {
  AgentRuntime,
  type RunAgentCliResult,
  type RuntimeSessionResourceChangedNotice,
} from "../runtime/agent-runtime.js";
import { currentRuntimeRun } from "../runtime/runtime-run.js";
import type { PlanHandoff } from "../engine/plan-handoff.js";
import { PlanCoordinator } from "../plan/coordinator.js";
import type { PlanProjection } from "../plan/contract.js";
import { createEngineRuntimePort } from "../runtime/engine-runtime-port-adapter.js";
import type { MemoryProposalPublishedNotice } from "../memory/worker.js";
import { createSessionRuntime } from "../runtime/session-runtime.js";
import { SilentReporter } from "../engine/reporter.js";
import { loadPicoConfig } from "../input/pico-config.js";
import { EffectiveConfigResolver } from "../input/effective-config.js";
import { UserConfigStore } from "../input/user-config-store.js";
import { resolveTrustedEffectiveMcpSources } from "../mcp/effective-config.js";
import { UserMcpConfigStore } from "../mcp/user-config-store.js";
import {
  assertCredentialRefMatchesProvider,
  assertCredentialRefMatchesModelRoute,
  credentialRefForProvider,
  credentialRefForModelRoute,
  createPlatformCredentialVault,
  normalizeProviderEndpoint,
  parseAnyCredentialRef,
  type CredentialVault,
} from "../provider/credential-vault.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";
import { loadEffectiveModelRuntime } from "../provider/effective-model-runtime.js";
import type { ProviderKind } from "../provider/factory.js";
import { logger } from "../observability/logger.js";
import { resolvePicoHome } from "../paths/pico-paths.js";
import { coordinateReasoningLevel } from "../provider/reasoning-capability.js";
import {
  BACKGROUND_HARDLINE_VERSION,
  BACKGROUND_HOOK_VERSION,
  prepareBackgroundYoloPolicy,
} from "../safety/background-yolo-policy.js";
import { WorkspaceTrustStore } from "../security/workspace-trust.js";
import type { CronJobRecord, CronRunRecord } from "../tasks/runtime-types.js";
import { createCronWorkspaceRuntimeFactory } from "./cron-workspace-runtime.js";
import {
  DesktopInteractionBroker,
  DesktopInteractionVersionConflictError,
  type DesktopInteractionEvent,
} from "./desktop-interaction-broker.js";
import { FileDesktopInteractionStore } from "./desktop-interaction-store.js";
import { DesktopReporter, type DesktopReporterEvent } from "./desktop-reporter.js";
import type { SessionSubscriptionRegistry } from "./session-subscription-owner.js";
import { PersistentActiveOverlay } from "./session-active-overlay.js";
import { DesktopRuntimeService } from "./desktop-runtime-service.js";
import { DesktopAutomationService } from "./desktop-automation-service.js";
import { buildApprovalRequestedPayload } from "./approval-wire.js";
import {
  createRuntimeNotification,
  isJsonObject,
  isJsonValue,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonObject,
} from "./protocol.js";
import { LocalDaemonHost } from "./runtime-host.js";
import { canonicalizeWorkspacePath } from "./workspace-registry.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { WorkspaceRuntimeService } from "./workspace-runtime-service.js";
import { BrowserAgentCommandBroker } from "./browser-agent-command-broker.js";
import { PluginRuntimeSnapshotRegistry } from "../plugins/plugin-runtime-snapshot-registry.js";
import {
  createBuiltinPluginCapabilityRegistry,
  type PluginCapabilityRegistry,
} from "../plugins/plugin-capability.js";

export interface ProductionLocalDaemonHostOptions {
  registrationStore?: WorkspaceRegistrationStore;
  trustStore?: WorkspaceTrustStore;
  agentRuntime?: AgentRuntime;
  credentialVault?: CredentialVault;
  userConfigStore?: UserConfigStore;
  userMcpConfigStore?: UserMcpConfigStore;
  effectiveConfigResolver?: EffectiveConfigResolver;
  /** Host-owned registry shared by Desktop catalog and AgentRuntime activation. */
  pluginRuntimeSnapshotRegistry?: PluginRuntimeSnapshotRegistry;
  /** Optional host-owned, restricted Provider/Tool capability factories. */
  pluginCapabilityRegistry?: PluginCapabilityRegistry;
  /** Whether the production host releases an injected plugin registry on close. */
  ownsPluginRuntimeSnapshotRegistry?: boolean;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Production-safe assembly. Cron remains the only autonomous source. Authenticated
 * run.start is foreground-only: it requires a trusted workspace and retains approval/
 * AskUser boundaries owned by this daemon.
 */

/**
 * Host lifecycle surface the assembled automations service needs. Bound late by
 * createProductionLocalDaemonHost because the LocalDaemonHost instance is created
 * after the services (the old single-function scope closed over it implicitly).
 */
export interface ProductionHostControl {
  readonly status: "stopped" | "starting" | "running" | "stopping";
  refreshRegisteredWorkspaces(): Promise<void>;
  readonly registeredWorkspaces: readonly string[];
  runCronJobNow(workspacePath: string, cronJobId: string): Promise<CronRunRecord>;
}

/** The assembled control-plane services + the closures the host lifecycle needs. */
export interface ProductionRuntimeServices {
  readonly service: WorkspaceRuntimeService;
  readonly desktopService: DesktopRuntimeService;
  readonly registrationStore: WorkspaceRegistrationStore;
  readonly validateAutomation: (
    job: CronJobRecord,
  ) => Promise<{ allowed: boolean; reason?: string }>;
  readonly picoHome: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly agentRuntime: AgentRuntime;
  readonly effectiveConfigResolver: EffectiveConfigResolver;
  readonly credentialVault: CredentialVault;
  readonly trustStore: WorkspaceTrustStore;
  /** Binds the host lifecycle once the LocalDaemonHost exists. */
  attachHost(control: ProductionHostControl): void;
  /** Binds the Runtime Host-owned Session live channel after Host Epoch exists. */
  attachSessionSubscriptions(registry: SessionSubscriptionRegistry): void;
  /** Flushes the in-memory Active Overlay before a subscription captures its bootstrap. */
  flushSessionOverlay(workspacePath: string, sessionId: string): Promise<void>;
}

/**
 * Assembles the production DesktopRuntimeService (and its WorkspaceRuntimeService
 * substrate). Shared by createProductionLocalDaemonHost and, from 3-B-3, the
 * runtime-host bridge composition factory so both transports serve the same services.
 */
export function createProductionRuntimeServices(
  options: ProductionLocalDaemonHostOptions = {},
): ProductionRuntimeServices {
  const suppliedEnv = options.env ?? process.env;
  // `options.env` is an overlay/test seam and may intentionally contain only model
  // credentials. Freeze one state root up front, then give every assembled service the
  // same explicit PICO_HOME so no child falls back to a different process/default root.
  const picoHome = resolvePicoHome({ picoHome: suppliedEnv["PICO_HOME"] });
  const env: Readonly<Record<string, string | undefined>> = {
    ...suppliedEnv,
    PICO_HOME: picoHome,
  };
  const trustStore =
    options.trustStore ?? new WorkspaceTrustStore({ userStateDirectory: picoHome });
  const agentRuntime = options.agentRuntime ?? new AgentRuntime();
  const browserAgentBroker = new BrowserAgentCommandBroker();
  if (
    options.pluginRuntimeSnapshotRegistry &&
    options.pluginCapabilityRegistry &&
    options.pluginRuntimeSnapshotRegistry.capabilityRegistry !== options.pluginCapabilityRegistry
  ) {
    throw new Error(
      "Production Plugin snapshot and activation must share the exact capability registry",
    );
  }
  const pluginCapabilityRegistry =
    options.pluginRuntimeSnapshotRegistry?.capabilityRegistry ??
    options.pluginCapabilityRegistry ??
    createBuiltinPluginCapabilityRegistry();
  const pluginRuntimeSnapshotRegistry =
    options.pluginRuntimeSnapshotRegistry ??
    new PluginRuntimeSnapshotRegistry({
      env,
      picoHome,
      capabilityRegistry: pluginCapabilityRegistry,
    });
  const ownsPluginRuntimeSnapshotRegistry =
    options.ownsPluginRuntimeSnapshotRegistry ??
    options.pluginRuntimeSnapshotRegistry === undefined;
  const credentialVault =
    options.credentialVault ?? createPlatformCredentialVault(process.platform, env);
  const userConfigStore = options.userConfigStore ?? new UserConfigStore({ picoHome });
  const userMcpConfigStore = options.userMcpConfigStore ?? new UserMcpConfigStore({ picoHome });
  const effectiveConfigResolver =
    options.effectiveConfigResolver ?? new EffectiveConfigResolver({ userConfigStore });
  const registrationStore =
    options.registrationStore ??
    new WorkspaceRegistrationStore(join(picoHome, "daemon-workspaces.json"));
  const validateAutomation = async (
    job: CronJobRecord,
  ): Promise<{ allowed: boolean; reason?: string }> => {
    try {
      await prepareBackgroundYoloPolicy({
        workDir: job.workspacePath,
        policy: job.policySnapshot,
        trustStore,
      });
      if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
      await resolveCronModelRoute(job, effectiveConfigResolver, env);
      if (!(await credentialVault.has(job.credentialRef))) {
        throw new Error(`系统凭证库中不存在 ${job.credentialRef}`);
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const pendingApprovals = new Map<string, PendingInteraction>();
  const pendingPrompts = new Map<string, PendingInteraction>();
  const resolvedApprovals = new Map<string, InteractionScope>();
  const resolvedPrompts = new Map<string, InteractionScope>();
  const interactionStore = new FileDesktopInteractionStore({ picoHome });
  let desktopResourceVersion = Date.now();
  const nextDesktopResourceVersion = () => ++desktopResourceVersion;
  let sessionSubscriptions: SessionSubscriptionRegistry | undefined;
  const activeOverlays = new Map<string, PersistentActiveOverlay>();
  const service: WorkspaceRuntimeService = new WorkspaceRuntimeService({
    registrationStore,
    env,
    execute: async ({ workspacePath, workspaceRuntime, prompt, sessionId, execution, context }) => {
      if (!(await trustStore.isTrusted(workspacePath))) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.FORBIDDEN,
          `工作区尚未信任，拒绝启动前台 Run: ${workspacePath}`,
        );
      }
      const targetSessionId = sessionId ?? createCliSessionId();
      context.bindSession(targetSessionId);
      const sessionLease = await globalSessionManager.getOrCreatePinned(
        targetSessionId,
        workspacePath,
        {
          persistence: true,
          picoHome,
          runtimePort: createEngineRuntimePort(),
        },
      );
      const session = sessionLease.session;
      let sessionLeaseTransferred = false;
      try {
        if (!session.runtimeEventStore) {
          throw new Error(
            `Production daemon requires durable Session persistence: ${targetSessionId}`,
          );
        }
        const persistedSettings = (await session.readHydrationSnapshot()).runtime.settings;
        const route = await resolveDesktopModelRoute(
          workspacePath,
          credentialVault,
          userConfigStore,
          effectiveConfigResolver,
          execution?.requestedModel ?? persistedSettings?.modelRouteId,
          persistedSettings?.provider,
          env,
        );
        const reasoningLevel = coordinateReasoningLevel(
          route.capabilities.reasoningProfile,
          persistedSettings?.thinkingEffortExplicit ? persistedSettings.thinkingEffort : undefined,
        ).level;
        const effectiveMcp = await resolveTrustedEffectiveMcpSources(workspacePath, {
          picoHome,
          trustStore,
          userStore: userMcpConfigStore,
        });
        // Resolve the shared immutable snapshot before creating SessionRuntime as well as before
        // AgentRuntime.execute. When a runtimeState is injected, AgentRuntime deliberately reuses
        // it and cannot attach extension Hook sources retroactively.
        const pluginSnapshot = await pluginRuntimeSnapshotRegistry.get(workspacePath);
        const runtimeState = await createSessionRuntime({
          session,
          sessionLease,
          env,
          workspaceTrustStore: trustStore,
          ...(workspaceRuntime.taskHostRuntime
            ? { taskHostRuntime: workspaceRuntime.taskHostRuntime }
            : {}),
          ...(persistedSettings?.collaborationMode !== "plan" && pluginSnapshot.hookSources.length
            ? { hookExtensionSources: pluginSnapshot.hookSources }
            : {}),
        });
        sessionLeaseTransferred = true;
        const broker = new DesktopInteractionBroker({
          store: interactionStore,
          ownerKey: createDesktopInteractionOwnerKey(
            workspacePath,
            targetSessionId,
            context.run.runId,
          ),
          onPersistenceError: (error) =>
            logger.error(
              { workspacePath, sessionId: targetSessionId, runId: context.run.runId, error },
              "桌面交互状态持久化失败",
            ),
          onListenerError: (error) =>
            logger.warn(
              { workspacePath, sessionId: targetSessionId, runId: context.run.runId, error },
              "桌面交互状态订阅者失败",
            ),
        });
        await broker.recover();
        const interaction: PendingInteraction = {
          broker,
          workspacePath,
          runId: context.run.runId,
          sessionId: targetSessionId,
        };
        const unsubscribeInteractions = broker.subscribe((event) => {
          publishInteractionEvent(
            service,
            interaction,
            event,
            pendingApprovals,
            pendingPrompts,
            resolvedApprovals,
            resolvedPrompts,
            nextDesktopResourceVersion,
          );
        });
        const overlayToolCallIds = new Map<string, string>();
        const overlayAnchorSequences = new Map<string, number>();
        const activeOverlay = new PersistentActiveOverlay(
          {
            async upsert(input) {
              const runtimeRun = currentRuntimeRun();
              if (
                !runtimeRun ||
                runtimeRun.runId !== context.run.runId ||
                runtimeRun.sessionId !== targetSessionId
              ) {
                throw new Error("Active Overlay 已离开对应 Runtime Run 上下文");
              }
              let anchorSequence = overlayAnchorSequences.get(input.partialId);
              if (anchorSequence === undefined) {
                anchorSequence = (await runtimeRun.store.readTranscriptWatermark(targetSessionId))
                  .throughSequence;
                overlayAnchorSequences.set(input.partialId, anchorSequence);
              }
              const snapshot = await runtimeRun.upsertPartialSnapshot(
                input.partialId,
                input.kind,
                input.expectedVersion,
                { ...input.payload, anchorSequence },
              );
              return { version: snapshot.version };
            },
          },
          {
            publishDelta(delta) {
              sessionSubscriptions?.publishSessionDelta({
                workspacePath,
                sessionId: targetSessionId,
                runId: delta.runId,
                turnId: delta.turnId,
                itemId: delta.itemId,
                streamId: delta.streamId,
                kind: delta.kind,
                startOffsetBytes: delta.startOffsetBytes,
                text: delta.text,
                ...(delta.stream ? { stream: delta.stream } : {}),
              });
            },
            publishContinuityDegraded(reason) {
              sessionSubscriptions?.publishContinuityDegraded(
                workspacePath,
                targetSessionId,
                reason,
              );
            },
          },
        );
        const activeOverlayKey = sessionOverlayKey(workspacePath, targetSessionId);
        activeOverlays.set(activeOverlayKey, activeOverlay);
        const reporter = new DesktopReporter({
          runId: context.run.runId,
          sessionId: targetSessionId,
          publish: (event) => {
            const handledByOverlay = persistReporterOverlayDelta(
              activeOverlay,
              overlayToolCallIds,
              event,
            );
            if (!handledByOverlay) {
              sessionSubscriptions?.publishReporterEvent(workspacePath, event);
            }
            publishDesktopReporterEvent(service, workspacePath, event, nextDesktopResourceVersion);
          },
        });
        for (const steer of context.drainSteers()) runtimeState.steerQueue.push(steer);
        const unsubscribeSteer = context.onSteer((message) =>
          runtimeState.steerQueue.push(message),
        );
        try {
          const skillActivation = execution?.skillActivation;
          if (skillActivation?.sourcePath && skillActivation.hooks !== undefined) {
            const trustAuthority = skillActivation.sourceId
              ? pluginSnapshot.skillSources.find((source) => source.id === skillActivation.sourceId)
                  ?.hookTrustAuthority
              : undefined;
            await runtimeState.activateComponentHooks({
              kind: "skill",
              path: skillActivation.sourcePath,
              componentId: skillActivation.name,
              inlineHooks: skillActivation.hooks,
              ...(trustAuthority ? { trustAuthority } : {}),
            });
          }
          const runtimeOptions = {
            prompt,
            dir: workspacePath,
            session: targetSessionId,
            provider: route.provider,
            baseURL: route.baseURL,
            apiKey: route.apiKey,
            model: route.model,
            modelRouteId: route.modelRouteId,
            modelCapabilities: route.capabilities,
            ...(reasoningLevel !== undefined ? { thinkingEffort: reasoningLevel } : {}),
            ...(persistedSettings?.collaborationMode === "plan" ||
            persistedSettings?.mode === "plan"
              ? { planMode: true }
              : {}),
            ...(persistedSettings?.mode ? { rewindInteractionMode: persistedSettings.mode } : {}),
            ...(persistedSettings?.mode === "plan" && persistedSettings.prePlanMode
              ? { rewindPrePlanMode: persistedSettings.prePlanMode }
              : {}),
            ...(execution?.allowedTools ? { allowedTools: execution.allowedTools } : {}),
          };
          const runtimeHost = {
            signal: context.signal,
            runtimeState,
            reporter,
            modelRouter: route.modelRouter,
            approvalNotifier: broker.notifyApproval,
            approvalManager: broker.approvalManager,
            askUserHandler: broker.askUserHandler,
            ...(execution?.resumeExistingSession ? { resumeExistingSession: true } : {}),
            waitAtSafeBoundary: context.waitAtSafeBoundary,
            rewindPointSink: context.bindCheckpoint,
            pluginSnapshot,
            pluginCapabilityRegistry,
            mcpConfigSources: effectiveMcp.sources,
            picoHome,
            env,
            browserAgent: browserAgentBroker.bind(targetSessionId),
            memoryProposalSink: (notice: MemoryProposalPublishedNotice) =>
              publishDesktopMemoryProposal(
                service,
                workspacePath,
                notice,
                nextDesktopResourceVersion,
              ),
            sessionResourceChangedSink: (notice: RuntimeSessionResourceChangedNotice) =>
              service.publishDesktopNotification(
                createRuntimeNotification({
                  topic: "session.resourceChanged",
                  scope: {
                    workspacePath: notice.workspacePath,
                    sessionId: notice.sessionId,
                  },
                  resourceVersion: nextDesktopResourceVersion(),
                  at: Date.now(),
                  payload: { resource: notice.resource, revision: notice.revision },
                }),
              ),
          };
          const planReview = execution?.planReview;
          const result: RunAgentCliResult =
            planReview?.action === "execute"
              ? await agentRuntime.approvePlanAndExecute(
                  {
                    approval: {
                      sessionId: targetSessionId,
                      dir: workspacePath,
                      planId: planReview.planId,
                      expectedRevision: planReview.expectedRevision,
                      expectedSessionSequence: planReview.expectedSessionSequence,
                      operationId: planReview.operationId,
                    },
                    execution: { ...runtimeOptions, planMode: false },
                  },
                  runtimeHost,
                )
              : planReview?.action === "resume_execution"
                ? await agentRuntime.resumePlanExecution(
                    {
                      sessionId: targetSessionId,
                      dir: workspacePath,
                      planId: planReview.planId,
                      expectedSessionSequence: planReview.expectedSessionSequence,
                      operationId: planReview.operationId,
                      execution: { ...runtimeOptions, planMode: false },
                    },
                    runtimeHost,
                  )
                : planReview?.action === "replan_execution"
                  ? await agentRuntime.replanInterruptedExecution(
                      {
                        sessionId: targetSessionId,
                        dir: workspacePath,
                        planId: planReview.planId,
                        expectedSessionSequence: planReview.expectedSessionSequence,
                        operationId: planReview.operationId,
                        prompt: planReview.feedback ?? "请根据中断原因重新规划后续步骤。",
                        execution: { ...runtimeOptions, planMode: true },
                      },
                      runtimeHost,
                    )
                  : await agentRuntime.execute(
                      planReview?.action === "continue_editing"
                        ? {
                            ...runtimeOptions,
                            prompt: `[PLAN REVISION FEEDBACK]\n${planReview.feedback ?? "请继续修改计划。"}`,
                            planMode: true,
                          }
                        : runtimeOptions,
                      runtimeHost,
                    );
          if (result.handoff) {
            publishDesktopPlanHandoff(
              service,
              workspacePath,
              result.handoff,
              nextDesktopResourceVersion,
            );
          }
          return {
            sessionId: result.sessionId,
            finalMessage: result.finalMessage,
            usage: result.usage,
          };
        } finally {
          unsubscribeSteer();
          unsubscribeInteractions();
          await broker.closeAsync();
          removeBrokerInteractions(pendingApprovals, broker);
          removeBrokerInteractions(pendingPrompts, broker);
          await activeOverlay.flush();
          try {
            await currentRuntimeRun()?.clearPartials();
          } catch (error) {
            logger.warn(
              { workspacePath, sessionId: targetSessionId, runId: context.run.runId, err: error },
              "Run 已结束但 Active Overlay 残留清理失败",
            );
          }
          if (activeOverlays.get(activeOverlayKey) === activeOverlay) {
            activeOverlays.delete(activeOverlayKey);
          }
          await runtimeState.dispose();
        }
      } finally {
        if (!sessionLeaseTransferred) sessionLease.release();
      }
    },
  });
  // Late-bound host lifecycle: automations need the LocalDaemonHost instance, which
  // only exists after the services are assembled (see attachHost).
  let attachedHost: ProductionHostControl | undefined;
  const attachHost = (control: ProductionHostControl): void => {
    attachedHost = control;
  };
  const requireHost = (): ProductionHostControl => {
    if (!attachedHost) {
      throw new Error("Production Runtime host 尚未绑定，Automation 无法访问 daemon 生命周期");
    }
    return attachedHost;
  };
  const automations: DesktopAutomationService = new DesktopAutomationService({
    picoHome,
    prepareSecurity: async (workspacePath) => {
      const route = await resolveDesktopAutomationRoute(
        workspacePath,
        effectiveConfigResolver,
        env,
      );
      const userProvider = (await userConfigStore.read()).config.providers[route.providerId];
      const useSharedProviderCredential =
        userProvider !== undefined &&
        userProvider.protocol === route.provider &&
        sameEndpoint(userProvider.baseURL, route.baseURL);
      if (route.origin === "environment" && !useSharedProviderCredential) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.FORBIDDEN,
          "持久 Automation 不支持仅由当前进程环境提供的 Provider，请先导入用户 Provider",
        );
      }
      const credentialRef = useSharedProviderCredential
        ? credentialRefForProvider({
            providerId: route.providerId,
            protocol: route.provider,
            baseURL: route.baseURL,
          })
        : credentialRefForModelRoute(route, workspacePath);
      if (!(await credentialVault.has(credentialRef))) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.FORBIDDEN,
          `模型路由 ${route.id} 尚未导入系统凭证库，无法创建持久 Automation`,
        );
      }
      return {
        credentialRef,
        modelRouteId: route.id,
        // The current desktop protocol has no tool/network-policy fields. Keep the
        // first release fail-closed: model-only jobs are real, tools stay unavailable.
        policySnapshot: {
          mode: "yolo",
          backgroundEnabled: true,
          trustedWorkspace: true,
          toolNetworkPolicy: "disabled",
          allowedTools: [],
          hardlineVersion: BACKGROUND_HARDLINE_VERSION,
          hookVersion: BACKGROUND_HOOK_VERSION,
          createdAt: Date.now(),
        },
      };
    },
    validateSecurity: async (job) => {
      const decision = await validateAutomation(job);
      if (!decision.allowed) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          decision.reason ?? "Automation Provider 或凭证已变化",
        );
      }
    },
    ensureWorkspaceRuntime: async (workspacePath) => {
      const canonicalWorkspace = await registrationStore.register(workspacePath);
      const host = requireHost();
      if (host.status !== "running") {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "Runtime daemon 尚未就绪，Automation 已保存为禁用状态",
        );
      }
      await host.refreshRegisteredWorkspaces();
      if (!host.registeredWorkspaces.includes(canonicalWorkspace)) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `工作区 Cron runtime 启动失败: ${canonicalWorkspace}`,
        );
      }
    },
    runNow: async (workspacePath, jobId): Promise<CronRunRecord> => {
      const host = requireHost();
      if (host.status !== "running") {
        throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "Runtime daemon 尚未就绪");
      }
      return host.runCronJobNow(workspacePath, jobId);
    },
  });
  const desktopService: DesktopRuntimeService = new DesktopRuntimeService({
    runtimeService: service,
    registrationStore,
    trustStore,
    browserAgentBroker,
    env,
    automations,
    userConfigStore,
    effectiveConfigResolver,
    credentialVault,
    pluginRuntimeSnapshotRegistry,
    ownsPluginRuntimeSnapshotRegistry,
    onTranscriptAdvanced: (workspacePath, sessionId) =>
      sessionSubscriptions?.publishTranscriptAdvanced(workspacePath, sessionId),
    planControl: {
      respond: async (input) => {
        const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
        if (input.action === "execute" || input.action === "continue_editing") {
          const projection =
            input.action === "continue_editing"
              ? (
                  await agentRuntime.requestPlanRevision({
                    sessionId: input.sessionId,
                    dir: workspacePath,
                    picoHome,
                    env,
                    planId: input.planId,
                    expectedRevision: input.expectedRevision,
                    expectedSessionSequence: input.expectedSessionSequence,
                    operationId: input.operationId,
                    feedback: input.feedback ?? "请继续修改计划。",
                  })
                ).projection
              : await readDesktopPlanProjection(
                  workspacePath,
                  input.sessionId,
                  picoHome,
                  input.operationId,
                );
          if (input.action === "execute") {
            await service.executeIdempotentDaemonCommand(
              workspacePath,
              {
                commandType: "plan.review.claim",
                idempotencyKey: input.operationId,
                request: {
                  planId: input.planId,
                  expectedRevision: input.expectedRevision,
                  expectedSessionSequence: input.expectedSessionSequence,
                  operationId: input.operationId,
                  action: input.action,
                },
              },
              () => {
                assertPendingPlanReview(projection, input);
                return { result: { accepted: true, operationId: input.operationId } };
              },
            );
          }
          const run = await service.startForegroundRun({
            workspacePath,
            sessionId: input.sessionId,
            prompt:
              input.action === "execute"
                ? "执行已批准计划"
                : `[PLAN REVISION FEEDBACK]\n${input.feedback ?? "请继续修改计划。"}`,
            execution: {
              resumeExistingSession: true,
              planReview: {
                action: input.action,
                planId: input.planId,
                expectedRevision: input.expectedRevision,
                expectedSessionSequence: input.expectedSessionSequence,
                operationId: input.operationId,
                ...(input.feedback ? { feedback: input.feedback } : {}),
              },
            },
            idempotencyKey: `plan-review-run:${input.operationId}`,
          });
          return { accepted: true, projection, run: jsonObject(run) };
        }
        if (input.action === "resume_execution" || input.action === "replan_execution") {
          const projection = await readDesktopPlanProjection(
            workspacePath,
            input.sessionId,
            picoHome,
            input.operationId,
          );
          await service.executeIdempotentDaemonCommand(
            workspacePath,
            {
              commandType: "plan.interrupted.claim",
              idempotencyKey: input.operationId,
              request: {
                planId: input.planId,
                expectedRevision: input.expectedRevision,
                expectedSessionSequence: input.expectedSessionSequence,
                action: input.action,
                ...(input.feedback ? { feedback: input.feedback } : {}),
              },
            },
            () => {
              assertInterruptedPlanControl(projection, input);
              return { result: { accepted: true, operationId: input.operationId } };
            },
          );
          const run = await service.startForegroundRun({
            workspacePath,
            sessionId: input.sessionId,
            prompt:
              input.action === "resume_execution" ? "继续执行已中断计划" : "重新规划已中断计划",
            execution: {
              resumeExistingSession: true,
              planReview: {
                action: input.action,
                planId: input.planId,
                expectedRevision: input.expectedRevision,
                expectedSessionSequence: input.expectedSessionSequence,
                operationId: input.operationId,
                ...(input.feedback ? { feedback: input.feedback } : {}),
              },
            },
            idempotencyKey: `plan-interrupted-run:${input.operationId}`,
          });
          return { accepted: true, projection, run: jsonObject(run) };
        }
        if (input.action === "cancel_execution") {
          const projection = await agentRuntime.cancelInterruptedPlan({
            sessionId: input.sessionId,
            dir: workspacePath,
            picoHome,
            env,
            planId: input.planId,
            expectedSessionSequence: input.expectedSessionSequence,
            operationId: input.operationId,
            ...(input.feedback ? { reason: input.feedback } : {}),
          });
          publishDesktopPlanProjection(
            service,
            workspacePath,
            projection,
            "updated",
            nextDesktopResourceVersion,
          );
          return { accepted: true, projection };
        }
        const lease = await globalSessionManager.getOrCreatePinned(input.sessionId, workspacePath, {
          persistence: true,
          picoHome,
          runtimePort: createEngineRuntimePort(),
        });
        try {
          if (!lease.session.runtimeEventStore) {
            throw new Error("Plan rejection requires durable Session storage");
          }
          const settings = (await lease.session.readHydrationSnapshot()).runtime.settings;
          if (!settings) throw new Error("Plan rejection requires persisted Session settings");
          const projection = await new PlanCoordinator(lease.session.runtimeEventStore, {
            sessionId: input.sessionId,
            invocationId: `plan-review:${input.operationId}`,
            runId: `plan-review:${input.operationId}`,
            turnId: `plan-review:${input.operationId}`,
            writeGuard: lease.session,
          }).rejectAndExit({
            operationId: input.operationId,
            expectedSessionSequence: input.expectedSessionSequence,
            planId: input.planId,
            expectedRevision: input.expectedRevision,
            reviewedBy: "user",
            settings,
            ...(input.feedback ? { reason: input.feedback } : {}),
          });
          await lease.session.refreshRuntimeProjection();
          publishDesktopPlanProjection(
            service,
            workspacePath,
            projection,
            "rejected",
            nextDesktopResourceVersion,
          );
          return { accepted: true, projection };
        } finally {
          lease.release();
        }
      },
    },
    interactions: {
      respondApproval: async (input) => {
        const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
        const respond = async () => {
          const key = interactionKey(workspacePath, input.approvalId);
          const pending = pendingApprovals.get(key);
          if (!pending) {
            const resolved = resolvedApprovals.get(key);
            if (!resolved) throw unknownInteraction("Approval", input.approvalId);
            assertInteractionScope(resolved, input, "Approval", input.approvalId, workspacePath);
            return { accepted: true, alreadyResolved: true };
          }
          assertInteractionScope(pending, input, "Approval", input.approvalId, workspacePath);
          try {
            const outcome = await pending.broker.resolveApprovalVersioned({
              taskId: input.approvalId,
              decision:
                input.decision === "allow_session"
                  ? "approve-session"
                  : input.decision === "allow_once"
                    ? "approve"
                    : "reject",
              ...(input.reason ? { reason: input.reason } : {}),
            });
            if (!outcome.accepted) {
              throw new RuntimeProtocolError(
                RUNTIME_ERROR_CODES.CONFLICT,
                `Approval ${input.approvalId} 已在另一请求中处理`,
              );
            }
            return {
              accepted: outcome.accepted,
              alreadyResolved: outcome.alreadyResolved,
            };
          } catch (error) {
            if (error instanceof DesktopInteractionVersionConflictError) {
              throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, error.message);
            }
            throw error;
          }
        };
        if (!input.idempotencyKey) return await respond();
        const response = await respond();
        const outcome = await service.executeIdempotentDaemonCommand(
          workspacePath,
          {
            commandType: "approval.respond",
            idempotencyKey: input.idempotencyKey,
            request: {
              workspacePath,
              approvalId: input.approvalId,
              decision: input.decision,
              ...(input.reason !== undefined ? { reason: input.reason } : {}),
              ...(input.runId !== undefined ? { runId: input.runId } : {}),
              ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            },
          },
          () => ({ result: response }),
        );
        return outcome.result;
      },
      respondPrompt: async (input) => {
        const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
        const respond = async () => {
          const key = interactionKey(workspacePath, input.promptId);
          const pending = pendingPrompts.get(key);
          if (!pending) {
            const resolved = resolvedPrompts.get(key);
            if (!resolved) throw unknownInteraction("Prompt", input.promptId);
            assertInteractionScope(resolved, input, "Prompt", input.promptId, workspacePath);
            return { accepted: true, alreadyResolved: true };
          }
          assertInteractionScope(pending, input, "Prompt", input.promptId, workspacePath);
          if (typeof input.answer !== "string" || !input.answer.trim()) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              "prompt.respond answer 必须是非空选项 ID、标签或自由文本",
            );
          }
          const outcome = await pending.broker.answerPromptVersioned({
            requestId: input.promptId,
            answer: input.answer.trim(),
          });
          if (!outcome.accepted) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              `Prompt ${input.promptId} 的 answer 不是有效选项，且该问题未声明 freeText`,
            );
          }
          return {
            accepted: outcome.accepted,
            alreadyResolved: outcome.alreadyResolved,
          };
        };
        if (!input.idempotencyKey) return await respond();
        const response = await respond();
        const outcome = await service.executeIdempotentDaemonCommand(
          workspacePath,
          {
            commandType: "prompt.respond",
            idempotencyKey: input.idempotencyKey,
            request: {
              workspacePath,
              promptId: input.promptId,
              answer: input.answer,
              ...(input.runId !== undefined ? { runId: input.runId } : {}),
              ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
            },
          },
          () => ({ result: response }),
        );
        return outcome.result;
      },
      cancelPrompt: async (input) => {
        const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
        const key = interactionKey(workspacePath, input.promptId);
        const pending = pendingPrompts.get(key);
        if (!pending) {
          // 已解析/不存在都视为非 pending：幂等返回 cancelled=false（Esc 重按不报错）。
          return { cancelled: false };
        }
        assertInteractionScope(pending, input, "Prompt", input.promptId, workspacePath);
        const outcome = await pending.broker.cancelPromptVersioned({
          requestId: input.promptId,
          reason: input.reason?.trim() || "用户在客户端取消了问题。",
        });
        return { cancelled: outcome.accepted };
      },
    },
  });
  return {
    service,
    desktopService,
    registrationStore,
    validateAutomation,
    picoHome,
    env,
    agentRuntime,
    effectiveConfigResolver,
    credentialVault,
    trustStore,
    attachHost,
    attachSessionSubscriptions(registry) {
      sessionSubscriptions = registry;
    },
    async flushSessionOverlay(workspacePath, sessionId) {
      await activeOverlays.get(sessionOverlayKey(workspacePath, sessionId))?.flush();
    },
  };
}

/** Stable, bounded persistence identity for one Desktop run's interactions. */
export function createDesktopInteractionOwnerKey(
  workspacePath: string,
  sessionId: string,
  runId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["desktop-interaction-owner-v1", workspacePath, sessionId, runId]))
    .digest("hex");
  return `desktop-run:v1:${digest}`;
}

function sessionOverlayKey(workspacePath: string, sessionId: string): string {
  return `${workspacePath}\u0000${sessionId}`;
}

/**
 * Shared assembly of the LocalDaemonHost lifecycle wrapper over production services.
 * 3-D Phase 5（2026-08-16）：旧传输（endpoint/instance-lock/LocalRuntimeDaemon）已退役，
 * host 只编排 service + cron runtime 生命周期；单例与传输由 kernel 的 flock 选主
 * 与 NDJSON endpoint 承担（runtime-host candidate 嵌入同一装配）。
 */
export function assembleProductionDaemonHost(
  services: ProductionRuntimeServices,
  _options: ProductionLocalDaemonHostOptions,
): LocalDaemonHost {
  const {
    service,
    desktopService,
    registrationStore,
    validateAutomation,
    picoHome,
    env,
    agentRuntime,
    effectiveConfigResolver,
    credentialVault,
    trustStore,
    attachHost,
  } = services;
  const cronRuntimeFactory = createCronWorkspaceRuntimeFactory({
    picoHome,
    getWorkspaceRuntime: (workspacePath) => service.getWorkspaceRuntime(workspacePath),
    canRun: validateAutomation,
    policyGuard: {
      evaluate: (job) =>
        job.policySnapshot.hardlineVersion === BACKGROUND_HARDLINE_VERSION &&
        job.policySnapshot.hookVersion === BACKGROUND_HOOK_VERSION
          ? { allowed: true }
          : { allowed: false, reason: "background_policy_version_mismatch" },
    },
    execute: async (job, context) => {
      if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
      const route = await resolveCronModelRoute(job, effectiveConfigResolver, env);
      const result = await agentRuntime.execute(
        {
          prompt: job.prompt,
          dir: job.workspacePath,
          provider: route.provider,
          baseURL: route.baseURL,
          model: route.model,
          modelRouteId: route.modelRouteId,
          modelCapabilities: route.capabilities,
          credentialRef: job.credentialRef,
          execution: { kind: "background", policy: job.policySnapshot },
        },
        {
          signal: context.signal,
          reporter: new SilentReporter(),
          backgroundTrustStore: trustStore,
          credentialResolver: credentialVault,
          picoHome,
          env,
        },
      );
      return {
        sessionId: result.sessionId,
        finalMessage: result.finalMessage,
        usage: result.usage,
      };
    },
  });
  const host: LocalDaemonHost = new LocalDaemonHost({
    service: desktopService,
    cronRuntimeFactory,
    registrationStore,
    onWorkspaceError: (workspacePath, error) =>
      logger.error({ workspacePath, err: error }, "Cron workspace 启动失败"),
  });
  attachHost(host);
  service.setRegistrationChangedListener(() => host.refreshRegisteredWorkspaces());
  return host;
}

export function createProductionLocalDaemonHost(
  options: ProductionLocalDaemonHostOptions = {},
): LocalDaemonHost {
  return assembleProductionDaemonHost(createProductionRuntimeServices(options), options);
}

async function resolveDesktopAutomationRoute(
  workspacePath: string,
  effectiveConfigResolver: EffectiveConfigResolver,
  env: Readonly<Record<string, string | undefined>>,
) {
  const config = await effectiveConfigResolver.resolve({
    workDir: workspacePath,
    projectTrusted: true,
    env,
  });
  const modelRouteId = config.defaultModelRouteId;
  if (!modelRouteId) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      "工作区尚未配置默认 model 路由，无法创建 Automation",
    );
  }
  const slash = modelRouteId.indexOf("/");
  const providerId = modelRouteId.slice(0, slash);
  const model = modelRouteId.slice(slash + 1);
  const provider = config.providers[providerId];
  if (!provider || !provider.models.includes(model)) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      `默认模型路由 ${modelRouteId} 不在显式 Provider 模型列表中`,
    );
  }
  return {
    id: modelRouteId,
    providerId,
    provider: provider.protocol,
    baseURL: provider.baseURL,
    model,
    apiKeyEnv: provider.apiKeyEnv,
    origin: config.sources[`providers.${providerId}`] ?? "user",
  };
}

async function resolveCronModelRoute(
  job: CronJobRecord,
  effectiveConfigResolver: EffectiveConfigResolver,
  env: Readonly<Record<string, string | undefined>>,
) {
  if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
  const parsedCredential = parseAnyCredentialRef(job.credentialRef);
  const modelRouteId =
    job.modelRouteId ??
    (parsedCredential.version === "v1" ? parsedCredential.modelRouteId : undefined);
  if (!modelRouteId) throw new Error("v2 Cron Job 缺少固定 modelRouteId");
  const slash = modelRouteId.indexOf("/");
  const providerId = modelRouteId.slice(0, slash);
  const model = modelRouteId.slice(slash + 1);
  const config = await effectiveConfigResolver.resolve({
    workDir: job.workspacePath,
    projectTrusted: true,
    env,
  });
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`配置模型路由 ${modelRouteId} 的 provider 已不存在`);
  if (!provider.models.includes(model)) {
    throw new Error(`配置模型路由 ${modelRouteId} 不在显式 models 列表中`);
  }
  const resolved = {
    id: modelRouteId,
    providerId,
    provider: provider.protocol,
    baseURL: provider.baseURL,
    model,
    apiKeyEnv: provider.apiKeyEnv,
    modelRouteId,
    capabilities: resolveModelRouteCapabilities(
      provider.protocol,
      model,
      provider.modelCapabilities?.[model],
      { baseURL: provider.baseURL },
    ),
  };
  if (parsedCredential.version === "v1") {
    assertCredentialRefMatchesModelRoute(job.credentialRef, resolved, job.workspacePath);
  } else {
    assertCredentialRefMatchesProvider(job.credentialRef, {
      providerId,
      protocol: provider.protocol,
      baseURL: provider.baseURL,
    });
  }
  return resolved;
}

function sameEndpoint(left: string, right: string): boolean {
  try {
    return normalizeProviderEndpoint(left) === normalizeProviderEndpoint(right);
  } catch {
    return false;
  }
}

interface InteractionScope {
  readonly workspacePath: string;
  readonly runId: string;
  readonly sessionId: string;
}

interface PendingInteraction extends InteractionScope {
  readonly broker: DesktopInteractionBroker;
}

async function resolveDesktopModelRoute(
  workspacePath: string,
  credentialVault: CredentialVault,
  userConfigStore: UserConfigStore,
  effectiveConfigResolver: EffectiveConfigResolver,
  requestedModel?: string,
  legacyProvider: ProviderKind = "openai",
  env: Readonly<Record<string, string | undefined>> = process.env,
) {
  const projectConfig = await loadPicoConfig(workspacePath);
  const requested = resolveDesktopRequestedModel(projectConfig, requestedModel);
  try {
    const runtime = await loadEffectiveModelRuntime({
      workDir: workspacePath,
      projectTrusted: true,
      legacyProvider,
      legacyModel: "",
      legacyModelExplicit: false,
      env,
      credentialVault,
      userConfigStore,
      configResolver: effectiveConfigResolver,
    });
    const active = runtime.router.providerConfig(requested ?? runtime.config.defaultModelRouteId);
    return {
      id: active.route.id,
      provider: active.provider,
      baseURL: active.config.baseURL,
      apiKey: active.config.apiKey,
      model: active.config.model,
      apiKeyEnv: active.route.apiKeyEnv,
      modelRouteId: active.route.id,
      capabilities: active.route.capabilities,
      modelRouter: runtime.router,
    };
  } catch (error) {
    if (error instanceof RuntimeProtocolError) throw error;
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      error instanceof Error ? error.message : String(error),
    );
  }
}

async function readDesktopPlanProjection(
  workspacePath: string,
  sessionId: string,
  picoHome: string,
  operationId: string,
): Promise<PlanProjection> {
  const lease = await globalSessionManager.getOrCreatePinned(sessionId, workspacePath, {
    persistence: true,
    picoHome,
    runtimePort: createEngineRuntimePort(),
  });
  try {
    if (!lease.session.runtimeEventStore) {
      throw new Error("Plan projection requires durable Session storage");
    }
    return await new PlanCoordinator(lease.session.runtimeEventStore, {
      sessionId,
      invocationId: `plan-review:${operationId}`,
      runId: `plan-review:${operationId}`,
      turnId: `plan-review:${operationId}`,
    }).project();
  } finally {
    lease.release();
  }
}

function assertPendingPlanReview(
  projection: PlanProjection,
  input: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
  },
): void {
  const pending = projection.pendingProposal;
  if (
    !pending ||
    pending.planId !== input.planId ||
    pending.revision !== input.expectedRevision ||
    projection.sessionSequence !== input.expectedSessionSequence
  ) {
    throw new RuntimeProtocolError(RUNTIME_ERROR_CODES.CONFLICT, "计划已更新，请刷新审批卡后重试");
  }
}

function assertInterruptedPlanControl(
  projection: PlanProjection,
  input: {
    readonly planId: string;
    readonly expectedRevision: number;
    readonly expectedSessionSequence: number;
  },
): void {
  const execution = projection.execution;
  if (
    !execution ||
    execution.status !== "interrupted" ||
    execution.planId !== input.planId ||
    execution.revision !== input.expectedRevision ||
    projection.sessionSequence !== input.expectedSessionSequence
  ) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.CONFLICT,
      "计划执行状态已更新，请刷新后重试",
    );
  }
}

function publishDesktopPlanHandoff(
  service: WorkspaceRuntimeService,
  workspacePath: string,
  handoff: PlanHandoff,
  nextResourceVersion: () => number,
): void {
  const proposal = handoff.projection.pendingProposal ?? handoff.projection.latestProposal;
  service.publishDesktopNotification(
    createRuntimeNotification({
      topic: "approval.requested",
      scope: { workspacePath, sessionId: handoff.sessionId, runId: handoff.runId },
      resourceVersion: nextResourceVersion(),
      at: Date.now(),
      payload: {
        approvalId: handoff.planId,
        runId: handoff.runId,
        request: jsonObject({
          title: proposal?.title ?? "计划等待审批",
          detail: proposal?.overview ?? "请审阅计划后选择下一步。",
          kind: "plan",
          toolName: "submit_plan",
          risk: "high",
          planId: handoff.planId,
          expectedRevision: handoff.revision,
          expectedSessionSequence: handoff.expectedSessionSequence,
          ...(proposal ? { plan: proposal } : {}),
          actions: ["execute", "continue_editing", "reject_exit"],
        }),
      },
    }),
  );
  publishDesktopPlanProjection(
    service,
    workspacePath,
    handoff.projection,
    "proposed",
    nextResourceVersion,
  );
}

function publishDesktopPlanProjection(
  service: WorkspaceRuntimeService,
  workspacePath: string,
  projection: PlanProjection,
  operation: "proposed" | "updated" | "executing" | "continue_editing" | "rejected",
  nextResourceVersion: () => number,
): void {
  service.publishDesktopNotification(
    createRuntimeNotification({
      topic: "plan.updated",
      scope: { workspacePath, sessionId: projection.sessionId },
      resourceVersion: nextResourceVersion(),
      at: Date.now(),
      payload: {
        sessionId: projection.sessionId,
        projection: jsonObject(projection),
        operation,
      },
    }),
  );
}

function resolveDesktopRequestedModel(
  config: Awaited<ReturnType<typeof loadPicoConfig>>,
  requestedModel?: string,
): string | undefined {
  const requested = requestedModel?.trim();
  // "inherit" = 不显式指定 → 回落调用方的 effective 默认路由（用户级）。
  if (!requested || requested === "inherit") return undefined;
  const aliased = config.compatibility.claude.enabled
    ? (config.compatibility.claude.modelAliases[requested] ?? requested)
    : requested;
  if (aliased.includes("/")) return aliased;
  const matches = Object.entries(config.providers)
    .filter(([, provider]) => provider.models.includes(aliased))
    .map(([providerId]) => `${providerId}/${aliased}`);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.INVALID_PARAMS,
      `Skill 模型 ${aliased} 匹配多个 Provider，请使用 provider/model 路由`,
    );
  }
  return aliased;
}

/** Production adapter from the worker's metadata-only sink to the durable Runtime channel. */
export function publishDesktopMemoryProposal(
  service: Pick<WorkspaceRuntimeService, "publishDesktopNotification">,
  workspacePath: string,
  notice: MemoryProposalPublishedNotice,
  nextResourceVersion: () => number,
  now: () => number = Date.now,
): void {
  service.publishDesktopNotification(
    createRuntimeNotification({
      topic: "memory.proposed",
      scope: { workspacePath },
      resourceVersion: nextResourceVersion(),
      at: now(),
      payload: {
        proposalId: notice.proposalId,
        version: notice.version,
        kind: notice.kind,
      },
    }),
  );
}

function persistReporterOverlayDelta(
  overlay: PersistentActiveOverlay,
  toolCallIds: Map<string, string>,
  event: DesktopReporterEvent,
): boolean {
  const turn =
    typeof event.payload["turn"] === "number" && Number.isSafeInteger(event.payload["turn"])
      ? event.payload["turn"]
      : 0;
  const stableTurnId = `turn:${event.runId}:${turn}`;
  if (event.type === "assistant.delta" || event.type === "assistant.reasoning.delta") {
    const text = firstString(event.payload["delta"]);
    if (!text || !event.sessionId) return true;
    const thinking = event.type === "assistant.reasoning.delta";
    void overlay.append({
      sessionId: event.sessionId,
      runId: event.runId,
      turnId: stableTurnId,
      itemId: `message:${stableTurnId}:${thinking ? "thinking" : "assistant"}`,
      streamId: `${thinking ? "thinking" : "assistant"}:live:${event.runId}:${turn}`,
      kind: thinking ? "thinking" : "text",
      text,
      anchorSequence: 0,
    });
    return true;
  }
  if (event.type === "tool.started") {
    const providerCallId = firstString(event.payload["providerCallId"]);
    const canonicalStart = event.payload["canonicalTranscriptStart"];
    const toolCallId =
      isJsonObject(canonicalStart) && typeof canonicalStart["toolCallId"] === "string"
        ? canonicalStart["toolCallId"]
        : undefined;
    if (providerCallId && toolCallId) toolCallIds.set(providerCallId, toolCallId);
    void overlay.complete(`thinking:live:${event.runId}:${turn}`);
    return false;
  }
  if (event.type === "tool.output") {
    const text = firstString(event.payload["chunk"]);
    const providerCallId = firstString(event.payload["providerCallId"]);
    const toolCallId = providerCallId ? toolCallIds.get(providerCallId) : undefined;
    if (!text || !event.sessionId || !toolCallId) return false;
    const stream = event.payload["stream"] === "stderr" ? "stderr" : "stdout";
    void overlay.append({
      sessionId: event.sessionId,
      runId: event.runId,
      turnId: stableTurnId,
      itemId: `tool:${toolCallId}`,
      streamId: `tool:live:${event.runId}:${toolCallId}:${stream}`,
      kind: "toolOutput",
      stream,
      text,
      anchorSequence: 0,
    });
    return true;
  }
  if (event.type === "assistant.message") {
    void overlay.complete(`assistant:live:${event.runId}:${turn}`);
    void overlay.complete(`thinking:live:${event.runId}:${turn}`);
  } else if (event.type === "tool.completed") {
    const result = event.payload["result"];
    const providerCallId =
      isJsonObject(result) && typeof result["toolCallId"] === "string"
        ? result["toolCallId"]
        : undefined;
    const toolCallId = providerCallId
      ? (toolCallIds.get(providerCallId) ?? providerCallId)
      : undefined;
    if (toolCallId) {
      void overlay.complete(`tool:live:${event.runId}:${toolCallId}:stdout`);
      void overlay.complete(`tool:live:${event.runId}:${toolCallId}:stderr`);
    }
  } else if (event.type === "run.finished" || event.type === "run.interrupted") {
    void overlay.flush();
  }
  return false;
}

export function publishDesktopReporterEvent(
  service: WorkspaceRuntimeService,
  workspacePath: string,
  event: DesktopReporterEvent,
  nextResourceVersion: () => number,
): void {
  if (
    [
      "run.started",
      "run.finished",
      "run.interrupted",
      "assistant.delta",
      "assistant.reasoning.delta",
      "assistant.message",
      "tool.output",
    ].includes(event.type)
  ) {
    return;
  }
  service.publishDesktopNotification(
    createRuntimeNotification({
      topic: "run.timeline",
      scope: {
        workspacePath,
        runId: event.runId,
        ...(event.sessionId ? { sessionId: event.sessionId } : {}),
      },
      resourceVersion: nextResourceVersion(),
      at: event.at,
      payload: { runId: event.runId, item: timelineItem(event) },
    }),
  );
}

function timelineItem(event: DesktopReporterEvent): JsonObject {
  const kind = event.type.startsWith("tool.")
    ? "tool"
    : event.type.startsWith("subagent.")
      ? "agent"
      : "status";
  const safePayload = safeTimelinePayload(event.type, event.payload);
  const thinkingStatus = event.type === "assistant.thinking";
  const state = thinkingStatus
    ? safePayload["active"] === false
      ? "done"
      : "active"
    : event.type.endsWith("completed") || event.type === "run.finished"
      ? "done"
      : "active";
  const detail = firstString(
    safePayload["content"],
    toolResultTimelineSummary(safePayload["result"]),
    safePayload["currentAction"],
    safePayload["summary"],
  );
  return jsonObject({
    ...(thinkingStatus ? { id: thinkingStatusId(event.runId, safePayload["turn"]) } : {}),
    kind,
    title: timelineTitle(event.type, safePayload),
    ...(detail ? { detail } : {}),
    state,
    eventType: event.type,
    data: safePayload,
  });
}

function thinkingStatusId(runId: string, turn: unknown): string {
  const safeTurn = typeof turn === "number" && Number.isSafeInteger(turn) ? turn : 0;
  return `status:thinking:${runId}:${safeTurn}`;
}

function safeTimelinePayload(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (type === "tool.completed") {
    return isJsonObject(payload["result"]) ? { result: payload["result"] } : {};
  }
  if (type === "subagent.trace" && payload["type"] === "tool.completed") {
    return {
      activityId: payload["activityId"],
      traceId: payload["traceId"],
      type: payload["type"],
      ...(isJsonObject(payload["result"]) ? { result: payload["result"] } : {}),
    };
  }
  return payload;
}

function timelineTitle(type: string, payload: Readonly<Record<string, unknown>>): string {
  if (type === "assistant.thinking") return "Pico 正在推理";
  if (type === "tool.started") return `开始 ${firstString(payload["toolName"]) ?? "工具"}`;
  if (type === "tool.completed") {
    const result = isJsonObject(payload["result"]) ? payload["result"] : undefined;
    return `完成 ${firstString(result?.["toolName"]) ?? "工具"}`;
  }
  if (type === "subagent.activity") {
    return firstString(payload["task"], payload["agentName"]) ?? "子代理状态更新";
  }
  if (type === "turn.started") return `第 ${String(payload["turn"] ?? "?")} 轮开始`;
  if (type === "run.finished") return "任务执行完成";
  if (type === "run.interrupted") return "任务已中断";
  return type;
}

function toolResultTimelineSummary(value: unknown): string | undefined {
  if (!isJsonObject(value)) return undefined;
  const size = value["rawSizeBytes"];
  const status = value["status"];
  if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) return undefined;
  return `${status === "succeeded" ? "Tool completed" : "Tool failed"} · ${size} bytes`;
}

function publishInteractionEvent(
  service: WorkspaceRuntimeService,
  interaction: PendingInteraction,
  event: DesktopInteractionEvent,
  pendingApprovals: Map<string, PendingInteraction>,
  pendingPrompts: Map<string, PendingInteraction>,
  resolvedApprovals: Map<string, InteractionScope>,
  resolvedPrompts: Map<string, InteractionScope>,
  nextResourceVersion: () => number,
): void {
  const scope = {
    workspacePath: interaction.workspacePath,
    sessionId: interaction.sessionId,
    runId: interaction.runId,
  };
  if (event.kind === "approval.pending") {
    const planNotice = event.notice as typeof event.notice & {
      readonly kind?: string;
    };
    const isPlan =
      planNotice.kind === "plan" ||
      event.notice.toolName === "exit_plan_mode" ||
      event.notice.toolName === "submit_plan";
    if (!isPlan) {
      pendingApprovals.set(
        interactionKey(interaction.workspacePath, event.notice.taskId),
        interaction,
      );
    }
    service.publishDesktopNotification(
      createRuntimeNotification({
        topic: "approval.requested",
        scope,
        resourceVersion: nextResourceVersion(),
        at: event.at,
        // providerCallId/diff/sessionScope 透传见 approval-wire.ts（3-D 漏账补齐）。
        payload: buildApprovalRequestedPayload(event.notice, interaction.runId),
      }),
    );
    return;
  }
  if (event.kind === "approval.settled") {
    const key = interactionKey(interaction.workspacePath, event.taskId);
    pendingApprovals.delete(key);
    rememberResolved(resolvedApprovals, key, interaction);
    service.publishDesktopNotification(
      createRuntimeNotification({
        topic: "approval.resolved",
        scope,
        resourceVersion: nextResourceVersion(),
        at: event.at,
        payload: {
          approvalId: event.taskId,
          decision:
            event.decision === "approve-session"
              ? "allow_session"
              : event.decision === "approve"
                ? "allow_once"
                : "deny",
        },
      }),
    );
    return;
  }
  if (event.kind === "prompt.pending") {
    pendingPrompts.set(
      interactionKey(interaction.workspacePath, event.request.requestId),
      interaction,
    );
    service.publishDesktopNotification(
      createRuntimeNotification({
        topic: "prompt.requested",
        scope,
        resourceVersion: nextResourceVersion(),
        at: event.at,
        payload: {
          promptId: event.request.requestId,
          runId: interaction.runId,
          prompt: jsonObject({
            question: event.request.question,
            ...(event.request.header ? { header: event.request.header } : {}),
            options: event.request.options.map((option) => ({
              optionId: option.optionId,
              label: option.label,
              ...(option.description ? { description: option.description } : {}),
            })),
            ...(event.request.freeText === true ? { freeText: true } : {}),
          }),
        },
      }),
    );
    return;
  }
  const key = interactionKey(interaction.workspacePath, event.requestId);
  pendingPrompts.delete(key);
  rememberResolved(resolvedPrompts, key, interaction);
  service.publishDesktopNotification(
    createRuntimeNotification({
      topic: "prompt.resolved",
      scope,
      resourceVersion: nextResourceVersion(),
      at: event.at,
      payload: { promptId: event.requestId },
    }),
  );
}

function unknownInteraction(kind: "Approval" | "Prompt", id: string): RuntimeProtocolError {
  return new RuntimeProtocolError(RUNTIME_ERROR_CODES.NOT_FOUND, `${kind} ${id} 不存在或已过期`);
}

function assertInteractionScope(
  expected: InteractionScope,
  requested: { readonly runId?: string; readonly sessionId?: string },
  kind: "Approval" | "Prompt",
  id: string,
  workspacePath: string,
): void {
  if (
    expected.workspacePath !== workspacePath ||
    (requested.runId !== undefined && requested.runId !== expected.runId) ||
    (requested.sessionId !== undefined && requested.sessionId !== expected.sessionId)
  ) {
    throw unknownInteraction(kind, id);
  }
}

function interactionKey(workspacePath: string, id: string): string {
  return `${workspacePath}\0${id}`;
}

function removeBrokerInteractions(
  interactions: Map<string, PendingInteraction>,
  broker: DesktopInteractionBroker,
): void {
  for (const [id, interaction] of interactions) {
    if (interaction.broker === broker) interactions.delete(id);
  }
}

function rememberResolved(
  interactions: Map<string, InteractionScope>,
  key: string,
  scope: InteractionScope,
): void {
  interactions.set(key, scope);
  if (interactions.size > 2_000) interactions.delete(interactions.keys().next().value as string);
}

function jsonObject(value: unknown): JsonObject {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) throw new Error("Desktop event is not JSON serializable");
  const parsed: unknown = JSON.parse(serialized);
  if (!isJsonObject(parsed) || !isJsonValue(parsed)) {
    throw new Error("Desktop event must be a JSON object");
  }
  return parsed as JsonObject;
}

function firstString(...values: readonly unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.length > 0);
}
