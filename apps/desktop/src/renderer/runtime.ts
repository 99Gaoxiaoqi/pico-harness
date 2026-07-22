import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
  isJsonValue,
  type DesktopRuntimeMethod,
  type RuntimeProviderInput,
  type RuntimeParams,
  type RuntimeNotification,
  type RuntimeMemoryFact,
  type RuntimeMemoryProposal,
  type RuntimeMemoryReviewBudget,
  type RuntimeMemorySettings,
  type RuntimeMcpServerInput,
  type RuntimeResult,
  type RuntimeScopedMcpServer,
  type RuntimeScopedSkill,
  type RuntimeUserDefaults,
} from "@pico/protocol";
import type { DesktopBridge, DesktopResult } from "../preload/contract.js";
import {
  emptyData,
  folderWorkspaceCapabilities,
  type AppData,
  type CatalogAgentView,
  type CatalogSkillView,
  type CapabilitySourceView,
  type CapabilityView,
  type ChangeView,
  type ConnectionState,
  type ConversationView,
  type JsonRecord,
  type ModelRouteView,
  type MemoryFactPatch,
  type MemoryProposalPatch,
  type MemorySettingsPatch,
  type ProviderConfigView,
  type ProviderCredentialSource,
  type ProviderCredentialStatus,
  type ProviderDraft,
  type ProviderOrigin,
  type ProviderProtocol,
  type ProviderView,
  type RunView,
  type SessionView,
  type SessionSettingsView,
  type UserDefaultsView,
  type UsageView,
  type WorkspaceCapabilities,
  type WorkspaceMode,
  type WorkspaceView,
} from "./model.js";
import { previewData } from "./fixture.js";
import {
  replaceWorkspaceItems,
  workspaceName,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "./workspace-session.js";
import type {
  ComposerBehavior,
  ConversationItemView,
  ConversationProgressState,
} from "./conversation/types.js";
import {
  applyLiveAssistantUpdate,
  applyLiveReasoningUpdate,
  conversationItemKey,
  mergeHydratedConversationItems,
} from "./conversation/items.js";
import { applyTimelineNotification } from "./timeline.js";

const SHARED_CONFIG_CAPABILITY = "shared-config-v1";
const WORKSPACE_MEMORY_CAPABILITY = "workspace-memory-v1";
const MAX_RENDERER_SEEN_EVENT_IDS = 10_000;

export function isMemoryNotificationTopic(topic: string): boolean {
  return topic === "memory.proposed" || topic === "memory.changed" || topic === "memory.forgotten";
}

export function isMemoryConflict(error: unknown): boolean {
  return error instanceof RuntimeInvocationError && error.code === "CONFLICT";
}

function getBridge(): DesktopBridge | undefined {
  return window.pico;
}

export function isPreviewMode(): boolean {
  const params = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(window.location.hash.split("?")[1] ?? "");
  return params.get("demo") === "1" || hashParams.get("demo") === "1";
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function numberValue(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function booleanValue(value: unknown, fallback = false): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function recordArray(value: unknown): readonly JsonRecord[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function progressState(value: unknown): ConversationProgressState {
  return value === "done" || value === "failed" || value === "waiting" ? value : "active";
}

function formatRunDuration(startedAt: number, finishedAt: number): string | undefined {
  if (startedAt <= 0 || finishedAt <= startedAt) return undefined;
  const seconds = Math.max(1, Math.round((finishedAt - startedAt) / 1_000));
  if (seconds < 60) return `${seconds} 秒`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return remainingSeconds > 0 ? `${minutes} 分 ${remainingSeconds} 秒` : `${minutes} 分`;
}

function structuredItemId(
  kind: "approval" | "prompt" | "changes",
  data: JsonRecord,
  fallback: string,
): string {
  const sourceId = stringValue(
    kind === "approval" ? data.approvalId : kind === "prompt" ? data.promptId : data.runId,
  );
  return sourceId ? `${kind}:${sourceId}` : fallback;
}

function conversationItem(item: JsonRecord, index: number): ConversationItemView | undefined {
  const id = stringValue(item.id, `conversation-item-${index}`);
  const at = numberValue(item.at ?? item.startedAt) || undefined;
  const meta = {
    ...(at ? { at } : {}),
    ...(item.truncated === true
      ? { truncated: true, originalBytes: numberValue(item.originalBytes) || undefined }
      : {}),
  };
  if (item.kind === "userMessage" || item.kind === "assistantMessage") {
    const text = stringValue(item.content);
    if (!text) return undefined;
    return {
      id,
      kind: item.kind,
      text,
      ...(item.kind === "assistantMessage" && stringValue(item.runId)
        ? { runId: stringValue(item.runId) }
        : {}),
      ...(item.kind === "assistantMessage" && stringValue(item.turnId)
        ? { turnId: stringValue(item.turnId) }
        : {}),
      ...meta,
    };
  }
  if (item.kind === "thinking") {
    const text = stringValue(item.content);
    if (!text) return undefined;
    return {
      id,
      kind: "thinking",
      text,
      ...(stringValue(item.runId) ? { runId: stringValue(item.runId) } : {}),
      ...(stringValue(item.turnId) ? { turnId: stringValue(item.turnId) } : {}),
      ...meta,
    };
  }
  if (item.kind === "skill") {
    return {
      id,
      kind: "skill",
      name: stringValue(item.name, "Skill"),
      args: stringValue(item.args),
      trigger: item.trigger === "model-tool" ? "model-tool" : "user-slash",
      ...meta,
    };
  }
  if (item.kind === "tool") {
    return {
      id,
      kind: "tool",
      toolName: stringValue(item.name, "tool"),
      title: stringValue(item.name, "工具调用"),
      detail: stringValue(item.args) || undefined,
      output: stringValue(item.summary) || undefined,
      state: item.status === "success" ? "done" : item.status === "error" ? "failed" : "active",
      ...meta,
    };
  }
  if (item.kind === "plan") {
    return {
      id,
      kind: "plan",
      title: stringValue(item.title, "执行计划"),
      steps: [
        {
          id: `${id}:step`,
          title: stringValue(item.detail ?? item.title, "计划已更新"),
          state: progressState(item.state),
        },
      ],
      ...meta,
    };
  }
  if (item.kind === "runBoundary") {
    const status = stringValue(item.status);
    const viewStatus =
      status === "failed"
        ? "failed"
        : status === "cancelled"
          ? "interrupted"
          : status === "succeeded" || status === "completed"
            ? "completed"
            : "started";
    const labels = {
      started: "运行中",
      completed: "运行完成",
      interrupted: "运行已停止",
      failed: "运行失败",
    } as const;
    const duration = formatRunDuration(numberValue(item.startedAt), numberValue(item.finishedAt));
    return {
      id,
      kind: "runBoundary",
      status: viewStatus,
      label: labels[viewStatus],
      ...(duration ? { duration } : {}),
      ...(stringValue(item.detail ?? item.error)
        ? { detail: stringValue(item.detail ?? item.error) }
        : {}),
      ...meta,
    };
  }
  if (item.kind === "goal") {
    return {
      id,
      kind: "goal",
      title: stringValue(item.title, "当前目标"),
      detail: stringValue(item.detail) || undefined,
      state: progressState(item.state),
      ...meta,
    };
  }
  if (item.kind === "subagent") {
    return {
      id,
      kind: "subagent",
      name: stringValue(item.name, "Agent"),
      title: stringValue(item.title, "子代理活动"),
      detail: stringValue(item.detail) || undefined,
      state: progressState(item.state),
      ...meta,
    };
  }
  if (item.kind === "approval") {
    const data = isRecord(item.data) ? item.data : {};
    const decision = stringValue(data.decision ?? item.state);
    return {
      id: structuredItemId("approval", data, id),
      kind: "approval",
      title: stringValue(item.title, "需要你的批准"),
      detail: stringValue(item.detail, "Runtime 请求执行受保护操作。"),
      state:
        decision === "deny" || decision === "denied"
          ? "denied"
          : decision === "allow_once" || decision === "allow_session" || decision === "allowed"
            ? "allowed"
            : "pending",
      ...meta,
    };
  }
  if (item.kind === "prompt") {
    const data = isRecord(item.data) ? item.data : {};
    const state = stringValue(item.state);
    return {
      id: structuredItemId("prompt", data, id),
      kind: "prompt",
      question: stringValue(item.title, "Pico 需要你的回答"),
      detail: stringValue(item.detail) || undefined,
      state: state === "answered" || state === "resolved" ? "answered" : "pending",
      ...meta,
    };
  }
  if (item.kind === "changes") {
    const data = isRecord(item.data) ? item.data : {};
    return {
      id: structuredItemId("changes", data, id),
      kind: "changes",
      title: stringValue(item.title, "文件已修改"),
      detail: stringValue(item.detail) || undefined,
      files: Array.isArray(data.files)
        ? data.files.map((file) => stringValue(file)).filter(Boolean)
        : [],
      state: item.state === "applied" || item.state === "conflict" ? item.state : "pending",
      ...meta,
    };
  }
  if (item.kind === "systemNotice" || item.kind === "error") {
    return {
      id,
      kind: "status",
      title: stringValue(item.content, item.kind === "error" ? "运行失败" : "状态更新"),
      tone: item.kind === "error" ? "error" : "neutral",
      ...meta,
    };
  }
  return undefined;
}

function parseConversation(
  value: unknown,
  workspacePath: string,
  sessionId: string,
): ConversationView {
  const result = isRecord(value) ? value : {};
  return {
    workspacePath,
    sessionId,
    items: recordArray(result.items)
      .map(conversationItem)
      .filter((item): item is ConversationItemView => item !== undefined),
    revision: stringValue(result.revision) || undefined,
    nextBefore: stringValue(result.nextBefore) || undefined,
    queuedCount: recordArray(result.queuedInputs).length,
  };
}

function isTerminalRunStatus(status: string): boolean {
  return ["cancelled", "failed", "succeeded", "completed"].includes(status);
}

function interactionSessionId(
  data: AppData,
  workspacePath: string,
  explicitSessionId: string,
  runId: string,
): string | undefined {
  if (explicitSessionId) return explicitSessionId;
  return data.runs.find((run) => run.workspacePath === workspacePath && run.id === runId)
    ?.sessionId;
}

function resolveApprovalState(
  current: AppData,
  input: {
    readonly approvalId: string;
    readonly decision: string;
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly runId: string;
  },
): AppData {
  const pending = current.approvals.find((approval) => approval.id === input.approvalId);
  const sessionId = interactionSessionId(
    current,
    input.workspacePath,
    input.sessionId,
    input.runId || pending?.runId || "",
  );
  const conversationKey = sessionId
    ? workspaceSessionKey({ workspacePath: input.workspacePath, sessionId })
    : undefined;
  const conversation = conversationKey ? current.conversations[conversationKey] : undefined;
  const state: "allowed" | "denied" =
    input.decision === "deny" || input.decision === "denied" ? "denied" : "allowed";

  if (!sessionId || !conversationKey || !conversation) {
    return {
      ...current,
      approvals: current.approvals.filter((approval) => approval.id !== input.approvalId),
    };
  }

  const stableKey = `approval:${input.approvalId}`;
  let found = false;
  const items = conversation.items.map((item) => {
    if (item.kind !== "approval" || conversationItemKey(item) !== stableKey) return item;
    found = true;
    return { ...item, id: stableKey, state };
  });
  const resolvedItems =
    found || !pending
      ? items
      : [
          ...items,
          {
            id: stableKey,
            kind: "approval" as const,
            title: pending.title,
            detail: pending.detail,
            state,
          },
        ];

  return {
    ...current,
    approvals: current.approvals.filter((approval) => approval.id !== input.approvalId),
    conversations: {
      ...current.conversations,
      [conversationKey]: { ...conversation, items: resolvedItems },
    },
  };
}

function resolvePromptState(
  current: AppData,
  input: {
    readonly promptId: string;
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly runId: string;
  },
): AppData {
  const pending = current.prompts.find((prompt) => prompt.id === input.promptId);
  const sessionId = interactionSessionId(
    current,
    input.workspacePath,
    input.sessionId,
    input.runId || pending?.runId || "",
  );
  const conversationKey = sessionId
    ? workspaceSessionKey({ workspacePath: input.workspacePath, sessionId })
    : undefined;
  const conversation = conversationKey ? current.conversations[conversationKey] : undefined;

  if (!sessionId || !conversationKey || !conversation) {
    return {
      ...current,
      prompts: current.prompts.filter((prompt) => prompt.id !== input.promptId),
    };
  }

  const stableKey = `prompt:${input.promptId}`;
  let found = false;
  const items = conversation.items.map((item) => {
    if (item.kind !== "prompt" || conversationItemKey(item) !== stableKey) return item;
    found = true;
    return { ...item, id: stableKey, state: "answered" as const };
  });
  const resolvedItems =
    found || !pending
      ? items
      : [
          ...items,
          {
            id: stableKey,
            kind: "prompt" as const,
            question: pending.question,
            state: "answered" as const,
          },
        ];

  return {
    ...current,
    prompts: current.prompts.filter((prompt) => prompt.id !== input.promptId),
    conversations: {
      ...current.conversations,
      [conversationKey]: { ...conversation, items: resolvedItems },
    },
  };
}

function parseSessionSettings(value: unknown): SessionSettingsView | undefined {
  const result = isRecord(value) ? value : {};
  const settings = isRecord(result.settings) ? result.settings : result;
  const model = stringValue(settings.model);
  const mode = settings.mode;
  if (!model || (mode !== "default" && mode !== "plan" && mode !== "auto" && mode !== "yolo")) {
    return undefined;
  }
  return {
    modelRouteId: stringValue(settings.modelRouteId) || undefined,
    model,
    mode,
    thinkingEffort: stringValue(settings.thinkingEffort, "off"),
    reasoningLevels: Array.isArray(settings.reasoningLevels)
      ? settings.reasoningLevels.map((level) => stringValue(level)).filter(Boolean)
      : [],
  };
}

function parseGoalItem(value: unknown): ConversationItemView | undefined {
  const result = isRecord(value) ? value : {};
  const snapshot = isRecord(result.goal) ? result.goal : undefined;
  if (!snapshot) return undefined;
  const activeGoalId = stringValue(snapshot.activeGoalId);
  const goal = recordArray(snapshot.goals).find(
    (candidate) => stringValue(candidate.id) === activeGoalId,
  );
  if (!goal) return undefined;
  const status = stringValue(goal.status);
  return {
    id: `goal:${activeGoalId}`,
    kind: "goal",
    title: stringValue(goal.title, "当前目标"),
    detail: stringValue(goal.progress ?? goal.description) || undefined,
    state:
      status === "complete"
        ? "done"
        : status === "blocked"
          ? "failed"
          : status === "paused"
            ? "waiting"
            : "active",
  };
}

function parseModelRoutes(value: unknown): readonly ModelRouteView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.providers).flatMap((provider) => {
    const providerId = stringValue(provider.id);
    if (!providerId || !Array.isArray(provider.models)) return [];
    return provider.models
      .map((model) => stringValue(model))
      .filter(Boolean)
      .map((model) => ({ id: `${providerId}/${model}`, label: model }));
  });
}

function providerProtocol(value: unknown): ProviderProtocol {
  return value === "claude" || value === "gemini" ? value : "openai";
}

function providerOrigin(value: unknown): ProviderOrigin {
  return value === "project-legacy" || value === "environment" ? value : "user";
}

function providerCredentialStatus(value: unknown): ProviderCredentialStatus {
  return value === "ready" || value === "environment" || value === "unsupported"
    ? value
    : "missing";
}

function providerCredentialSource(value: unknown): ProviderCredentialSource {
  return value === "config" || value === "keychain" || value === "environment" ? value : "none";
}

function parseProviderProfile(value: JsonRecord, index: number): ProviderView {
  return {
    id: stringValue(value.id, `provider-${index}`),
    protocol: providerProtocol(value.protocol),
    baseURL: stringValue(value.baseURL),
    apiKeyEnv: stringValue(value.apiKeyEnv),
    models: Array.isArray(value.models)
      ? value.models.map((model) => stringValue(model)).filter(Boolean)
      : [],
    discoverModels: booleanValue(value.discoverModels),
    ...(isRecord(value.modelCapabilities) ? { modelCapabilities: value.modelCapabilities } : {}),
    origin: providerOrigin(value.origin),
    fingerprint: stringValue(value.fingerprint),
    credentialStatus: providerCredentialStatus(value.credentialStatus),
    credentialSource: providerCredentialSource(value.credentialSource),
    storedCredentialPresent: booleanValue(value.storedCredentialPresent),
  };
}

function parseUserDefaults(value: unknown): UserDefaultsView {
  const defaults = isRecord(value) ? value : {};
  const mode = defaults.mode;
  return {
    ...(stringValue(defaults.modelRouteId)
      ? { modelRouteId: stringValue(defaults.modelRouteId) }
      : {}),
    ...(mode === "default" || mode === "plan" || mode === "auto" || mode === "yolo"
      ? { mode }
      : {}),
    ...(stringValue(defaults.thinkingEffort)
      ? { thinkingEffort: stringValue(defaults.thinkingEffort) }
      : {}),
  };
}

function parseProviderConfig(
  results: Readonly<Record<string, unknown>>,
  supported: boolean,
): ProviderConfigView {
  if (!supported) {
    return {
      supported: false,
      writable: false,
      revision: "",
      userDefaults: {},
      providers: [],
    };
  }
  const registryResult = isRecord(results.providerRegistry) ? results.providerRegistry : {};
  const userResult = isRecord(results.userConfig) ? results.userConfig : {};
  const userConfig = isRecord(userResult.config) ? userResult.config : {};
  const effectiveResult = isRecord(results.effectiveConfig) ? results.effectiveConfig : {};
  const effectiveConfig = isRecord(effectiveResult.config) ? effectiveResult.config : {};
  const effectiveProviders = recordArray(effectiveConfig.providers);
  const registryProviders = recordArray(registryResult.providers);
  const revision = stringValue(registryResult.revision ?? userResult.revision);
  const writable =
    isRecord(results.providerRegistry) && isRecord(results.userConfig) && revision.length > 0;
  const defaultModelRouteId = stringValue(
    effectiveConfig.defaultModelRouteId ??
      (isRecord(userConfig.defaults) ? userConfig.defaults.modelRouteId : undefined),
  );
  return {
    supported: true,
    writable,
    revision,
    ...(defaultModelRouteId ? { defaultModelRouteId } : {}),
    userDefaults: parseUserDefaults(userConfig.defaults),
    providers: (effectiveProviders.length > 0 ? effectiveProviders : registryProviders).map(
      parseProviderProfile,
    ),
  };
}

function parseCatalogAgents(value: unknown): readonly CatalogAgentView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.agents).map((agent) => ({
    name: stringValue(agent.name, "未命名 Agent"),
    description: stringValue(agent.description, "由当前 Runtime 提供。"),
    source: stringValue(agent.source, "runtime"),
    tools: Array.isArray(agent.tools)
      ? agent.tools.map((tool) => stringValue(tool)).filter(Boolean)
      : [],
    modelRouteId: stringValue(agent.modelRouteId) || undefined,
  }));
}

