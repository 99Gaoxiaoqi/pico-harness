import type { ProviderKind } from "../provider/factory.js";
import type { ModelRoute, ModelRouter } from "../provider/model-router.js";
import { isValidThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import {
  coordinateReasoningLevel,
  type ResolvedModelReasoningCapability,
} from "../provider/reasoning-capability.js";
import type { Registry } from "../tools/registry.js";
import type {
  PersistedCollaborationMode,
  PersistedPermissionMode,
  PersistedSessionSettings,
  PersistedSessionSettingsWrite,
  SessionRuntimePersistence,
} from "../engine/session-runtime.js";
import { sessionScopeKey } from "../engine/session-scope.js";
import {
  compileRuntimePermissionProfile,
  createBypassExecutionBoundary,
  createManagedExecutionBoundary,
  createWorkspaceWritePermissionProfile,
  type ExecutionBoundary,
} from "../safety/permission-profile.js";

export interface SessionToolStatus {
  name: string;
  readOnly: boolean;
}

export type CollaborationMode = PersistedCollaborationMode;
export type PermissionMode = PersistedPermissionMode;
export const DEFAULT_COLLABORATION_MODE: CollaborationMode = "agent";
export const DEFAULT_PERMISSION_MODE: PermissionMode = "ask";
export type SessionMode = "new" | "continue" | "resume" | "fork";

export interface SessionSettings {
  sessionId: string;
  /** 用户显式命名的会话标题；未设置时列表回退到首条用户消息。 */
  title?: string;
  sessionMode: SessionMode;
  forkFrom?: string;
  sideConversation?: boolean;
  cwd: string;
  provider: ProviderKind;
  collaborationMode: CollaborationMode;
  /** Orchestration axis: "default" = direct execution, "graph" / "swarm" = coordinated execution. */
  orchestrationMode: "default" | "graph" | "swarm";
  model: string;
  /** Stable providerID/modelID identity. Endpoint and credentials stay in ModelRouter. */
  modelRouteId?: string;
  /** Current model reasoning level. Field name is retained for persisted-session compatibility. */
  thinkingEffort: string;
  thinkingEffortExplicit: boolean;
  /** Canonical foreground permission axis. */
  permissionMode: PermissionMode;
  tools: readonly SessionToolStatus[];
  additionalDirectories: readonly string[];
}

export interface SessionSettingsDefaults {
  sessionId: string;
  title?: string;
  sessionMode?: SessionMode;
  forkFrom?: string;
  cwd: string;
  /** Host-owned Pico state root used only to isolate process-local session state. */
  picoHome?: string;
  provider: ProviderKind;
  collaborationMode?: CollaborationMode;
  model: string;
  modelRouteId?: string;
  thinkingEffort?: string;
  permissionMode?: PermissionMode;
  tools?: readonly SessionToolStatus[];
  additionalDirectories?: readonly string[];
  /** Initial orchestration mode for new sessions (CLI --graph / --swarm / programmatic). Defaults to "default". */
  orchestrationMode?: "default" | "graph" | "swarm";
}

export interface SessionSettingResult {
  ok: boolean;
  message: string;
}

export interface SessionSettingsPersistenceOptions {
  persistence: SessionRuntimePersistence;
  /** 默认 true：已持久设置覆盖启动默认值。11.4 显式强制新值时可传 false。 */
  restore?: boolean;
}

const settingsBySession = new Map<string, SessionSettings>();
const persistenceBySettings = new WeakMap<SessionSettings, SessionRuntimePersistence>();
export function createDefaultSessionSettings(defaults: SessionSettingsDefaults): SessionSettings {
  const forkFrom = defaults.forkFrom;
  const title = normalizeSessionTitle(defaults.title);
  return {
    sessionId: defaults.sessionId,
    ...(title !== undefined ? { title } : {}),
    sessionMode: defaults.sessionMode ?? "new",
    ...(forkFrom !== undefined ? { forkFrom } : {}),
    cwd: defaults.cwd,
    provider: defaults.provider,
    collaborationMode: defaults.collaborationMode ?? DEFAULT_COLLABORATION_MODE,
    orchestrationMode: defaults.orchestrationMode ?? "default",
    permissionMode: defaults.permissionMode ?? DEFAULT_PERMISSION_MODE,
    model: defaults.model,
    ...(defaults.modelRouteId !== undefined ? { modelRouteId: defaults.modelRouteId } : {}),
    thinkingEffort: defaults.thinkingEffort ?? "off",
    thinkingEffortExplicit: defaults.thinkingEffort !== undefined,
    tools: defaults.tools ?? [],
    additionalDirectories: createAdditionalDirectorySnapshot(defaults.additionalDirectories ?? []),
  };
}

export function getOrCreateSessionSettings(
  defaults: SessionSettingsDefaults,
  persistenceOptions?: SessionSettingsPersistenceOptions,
): SessionSettings {
  const runtimeSnapshot = persistenceOptions?.persistence.getRuntimeStateSnapshot();
  const restored = persistenceOptions?.restore === false ? undefined : runtimeSnapshot?.settings;
  if (restored !== undefined && runtimeSnapshot?.boundary === undefined) {
    throw new Error(`Session ${defaults.sessionId} has no durable execution boundary`);
  }
  const key = sessionSettingsKey(defaults.sessionId, defaults.cwd, defaults.picoHome);
  const existing = settingsBySession.get(key);
  if (existing !== undefined) {
    const sessionMode = defaults.sessionMode;
    const forkFrom = defaults.forkFrom;
    if (sessionMode !== undefined) {
      existing.sessionMode = sessionMode;
    }
    if (forkFrom !== undefined) {
      existing.forkFrom = forkFrom;
    } else if (sessionMode !== "fork" && defaults.sessionMode !== undefined) {
      delete existing.forkFrom;
    }
    if (restored) {
      applyPersistedSessionSettings(existing, restored);
    } else {
      existing.provider = defaults.provider;
      if (persistenceOptions?.restore === false) {
        existing.model = defaults.model;
        if (defaults.modelRouteId !== undefined) {
          existing.modelRouteId = defaults.modelRouteId;
        } else {
          delete existing.modelRouteId;
        }
      }
      if (defaults.collaborationMode !== undefined) {
        existing.collaborationMode = defaults.collaborationMode;
      }
      if (defaults.permissionMode !== undefined) {
        existing.permissionMode = defaults.permissionMode;
      }
      if (defaults.thinkingEffort !== undefined) {
        existing.thinkingEffort = defaults.thinkingEffort;
        existing.thinkingEffortExplicit = true;
      }
      const title = normalizeSessionTitle(defaults.title);
      if (title !== undefined) existing.title = title;
    }
    existing.tools = defaults.tools ?? existing.tools;
    for (const directory of defaults.additionalDirectories ?? []) {
      if (!existing.additionalDirectories.includes(directory)) {
        existing.additionalDirectories = createAdditionalDirectorySnapshot([
          ...existing.additionalDirectories,
          directory,
        ]);
      }
    }
    bindSessionSettingsPersistence(existing, persistenceOptions?.persistence);
    persistSessionSettings(existing);
    return existing;
  }

  const created = createDefaultSessionSettings(defaults);
  if (restored) applyPersistedSessionSettings(created, restored);
  for (const directory of defaults.additionalDirectories ?? []) {
    if (!created.additionalDirectories.includes(directory)) {
      created.additionalDirectories = createAdditionalDirectorySnapshot([
        ...created.additionalDirectories,
        directory,
      ]);
    }
  }
  settingsBySession.set(key, created);
  bindSessionSettingsPersistence(created, persistenceOptions?.persistence);
  persistSessionSettings(created);
  return created;
}

export function getStoredSessionSettings(
  sessionId: string,
  cwd?: string,
  picoHome?: string,
): SessionSettings | undefined {
  if (cwd !== undefined) return settingsBySession.get(sessionSettingsKey(sessionId, cwd, picoHome));
  for (const settings of [...settingsBySession.values()].reverse()) {
    if (settings.sessionId === sessionId) return settings;
  }
  return undefined;
}

/** 新 fork 在公布前失败时，同步移除其未对外可见的运行态。 */
export function forgetSessionSettings(sessionId: string, cwd?: string, picoHome?: string): void {
  if (cwd !== undefined) {
    const key = sessionSettingsKey(sessionId, cwd, picoHome);
    const settings = settingsBySession.get(key);
    if (settings) persistenceBySettings.delete(settings);
    settingsBySession.delete(key);
  } else {
    for (const [key, settings] of settingsBySession) {
      if (settings.sessionId !== sessionId) continue;
      persistenceBySettings.delete(settings);
      settingsBySession.delete(key);
    }
  }
}

export function addSessionAdditionalDirectory(
  settings: SessionSettings,
  directory: string,
): readonly string[] {
  if (settings.additionalDirectories.includes(directory)) {
    return settings.additionalDirectories;
  }

  settings.additionalDirectories = createAdditionalDirectorySnapshot([
    ...settings.additionalDirectories,
    directory,
  ]);
  persistSessionSettings(settings);
  return settings.additionalDirectories;
}

export function setSessionAdditionalDirectories(
  settings: SessionSettings,
  directories: readonly string[],
): readonly string[] {
  settings.additionalDirectories = createAdditionalDirectorySnapshot(directories);
  persistSessionSettings(settings);
  return settings.additionalDirectories;
}

export function setSessionTools(
  settings: SessionSettings,
  tools: readonly SessionToolStatus[],
): readonly SessionToolStatus[] {
  settings.tools = Object.freeze(tools.map((tool) => Object.freeze({ ...tool })));
  return settings.tools;
}

export function setSessionModel(settings: SessionSettings, model: string): SessionSettingResult {
  const normalized = model.trim();
  if (!normalized) {
    return { ok: false, message: `Current model: ${settings.model}` };
  }
  if (persistenceBySettings.has(settings)) {
    return {
      ok: false,
      message: "Durable Sessions require a model route. Use /model with providerID/modelID.",
    };
  }

  settings.model = normalized;
  delete settings.modelRouteId;
  return { ok: true, message: `Model set to ${settings.model}` };
}

/** 更新会话的用户可识别标题，并同步写入 Session runtime_state。 */
export function setSessionTitle(settings: SessionSettings, title: string): SessionSettingResult {
  const normalized = normalizeSessionTitle(title);
  if (normalized === undefined) {
    return {
      ok: false,
      message: "Usage: /rename <title> (1-120 non-whitespace characters)",
    };
  }
  settings.title = normalized;
  persistSessionSettings(settings);
  return { ok: true, message: `Session renamed to ${settings.title}` };
}

export function setSessionModelRoute(
  settings: SessionSettings,
  router: ModelRouter,
  query: string,
): SessionSettingResult {
  const validation = router.validate(query);
  if (!validation.ok) return { ok: false, message: validation.message };

  const { route } = validation;
  const { previousLevel, selection } = applySessionModelRoute(settings, route);
  const reasoningMessage = formatReasoningSelectionAfterModelSwitch(
    route.capabilities.reasoningProfile,
    previousLevel,
    selection.level,
    selection.reason,
  );
  return {
    ok: true,
    message: [`Model set to ${route.id}`, reasoningMessage].filter(Boolean).join("\n"),
  };
}

/** 将用户显式选择的路由写回运行态。 */
export function migrateSessionModelRoute(settings: SessionSettings, route: ModelRoute): void {
  applySessionModelRoute(settings, route);
}

/** 恢复会话时以已持久化的 route ID 为唯一权威，不按 model 名猜测路由。 */
export function resolveRestoredSessionModelRoute(
  router: ModelRouter,
  restored: PersistedSessionSettings | undefined,
  fallbackRouteId?: string,
): ModelRoute {
  if (!restored) {
    return router.resolve(fallbackRouteId) ?? router.require(undefined);
  }

  const routeId = restored.modelRouteId;
  const route = router.routes.find((candidate) => candidate.id === routeId);
  if (route) return route;
  const available = router.routes.map((candidate) => candidate.id).join(", ") || "none";
  throw new Error(
    `会话固定的模型路由 ${routeId} 已不可用。为避免把会话发送到其他 Provider，Pico 不会自动切换模型。请使用 --model <provider/model> 显式选择。可用模型: ${available}。`,
  );
}

function applySessionModelRoute(settings: SessionSettings, route: ModelRoute) {
  settings.modelRouteId = route.id;
  settings.provider = route.provider;
  settings.model = route.model;
  const previousLevel = settings.thinkingEffort;
  const selection = coordinateReasoningLevel(
    route.capabilities.reasoningProfile,
    settings.thinkingEffortExplicit ? previousLevel : undefined,
  );
  applyReasoningLevelSelection(settings, selection);
  persistSessionSettings(settings);
  return { previousLevel, selection };
}

export function exitSessionPlanMode(settings: SessionSettings): SessionSettingResult {
  if (settings.collaborationMode !== "plan") {
    return { ok: true, message: "Collaboration mode remains agent" };
  }
  settings.collaborationMode = "agent";
  persistSessionSettings(settings);
  return { ok: true, message: "Collaboration mode restored to agent" };
}

export function setSessionCollaborationMode(
  settings: SessionSettings,
  mode: CollaborationMode,
): SessionSettingResult {
  if (mode === "plan") {
    settings.collaborationMode = "plan";
  } else {
    settings.collaborationMode = "agent";
  }
  persistSessionSettings(settings);
  return { ok: true, message: `Collaboration mode set to ${mode}` };
}

export function setSessionOrchestrationMode(
  settings: SessionSettings,
  mode: "default" | "graph" | "swarm",
): SessionSettingResult {
  settings.orchestrationMode = mode;
  persistSessionSettings(settings);
  return {
    ok: true,
    message: `编排模式已设置：${mode}`,
  };
}

export function setSessionSideConversation(
  settings: SessionSettings,
  enabled: boolean,
): SessionSettingResult {
  if (enabled) settings.sideConversation = true;
  else delete settings.sideConversation;
  persistSessionSettings(settings);
  return {
    ok: true,
    message: enabled ? "Side conversation enabled" : "Side conversation disabled",
  };
}

export function setSessionPermissionMode(
  settings: SessionSettings,
  mode: string,
): SessionSettingResult {
  const normalized = normalizePermissionMode(mode);
  if (!normalized) {
    return {
      ok: false,
      message: `Current permission mode: ${settings.permissionMode}\nUsage: /permissions <ask|auto|full-access>`,
    };
  }

  settings.permissionMode = normalized;
  persistSessionSettings(settings);
  return { ok: true, message: `Permission mode set to ${settings.permissionMode}` };
}

export function setSessionThinkingEffort(
  settings: SessionSettings,
  effort: string,
  router: ModelRouter,
): SessionSettingResult {
  const route = resolveSessionModelRoute(settings, router);
  if (!route) {
    return {
      ok: false,
      message: `Current model route ${settings.modelRouteId ?? settings.model} is unavailable. Use /model to select an available route.`,
    };
  }
  const capability = route.capabilities.reasoningProfile;
  if (capability.enabled !== true || capability.levels.length === 0) {
    return { ok: false, message: formatRouteReasoningStatus(route.id, capability) };
  }
  const normalized = effort.trim().toLowerCase();
  const level = capability.levels.find((candidate) => candidate.toLowerCase() === normalized);
  if (!level) {
    return {
      ok: false,
      message: formatRouteReasoningStatus(route.id, capability, settings.thinkingEffort),
    };
  }
  settings.thinkingEffort = level;
  settings.thinkingEffortExplicit = true;
  persistSessionSettings(settings);
  return { ok: true, message: `Thinking level set to ${level} for ${route.id}` };
}

export function formatSessionReasoningStatus(
  settings: SessionSettings,
  router: ModelRouter,
): string {
  const route = resolveSessionModelRoute(settings, router);
  if (!route) {
    return `推理控制不可用：找不到模型路由 ${settings.modelRouteId ?? settings.model}。`;
  }
  return formatRouteReasoningStatus(
    route.id,
    route.capabilities.reasoningProfile,
    settings.thinkingEffortExplicit ? settings.thinkingEffort : undefined,
  );
}

export function sessionReasoningCandidates(
  settings: SessionSettings,
  router: ModelRouter,
): readonly string[] {
  return resolveSessionModelRoute(settings, router)?.capabilities.reasoningProfile.levels ?? [];
}

export function parseThinkingEffortArg(raw: string): ThinkingEffort | undefined {
  const value = raw.trim().toLowerCase();
  if (!isValidThinkingEffort(value)) return undefined;
  return value as ThinkingEffort;
}

export function formatSessionStatus(settings: SessionSettings): string {
  return [
    `Collaboration mode: ${settings.collaborationMode}`,
    `Permission mode: ${settings.permissionMode}`,
    `Orchestration: ${settings.orchestrationMode}`,
    `Model: ${settings.model}`,
    `Model route: ${settings.modelRouteId ?? "unconfigured"}`,
    `Thinking effort: ${settings.thinkingEffort}`,
    `Session: ${settings.sessionId}`,
    `Title: ${settings.title ?? "-"}`,
    `sessionId: ${settings.sessionId}`,
    `sessionMode: ${settings.sessionMode}`,
    `forkFrom: ${settings.forkFrom ?? "-"}`,
    `CWD: ${settings.cwd}`,
  ].join("\n");
}

export function formatPermissionStatus(settings: SessionSettings): string {
  return [
    `Permission mode: ${settings.permissionMode}`,
    "Usage: /permissions <ask|auto|full-access>",
  ].join("\n");
}

export function formatToolStatus(tools: readonly SessionToolStatus[]): string {
  if (tools.length === 0) {
    return "No tools are available.";
  }

  return tools.map((tool) => `${tool.name} - ${tool.readOnly ? "read-only" : "write"}`).join("\n");
}

export function toolStatusFromRegistry(registry: Registry): SessionToolStatus[] {
  return registry.getAvailableTools().map((tool) => ({
    name: tool.name,
    readOnly: registry.isReadOnlyTool?.(tool.name) ?? false,
  }));
}

function resolveSessionModelRoute(settings: SessionSettings, router: ModelRouter) {
  return router.routes.find((candidate) => candidate.id === settings.modelRouteId);
}

function formatThinkingUsage(capability: ResolvedModelReasoningCapability): string {
  return capability.levels.length > 0 ? `/thinking <${capability.levels.join("|")}>` : "/thinking";
}

function formatRouteReasoningStatus(
  routeId: string,
  capability: ResolvedModelReasoningCapability,
  storedLevel?: string,
): string {
  const lines = [`路由：${routeId}`];
  if (capability.enabled === false) {
    lines.push("推理：此模型已禁用。", "可选档位：无");
    return lines.join("\n");
  }
  if (capability.enabled === "unknown") {
    lines.push("推理控制：未知（模型未提供推理元数据）。", "可选档位：无");
    return lines.join("\n");
  }
  if (capability.levels.length === 0) {
    lines.push("推理：由模型固定控制。", "可选档位：无");
    return lines.join("\n");
  }
  const selection = coordinateReasoningLevel(capability, storedLevel);
  lines.push(
    `支持档位：${capability.levels.join("、")}`,
    `默认档位：${capability.defaultLevel ?? capability.levels[0]}`,
    `当前档位：${selection.level ?? "无"}`,
    `用法：${formatThinkingUsage(capability)}`,
  );
  return lines.join("\n");
}

function formatReasoningSelectionAfterModelSwitch(
  capability: ResolvedModelReasoningCapability,
  previousLevel: string,
  level: string | undefined,
  reason: "requested" | "default" | "fallback" | "not_adjustable",
): string {
  if (reason === "fallback" && level !== undefined) {
    return `Thinking level ${previousLevel} is unsupported; using model default ${level}.`;
  }
  if (capability.enabled === false) return "Reasoning is disabled for this model.";
  if (capability.enabled === "unknown") return "Reasoning controls are unknown for this model.";
  if (capability.levels.length === 0) return "Reasoning is fixed/model-controlled for this model.";
  return "";
}

/**
 * A route with fixed, disabled, or unknown reasoning controls must not inherit an explicit
 * level from the previously selected model. Retaining it makes the persisted UI state disagree
 * with the request capability preflight on the next turn.
 */
function applyReasoningLevelSelection(
  settings: SessionSettings,
  selection: ReturnType<typeof coordinateReasoningLevel>,
): boolean {
  if (selection.level === undefined) {
    const changed = settings.thinkingEffort !== "off" || settings.thinkingEffortExplicit;
    settings.thinkingEffort = "off";
    settings.thinkingEffortExplicit = false;
    return changed;
  }

  const changed = settings.thinkingEffort !== selection.level;
  settings.thinkingEffort = selection.level;
  return changed;
}

export function normalizePermissionMode(mode: string | undefined): PermissionMode | undefined {
  const normalized = mode?.trim().toLowerCase();
  if (normalized === "ask") return "ask";
  if (normalized === "auto") return "auto";
  if (normalized === "full-access") return "full-access";
  return undefined;
}

function createAdditionalDirectorySnapshot(directories: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(directories)]);
}

