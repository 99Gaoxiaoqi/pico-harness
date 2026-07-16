import { join } from "node:path";
import { createCliSessionId } from "../cli/session-resolver.js";
import { globalSessionManager } from "../engine/session.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { createSessionRuntime } from "../runtime/session-runtime.js";
import { SilentReporter } from "../engine/reporter.js";
import { loadPicoConfig } from "../input/pico-config.js";
import { EffectiveConfigResolver } from "../input/effective-config.js";
import { UserConfigStore } from "../input/user-config-store.js";
import { resolveProjectMcpConfigPath } from "../mcp/config-path.js";
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
  type DesktopInteractionEvent,
} from "./desktop-interaction-broker.js";
import { DesktopReporter, type DesktopReporterEvent } from "./desktop-reporter.js";
import { DesktopRuntimeService } from "./desktop-runtime-service.js";
import { DesktopAutomationService } from "./desktop-automation-service.js";
import { resolveLocalDaemonEndpoint, type LocalDaemonEndpoint } from "./endpoint.js";
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

export interface ProductionLocalDaemonHostOptions {
  endpoint?: LocalDaemonEndpoint;
  registrationStore?: WorkspaceRegistrationStore;
  trustStore?: WorkspaceTrustStore;
  agentRuntime?: AgentRuntime;
  credentialVault?: CredentialVault;
  userConfigStore?: UserConfigStore;
  effectiveConfigResolver?: EffectiveConfigResolver;
  env?: Readonly<Record<string, string | undefined>>;
}

/**
 * Production-safe assembly. Cron remains the only autonomous source. Authenticated
 * run.start is foreground-only: it requires a trusted workspace and retains approval/
 * AskUser boundaries owned by this daemon.
 */