function parseCatalogSkills(value: unknown): readonly CatalogSkillView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.skills).map((skill) => ({
    name: stringValue(skill.name, "未命名 Skill"),
    description: stringValue(skill.description, "由当前 Runtime 提供。"),
    allowedTools: Array.isArray(skill.allowedTools)
      ? skill.allowedTools.map((tool) => stringValue(tool)).filter(Boolean)
      : [],
    model: stringValue(skill.model) || undefined,
  }));
}

function parseChanges(value: unknown): {
  readonly changes: readonly ChangeView[];
  readonly fingerprint?: string | undefined;
} {
  const result = isRecord(value) ? value : {};
  return {
    changes: recordArray(result.changes).map((item) => ({
      path: stringValue(item.path),
      status:
        item.status === "added" || item.status === "deleted" || item.status === "renamed"
          ? item.status
          : "modified",
      additions: numberValue(item.additions),
      deletions: numberValue(item.deletions),
      patch: stringValue(item.patch) || undefined,
    })),
    fingerprint: stringValue(result.fingerprint) || undefined,
  };
}

function parseUsage(value: unknown): UsageView {
  const result = isRecord(value) ? value : {};
  const usage = isRecord(result.usage) ? result.usage : result;
  const total = isRecord(usage.total) ? usage.total : usage;
  return {
    inputTokens: numberValue(total.inputTokens || total.input_tokens) || undefined,
    outputTokens: numberValue(total.outputTokens || total.output_tokens) || undefined,
    cachedTokens: numberValue(total.cachedTokens || total.cached_tokens) || undefined,
    cost: numberValue(total.cost) || undefined,
    period: stringValue(usage.period || usage.rangeAccuracy),
  };
}

function capability(item: JsonRecord, index: number): CapabilityView {
  const enabled = item.enabled;
  const configured = item.configured;
  return {
    id: stringValue(item.id ?? item.name, `capability-${index}`),
    name: stringValue(item.name ?? item.id, "未命名能力"),
    description: stringValue(item.description, "由当前 Runtime 提供。"),
    state:
      configured === false || enabled === false
        ? ("disabled" as const)
        : item.error
          ? ("attention" as const)
          : ("ready" as const),
    meta: stringValue(item.model ?? item.version ?? item.status),
  };
}

function capabilitySource(
  source: RuntimeScopedSkill["source"] | RuntimeScopedMcpServer["source"],
): CapabilitySourceView {
  return {
    scope: source.scope,
    sourceId: source.sourceId,
    sourceLabel: source.sourceLabel,
    readOnly: source.readOnly,
    effective: source.effective,
    ...(source.shadowedBy ? { shadowedBy: source.shadowedBy } : {}),
  };
}

function scopedSkill(skill: RuntimeScopedSkill, index: number): CapabilityView {
  return {
    id: `${skill.source.sourceId}:${skill.name}:${index}`,
    name: skill.name,
    description: skill.description,
    state: skill.source.effective ? "ready" : "disabled",
    meta:
      skill.model ??
      (skill.allowedTools && skill.allowedTools.length > 0
        ? `${skill.allowedTools.length} 个工具`
        : undefined),
    source: capabilitySource(skill.source),
  };
}

function scopedMcpServer(server: RuntimeScopedMcpServer, index: number): CapabilityView {
  const endpoint =
    server.transport === "stdio"
      ? `${server.commandLabel}${server.hasArguments ? " · 含启动参数" : ""}`
      : server.endpointLabel;
  return {
    id: `${server.source.sourceId}:${server.name}:${index}`,
    name: server.name,
    description: endpoint ? `${server.transport.toUpperCase()} · ${endpoint}` : server.transport,
    state: server.enabled === false ? "disabled" : server.source.effective ? "ready" : "attention",
    meta: server.transport,
    source: capabilitySource(server.source),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Runtime 返回了未知错误。";
}

export class RuntimeInvocationError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(`${code}: ${message}`);
    this.name = "RuntimeInvocationError";
  }
}

async function invoke<Method extends DesktopRuntimeMethod>(
  bridge: DesktopBridge,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<RuntimeResult<Method>> {
  const call = bridge.runtime[method];
  const result = await call(params);
  if (!result.ok) {
    throw new RuntimeInvocationError(
      result.error.code,
      result.error.message,
      result.error.retryable,
    );
  }
  return result.value;
}

async function optionalInvoke<Method extends DesktopRuntimeMethod>(
  bridge: DesktopBridge,
  method: Method,
  params: RuntimeParams<Method>,
): Promise<
  | { readonly value: RuntimeResult<Method>; readonly error?: never }
  | { readonly value?: never; readonly error: string }
> {
  try {
    return { value: await invoke(bridge, method, params) };
  } catch (error) {
    return { error: errorMessage(error) };
  }
}

async function optionalEntry<Key extends string, Method extends DesktopRuntimeMethod>(
  key: Key,
  bridge: DesktopBridge,
  method: Method,
  params: RuntimeParams<Method>,
) {
  return [key, await optionalInvoke(bridge, method, params)] as const;
}

function parseWorkspaceList(value: unknown): readonly JsonRecord[] {
  if (!isRecord(value)) return [];
  return recordArray(value.workspaces);
}

function parseSessions(value: unknown, workspacePath: string): readonly SessionView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.sessions)
    .map((item, index) => ({
      id: stringValue(item.sessionId ?? item.id, `session-${index}`),
      workspacePath,
      title: stringValue(item.title, "未命名任务"),
      status: item.status === "archived" ? ("archived" as const) : ("active" as const),
      pinned: booleanValue(item.pinned),
      updatedAt: numberValue(item.updatedAt, Date.now()),
      summary: stringValue(item.summary),
    }))
    .sort(compareSessions);
}

function compareSessions(left: SessionView, right: SessionView): number {
  return (
    Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) || right.updatedAt - left.updatedAt
  );
}

