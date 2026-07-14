import { realpathSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createCliSessionId } from "../cli/session-resolver.js";
import { globalSessionManager } from "../engine/session.js";
import { AgentRuntime } from "../runtime/agent-runtime.js";
import { createSessionRuntime } from "../runtime/session-runtime.js";
import { SilentReporter } from "../engine/reporter.js";
import { loadPicoConfig } from "../input/pico-config.js";
import {
  assertCredentialRefMatchesModelRoute,
  credentialRefForModelRoute,
  createPlatformCredentialVault,
  parseCredentialRef,
  type CredentialVault,
} from "../provider/credential-vault.js";
import { resolveModelRouteCapabilities } from "../provider/model-capabilities.js";
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
import type { LocalDaemonEndpoint } from "./endpoint.js";
import {
  createRuntimeEvent,
  isJsonObject,
  isJsonValue,
  RUNTIME_ERROR_CODES,
  RuntimeProtocolError,
  type JsonObject,
} from "./protocol.js";
import { LocalDaemonHost } from "./runtime-host.js";
import { WorkspaceRegistrationStore } from "./workspace-registration.js";
import { WorkspaceRuntimeService } from "./workspace-runtime-service.js";

export interface ProductionLocalDaemonHostOptions {
  endpoint?: LocalDaemonEndpoint;
  registrationStore?: WorkspaceRegistrationStore;
  trustStore?: WorkspaceTrustStore;
  agentRuntime?: AgentRuntime;
  credentialVault?: CredentialVault;
}

/**
 * Production-safe assembly. Cron remains the only autonomous source. Authenticated
 * run.start is foreground-only: it requires a trusted workspace and retains approval/
 * AskUser boundaries owned by this daemon.
 */