export function createProductionLocalDaemonHost(
  options: ProductionLocalDaemonHostOptions = {},
): LocalDaemonHost {
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
  const credentialVault =
    options.credentialVault ?? createPlatformCredentialVault(process.platform, env);
  const userConfigStore = options.userConfigStore ?? new UserConfigStore({ picoHome });
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
  let desktopResourceVersion = Date.now();
  const nextDesktopResourceVersion = () => ++desktopResourceVersion;
  const service = new WorkspaceRuntimeService({
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
      const session =
        globalSessionManager.get(targetSessionId, workspacePath, { picoHome }) ??
        (await globalSessionManager.getOrCreate(targetSessionId, workspacePath, {
          persistence: true,
          picoHome,
        }));
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
        execution?.requestedModel ?? persistedSettings?.modelRouteId ?? persistedSettings?.model,
        persistedSettings?.provider,
        env,
      );
      const reasoningLevel = coordinateReasoningLevel(
        route.capabilities.reasoningProfile,
        persistedSettings?.thinkingEffortExplicit ? persistedSettings.thinkingEffort : undefined,
      ).level;
      const runtimeState = await createSessionRuntime({
        session,
        env,
        ...(workspaceRuntime.taskHostRuntime
          ? { taskHostRuntime: workspaceRuntime.taskHostRuntime }
          : {}),
      });
      const broker = new DesktopInteractionBroker();
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
      const reporter = new DesktopReporter({
        runId: context.run.runId,
        sessionId: targetSessionId,
        publish: (event) =>
          publishTimelineEvent(service, workspacePath, event, nextDesktopResourceVersion),
      });
      for (const steer of context.drainSteers()) runtimeState.steerQueue.push(steer);
      const unsubscribeSteer = context.onSteer((message) => runtimeState.steerQueue.push(message));
      try {
        const skillActivation = execution?.skillActivation;
        if (skillActivation?.sourcePath && skillActivation.hooks !== undefined) {
          await runtimeState.activateComponentHooks({
            kind: "skill",
            path: skillActivation.sourcePath,
            componentId: skillActivation.name,
            inlineHooks: skillActivation.hooks,
          });
        }
        const result = await agentRuntime.execute(
          {
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
            ...(persistedSettings?.mode === "plan" ? { planMode: true } : {}),
            ...(persistedSettings?.mode ? { rewindInteractionMode: persistedSettings.mode } : {}),
            ...(persistedSettings?.mode === "plan" && persistedSettings.prePlanMode
              ? { rewindPrePlanMode: persistedSettings.prePlanMode }
              : {}),
            ...(execution?.allowedTools ? { allowedTools: execution.allowedTools } : {}),
            ...(await existingMcpConfig(workspacePath)),
          },
          {
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
            picoHome,
            env,
          },
        );
        return {
          sessionId: result.sessionId,
          finalMessage: result.finalMessage,
          usage: result.usage,
        };
      } finally {
        unsubscribeSteer();
        unsubscribeInteractions();
        broker.close();
        removeBrokerInteractions(pendingApprovals, broker);
        removeBrokerInteractions(pendingPrompts, broker);
        await runtimeState.dispose();
      }
    },
  });
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
    env,
    automations,
    userConfigStore,
    effectiveConfigResolver,
    credentialVault,
    interactions: {
      respondApproval: async (input) => {
        const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
        const respond = () => {
          const key = interactionKey(workspacePath, input.approvalId);
          const pending = pendingApprovals.get(key);
          if (!pending) {
            const resolved = resolvedApprovals.get(key);
            if (!resolved) throw unknownInteraction("Approval", input.approvalId);
            assertInteractionScope(resolved, input, "Approval", input.approvalId, workspacePath);
            return { accepted: true, alreadyResolved: true };
          }
          assertInteractionScope(pending, input, "Approval", input.approvalId, workspacePath);
          const accepted = pending.broker.resolveApproval({
            taskId: input.approvalId,
            decision:
              input.decision === "allow_session"
                ? "approve-session"
                : input.decision === "allow_once"
                  ? "approve"
                  : "reject",
            ...(input.reason ? { reason: input.reason } : {}),
          });
          if (!accepted) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.CONFLICT,
              `Approval ${input.approvalId} 已在另一请求中处理`,
            );
          }
          return { accepted, alreadyResolved: false };
        };
        if (!input.idempotencyKey) return respond();
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
          () => ({ result: respond() }),
        );
        return outcome.result;
      },
      respondPrompt: async (input) => {
        const workspacePath = await canonicalizeWorkspacePath(input.workspacePath);
        const respond = () => {
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
              "prompt.respond answer 必须是非空选项 ID 或标签",
            );
          }
          const accepted = pending.broker.answerPrompt(input.promptId, input.answer.trim());
          if (!accepted) {
            throw new RuntimeProtocolError(
              RUNTIME_ERROR_CODES.INVALID_PARAMS,
              `Prompt ${input.promptId} 的 answer 不是服务端提供的选项`,
            );
          }
          return { accepted, alreadyResolved: false };
        };
        if (!input.idempotencyKey) return respond();
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
          () => ({ result: respond() }),
        );
        return outcome.result;
      },
    },
  });
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
    endpoint: options.endpoint ?? resolveLocalDaemonEndpoint({ env }),
  });
  service.setRegistrationChangedListener(() => host.refreshRegisteredWorkspaces());
  return host;
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
      legacyModel: env["LLM_MODEL"]?.trim() ?? "",
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

function resolveDesktopRequestedModel(
  config: Awaited<ReturnType<typeof loadPicoConfig>>,
  requestedModel?: string,
): string | undefined {
  const requested = requestedModel?.trim();
  if (!requested || requested === "inherit") return config.model;
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

async function existingMcpConfig(
  workspacePath: string,
): Promise<{ readonly mcpConfigPath?: string }> {
  const resolution = await resolveProjectMcpConfigPath(workspacePath);
  return resolution.exists ? { mcpConfigPath: resolution.path } : {};
}

function publishTimelineEvent(
  service: WorkspaceRuntimeService,
  workspacePath: string,
  event: DesktopReporterEvent,
  nextResourceVersion: () => number,
): void {
  // WorkspaceRuntime is the sole lifecycle authority. Stream chunks and final assistant/tool
  // bodies already belong to the canonical transcript; without a separate bounded live channel,
  // duplicating them into the durable timeline only creates an unbounded second event stream.
  if (
    [
      "run.started",
      "run.finished",
      "run.interrupted",
      "assistant.delta",
      "assistant.message",
      "tool.output",
    ].includes(event.type)
  )
    return;
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
      payload: {
        runId: event.runId,
        item: timelineItem(event),
      },
    }),
  );
}