function parseRuns(value: unknown, workspacePath: string): readonly RunView[] {
  const result = isRecord(value) ? value : {};
  return recordArray(result.runs)
    .map((item, index) => ({
      id: stringValue(item.runId ?? item.id, `run-${index}`),
      workspacePath,
      sessionId: stringValue(item.sessionId) || undefined,
      description: stringValue(item.description, "任务运行"),
      status: stringValue(item.status, "unknown"),
      startedAt: numberValue(item.startedAt, Date.now()),
      updatedAt: numberValue(item.updatedAt, Date.now()),
    }))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

function parseWorkspaceMode(value: unknown, fallback?: WorkspaceMode): WorkspaceMode | undefined {
  return value === "git" || value === "folder" ? value : fallback;
}

function parseWorkspaceCapabilities(
  value: unknown,
  mode: WorkspaceMode | undefined,
  fallback: WorkspaceCapabilities,
): WorkspaceCapabilities {
  const capabilities = isRecord(value) ? value : {};
  const defaults =
    mode === "git"
      ? {
          foregroundRuns: true,
          fileHistory: true,
          isolatedWorktrees: true,
          branchMerge: true,
        }
      : mode === "folder"
        ? folderWorkspaceCapabilities
        : fallback;
  return {
    foregroundRuns: booleanValue(capabilities.foregroundRuns, defaults.foregroundRuns),
    fileHistory: booleanValue(capabilities.fileHistory, defaults.fileHistory),
    isolatedWorktrees: booleanValue(capabilities.isolatedWorktrees, defaults.isolatedWorktrees),
    branchMerge: booleanValue(capabilities.branchMerge, defaults.branchMerge),
  };
}

function mergeLoadedData(
  base: AppData,
  workspacePath: string,
  results: Readonly<Record<string, unknown>>,
): AppData {
  const workspaceResult = isRecord(results.workspace) ? results.workspace : {};
  const workspaceMode = parseWorkspaceMode(workspaceResult.mode, base.workspaceMode);
  const jobResult = isRecord(results.jobs) ? results.jobs : {};
  const providerResult = isRecord(results.legacyProviders) ? results.legacyProviders : {};
  const usageResult = isRecord(results.usage) ? results.usage : {};
  const usage = isRecord(usageResult.usage) ? usageResult.usage : {};
  const usageTotal = isRecord(usage.total) ? usage.total : usage;
  const configResult = isRecord(results.config) ? results.config : {};
  const changeResult = isRecord(results.changes) ? results.changes : {};
  const agentCatalogResult = isRecord(results.agentCatalog) ? results.agentCatalog : {};
  const skillCatalogResult = isRecord(results.skillCatalog) ? results.skillCatalog : {};

  return {
    ...base,
    workspaceMode,
    workspaceBranch: stringValue(workspaceResult.branch) || undefined,
    workspaceCapabilities: parseWorkspaceCapabilities(
      workspaceResult.capabilities,
      workspaceMode,
      base.workspaceCapabilities,
    ),
    sessions: [
      ...replaceWorkspaceItems(
        base.sessions,
        workspacePath,
        parseSessions(results.sessions, workspacePath),
      ),
    ].sort(compareSessions),
    runs: [
      ...replaceWorkspaceItems(base.runs, workspacePath, parseRuns(results.runs, workspacePath)),
    ].sort((left, right) => right.updatedAt - left.updatedAt),
    jobs: recordArray(jobResult.jobs).map((item, index) => ({
      id: stringValue(item.jobId ?? item.id, `job-${index}`),
      name: stringValue(item.name, "未命名自动化"),
      prompt: stringValue(item.prompt),
      schedule: stringValue(item.schedule),
      enabled: booleanValue(item.enabled),
      status: stringValue(item.status, "idle"),
      updatedAt: numberValue(item.updatedAt, Date.now()),
    })),
    providers: recordArray(providerResult.providers).map(capability),
    providerConfig: parseProviderConfig(results, base.providerConfig.supported),
    modelRoutes: parseModelRoutes(
      isRecord(results.effectiveConfig) && isRecord(results.effectiveConfig.config)
        ? results.effectiveConfig.config
        : providerResult,
    ),
    catalogAgents: parseCatalogAgents(agentCatalogResult),
    catalogSkills: parseCatalogSkills(skillCatalogResult),
    changes: recordArray(changeResult.changes).map((item) => ({
      path: stringValue(item.path),
      status:
        item.status === "added" || item.status === "deleted" || item.status === "renamed"
          ? item.status
          : "modified",
      additions: numberValue(item.additions),
      deletions: numberValue(item.deletions),
      patch: stringValue(item.patch) || undefined,
    })),
    changeFingerprint: stringValue(changeResult.fingerprint) || undefined,
    usage: {
      inputTokens: numberValue(usageTotal.inputTokens || usageTotal.input_tokens) || undefined,
      outputTokens: numberValue(usageTotal.outputTokens || usageTotal.output_tokens) || undefined,
      cachedTokens: numberValue(usageTotal.cachedTokens || usageTotal.cached_tokens) || undefined,
      cost: numberValue(usageTotal.cost) || undefined,
      period: stringValue(usage.period || usage.rangeAccuracy),
    },
    configVersion: numberValue(configResult.version),
  };
}

export interface RuntimeActions {
  chooseWorkspace(): Promise<string | undefined>;
  selectWorkspace(workspacePath: string): Promise<void>;
  trustWorkspace(workspacePath: string, trusted: boolean): Promise<void>;
  reload(): Promise<void>;
  loadSession(ref: WorkspaceSessionRef): Promise<void>;
  loadEarlierSession(ref: WorkspaceSessionRef): Promise<void>;
  sendMessage(input: {
    readonly workspacePath: string;
    readonly sessionId?: string;
    readonly text: string;
    readonly behavior?: ComposerBehavior;
    readonly expectedRunId?: string;
    readonly activation?:
      | { readonly kind: "skill"; readonly name: string }
      | { readonly kind: "agent"; readonly name: string };
  }): Promise<{
    readonly succeeded: boolean;
    readonly workspacePath?: string | undefined;
    readonly sessionId?: string | undefined;
  }>;
  renameSession(ref: WorkspaceSessionRef, title: string): Promise<void>;
  forkSession(ref: WorkspaceSessionRef): Promise<WorkspaceSessionRef | undefined>;
  compactSession(ref: WorkspaceSessionRef): Promise<void>;
  updateSessionSettings(
    ref: WorkspaceSessionRef,
    patch: Readonly<{
      modelRouteId?: string;
      mode?: "default" | "plan" | "auto" | "yolo";
      thinkingEffort?: string;
    }>,
  ): Promise<void>;
  setSessionArchived(ref: WorkspaceSessionRef, archived: boolean): Promise<void>;
  setSessionPinned(ref: WorkspaceSessionRef, pinned: boolean): Promise<void>;
  deleteSession(ref: WorkspaceSessionRef): Promise<boolean>;
  pauseRun(runId: string): Promise<void>;
  resumeRun(runId: string): Promise<void>;
  stopRun(runId: string): Promise<void>;
  steerRun(runId: string, message: string): Promise<void>;
  respondApproval(id: string, decision: "allow_once" | "allow_session" | "deny"): Promise<void>;
  respondPrompt(id: string, answer: string): Promise<void>;
  reviewChanges(
    decision: "approve" | "request_changes",
    message?: string,
    target?: { readonly runId: string; readonly fingerprint: string },
  ): Promise<void>;
  applyChanges(target?: { readonly runId: string; readonly fingerprint: string }): Promise<void>;
  previewRewind(ref: WorkspaceSessionRef): Promise<
    | {
        readonly checkpointId: string;
        readonly fingerprint: string;
        readonly changeCount: number;
      }
    | undefined
  >;
  applyRewind(ref: WorkspaceSessionRef, checkpointId: string, fingerprint: string): Promise<void>;
  toggleJob(id: string, enabled: boolean): Promise<void>;
  createJob(input: {
    readonly name: string;
    readonly prompt: string;
    readonly schedule: string;
  }): Promise<void>;
  runJob(id: string): Promise<void>;
  deleteJob(id: string): Promise<void>;
  loadCapabilityScope(kind: "skills" | "mcp", workspacePath?: string): Promise<void>;
  addUserMcp(server: RuntimeMcpServerInput): Promise<boolean>;
  deleteUserMcp(serverName: string): Promise<boolean>;
  upsertProvider(provider: ProviderDraft): Promise<boolean>;
  deleteProvider(providerId: string): Promise<boolean>;
  setDefaultModelRoute(modelRouteId?: string): Promise<boolean>;
  setProviderCredential(
    providerId: string,
    secret: string,
    expectedRevision: string,
  ): Promise<boolean>;
  deleteProviderCredential(providerId: string, expectedRevision: string): Promise<boolean>;
  refreshMemory(): Promise<void>;
  updateMemoryFact(
    factId: string,
    expectedVersion: number,
    patch: MemoryFactPatch,
  ): Promise<RuntimeMemoryFact | undefined>;
  forgetMemoryFact(factId: string, expectedVersion: number): Promise<boolean>;
  resolveMemoryProposal(
    proposalId: string,
    expectedVersion: number,
    resolution: "accepted" | "rejected",
    patch?: MemoryProposalPatch,
  ): Promise<
    | {
        readonly proposal: RuntimeMemoryProposal;
        readonly fact?: RuntimeMemoryFact | undefined;
      }
    | undefined
  >;
  updateMemorySettings(
    expectedVersion: number,
    patch: MemorySettingsPatch,
  ): Promise<RuntimeMemorySettings | undefined>;
  setLaunchAtLogin(enabled: boolean): Promise<void>;
  setBackgroundMode(enabled: boolean): Promise<void>;
  openWorkspace(): Promise<void>;
  initializeWorkspace(): Promise<void>;
  runDiagnostics(kind: "runtime" | "resources"): Promise<string | undefined>;
}

export interface RuntimeStore {
  readonly preview: boolean;
  readonly connection: ConnectionState;
  readonly data: AppData;
  readonly busy: string | undefined;
  readonly message: string | undefined;
  readonly actions: RuntimeActions;
}

export function useRuntimeStore(): RuntimeStore {
  const preview = useMemo(isPreviewMode, []);
  const [connection, setConnection] = useState<ConnectionState>(
    preview ? { kind: "ready" } : { kind: "loading" },
  );
  const [data, setData] = useState<AppData>(preview ? previewData : emptyData);
  const [busy, setBusy] = useState<string>();
  const [message, setMessage] = useState<string>();
  const dataRef = useRef(data);
  const runtimeCapabilitiesRef = useRef(
    new Set<string>(
      preview
        ? [
            SHARED_CONFIG_CAPABILITY,
            WORKSPACE_MEMORY_CAPABILITY,
            CAPABILITY_SCOPE_RUNTIME_CAPABILITY,
          ]
        : [],
    ),
  );
  const seenEventIdsRef = useRef(new Set<string>());
  const workspaceLoadGenerationRef = useRef(0);
  const memoryLoadGenerationRef = useRef(0);
  const conversationLoadGenerationsRef = useRef(new Map<string, number>());
  const pendingSendRef = useRef<
    | {
        readonly identity: string;
        readonly idempotencyKey: string;
      }
    | undefined
  >(undefined);
  dataRef.current = data;

  const reportFailure = useCallback((error: unknown) => {
    setMessage(errorMessage(error));
  }, []);

  const loadWorkspaceIndex = useCallback(
    async (bridge: DesktopBridge, reset = false): Promise<readonly WorkspaceView[]> => {
      const workspaceValue = await invoke(bridge, "workspace.list", {});
      const indexed = await Promise.all(
        parseWorkspaceList(workspaceValue).flatMap((workspace) => {
          const workspacePath = stringValue(workspace.workspacePath);
          if (!workspacePath || !booleanValue(workspace.registered, true)) return [];
          return [
            (async () => {
              const trust = await optionalInvoke(bridge, "workspace.trustStatus", {
                workspacePath,
              });
              const trusted = booleanValue(trust.value?.trusted);
              const [sessions, runs] = trusted
                ? await Promise.all([
                    optionalInvoke(bridge, "session.list", {
                      workspacePath,
                      includeArchived: true,
                    }),
                    optionalInvoke(bridge, "runs.list", { workspacePath }),
                  ])
                : [{ value: { sessions: [] } }, { value: { runs: [] } }];
              return {
                workspace: {
                  path: workspacePath,
                  name: workspaceName(workspacePath),
                  mode: parseWorkspaceMode(workspace.mode, "folder") ?? "folder",
                  registered: true,
                  trusted,
                } satisfies WorkspaceView,
                sessions: parseSessions(sessions.value, workspacePath),
                runs: parseRuns(runs.value, workspacePath),
              };
            })(),
          ];
        }),
      );
      const workspaces = indexed.map((item) => item.workspace);
      const sessions = indexed.flatMap((item) => item.sessions).sort(compareSessions);
      const runs = indexed
        .flatMap((item) => item.runs)
        .sort((left, right) => right.updatedAt - left.updatedAt);
      setData((current) => {
        const base = reset ? emptyData : current;
        return {
          ...base,
          workspaces,
          sessions,
          runs,
          providerConfig: {
            ...base.providerConfig,
            supported: runtimeCapabilitiesRef.current.has(SHARED_CONFIG_CAPABILITY),
          },
        };
      });
      return workspaces;
    },
    [],
  );

  const loadUserCapabilities = useCallback(async (bridge: DesktopBridge) => {
    if (!runtimeCapabilitiesRef.current.has(CAPABILITY_SCOPE_RUNTIME_CAPABILITY)) {
      setData((current) => ({
        ...current,
        notices: {
          ...current.notices,
          skills: "当前 Runtime 未提供全局 Skills 作用域能力。",
          mcp: "当前 Runtime 未提供全局 MCP 作用域能力。",
        },
      }));
      return;
    }
    const [skillResult, mcpResult] = await Promise.all([
      optionalInvoke(bridge, "skills.user.list", {}),
      optionalInvoke(bridge, "mcp.user.list", {}),
    ]);
    setData((current) => {
      const skills = skillResult.value?.skills.map(scopedSkill);
      const mcpServers = mcpResult.value?.servers.map(scopedMcpServer);
      const skillRevision = skillResult.value?.revision;
      const mcpRevision = mcpResult.value?.revision;
      const notices = { ...current.notices };
      if (skillResult.error) notices.skills = skillResult.error;
      else delete notices.skills;
      if (mcpResult.error) notices.mcp = mcpResult.error;
      else delete notices.mcp;
      return {
        ...current,
        ...(skills && skillRevision
          ? {
              skills: current.skillScope.workspacePath ? current.skills : skills,
              skillScope: {
                ...current.skillScope,
                userItems: skills,
                userRevision: skillRevision,
              },
            }
          : {}),
        ...(mcpServers && mcpRevision
          ? {
              mcpServers: current.mcpScope.workspacePath ? current.mcpServers : mcpServers,
              mcpScope: {
                ...current.mcpScope,
                userItems: mcpServers,
                userRevision: mcpRevision,
              },
            }
          : {}),
        notices,
      };
    });
  }, []);

  const loadScopedCapabilities = useCallback(
    async (bridge: DesktopBridge, kind: "skills" | "mcp", workspacePath?: string) => {
      if (!workspacePath) {
        await loadUserCapabilities(bridge);
        setData((current) => ({
          ...current,
          ...(kind === "skills"
            ? {
                skills: current.skillScope.userItems,
                skillScope: { ...current.skillScope, workspacePath: undefined },
              }
            : {
                mcpServers: current.mcpScope.userItems,
                mcpScope: { ...current.mcpScope, workspacePath: undefined },
              }),
        }));
        return;
      }
      try {
        if (kind === "skills") {
          const result = await invoke(bridge, "skills.effective.list", { workspacePath });
          setData((current) => {
            const notices = { ...current.notices };
            delete notices.skills;
            return {
              ...current,
              skills: result.skills.map(scopedSkill),
              skillScope: { ...current.skillScope, workspacePath },
              notices,
            };
          });
        } else {
          const result = await invoke(bridge, "mcp.effective.list", { workspacePath });
          setData((current) => {
            const notices = { ...current.notices };
            delete notices.mcp;
            return {
              ...current,
              mcpServers: result.servers.map(scopedMcpServer),
              mcpScope: { ...current.mcpScope, workspacePath },
              notices,
            };
          });
        }
      } catch (error) {
        const detail =
          error instanceof RuntimeInvocationError && error.code === "FORBIDDEN"
            ? "该项目尚未信任，无法读取项目级能力；已继续显示用户级列表。"
            : `${errorMessage(error)}；已继续显示用户级列表。`;
        setData((current) => ({
          ...current,
          ...(kind === "skills"
            ? {
                skills: current.skillScope.userItems,
                skillScope: { ...current.skillScope, workspacePath: undefined },
              }
            : {
                mcpServers: current.mcpScope.userItems,
                mcpScope: { ...current.mcpScope, workspacePath: undefined },
              }),
          notices: {
            ...current.notices,
            [kind]: detail,
          },
        }));
        throw error;
      }
    },
    [loadUserCapabilities],
  );

  const loadMemory = useCallback(
    async (bridge: DesktopBridge, workspacePath: string) => {
      const generation = memoryLoadGenerationRef.current + 1;
      memoryLoadGenerationRef.current = generation;
      const isCurrentLoad = () =>
        memoryLoadGenerationRef.current === generation &&
        dataRef.current.workspacePath === workspacePath;
      if (!runtimeCapabilitiesRef.current.has(WORKSPACE_MEMORY_CAPABILITY)) {
        setData((current) => ({
          ...current,
          memory: {
            workspacePath,
            facts: [],
            proposals: [],
            status: "degraded",
            error: "当前 Runtime 未提供工作区记忆能力。请完整重启 Pico 后重试。",
          },
        }));
        return;
      }
      if (preview) {
        setData((current) => ({ ...current, memory: previewData.memory }));
        return;
      }
      setData((current) => ({
        ...current,
        memory: { ...current.memory, workspacePath, status: "loading", error: undefined },
      }));
      try {
        const [factsResult, proposalsResult, settingsResult] = await Promise.all([
          invoke(bridge, "memory.list", {
            workspacePath,
            states: ["active", "disabled", "archived"],
            limit: 500,
          }),
          invoke(bridge, "memory.review.list", {
            workspacePath,
            statuses: ["pending"],
            limit: 500,
          }),
          invoke(bridge, "memory.settings.get", { workspacePath }),
        ]);
        if (!isCurrentLoad()) return;
        setData((current) => ({
          ...current,
          memory: {
            workspacePath,
            facts: factsResult.facts,
            proposals: proposalsResult.proposals,
            settings: settingsResult.settings,
            reviewBudget: settingsResult.reviewBudget,
            status: "ready",
          },
        }));
      } catch (error) {
        if (isCurrentLoad()) {
          setData((current) => ({
            ...current,
            memory: {
              ...current.memory,
              workspacePath,
              status: "error",
              error: errorMessage(error),
            },
          }));
        }
        throw error;
      }
    },
    [preview],
  );

  const loadWorkspace = useCallback(async (bridge: DesktopBridge, workspacePath: string) => {
    const generation = workspaceLoadGenerationRef.current + 1;
    workspaceLoadGenerationRef.current = generation;
    const isCurrentLoad = () => workspaceLoadGenerationRef.current === generation;
    const params = { workspacePath };
    const sharedConfigSupported = runtimeCapabilitiesRef.current.has(SHARED_CONFIG_CAPABILITY);
    const requests = [
      optionalEntry("workspace", bridge, "workspace.status", params),
      optionalEntry("sessions", bridge, "session.list", { ...params, includeArchived: true }),
      optionalEntry("runs", bridge, "runs.list", params),
      optionalEntry("jobs", bridge, "jobs.list", params),
      optionalEntry("legacyProviders", bridge, "config.providers", params),
      optionalEntry("agentCatalog", bridge, "catalog.agents", params),
      optionalEntry("skillCatalog", bridge, "catalog.skills", params),
      optionalEntry("usage", bridge, "usage.get", params),
      optionalEntry("config", bridge, "config.get", params),
      ...(sharedConfigSupported
        ? ([
            optionalEntry("providerRegistry", bridge, "provider.list", {}),
            optionalEntry("userConfig", bridge, "config.user.get", {}),
            optionalEntry("effectiveConfig", bridge, "config.effective.get", params),
          ] as const)
        : []),
    ];
    const entries = await Promise.all(requests);
    const values: Record<string, unknown> = {};
    const notices: Record<string, string> = {};
    for (const [key, result] of entries) {
      if (result.error) notices[key] = result.error;
      else values[key] = result.value;
    }
    if (!sharedConfigSupported) {
      notices.providers =
        "当前 Runtime 缺少统一配置能力。请完全退出并重新启动 Pico 后再管理 Provider。";
    } else {
      notices.providers =
        notices.providerRegistry ?? notices.userConfig ?? notices.effectiveConfig ?? "";
      if (!notices.providers) delete notices.providers;
    }
    const trustResult = await optionalInvoke(bridge, "workspace.trustStatus", params);
    let launchAtLogin: boolean | undefined;
    try {
      const launchResult = await bridge.platform.getLaunchAtLogin();
      if (launchResult.ok) launchAtLogin = launchResult.value;
      else notices.desktopPreferences = launchResult.error.message;
    } catch (error) {
      notices.desktopPreferences = errorMessage(error);
    }
    if (!isCurrentLoad()) return;
    if (trustResult.error) notices.trust = trustResult.error;
    setData((current) => {
      const trusted = booleanValue(trustResult.value?.trusted);
      const switchingWorkspace = current.workspacePath !== workspacePath;
      const workspaceMode = parseWorkspaceMode(
        isRecord(values.workspace) ? values.workspace.mode : undefined,
        "folder",
      );
      const selectedWorkspace: WorkspaceView = {
        path: workspacePath,
        name: workspaceName(workspacePath),
        mode: workspaceMode ?? "folder",
        registered: true,
        trusted,
      };
      const workspaces = [
        selectedWorkspace,
        ...current.workspaces.filter((workspace) => workspace.path !== workspacePath),
      ];
      return mergeLoadedData(
        {
          ...current,
          workspaces,
          workspacePath,
          trusted,
          launchAtLogin,
          notices,
          memory:
            trusted && !switchingWorkspace
              ? current.memory
              : { workspacePath, facts: [], proposals: [], status: "idle" },
          ...(switchingWorkspace
            ? {
                timeline: [],
                approvals: [],
                prompts: [],
                changes: [],
                changeFingerprint: undefined,
              }
            : {}),
          providerConfig: {
            ...current.providerConfig,
            supported: sharedConfigSupported,
          },
        },
        workspacePath,
        values,
      );
    });
  }, []);

  const loadConversation = useCallback(
    async (bridge: DesktopBridge, workspacePath: string, sessionId: string) => {
      if (preview) return;
      const conversationKey = workspaceSessionKey({ workspacePath, sessionId });
      const loadKey = conversationKey;
      const generation = (conversationLoadGenerationsRef.current.get(loadKey) ?? 0) + 1;
      conversationLoadGenerationsRef.current.set(loadKey, generation);
      const isCurrentLoad = () =>
        conversationLoadGenerationsRef.current.get(loadKey) === generation;
      let value: unknown;
      try {
        value = await invoke(bridge, "session.transcript", {
          workspacePath,
          sessionId,
          limit: 200,
        });
      } catch (error) {
        if (!isCurrentLoad()) return;
        setData((current) => ({
          ...current,
          conversations: {
            ...current.conversations,
            [conversationKey]: {
              workspacePath,
              sessionId,
              items: [],
              queuedCount: 0,
              loadError: errorMessage(error),
            },
          },
        }));
        throw error;
      }
      if (!isCurrentLoad()) return;
      const record = isRecord(value) ? value : {};
      const activeRun = isRecord(record.activeRun) ? record.activeRun : undefined;
      const activeRunId = stringValue(activeRun?.runId) || undefined;
      const changeRunId =
        activeRunId ||
        dataRef.current.runs.find(
          (run) =>
            run.workspacePath === workspacePath &&
            run.sessionId === sessionId &&
            isTerminalRunStatus(run.status),
        )?.id;
      const [sessionUsage, settingsResult, goalResult] = await Promise.all([
        optionalInvoke(bridge, "usage.get", { workspacePath, sessionId }),
        optionalInvoke(bridge, "session.settings.get", { workspacePath, sessionId }),
        optionalInvoke(bridge, "goal.get", { workspacePath, sessionId }),
      ]);
      if (!isCurrentLoad()) return;
      let conversation: ConversationView = {
        ...parseConversation(record, workspacePath, sessionId),
        ...(activeRunId ? { runId: activeRunId } : {}),
        ...(!sessionUsage.error ? { usage: parseUsage(sessionUsage.value) } : {}),
        ...(!settingsResult.error ? { settings: parseSessionSettings(settingsResult.value) } : {}),
        ...(!goalResult.error ? { goalItem: parseGoalItem(goalResult.value) } : {}),
      };
      if (changeRunId) {
        const changeList = await optionalInvoke(bridge, "changes.list", {
          workspacePath,
          runId: changeRunId,
        });
        if (!isCurrentLoad()) return;
        if (!changeList.error && changeList.value) {
          const listValue = changeList.value;
          const changes = await Promise.all(
            recordArray(listValue.changes).map(async (change) => {
              const path = stringValue(change.path);
              if (!path) return change;
              const diff = await optionalInvoke(bridge, "changes.diff", {
                workspacePath,
                runId: changeRunId,
                path,
              });
              return { ...change, patch: stringValue(diff.value?.patch) || undefined };
            }),
          );
          if (!isCurrentLoad()) return;
          const parsed = parseChanges({ ...listValue, changes });
          conversation = {
            ...conversation,
            changes: parsed.changes,
            changeFingerprint: parsed.fingerprint,
          };
        }
      }
      if (!isCurrentLoad()) return;
      setData((current) => ({
        ...current,
        conversations: {
          ...current.conversations,
          [conversationKey]: {
            ...conversation,
            items: mergeHydratedConversationItems(
              conversation.items,
              current.conversations[conversationKey]?.items ?? [],
              activeRunId,
            ),
          },
        },
        runs: activeRun
          ? [
              {
                id: stringValue(activeRun.runId),
                workspacePath,
                sessionId: stringValue(activeRun.sessionId, sessionId),
                description: stringValue(activeRun.description, "会话运行"),
                status: stringValue(activeRun.status, "running"),
                startedAt: numberValue(activeRun.startedAt, Date.now()),
                updatedAt: numberValue(activeRun.updatedAt, Date.now()),
              },
              ...current.runs.filter(
                (run) =>
                  run.workspacePath !== workspacePath || run.id !== stringValue(activeRun.runId),
              ),
            ]
          : current.runs.filter(
              (run) =>
                run.workspacePath !== workspacePath ||
                run.sessionId !== sessionId ||
                isTerminalRunStatus(run.status),
            ),
      }));
    },
    [preview],
  );

  const bootstrap = useCallback(async () => {
    if (preview) return;
    setConnection({ kind: "loading" });
    setMessage(undefined);
    const bridge = getBridge();
    if (!bridge) {
      setConnection({
        kind: "unavailable",
        detail: "安全桥接未加载。请从 Pico 桌面应用启动，而不是直接打开页面。",
      });
      return;
    }
    try {
      const pingValue = await invoke(bridge, "runtime.ping", {});
      const capabilities = pingValue.capabilities.map((capability) => stringValue(capability));
      runtimeCapabilitiesRef.current = new Set(capabilities);
      if (!capabilities.includes("session-conversation-v1")) {
        throw new Error("当前 Runtime 缺少会话能力。请完全退出并重新启动 Pico。");
      }
      await loadWorkspaceIndex(bridge, true);
      await loadUserCapabilities(bridge);
      setConnection({ kind: "ready" });
    } catch (error) {
      setConnection({ kind: "error", detail: errorMessage(error), retryable: true });
    }
  }, [loadUserCapabilities, loadWorkspaceIndex, preview]);

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  useEffect(() => {
    if (preview || connection.kind !== "ready") return;
    const bridge = getBridge();
    if (!bridge) return;
    const refreshOnFocus = () => {
      const workspacePath = dataRef.current.workspacePath;
      void loadWorkspaceIndex(bridge)
        .then(() => loadUserCapabilities(bridge))
        .then(() => (workspacePath ? loadWorkspace(bridge, workspacePath) : undefined))
        .catch(reportFailure);
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [
    connection.kind,
    loadUserCapabilities,
    loadWorkspace,
    loadWorkspaceIndex,
    preview,
    reportFailure,
  ]);

  useEffect(() => {
    if (preview || connection.kind !== "ready" || !data.workspacePath) return;
    const bridge = getBridge();
    if (!bridge) return;
    seenEventIdsRef.current.clear();
    const workspacePath = data.workspacePath;
    let disposed = false;
    let subscription: ReturnType<DesktopBridge["events"]["subscribe"]> | undefined;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    let memoryRefreshTimer: ReturnType<typeof setTimeout> | undefined;
    const dirtySessions = new Set<string>();
    const scheduleHydration = (sessionId?: string) => {
      if (sessionId) dirtySessions.add(sessionId);
      if (refreshTimer) return;
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (disposed) return;
        const currentWorkspace = dataRef.current.workspacePath;
        if (!currentWorkspace) return;
        const sessions = [...dirtySessions];
        dirtySessions.clear();
        void loadWorkspace(bridge, currentWorkspace)
          .then(() =>
            Promise.all(
              sessions.map((candidate) => loadConversation(bridge, currentWorkspace, candidate)),
            ),
          )
          .catch(reportFailure);
      }, 25);
    };
    const scheduleMemoryRefresh = () => {
      if (memoryRefreshTimer) return;
      memoryRefreshTimer = setTimeout(() => {
        memoryRefreshTimer = undefined;
        if (disposed || dataRef.current.workspacePath !== workspacePath) return;
        void loadMemory(bridge, workspacePath).catch(reportFailure);
      }, 25);
    };
    const handleEvent = (event: RuntimeNotification) => {
      const scope = event.scope;
      const scopedWorkspacePath = stringValue(scope.workspacePath);
      if (scopedWorkspacePath && scopedWorkspacePath !== dataRef.current.workspacePath) return;
      const eventId = stringValue(event.eventId);
      if (eventId && seenEventIdsRef.current.has(eventId)) return;
      if (eventId) {
        seenEventIdsRef.current.add(eventId);
        if (seenEventIdsRef.current.size > MAX_RENDERER_SEEN_EVENT_IDS) {
          const oldest = seenEventIdsRef.current.values().next().value;
          if (oldest !== undefined) seenEventIdsRef.current.delete(oldest);
        }
      }
      const payload = isRecord(event.payload) ? event.payload : {};
      const topic = stringValue(event.topic);
      if (isMemoryNotificationTopic(topic)) {
        scheduleMemoryRefresh();
      } else if (topic === "approval.requested") {
        const request = isRecord(payload.request) ? payload.request : {};
        setData((current) => ({
          ...current,
          approvals: [
            ...current.approvals.filter((item) => item.id !== stringValue(payload.approvalId)),
            {
              id: stringValue(payload.approvalId),
              runId: stringValue(payload.runId ?? scope.runId),
              title: stringValue(request.title, "需要你的批准"),
              detail: stringValue(
                request.detail ?? request.description,
                "Runtime 请求执行受保护操作。",
              ),
              command: stringValue(request.command) || undefined,
              risk: request.risk === "high" || request.risk === "medium" ? request.risk : "low",
            },
          ],
        }));
      } else if (topic === "prompt.requested") {
        const prompt = isRecord(payload.prompt) ? payload.prompt : {};
        const options = Array.isArray(prompt.options)
          ? prompt.options.map((item) =>
              isRecord(item) ? stringValue(item.label) : stringValue(item),
            )
          : [];
        setData((current) => ({
          ...current,
          prompts: [
            ...current.prompts.filter((item) => item.id !== stringValue(payload.promptId)),
            {
              id: stringValue(payload.promptId),
              runId: stringValue(payload.runId ?? scope.runId),
              question: stringValue(prompt.question ?? prompt.message, "Pico 需要你的选择"),
              options,
            },
          ],
        }));
      } else if (topic === "approval.resolved") {
        const approvalId = stringValue(payload.approvalId);
        setData((current) =>
          resolveApprovalState(current, {
            approvalId,
            decision: stringValue(payload.decision),
            workspacePath,
            sessionId: stringValue(scope.sessionId),
            runId: stringValue(scope.runId ?? payload.runId),
          }),
        );
      } else if (topic === "prompt.resolved") {
        const promptId = stringValue(payload.promptId);
        setData((current) =>
          resolvePromptState(current, {
            promptId,
            workspacePath,
            sessionId: stringValue(scope.sessionId),
            runId: stringValue(scope.runId ?? payload.runId),
          }),
        );
      } else if (topic === "run.started") {
        const run = isRecord(payload.run) ? payload.run : {};
        const runId = stringValue(scope.runId ?? run.runId);
        const sessionId = stringValue(scope.sessionId ?? run.sessionId);
        const conversationKey = sessionId
          ? workspaceSessionKey({ workspacePath, sessionId })
          : undefined;
        if (runId) {
          setData((current) => ({
            ...current,
            runs: [
              {
                id: runId,
                workspacePath,
                sessionId: sessionId || undefined,
                description: stringValue(run.description, "会话运行"),
                status: stringValue(run.status, "running"),
                startedAt: numberValue(run.startedAt, event.at),
                updatedAt: numberValue(run.updatedAt, event.at),
              },
              ...current.runs.filter(
                (candidate) => candidate.workspacePath !== workspacePath || candidate.id !== runId,
              ),
            ],
            ...(sessionId && conversationKey
              ? {
                  conversations: {
                    ...current.conversations,
                    [conversationKey]: {
                      ...(current.conversations[conversationKey] ?? {
                        workspacePath,
                        sessionId,
                        items: [],
                        queuedCount: 0,
                      }),
                      runId,
                      items: (current.conversations[conversationKey]?.items ?? []).filter(
                        (candidate) =>
                          (candidate.kind !== "thinking" &&
                            candidate.kind !== "assistantMessage") ||
                          candidate.streaming !== true,
                      ),
                    },
                  },
                }
              : {}),
          }));
        }
        scheduleHydration(sessionId || undefined);
      } else if (topic === "run.timeline") {
        setData((current) => ({
          ...current,
          timeline: applyTimelineNotification(current.timeline, event),
        }));
      } else if (topic === "run.live") {
        const sessionId = stringValue(scope.sessionId);
        const runId = stringValue(scope.runId ?? payload.runId);
        const conversationKey = sessionId
          ? workspaceSessionKey({ workspacePath, sessionId })
          : undefined;
        const item = isRecord(payload.item) ? payload.item : {};
        const operation = stringValue(item.operation);
        const liveOperation =
          operation === "append"
            ? "append"
            : operation === "complete"
              ? "complete"
              : operation === "clear"
                ? "clear"
                : undefined;
        if (
          sessionId &&
          conversationKey &&
          runId &&
          (item.kind === "thinking" || item.kind === "assistantMessage") &&
          liveOperation
        ) {
          setData((current) => {
            const conversation = current.conversations[conversationKey] ?? {
              workspacePath,
              sessionId,
              items: [],
              queuedCount: 0,
              runId,
            };
            const activeRun = current.runs.find(
              (candidate) =>
                candidate.workspacePath === workspacePath &&
                candidate.sessionId === sessionId &&
                !isTerminalRunStatus(candidate.status),
            );
            if (activeRun && activeRun.id !== runId) return current;
            const runConversation =
              conversation.runId === runId
                ? conversation
                : {
                    ...conversation,
                    runId,
                    items: conversation.items.filter(
                      (candidate) =>
                        (candidate.kind !== "thinking" && candidate.kind !== "assistantMessage") ||
                        candidate.streaming !== true,
                    ),
                  };
            const update = {
              runId,
              operation: liveOperation,
              ...(stringValue(item.streamId) ? { streamId: stringValue(item.streamId) } : {}),
              ...(stringValue(item.turnId) ? { turnId: stringValue(item.turnId) } : {}),
              ...(stringValue(item.delta) ? { delta: stringValue(item.delta) } : {}),
              ...(item.truncated === true ? { truncated: true } : {}),
              at: numberValue(event.at, Date.now()),
            } as const;
            return {
              ...current,
              conversations: {
                ...current.conversations,
                [conversationKey]: {
                  ...runConversation,
                  items:
                    item.kind === "thinking"
                      ? applyLiveReasoningUpdate(runConversation.items, update)
                      : applyLiveAssistantUpdate(runConversation.items, update),
                },
              },
            };
          });
          if (item.kind === "assistantMessage" && operation === "complete") {
            scheduleHydration(sessionId);
          }
        }
      } else if (topic === "config.updated") {
        const changedCapabilities = Array.isArray(payload.capabilities)
          ? payload.capabilities.map((item) => stringValue(item))
          : [];
        if (changedCapabilities.includes("skills") || changedCapabilities.includes("mcp")) {
          void loadUserCapabilities(bridge)
            .then(async () => {
              const current = dataRef.current;
              await Promise.all([
                changedCapabilities.includes("skills") && current.skillScope.workspacePath
                  ? loadScopedCapabilities(bridge, "skills", current.skillScope.workspacePath)
                  : undefined,
                changedCapabilities.includes("mcp") && current.mcpScope.workspacePath
                  ? loadScopedCapabilities(bridge, "mcp", current.mcpScope.workspacePath)
                  : undefined,
              ]);
            })
            .catch(reportFailure);
        }
        scheduleHydration();
      } else if (topic.startsWith("run.") || topic.startsWith("session.")) {
        scheduleHydration(stringValue(scope.sessionId) || undefined);
      }
    };
    void (async () => {
      // Capture the durable boundary first, hydrate current state once, then only
      // subscribe after that high-watermark. Historical events never enter the
      // Main/preload pending buffers or trigger one refresh per old event.
      const boundary = await bridge.runtime["events.replay"]({ workspacePath, limit: 1 });
      if (!boundary.ok) throw new Error(boundary.error.message);
      await loadWorkspace(bridge, workspacePath);
      if (disposed) return;
      const highWatermarkEventId = boundary.value.highWatermarkEventId;
      subscription = bridge.events.subscribe(
        {
          workspacePath,
          ...(highWatermarkEventId ? { afterEventId: highWatermarkEventId } : {}),
        },
        handleEvent,
      );
      const result = await subscription.ready;
      if (!result.ok && !disposed) setMessage(`事件订阅失败：${result.error.message}`);
    })().catch((error: unknown) => {
      if (!disposed) reportFailure(error);
    });
    return () => {
      disposed = true;
      if (refreshTimer) clearTimeout(refreshTimer);
      if (memoryRefreshTimer) clearTimeout(memoryRefreshTimer);
      subscription?.dispose();
    };
  }, [
    connection.kind,
    data.workspacePath,
    loadConversation,
    loadMemory,
    loadScopedCapabilities,
    loadUserCapabilities,
    loadWorkspace,
    preview,
    reportFailure,
  ]);

  const perform = useCallback(
    async (
      label: string,
      operation: (bridge: DesktopBridge) => Promise<void>,
    ): Promise<boolean> => {
      setBusy(label);
      setMessage(undefined);
      try {
        if (preview) {
          await operation(createPreviewBridge());
          return true;
        }
        const bridge = getBridge();
        if (!bridge) throw new Error("桌面安全桥接不可用。");
        await operation(bridge);
        return true;
      } catch (error) {
        if (!preview && label.startsWith("memory-") && isMemoryConflict(error)) {
          const bridge = getBridge();
          const workspacePath = dataRef.current.workspacePath;
          if (bridge && workspacePath) {
            try {
              await loadMemory(bridge, workspacePath);
            } catch (reloadError) {
              reportFailure(reloadError);
              return false;
            }
          }
          setMessage("记忆已在另一处更新，已重新加载最新内容。请检查后重试本次操作。");
          return false;
        }
        if (
          !preview &&
          label.startsWith("mcp-user-") &&
          error instanceof RuntimeInvocationError &&
          (error.code === "CONFIG_REVISION_CONFLICT" || error.code === "CONFLICT")
        ) {
          const bridge = getBridge();
          if (bridge) {
            try {
              await loadUserCapabilities(bridge);
            } catch (reloadError) {
              reportFailure(reloadError);
              return false;
            }
          }
          setMessage("MCP 配置已在另一处更新，已刷新用户级列表。请检查后重试。");
          return false;
        }
        if (
          !preview &&
          label.startsWith("provider-") &&
          error instanceof RuntimeInvocationError &&
          (error.code === "CONFIG_REVISION_CONFLICT" || error.code === "CONFLICT")
        ) {
          const bridge = getBridge();
          const workspacePath = dataRef.current.workspacePath;
          if (bridge && workspacePath) {
            try {
              await loadWorkspace(bridge, workspacePath);
            } catch (reloadError) {
              reportFailure(reloadError);
              return false;
            }
          }
          setMessage(
            "Provider 配置已被 App 或 TUI 的另一处更新，已重新加载最新内容。请检查后重新应用本次修改。",
          );
          return false;
        }
        reportFailure(error);
        return false;
      } finally {
        setBusy(undefined);
      }
    },
    [loadMemory, loadUserCapabilities, loadWorkspace, preview, reportFailure],
  );

  const actions = useMemo<RuntimeActions>(
    () => ({
      async chooseWorkspace() {
        let selectedWorkspacePath: string | undefined;
        await perform("choose-workspace", async (bridge) => {
          const result = await bridge.platform.chooseWorkspace();
          if (!result.ok) throw new Error(result.error.message);
          if (!result.value) return;
          if (preview) {
            selectedWorkspacePath = result.value;
            setData(previewData);
            return;
          }
          const registeredValue = await invoke(bridge, "workspace.register", {
            workspacePath: result.value,
          });
          const workspacePath = stringValue(registeredValue.workspacePath, result.value);
          selectedWorkspacePath = workspacePath;
          await loadWorkspaceIndex(bridge);
          await loadWorkspace(bridge, workspacePath);
        });
        return selectedWorkspacePath;
      },
      async selectWorkspace(workspacePath) {
        if (!workspacePath) return;
        if (preview) {
          setData(previewData);
          return;
        }
        await perform("select-workspace", async (bridge) => {
          await loadWorkspace(bridge, workspacePath);
        });
      },
      async trustWorkspace(workspacePath, trusted) {
        if (!workspacePath) return;
        await perform("trust-workspace", async (bridge) => {
          if (!preview) await invoke(bridge, "workspace.trust", { workspacePath, trusted });
          if (!preview) {
            await loadWorkspaceIndex(bridge);
            await loadWorkspace(bridge, workspacePath);
            return;
          }
          setData((current) => ({
            ...current,
            trusted,
            workspaces: current.workspaces.map((workspace) =>
              workspace.path === workspacePath ? { ...workspace, trusted } : workspace,
            ),
          }));
        });
      },
      reload: bootstrap,
      async loadSession(ref) {
        if (!ref.workspacePath || !ref.sessionId) return;
        await perform("load-session", async (bridge) => {
          if (preview) return;
          if (dataRef.current.workspacePath !== ref.workspacePath) {
            await loadWorkspace(bridge, ref.workspacePath);
          }
          await loadConversation(bridge, ref.workspacePath, ref.sessionId);
        });
      },
      async loadEarlierSession(ref) {
        const { workspacePath, sessionId } = ref;
        const conversationKey = workspaceSessionKey(ref);
        const conversation = dataRef.current.conversations[conversationKey];
        const before = conversation?.nextBefore;
        const expectedRevision = conversation?.revision;
        if (!workspacePath || !before || !expectedRevision) return;
        await perform("load-earlier-session", async (bridge) => {
          if (preview) return;
          let value: unknown;
          try {
            value = await invoke(bridge, "session.transcript", {
              workspacePath,
              sessionId,
              before,
              limit: 200,
              expectedRevision,
            });
          } catch (error) {
            if (error instanceof RuntimeInvocationError && error.code === "CONFLICT") {
              await loadConversation(bridge, workspacePath, sessionId);
              setMessage("会话历史已更新，已从最新版本重新加载。");
              return;
            }
            throw error;
          }
          const page = parseConversation(value, workspacePath, sessionId);
          if (
            page.revision !== expectedRevision ||
            dataRef.current.conversations[conversationKey]?.revision !== expectedRevision
          ) {
            await loadConversation(bridge, workspacePath, sessionId);
            setMessage("会话历史已更新，已从最新版本重新加载。");
            return;
          }
          setData((current) => {
            const latest = current.conversations[conversationKey];
            if (!latest || latest.revision !== expectedRevision) return current;
            const existingIds = new Set(latest.items.map((item) => item.id));
            const olderItems = page.items.filter((item) => !existingIds.has(item.id));
            return {
              ...current,
              conversations: {
                ...current.conversations,
                [conversationKey]: {
                  ...latest,
                  items: [...olderItems, ...latest.items],
                  nextBefore: page.nextBefore,
                  queuedCount: page.queuedCount,
                },
              },
            };
          });
        });
      },
      async sendMessage(input) {
        const workspacePath = input.workspacePath;
        if (!workspacePath || !input.text.trim()) return { succeeded: false };
        let resolvedSessionId = input.sessionId;
        const sendIdentity = JSON.stringify({
          workspacePath,
          sessionId: input.sessionId,
          text: input.text.trim(),
          behavior: input.behavior ?? "auto",
          expectedRunId: input.expectedRunId,
          activation: input.activation,
        });
        const idempotencyKey =
          pendingSendRef.current?.identity === sendIdentity
            ? pendingSendRef.current.idempotencyKey
            : crypto.randomUUID();
        pendingSendRef.current = { identity: sendIdentity, idempotencyKey };
        const succeeded = await perform("send-message", async (bridge) => {
          if (preview) {
            resolvedSessionId ??= "session-atlas";
            const sessionId = resolvedSessionId;
            if (!sessionId) return;
            const conversationKey = workspaceSessionKey({ workspacePath, sessionId });
            setData((current) => {
              const conversation = current.conversations[conversationKey] ?? {
                workspacePath,
                sessionId,
                items: [],
                queuedCount: 0,
              };
              return {
                ...current,
                conversations: {
                  ...current.conversations,
                  [conversationKey]: {
                    ...conversation,
                    items: [
                      ...conversation.items,
                      {
                        id: `preview-user-${Date.now()}`,
                        kind: "userMessage" as const,
                        text: input.text.trim(),
                        at: Date.now(),
                      },
                    ],
                  },
                },
              };
            });
            return;
          }
          const value = await invoke(bridge, "session.send", {
            workspacePath,
            ...(input.sessionId ? { sessionId: input.sessionId } : {}),
            input:
              input.activation?.kind === "skill"
                ? { kind: "skill", name: input.activation.name, args: input.text.trim() }
                : input.activation?.kind === "agent"
                  ? { kind: "agent", name: input.activation.name, task: input.text.trim() }
                  : { kind: "text", text: input.text.trim() },
            behavior: input.behavior ?? "auto",
            ...(input.expectedRunId ? { expectedRunId: input.expectedRunId } : {}),
            idempotencyKey,
          });
          const session = value.session;
          resolvedSessionId = stringValue(session.sessionId, input.sessionId);
          await loadWorkspace(bridge, workspacePath);
          if (resolvedSessionId) {
            await loadConversation(bridge, workspacePath, resolvedSessionId);
          }
        });
        if (succeeded && pendingSendRef.current?.identity === sendIdentity) {
          pendingSendRef.current = undefined;
        }
        return {
          succeeded,
          ...(succeeded ? { workspacePath } : {}),
          ...(resolvedSessionId ? { sessionId: resolvedSessionId } : {}),
        };
      },
      async renameSession(ref, title) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath || !title.trim()) return;
        await perform("rename-session", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "session.rename", {
              workspacePath,
              sessionId,
              title: title.trim(),
            });
            await loadWorkspace(bridge, workspacePath);
            return;
          }
          setData((current) => ({
            ...current,
            sessions: current.sessions.map((session) =>
              session.workspacePath === workspacePath && session.id === sessionId
                ? { ...session, title: title.trim() }
                : session,
            ),
          }));
        });
      },
      async forkSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return undefined;
        let forkedSessionId: string | undefined;
        await perform("fork-session", async (bridge) => {
          if (preview) {
            forkedSessionId = `${sessionId}-fork`;
            return;
          }
          const value = await invoke(bridge, "session.fork", { workspacePath, sessionId });
          const session = value.session;
          forkedSessionId = stringValue(session.sessionId);
          await loadWorkspace(bridge, workspacePath);
          if (forkedSessionId) await loadConversation(bridge, workspacePath, forkedSessionId);
        });
        return forkedSessionId ? { workspacePath, sessionId: forkedSessionId } : undefined;
      },
      async compactSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("compact-session", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "session.compact", { workspacePath, sessionId });
            await loadConversation(bridge, workspacePath, sessionId);
          }
          setMessage("会话上下文已压缩，可见历史已从 Runtime 重新加载。");
        });
      },
      async updateSessionSettings(ref, patch) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("session-settings", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "session.settings.update", {
              workspacePath,
              sessionId,
              ...patch,
            });
            await loadConversation(bridge, workspacePath, sessionId);
          }
        });
      },
      async setSessionArchived(ref, archived) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("session-state", async (bridge) => {
          if (!preview)
            await invoke(bridge, archived ? "session.archive" : "session.restore", {
              workspacePath,
              sessionId,
            });
          setData((current) => ({
            ...current,
            sessions: current.sessions.map((session) =>
              session.workspacePath === workspacePath && session.id === sessionId
                ? { ...session, status: archived ? "archived" : "active" }
                : session,
            ),
          }));
        });
      },
      async setSessionPinned(ref, pinned) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return;
        await perform("session-state", async (bridge) => {
          if (!preview)
            await invoke(bridge, pinned ? "session.pin" : "session.unpin", {
              workspacePath,
              sessionId,
            });
          setData((current) => ({
            ...current,
            sessions: current.sessions
              .map((session) =>
                session.workspacePath === workspacePath && session.id === sessionId
                  ? { ...session, pinned }
                  : session,
              )
              .sort(compareSessions),
          }));
        });
      },
      async deleteSession(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return false;
        const key = workspaceSessionKey(ref);
        return await perform("session-state", async (bridge) => {
          if (!preview) await invoke(bridge, "session.delete", { workspacePath, sessionId });
          setData((current) => {
            const conversations = { ...current.conversations };
            delete conversations[key];
            return {
              ...current,
              sessions: current.sessions.filter(
                (session) => session.workspacePath !== workspacePath || session.id !== sessionId,
              ),
              runs: current.runs.filter(
                (run) => run.workspacePath !== workspacePath || run.sessionId !== sessionId,
              ),
              conversations,
            };
          });
        });
      },
      async pauseRun(runId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("pause-run", async (bridge) => {
          if (!preview) await invoke(bridge, "run.pause", { workspacePath, runId });
          setData((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.workspacePath === workspacePath && run.id === runId
                ? { ...run, status: "pause_requested" }
                : run,
            ),
          }));
        });
      },
      async resumeRun(runId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("resume-run", async (bridge) => {
          if (!preview) await invoke(bridge, "run.resume", { workspacePath, runId });
          setData((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.workspacePath === workspacePath && run.id === runId
                ? { ...run, status: "running" }
                : run,
            ),
          }));
        });
      },
      async stopRun(runId) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("stop-run", async (bridge) => {
          if (!preview) await invoke(bridge, "run.cancel", { workspacePath, runId });
          setData((current) => ({
            ...current,
            runs: current.runs.map((run) =>
              run.workspacePath === workspacePath && run.id === runId
                ? { ...run, status: "cancelling" }
                : run,
            ),
          }));
        });
      },
      async steerRun(runId, messageText) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !messageText.trim()) return;
        await perform("steer-run", async (bridge) => {
          if (!preview)
            await invoke(bridge, "run.steer", {
              workspacePath,
              runId,
              message: messageText.trim(),
            });
          setMessage("新指令已排队，会在安全边界生效。");
        });
      },
      async respondApproval(id, decision) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("approval", async (bridge) => {
          if (!preview)
            await invoke(bridge, "approval.respond", {
              workspacePath,
              approvalId: id,
              decision,
              idempotencyKey: crypto.randomUUID(),
            });
          setData((current) =>
            resolveApprovalState(current, {
              approvalId: id,
              decision,
              workspacePath,
              sessionId: "",
              runId: current.approvals.find((approval) => approval.id === id)?.runId ?? "",
            }),
          );
        });
      },
      async respondPrompt(id, answer) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !answer.trim()) return;
        await perform("prompt", async (bridge) => {
          if (!preview)
            await invoke(bridge, "prompt.respond", {
              workspacePath,
              promptId: id,
              answer: answer.trim(),
              idempotencyKey: crypto.randomUUID(),
            });
          setData((current) =>
            resolvePromptState(current, {
              promptId: id,
              workspacePath,
              sessionId: "",
              runId: current.prompts.find((prompt) => prompt.id === id)?.runId ?? "",
            }),
          );
        });
      },
      async reviewChanges(decision, reviewMessage, target) {
        const workspacePath = dataRef.current.workspacePath;
        const runId =
          target?.runId ??
          dataRef.current.runs.find((run) => run.workspacePath === workspacePath)?.id;
        const expectedFingerprint = target?.fingerprint ?? dataRef.current.changeFingerprint;
        if (!workspacePath || !runId || !expectedFingerprint) return;
        await perform("review", async (bridge) => {
          if (!preview)
            await invoke(bridge, "changes.review", {
              workspacePath,
              runId,
              decision,
              expectedFingerprint,
              ...(reviewMessage ? { message: reviewMessage } : {}),
            });
          setMessage(decision === "approve" ? "更改已批准，等待应用。" : "修改意见已发回任务。");
        });
      },
      async applyChanges(target) {
        const workspacePath = dataRef.current.workspacePath;
        const runId =
          target?.runId ??
          dataRef.current.runs.find((run) => run.workspacePath === workspacePath)?.id;
        const expectedFingerprint = target?.fingerprint ?? dataRef.current.changeFingerprint;
        if (!workspacePath || !runId || !expectedFingerprint) return;
        await perform("apply", async (bridge) => {
          if (!preview)
            await invoke(bridge, "changes.apply", { workspacePath, runId, expectedFingerprint });
          setMessage("更改已应用到工作区。");
        });
      },
      async previewRewind(ref) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath) return undefined;
        let previewResult:
          | {
              readonly checkpointId: string;
              readonly fingerprint: string;
              readonly changeCount: number;
            }
          | undefined;
        await perform("rewind-preview", async (bridge) => {
          if (preview) {
            previewResult = {
              checkpointId: "preview-checkpoint",
              fingerprint: "preview-rewind:54b9c2",
              changeCount: dataRef.current.changes.length,
            };
            return;
          }
          const listValue = await invoke(bridge, "rewind.list", { workspacePath, sessionId });
          const list = isRecord(listValue) ? recordArray(listValue.checkpoints) : [];
          const checkpoint = [...list].sort(
            (left, right) => numberValue(right.createdAt) - numberValue(left.createdAt),
          )[0];
          const checkpointId = checkpoint ? stringValue(checkpoint.checkpointId) : "";
          if (!checkpointId) throw new Error("当前会话没有可用检查点。");
          const value = await invoke(bridge, "rewind.preview", {
            workspacePath,
            sessionId,
            checkpointId,
          });
          previewResult = {
            checkpointId,
            fingerprint: stringValue(value.fingerprint),
            changeCount: recordArray(value.changes).length,
          };
        });
        return previewResult;
      },
      async applyRewind(ref, checkpointId, fingerprint) {
        const { workspacePath, sessionId } = ref;
        if (!workspacePath || !fingerprint) return;
        await perform("rewind-apply", async (bridge) => {
          if (!preview)
            await invoke(bridge, "rewind.apply", {
              workspacePath,
              sessionId,
              checkpointId,
              expectedFingerprint: fingerprint,
            });
          setMessage("已回到检查点。Runtime 已使用预览指纹重新验证。");
          if (!preview) {
            await loadWorkspace(bridge, workspacePath);
            await loadConversation(bridge, workspacePath, sessionId);
          }
        });
      },
      async toggleJob(id, enabled) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("toggle-job", async (bridge) => {
          if (!preview)
            await invoke(bridge, "jobs.setEnabled", { workspacePath, jobId: id, enabled });
          setData((current) => ({
            ...current,
            jobs: current.jobs.map((job) => (job.id === id ? { ...job, enabled } : job)),
          }));
        });
      },
      async createJob(input) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !input.name.trim() || !input.prompt.trim() || !input.schedule.trim())
          return;
        await perform("create-job", async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              jobs: [
                ...current.jobs,
                {
                  id: `preview-job-${Date.now()}`,
                  name: input.name.trim(),
                  prompt: input.prompt.trim(),
                  schedule: input.schedule.trim(),
                  enabled: true,
                  status: "idle",
                  updatedAt: Date.now(),
                },
              ],
            }));
          } else {
            await invoke(bridge, "jobs.create", {
              workspacePath,
              name: input.name.trim(),
              prompt: input.prompt.trim(),
              schedule: input.schedule.trim(),
              enabled: true,
            });
            await loadWorkspace(bridge, workspacePath);
          }
        });
      },
      async runJob(id) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("run-job", async (bridge) => {
          if (!preview) await invoke(bridge, "jobs.runNow", { workspacePath, jobId: id });
          setData((current) => ({
            ...current,
            jobs: current.jobs.map((job) =>
              job.id === id ? { ...job, status: "running", updatedAt: Date.now() } : job,
            ),
          }));
        });
      },
      async deleteJob(id) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("delete-job", async (bridge) => {
          if (!preview) await invoke(bridge, "jobs.delete", { workspacePath, jobId: id });
          setData((current) => ({
            ...current,
            jobs: current.jobs.filter((job) => job.id !== id),
          }));
        });
      },
      async loadCapabilityScope(kind, workspacePath) {
        await perform(`capability-${kind}`, async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              ...(kind === "skills"
                ? {
                    skills: current.skillScope.userItems,
                    skillScope: { ...current.skillScope, workspacePath },
                  }
                : {
                    mcpServers: current.mcpScope.userItems,
                    mcpScope: { ...current.mcpScope, workspacePath },
                  }),
            }));
            return;
          }
          await loadScopedCapabilities(bridge, kind, workspacePath);
        });
      },
      async addUserMcp(server) {
        const revision = dataRef.current.mcpScope.userRevision;
        if (!revision) {
          setMessage("MCP 用户级配置尚未加载，请刷新后再试。");
          return false;
        }
        if (dataRef.current.mcpScope.userItems.some((item) => item.name === server.name)) {
          setMessage(
            `MCP 服务 ${server.name} 已存在。Desktop v1 不会覆盖现有配置，以避免丢失密钥。`,
          );
          return false;
        }
        return perform("mcp-user-add", async (bridge) => {
          if (preview) {
            const item: CapabilityView = {
              id: `user:mcp:${server.name}`,
              name: server.name,
              description: `${server.transport.toUpperCase()} · ${server.transport === "stdio" ? server.command : server.url}`,
              state: server.enabled === false ? "disabled" : "ready",
              meta: server.transport,
              source: {
                scope: "user",
                sourceId: "user:mcp",
                sourceLabel: "~/.pico/config.json",
                readOnly: false,
                effective: true,
              },
            };
            setData((current) => {
              const userItems = [
                ...current.mcpScope.userItems.filter((candidate) => candidate.name !== server.name),
                item,
              ];
              return {
                ...current,
                mcpServers: [
                  ...current.mcpServers.filter(
                    (candidate) =>
                      candidate.name !== server.name || candidate.source?.scope !== "user",
                  ),
                  item,
                ],
                mcpScope: {
                  ...current.mcpScope,
                  userItems,
                  userRevision: `${current.mcpScope.userRevision}-next`,
                },
              };
            });
          } else {
            await invoke(bridge, "mcp.user.upsert", {
              server,
              expectedRevision: revision,
              idempotencyKey: globalThis.crypto.randomUUID(),
            });
            await loadUserCapabilities(bridge);
            const workspacePath = dataRef.current.mcpScope.workspacePath;
            if (workspacePath) await loadScopedCapabilities(bridge, "mcp", workspacePath);
          }
          setMessage(`MCP 服务 ${server.name} 已添加。`);
        });
      },
      async deleteUserMcp(serverName) {
        const revision = dataRef.current.mcpScope.userRevision;
        if (!revision) {
          setMessage("MCP 用户级配置尚未加载，请刷新后再试。");
          return false;
        }
        return perform("mcp-user-delete", async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              mcpServers: current.mcpServers.filter(
                (candidate) => candidate.name !== serverName || candidate.source?.scope !== "user",
              ),
              mcpScope: {
                ...current.mcpScope,
                userItems: current.mcpScope.userItems.filter(
                  (candidate) => candidate.name !== serverName,
                ),
                userRevision: `${current.mcpScope.userRevision}-next`,
              },
            }));
          } else {
            await invoke(bridge, "mcp.user.delete", {
              serverName,
              expectedRevision: revision,
              idempotencyKey: globalThis.crypto.randomUUID(),
            });
            await loadUserCapabilities(bridge);
            const workspacePath = dataRef.current.mcpScope.workspacePath;
            if (workspacePath) await loadScopedCapabilities(bridge, "mcp", workspacePath);
          }
          setMessage(`MCP 服务 ${serverName} 已删除。`);
        });
      },
      async upsertProvider(provider) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) {
          setMessage(
            providerConfig.supported
              ? "Provider 配置尚未完整加载，请重新加载后再试。"
              : "当前 Runtime 不支持统一 Provider 配置。请完全退出并重新启动 Pico。",
          );
          return false;
        }
        return perform("provider-save", async (bridge) => {
          if (preview) {
            const previous = dataRef.current.providerConfig.providers.find(
              (item) => item.id === provider.id,
            );
            const next: ProviderView = {
              ...provider,
              origin: "user",
              fingerprint: previous?.fingerprint ?? `preview-${provider.id}-fingerprint`,
              credentialStatus: previous?.credentialStatus ?? "missing",
              credentialSource: previous?.credentialSource ?? "none",
              storedCredentialPresent: previous?.storedCredentialPresent ?? false,
            };
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: [
                  ...current.providerConfig.providers.filter((item) => item.id !== provider.id),
                  next,
                ],
              },
            }));
            setMessage(`Provider ${provider.id} 已保存。`);
            return;
          }
          if (provider.modelCapabilities && !isJsonValue(provider.modelCapabilities)) {
            throw new Error("Provider modelCapabilities 必须是 JSON 对象。");
          }
          const runtimeProvider: RuntimeProviderInput = {
            id: provider.id,
            protocol: provider.protocol,
            baseURL: provider.baseURL,
            apiKeyEnv: provider.apiKeyEnv,
            models: provider.models,
            discoverModels: provider.discoverModels,
            ...(provider.modelCapabilities
              ? { modelCapabilities: provider.modelCapabilities }
              : {}),
          };
          await invoke(bridge, "provider.upsert", {
            provider: runtimeProvider,
            expectedRevision: providerConfig.revision,
          });
          const workspacePath = dataRef.current.workspacePath;
          if (workspacePath) await loadWorkspace(bridge, workspacePath);
          setMessage(`Provider ${provider.id} 已保存。`);
        });
      },
      async deleteProvider(providerId) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) return false;
        return perform("provider-delete", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "provider.delete", {
              providerId,
              expectedRevision: providerConfig.revision,
            });
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: current.providerConfig.providers.filter(
                  (provider) => provider.id !== providerId,
                ),
              },
            }));
          }
          setMessage(`Provider ${providerId} 已删除。`);
        });
      },
      async setDefaultModelRoute(modelRouteId) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) return false;
        const defaults: RuntimeUserDefaults = {
          ...(modelRouteId ? { modelRouteId } : {}),
          ...(providerConfig.userDefaults.mode ? { mode: providerConfig.userDefaults.mode } : {}),
          ...(providerConfig.userDefaults.thinkingEffort
            ? { thinkingEffort: providerConfig.userDefaults.thinkingEffort }
            : {}),
        };
        return perform("provider-default", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "config.user.update", {
              defaults,
              expectedRevision: providerConfig.revision,
            });
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                userDefaults: {
                  ...current.providerConfig.userDefaults,
                  ...(modelRouteId ? { modelRouteId } : { modelRouteId: undefined }),
                },
              },
            }));
          }
          setMessage(modelRouteId ? "默认模型已更新。" : "已清除用户默认模型。");
        });
      },
      async setProviderCredential(providerId, secret, expectedRevision) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable || !secret) return false;
        return perform("provider-credential", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "provider.credential.set", {
              providerId,
              secret,
              expectedRevision,
            });
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: current.providerConfig.providers.map((provider) =>
                  provider.id === providerId
                    ? {
                        ...provider,
                        credentialStatus: "ready",
                        credentialSource: "config",
                        storedCredentialPresent: true,
                      }
                    : provider,
                ),
              },
            }));
          }
          setMessage(`Provider ${providerId} 的 API Key 已保存到 ~/.pico/config.json。`);
        });
      },
      async deleteProviderCredential(providerId, expectedRevision) {
        const providerConfig = dataRef.current.providerConfig;
        if (!providerConfig.writable) return false;
        return perform("provider-credential-delete", async (bridge) => {
          if (!preview) {
            await invoke(bridge, "provider.credential.delete", {
              providerId,
              expectedRevision,
            });
            const workspacePath = dataRef.current.workspacePath;
            if (workspacePath) await loadWorkspace(bridge, workspacePath);
          } else {
            setData((current) => ({
              ...current,
              providerConfig: {
                ...current.providerConfig,
                revision: `${current.providerConfig.revision}-next`,
                providers: current.providerConfig.providers.map((provider) =>
                  provider.id === providerId
                    ? {
                        ...provider,
                        credentialStatus: "missing",
                        credentialSource: "none",
                        storedCredentialPresent: false,
                      }
                    : provider,
                ),
              },
            }));
          }
          setMessage(`Provider ${providerId} 在 ~/.pico/config.json 中的 API Key 已删除。`);
        });
      },
      async refreshMemory() {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return;
        await perform("memory-refresh", async (bridge) => {
          await loadMemory(bridge, workspacePath);
        });
      },
      async updateMemoryFact(factId, expectedVersion, patch) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return undefined;
        let updated: RuntimeMemoryFact | undefined;
        await perform("memory-update", async (bridge) => {
          if (preview) {
            const fact = dataRef.current.memory.facts.find((item) => item.factId === factId);
            if (!fact || fact.version !== expectedVersion) return;
            const { expiresAt: oldExpiresAt, lastUsedAt: oldLastUsedAt, ...baseFact } = fact;
            const { expiresAt, lastUsedAt, ...basePatch } = patch;
            updated = {
              ...baseFact,
              ...basePatch,
              ...(expiresAt === undefined
                ? oldExpiresAt
                  ? { expiresAt: oldExpiresAt }
                  : {}
                : expiresAt === null
                  ? {}
                  : { expiresAt }),
              ...(lastUsedAt === undefined
                ? oldLastUsedAt
                  ? { lastUsedAt: oldLastUsedAt }
                  : {}
                : lastUsedAt === null
                  ? {}
                  : { lastUsedAt }),
              version: fact.version + 1,
              updatedAt: new Date().toISOString(),
            };
            const nextFact = updated;
            setData((current) => {
              return {
                ...current,
                memory: {
                  ...current.memory,
                  facts: current.memory.facts.map((item) =>
                    item.factId === factId ? nextFact : item,
                  ),
                },
              };
            });
          } else {
            const result = await invoke(bridge, "memory.update", {
              workspacePath,
              factId,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
              ...patch,
            });
            updated = result.fact;
            await loadMemory(bridge, workspacePath);
          }
          setMessage("记忆已更新。");
        });
        return updated;
      },
      async forgetMemoryFact(factId, expectedVersion) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return false;
        return perform("memory-forget", async (bridge) => {
          if (preview) {
            setData((current) => ({
              ...current,
              memory: {
                ...current.memory,
                facts: current.memory.facts.filter((item) => item.factId !== factId),
              },
            }));
          } else {
            await invoke(bridge, "memory.forget", {
              workspacePath,
              factId,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
            });
            await loadMemory(bridge, workspacePath);
          }
          setMessage("记忆已永久删除，无法撤销。");
        });
      },
      async resolveMemoryProposal(proposalId, expectedVersion, resolution, patch) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return undefined;
        let resolved:
          | { readonly proposal: RuntimeMemoryProposal; readonly fact?: RuntimeMemoryFact }
          | undefined;
        await perform("memory-review", async (bridge) => {
          if (preview) {
            const proposal = dataRef.current.memory.proposals.find(
              (item) => item.proposalId === proposalId,
            );
            if (!proposal || proposal.version !== expectedVersion) return;
            const reviewedProposal: RuntimeMemoryProposal = {
              ...proposal,
              ...patch,
              status: resolution,
              version: proposal.version + 1,
              reviewedAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              ...(resolution === "accepted" ? { resolvedFactId: `fact-${proposalId}` } : {}),
            };
            const fact: RuntimeMemoryFact | undefined =
              resolution === "accepted"
                ? {
                    factId: `fact-${proposalId}`,
                    kind: patch?.kind ?? proposal.kind,
                    title: patch?.title ?? proposal.title,
                    content: patch?.content ?? proposal.content,
                    confidence: patch?.confidence ?? proposal.confidence,
                    state: "active",
                    pinned: false,
                    ...(proposal.sourceId ? { sourceId: proposal.sourceId } : {}),
                    version: 1,
                    createdAt: new Date().toISOString(),
                    updatedAt: new Date().toISOString(),
                  }
                : undefined;
            resolved = { proposal: reviewedProposal, ...(fact ? { fact } : {}) };
            setData((current) => ({
              ...current,
              memory: {
                ...current.memory,
                proposals: current.memory.proposals.filter(
                  (item) => item.proposalId !== proposalId,
                ),
                facts: fact ? [fact, ...current.memory.facts] : current.memory.facts,
              },
            }));
          } else {
            const result = await invoke(bridge, "memory.review.resolve", {
              workspacePath,
              proposalId,
              resolution,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
              ...(patch ? { patch } : {}),
            });
            resolved = result;
            await loadMemory(bridge, workspacePath);
          }
          setMessage(
            resolution === "accepted"
              ? "建议已批准并写入工作区记忆。"
              : "建议已拒绝；当前协议不支持撤销拒绝。",
          );
        });
        return resolved;
      },
      async updateMemorySettings(expectedVersion, patch) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath || !dataRef.current.trusted) return undefined;
        let updated: RuntimeMemorySettings | undefined;
        await perform("memory-settings", async (bridge) => {
          if (preview) {
            const settings = dataRef.current.memory.settings;
            if (!settings || settings.version !== expectedVersion) return;
            const nextSettings: RuntimeMemorySettings = {
              ...settings,
              ...patch,
              autoCommit: false,
              version: settings.version + 1,
              updatedAt: new Date().toISOString(),
            };
            updated = nextSettings;
            setData((current) => ({
              ...current,
              memory: {
                ...current.memory,
                settings: nextSettings,
                reviewBudget: previewReviewBudget(
                  nextSettings.reviewMode,
                  current.memory.reviewBudget,
                ),
              },
            }));
          } else {
            const result = await invoke(bridge, "memory.settings.update", {
              workspacePath,
              expectedVersion,
              idempotencyKey: crypto.randomUUID(),
              ...patch,
            });
            updated = result.settings;
            await loadMemory(bridge, workspacePath);
          }
          setMessage("记忆设置已更新。");
        });
        return updated;
      },
      async setLaunchAtLogin(enabled) {
        await perform("launch-at-login", async (bridge) => {
          const result = await bridge.platform.setLaunchAtLogin(enabled);
          if (!result.ok) throw new Error(result.error.message);
          setData((current) => ({ ...current, launchAtLogin: enabled }));
          setMessage(enabled ? "已开启登录时启动。" : "已关闭登录时启动。");
        });
      },
      async setBackgroundMode(enabled) {
        await perform("background-mode", async (bridge) => {
          const result = await bridge.lifecycle.setBackgroundMode(enabled);
          if (!result.ok) throw new Error(result.error.message);
          setMessage(enabled ? "关闭窗口后 Pico 会继续运行。" : "关闭窗口时 Pico 将退出。");
        });
      },
      async openWorkspace() {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("open-workspace", async (bridge) => {
          const result = await bridge.platform.openDirectory(workspacePath);
          if (!result.ok) throw new Error(result.error.message);
        });
      },
      async initializeWorkspace() {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return;
        await perform("workspace-init", async (bridge) => {
          if (!preview) await invoke(bridge, "workspace.init", { workspacePath });
          setMessage("Pico 项目入口已初始化；已存在的文件保持不变。");
        });
      },
      async runDiagnostics(kind) {
        const workspacePath = dataRef.current.workspacePath;
        if (!workspacePath) return undefined;
        let output: string | undefined;
        await perform("diagnostics", async (bridge) => {
          if (preview) {
            output = "Preview 模式不运行本机诊断。";
            return;
          }
          const value = await invoke(
            bridge,
            kind === "resources" ? "diagnostics.resources" : "diagnostics.run",
            { workspacePath },
          );
          output = stringValue(value.output, "诊断完成，未返回文本报告。");
        });
        return output;
      },
    }),
    [
      bootstrap,
      loadConversation,
      loadMemory,
      loadScopedCapabilities,
      loadWorkspace,
      loadWorkspaceIndex,
      perform,
      preview,
    ],
  );

  return { preview, connection, data, busy, message, actions };
}