function sessionSettingsKey(sessionId: string, cwd: string, picoHome?: string): string {
  return sessionScopeKey(sessionId, cwd, picoHome);
}

export function snapshotSessionSettings(settings: SessionSettings): PersistedSessionSettingsWrite {
  const modelRouteId = settings.modelRouteId?.trim();
  if (!modelRouteId || !/^[^/\s]+\/\S.*$/u.test(modelRouteId)) {
    throw new Error("Durable Session settings require a stable providerID/modelID route");
  }
  return {
    ...(settings.title !== undefined ? { title: settings.title } : {}),
    ...(settings.forkFrom !== undefined ? { forkFrom: settings.forkFrom } : {}),
    ...(settings.sideConversation === true ? { sideConversation: true } : {}),
    provider: settings.provider,
    model: settings.model,
    modelRouteId,
    collaborationMode: settings.collaborationMode,
    orchestrationMode: settings.orchestrationMode,
    permissionMode: settings.permissionMode,
    thinkingEffort: settings.thinkingEffort,
    thinkingEffortExplicit: settings.thinkingEffortExplicit,
    additionalDirectories: [...settings.additionalDirectories],
  };
}

function applyPersistedSessionSettings(
  settings: SessionSettings,
  persisted: PersistedSessionSettings,
): void {
  if (persisted.title !== undefined) {
    settings.title = persisted.title;
  } else {
    delete settings.title;
  }
  if (persisted.forkFrom !== undefined) {
    settings.forkFrom = persisted.forkFrom;
  } else {
    delete settings.forkFrom;
  }
  if (persisted.sideConversation === true) settings.sideConversation = true;
  else delete settings.sideConversation;
  settings.provider = persisted.provider;
  settings.model = persisted.model;
  settings.modelRouteId = persisted.modelRouteId;
  settings.collaborationMode = persisted.collaborationMode;
  settings.orchestrationMode = persisted.orchestrationMode;
  settings.permissionMode = persisted.permissionMode;
  settings.thinkingEffort = persisted.thinkingEffort;
  settings.thinkingEffortExplicit = persisted.thinkingEffortExplicit;
  settings.additionalDirectories = createAdditionalDirectorySnapshot(
    persisted.additionalDirectories,
  );
}