export function createProductionLocalDaemonHost(
  options: ProductionLocalDaemonHostOptions = {},
): LocalDaemonHost {
  const trustStore = options.trustStore ?? new WorkspaceTrustStore();
  const agentRuntime = options.agentRuntime ?? new AgentRuntime();
  const credentialVault = options.credentialVault ?? createPlatformCredentialVault();
  const registrationStore = options.registrationStore ?? new WorkspaceRegistrationStore();
  const pendingApprovals = new Map<string, PendingInteraction>();
  const pendingPrompts = new Map<string, PendingInteraction>();
  const resolvedApprovals = new Set<string>();
  const resolvedPrompts = new Set<string>();
  let desktopResourceVersion = Date.now();
  const nextDesktopResourceVersion = () => ++desktopResourceVersion;
  const service = new WorkspaceRuntimeService({
    registrationStore,
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
        globalSessionManager.get(targetSessionId, workspacePath) ??
        (await globalSessionManager.getOrCreate(targetSessionId, workspacePath));
      const persistedSettings = (await session.readHydrationSnapshot()).runtime.settings;
      const route = await resolveDesktopModelRoute(
        workspacePath,
        credentialVault,
        execution?.requestedModel ?? persistedSettings?.modelRouteId ?? persistedSettings?.model,
      );
      const reasoningLevel = coordinateReasoningLevel(
        route.capabilities.reasoningProfile,
        persistedSettings?.thinkingEffortExplicit ? persistedSettings.thinkingEffort : undefined,
      ).level;
      const runtimeState = await createSessionRuntime({
        workDir: workspacePath,
        sessionId: targetSessionId,
        session,
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
            allowModelFallback: false,
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
            approvalNotifier: broker.notifyApproval,
            approvalManager: broker.approvalManager,
            askUserHandler: broker.askUserHandler,
            ...(execution?.resumeExistingSession ? { resumeExistingSession: true } : {}),
            waitAtSafeBoundary: context.waitAtSafeBoundary,
            rewindPointSink: context.bindCheckpoint,
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
    prepareSecurity: async (workspacePath) => {
      const route = await resolveDesktopAutomationRoute(workspacePath);
      const credentialRef = credentialRefForModelRoute(route, workspacePath);
      if (!(await credentialVault.has(credentialRef))) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.FORBIDDEN,
          `模型路由 ${route.id} 尚未导入系统凭证库，无法创建持久 Automation`,
        );
      }
      return {
        credentialRef,
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
    ensureWorkspaceRuntime: async (workspacePath) => {
      await registrationStore.register(workspacePath);
      if (host.status !== "running") {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          "Runtime daemon 尚未就绪，Automation 已保存为禁用状态",
        );
      }
      await host.refreshRegisteredWorkspaces();
      if (!host.registeredWorkspaces.includes(workspacePath)) {
        throw new RuntimeProtocolError(
          RUNTIME_ERROR_CODES.CONFLICT,
          `工作区 Cron runtime 启动失败: ${workspacePath}`,
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
    automations,
    interactions: {
      respondApproval: ({ workspacePath, approvalId, decision, reason }) => {
        const pending = pendingApprovals.get(approvalId);
        if (!pending) {
          if (resolvedApprovals.has(approvalId)) return { accepted: true, alreadyResolved: true };
          throw unknownInteraction("Approval", approvalId);
        }
        assertInteractionWorkspace(pending, workspacePath, "Approval", approvalId);
        const accepted = pending.broker.resolveApproval({
          taskId: approvalId,
          decision:
            decision === "allow_session"
              ? "approve-session"
              : decision === "allow_once"
                ? "approve"
                : "reject",
          ...(reason ? { reason } : {}),
        });
        if (!accepted) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.CONFLICT,
            `Approval ${approvalId} 已在另一请求中处理`,
          );
        }
        return { accepted, alreadyResolved: false };
      },
      respondPrompt: ({ workspacePath, promptId, answer }) => {
        const pending = pendingPrompts.get(promptId);
        if (!pending) {
          if (resolvedPrompts.has(promptId)) return { accepted: true, alreadyResolved: true };
          throw unknownInteraction("Prompt", promptId);
        }
        assertInteractionWorkspace(pending, workspacePath, "Prompt", promptId);
        if (typeof answer !== "string" || !answer.trim()) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            "prompt.respond answer 必须是非空选项 ID 或标签",
          );
        }
        const accepted = pending.broker.answerPrompt(promptId, answer.trim());
        if (!accepted) {
          throw new RuntimeProtocolError(
            RUNTIME_ERROR_CODES.INVALID_PARAMS,
            `Prompt ${promptId} 的 answer 不是服务端提供的选项`,
          );
        }
        return { accepted, alreadyResolved: false };
      },
    },
  });
  const validate = async (job: CronJobRecord): Promise<{ allowed: boolean; reason?: string }> => {
    try {
      await prepareBackgroundYoloPolicy({
        workDir: job.workspacePath,
        policy: job.policySnapshot,
        trustStore,
      });
      if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
      await resolveCronModelRoute(job);
      if (!(await credentialVault.has(job.credentialRef))) {
        throw new Error(`系统凭证库中不存在 ${job.credentialRef}`);
      }
      return { allowed: true };
    } catch (error) {
      return { allowed: false, reason: error instanceof Error ? error.message : String(error) };
    }
  };
  const cronRuntimeFactory = createCronWorkspaceRuntimeFactory({
    getWorkspaceRuntime: (workspacePath) => service.getWorkspaceRuntime(workspacePath),
    canRun: validate,
    policyGuard: {
      evaluate: (job) =>
        job.policySnapshot.hardlineVersion === BACKGROUND_HARDLINE_VERSION &&
        job.policySnapshot.hookVersion === BACKGROUND_HOOK_VERSION
          ? { allowed: true }
          : { allowed: false, reason: "background_policy_version_mismatch" },
    },
    execute: async (job, context) => {
      if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
      const route = await resolveCronModelRoute(job);
      const result = await agentRuntime.execute(
        {
          prompt: job.prompt,
          dir: job.workspacePath,
          provider: route.provider,
          baseURL: route.baseURL,
          model: route.model,
          modelRouteId: route.modelRouteId,
          modelCapabilities: route.capabilities,
          allowModelFallback: false,
          credentialRef: job.credentialRef,
          execution: { kind: "background", policy: job.policySnapshot },
        },
        {
          signal: context.signal,
          reporter: new SilentReporter(),
          backgroundTrustStore: trustStore,
          credentialResolver: credentialVault,
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
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  service.setRegistrationChangedListener(() => host.refreshRegisteredWorkspaces());
  return host;
}

async function resolveDesktopAutomationRoute(workspacePath: string) {
  const config = await loadPicoConfig(workspacePath);
  const modelRouteId = config.model;
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
    provider: provider.protocol,
    baseURL: provider.baseURL,
    model,
    apiKeyEnv: provider.apiKeyEnv,
  };
}

async function resolveCronModelRoute(job: CronJobRecord) {
  if (!job.credentialRef) throw new Error("Cron Job 缺少 credentialRef");
  const { modelRouteId } = parseCredentialRef(job.credentialRef);
  const slash = modelRouteId.indexOf("/");
  const providerId = modelRouteId.slice(0, slash);
  const model = modelRouteId.slice(slash + 1);
  const config = await loadPicoConfig(job.workspacePath);
  const provider = config.providers[providerId];
  if (!provider) throw new Error(`配置模型路由 ${modelRouteId} 的 provider 已不存在`);
  if (!provider.models.includes(model)) {
    throw new Error(`配置模型路由 ${modelRouteId} 不在显式 models 列表中`);
  }
  const resolved = {
    id: modelRouteId,
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
  assertCredentialRefMatchesModelRoute(job.credentialRef, resolved, job.workspacePath);
  return resolved;
}

interface PendingInteraction {
  readonly broker: DesktopInteractionBroker;
  readonly workspacePath: string;
  readonly runId: string;
  readonly sessionId: string;
}

async function resolveDesktopModelRoute(
  workspacePath: string,
  credentialVault: CredentialVault,
  requestedModel?: string,
) {
  const config = await loadPicoConfig(workspacePath);
  const modelRouteId = resolveDesktopRequestedModel(config, requestedModel);
  if (!modelRouteId) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      "工作区尚未配置默认 model 路由，无法启动桌面任务",
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
  const route = {
    id: modelRouteId,
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
  const environmentSecret = process.env[provider.apiKeyEnv]
    ?.split(",")
    .map((value) => value.trim())
    .find(Boolean);
  if (environmentSecret) return { ...route, apiKey: environmentSecret };

  const credentialRef = credentialRefForModelRoute(route, workspacePath);
  if (!(await credentialVault.has(credentialRef))) {
    throw new RuntimeProtocolError(
      RUNTIME_ERROR_CODES.FORBIDDEN,
      `模型路由 ${modelRouteId} 缺少系统凭证库凭证或环境变量 ${provider.apiKeyEnv}`,
    );
  }
  return { ...route, apiKey: await credentialVault.resolve(credentialRef) };
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
  const mcpConfigPath = join(workspacePath, ".claw", "mcp.json");
  try {
    if ((await stat(mcpConfigPath)).isFile()) return { mcpConfigPath };
  } catch (error) {
    if (!isNodeCode(error, "ENOENT")) throw error;
  }
  return {};
}

function publishTimelineEvent(
  service: WorkspaceRuntimeService,
  workspacePath: string,
  event: DesktopReporterEvent,
  nextResourceVersion: () => number,
): void {
  service.publishDesktopEvent(
    createRuntimeEvent({
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
  const detail = firstString(
    event.payload["content"],
    event.payload["result"],
    event.payload["currentAction"],
    event.payload["summary"],
  );
  return jsonObject({
    kind,
    title: timelineTitle(event.type, event.payload),
    ...(detail ? { detail } : {}),
    state,
    eventType: event.type,
    data: event.payload,
  });
}

function timelineTitle(type: string, payload: Readonly<Record<string, unknown>>): string {
  if (type === "assistant.thinking") return "Pico 正在推理";
  if (type === "assistant.message") return "Pico 已回复";
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
  resolvedApprovals: Set<string>,
  resolvedPrompts: Set<string>,
  nextResourceVersion: () => number,
): void {
  const scope = {
    workspacePath: interaction.workspacePath,
    sessionId: interaction.sessionId,
    runId: interaction.runId,
  };
  if (event.kind === "approval.pending") {
    pendingApprovals.set(event.notice.taskId, interaction);
    service.publishDesktopEvent(
      createRuntimeEvent({
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
    pendingApprovals.delete(event.taskId);
    rememberResolved(resolvedApprovals, event.taskId);
    service.publishDesktopEvent(
      createRuntimeEvent({
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
    pendingPrompts.set(event.request.requestId, interaction);
    service.publishDesktopEvent(
      createRuntimeEvent({
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
  pendingPrompts.delete(event.requestId);
  rememberResolved(resolvedPrompts, event.requestId);
  service.publishDesktopEvent(
    createRuntimeEvent({
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

function assertInteractionWorkspace(
  interaction: PendingInteraction,
  workspacePath: string,
  kind: "Approval" | "Prompt",
  id: string,
): void {
  if (
    canonicalInteractionPath(interaction.workspacePath) === canonicalInteractionPath(workspacePath)
  )
    return;
  throw new RuntimeProtocolError(
    RUNTIME_ERROR_CODES.FORBIDDEN,
    `${kind} ${id} 不属于请求中的工作区`,
  );
}

function canonicalInteractionPath(workspacePath: string): string {
  try {
    return realpathSync(workspacePath).normalize("NFC");
  } catch {
    return resolve(workspacePath).normalize("NFC");
  }
}

function removeBrokerInteractions(
  interactions: Map<string, PendingInteraction>,
  broker: DesktopInteractionBroker,
): void {
  for (const [id, interaction] of interactions) {
    if (interaction.broker === broker) interactions.delete(id);
  }
}

function rememberResolved(ids: Set<string>, id: string): void {
  ids.add(id);
  if (ids.size > 2_000) ids.delete(ids.values().next().value as string);
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

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