function previewReviewBudget(
  mode: RuntimeMemorySettings["reviewMode"],
  current: RuntimeMemoryReviewBudget | undefined,
): RuntimeMemoryReviewBudget {
  const limits =
    mode === "eco"
      ? { maxCalls: 0, maxInputTokens: 0, maxOutputTokens: 0, maxCostUsd: 0 }
      : mode === "balanced"
        ? { maxCalls: 8, maxInputTokens: 16_000, maxOutputTokens: 2_000, maxCostUsd: 0.1 }
        : { maxCalls: 16, maxInputTokens: 32_000, maxOutputTokens: 4_000, maxCostUsd: 0.25 };
  const usage = {
    calls: current?.calls ?? 0,
    inputTokens: current?.inputTokens ?? 0,
    outputTokens: current?.outputTokens ?? 0,
    costUsd: current?.costUsd ?? 0,
  };
  const exhausted =
    mode !== "eco" &&
    (usage.calls >= limits.maxCalls ||
      usage.inputTokens >= limits.maxInputTokens ||
      usage.outputTokens >= limits.maxOutputTokens ||
      usage.costUsd >= limits.maxCostUsd);
  return {
    mode,
    allowed: mode !== "eco" && !exhausted,
    reason: mode === "eco" ? "eco-mode" : exhausted ? "budget-exhausted" : "available",
    ...usage,
    ...limits,
    ...(exhausted && current?.nextRecoveryAt ? { nextRecoveryAt: current.nextRecoveryAt } : {}),
  };
}

function createPreviewBridge(): DesktopBridge {
  const success = <T>(value: T): Promise<DesktopResult<T>> => Promise.resolve({ ok: true, value });
  return {
    runtime: new Proxy(
      {},
      {
        get: () => () => success({}),
      },
    ) as DesktopBridge["runtime"],
    events: {
      subscribe: () => ({
        ready: success({ subscribed: true, events: [], hasMore: false }),
        dispose: () => undefined,
      }),
    },
    platform: {
      chooseWorkspace: () => success(previewData.workspacePath),
      showNotification: () => success(undefined),
      openDirectory: () => success(undefined),
      getLaunchAtLogin: () => success(false),
      setLaunchAtLogin: () => success(undefined),
    },
    lifecycle: {
      setBackgroundMode: () => success(undefined),
      quit: () => success(undefined),
    },
  };
}