function normalizeSessionTitle(value: string | undefined): string | undefined {
  const compacted = value?.replace(/\s+/gu, " ").trim();
  if (!compacted || compacted.length > 120) return undefined;
  return compacted;
}

function bindSessionSettingsPersistence(
  settings: SessionSettings,
  persistence: SessionRuntimePersistence | undefined,
): void {
  if (persistence) persistenceBySettings.set(settings, persistence);
}

function persistSessionSettings(settings: SessionSettings): void {
  const persistence = persistenceBySettings.get(settings);
  if (!persistence) return;
  const boundary = reconcileExecutionBoundary(
    persistence.getRuntimeStateSnapshot().boundary,
    settings.permissionMode,
  );
  persistence.updateRuntimeState({ settings: snapshotSessionSettings(settings), boundary });
}

/** Keep the durable boundary authoritative while the permission label changes. */
function reconcileExecutionBoundary(
  current: ExecutionBoundary | undefined,
  permissionMode: SessionSettings["permissionMode"],
): ExecutionBoundary {
  if (!current) {
    return compileRuntimePermissionProfile({
      collaborationMode: "agent",
      permissionMode,
    });
  }
  // An externally isolated session is owned by another sandbox authority. Local
  // settings writes must never silently replace that boundary.
  if (current.kind === "external") return current;
  if (permissionMode === "full-access") {
    return current.kind === "bypass"
      ? current
      : createBypassExecutionBoundary(current.revision + 1);
  }
  return current.kind === "managed"
    ? current
    : createManagedExecutionBoundary(createWorkspaceWritePermissionProfile(), current.revision + 1);
}