function timelineItem(event: DesktopReporterEvent): JsonObject {
  const kind = event.type.startsWith("tool.")
    ? "tool"
    : event.type.startsWith("subagent.")
      ? "agent"
      : "status";
  const state =
    event.type.endsWith("completed") || event.type === "run.finished" ? "done" : "active";
  const safePayload = safeTimelinePayload(event.type, event.payload);
  const detail = firstString(
    safePayload["content"],
    safePayload["resultSummary"],
    safePayload["currentAction"],
    safePayload["summary"],
  );
  return jsonObject({
    kind,
    title: timelineTitle(event.type, safePayload),
    ...(detail ? { detail } : {}),
    state,
    eventType: event.type,
    data: safePayload,
  });
}

function safeTimelinePayload(
  type: string,
  payload: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (type === "tool.completed") {
    const resultBytes =
      typeof payload["result"] === "string" ? Buffer.byteLength(payload["result"], "utf8") : 0;
    const isError = payload["isError"] === true;
    return {
      toolName: payload["toolName"],
      isError,
      truncated: payload["truncated"] === true,
      resultBytes,
      resultSummary: `${isError ? "Tool failed" : "Tool completed"} · ${resultBytes} bytes`,
      ...(typeof payload["providerCallId"] === "string"
        ? { providerCallId: payload["providerCallId"] }
        : {}),
    };
  }
  if (type === "subagent.trace" && payload["type"] === "tool.completed") {
    const resultBytes =
      typeof payload["result"] === "string" ? Buffer.byteLength(payload["result"], "utf8") : 0;
    const isError = payload["isError"] === true;
    return {
      activityId: payload["activityId"],
      traceId: payload["traceId"],
      type: payload["type"],
      isError,
      truncated: payload["truncated"] === true,
      resultBytes,
      resultSummary: `${isError ? "Tool failed" : "Tool completed"} · ${resultBytes} bytes`,
    };
  }
  return payload;
}

function timelineTitle(type: string, payload: Readonly<Record<string, unknown>>): string {
  if (type === "assistant.thinking") return "Pico 正在推理";
  if (type === "tool.started") return `开始 ${firstString(payload["toolName"]) ?? "工具"}`;
  if (type === "tool.completed") return `完成 ${firstString(payload["toolName"]) ?? "工具"}`;
  if (type === "subagent.activity") {
    return firstString(payload["task"], payload["agentName"]) ?? "子代理状态更新";
  }
  if (type === "turn.started") return `第 ${String(payload["turn"] ?? "?")} 轮开始`;
  if (type === "run.finished") return "任务执行完成";
  if (type === "run.interrupted") return "任务已中断";
  return type;
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
    pendingApprovals.set(
      interactionKey(interaction.workspacePath, event.notice.taskId),
      interaction,
    );
    service.publishDesktopNotification(
      createRuntimeNotification({
        topic: "approval.requested",
        scope,
        resourceVersion: nextResourceVersion(),
        at: event.at,
        payload: {
          approvalId: event.notice.taskId,
          runId: interaction.runId,
          request: jsonObject({
            title: "需要你的批准",
            detail: event.notice.preview?.summary ?? event.notice.message,
            toolName: event.notice.toolName,
            args: event.notice.args,
            ...(event.notice.preview?.target ? { command: event.notice.preview.target } : {}),
            risk: "high",
          }),
        },
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
