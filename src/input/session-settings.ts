import { resolve } from "node:path";
import type { ProviderKind } from "../provider/factory.js";
import type { ModelRoute, ModelRouter } from "../provider/model-router.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { isValidThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import {
  coordinateReasoningLevel,
  type ResolvedModelReasoningCapability,
} from "../provider/reasoning-capability.js";
import type { Registry } from "../tools/registry.js";
import { globalSessionPermissionGrants } from "../approval/session-permissions.js";
import type {
  PersistedSessionSettings,
  SessionRuntimePersistence,
} from "../engine/session-runtime.js";

export interface SessionToolStatus {
  name: string;
  readOnly: boolean;
}

export type InteractionMode = "default" | "plan" | "auto" | "yolo";
export const DEFAULT_INTERACTION_MODE: InteractionMode = "yolo";
export type SessionMode = "new" | "continue" | "resume" | "fork";

export interface SessionSettings {
  sessionId: string;
  /** 用户显式命名的会话标题；未设置时列表回退到首条用户消息。 */
  title?: string;
  sessionMode: SessionMode;
  forkFrom?: string;
  cwd: string;
  provider: ProviderKind;
  mode: InteractionMode;
  /** 进入 plan 前的模式；退出 plan 时恢复。 */
  prePlanMode?: Exclude<InteractionMode, "plan">;
  model: string;
  /** Stable providerID/modelID identity. Endpoint and credentials stay in ModelRouter. */
  modelRouteId?: string;
  /** Current model reasoning level. Field name is retained for persisted-session compatibility. */
  thinkingEffort: string;
  thinkingEffortExplicit: boolean;
  /** @deprecated `/permissions` 兼容别名；读写都代理到 mode，不保存第二份状态。 */
  permissionMode: InteractionMode;
  tools: readonly SessionToolStatus[];
  additionalDirectories: readonly string[];
}

export interface SessionSettingsDefaults {
  sessionId: string;
  title?: string;
  sessionMode?: SessionMode;
  forkFrom?: string;
  cwd: string;
  provider: ProviderKind;
  mode?: InteractionMode;
  model: string;
  modelRouteId?: string;
  thinkingEffort?: string;
  permissionMode?: string;
  tools?: readonly SessionToolStatus[];
  additionalDirectories?: readonly string[];
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
let persistenceBySettings = new WeakMap<SessionSettings, SessionRuntimePersistence>();
const resolvedCliSessionSemantics = new Map<
  string,
  { sessionMode: SessionMode; forkFrom?: string }
>();
const permissionCommandModes = new Set([
  "ask",
  "default",
  "auto",
  "acceptedits",
  "yolo",
  "bypasspermissions",
  "plan",
]);

export function createDefaultSessionSettings(defaults: SessionSettingsDefaults): SessionSettings {
  const resolvedSemantics = resolvedCliSessionSemantics.get(defaults.sessionId);
  const forkFrom = defaults.forkFrom ?? resolvedSemantics?.forkFrom;
  const title = normalizeSessionTitle(defaults.title);
  const mode =
    normalizeInteractionMode(defaults.mode ?? defaults.permissionMode) ?? DEFAULT_INTERACTION_MODE;
  const compatibilityPreviousMode = normalizeInteractionMode(defaults.permissionMode);
  const settings = {
    sessionId: defaults.sessionId,
    ...(title !== undefined ? { title } : {}),
    sessionMode: defaults.sessionMode ?? resolvedSemantics?.sessionMode ?? "new",
    ...(forkFrom !== undefined ? { forkFrom } : {}),
    cwd: defaults.cwd,
    provider: defaults.provider,
    mode,
    ...(mode === "plan" && compatibilityPreviousMode && compatibilityPreviousMode !== "plan"
      ? { prePlanMode: compatibilityPreviousMode }
      : {}),
    model: defaults.model,
    ...(defaults.modelRouteId !== undefined ? { modelRouteId: defaults.modelRouteId } : {}),
    thinkingEffort: defaults.thinkingEffort ?? "off",
    thinkingEffortExplicit: defaults.thinkingEffort !== undefined,
    tools: defaults.tools ?? [],
    additionalDirectories: createAdditionalDirectorySnapshot(defaults.additionalDirectories ?? []),
  } as Omit<SessionSettings, "permissionMode"> & Partial<Pick<SessionSettings, "permissionMode">>;
  return withPermissionModeAlias(settings);
}

export function getOrCreateSessionSettings(
  defaults: SessionSettingsDefaults,
  persistenceOptions?: SessionSettingsPersistenceOptions,
): SessionSettings {
  const restored =
    persistenceOptions?.restore === false
      ? undefined
      : persistenceOptions?.persistence.getRuntimeStateSnapshot().settings;
  const key = sessionSettingsKey(defaults.sessionId, defaults.cwd);
  const existing = settingsBySession.get(key);
  if (existing !== undefined) {
    const resolvedSemantics = resolvedCliSessionSemantics.get(defaults.sessionId);
    const sessionMode = defaults.sessionMode ?? resolvedSemantics?.sessionMode;
    const forkFrom = defaults.forkFrom ?? resolvedSemantics?.forkFrom;
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
      const requestedMode = normalizeInteractionMode(defaults.mode ?? defaults.permissionMode);
      if (requestedMode !== undefined && requestedMode !== existing.mode) {
        applySessionMode(existing, requestedMode);
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

export function rememberResolvedCliSession(selection: {
  sessionId: string;
  mode: SessionMode;
  sourceSessionId?: string;
}): void {
  resolvedCliSessionSemantics.set(selection.sessionId, {
    sessionMode: selection.mode,
    ...(selection.sourceSessionId !== undefined ? { forkFrom: selection.sourceSessionId } : {}),
  });
}

export function getStoredSessionSettings(
  sessionId: string,
  cwd?: string,
): SessionSettings | undefined {
  if (cwd !== undefined) return settingsBySession.get(sessionSettingsKey(sessionId, cwd));
  for (const settings of [...settingsBySession.values()].reverse()) {
    if (settings.sessionId === sessionId) return settings;
  }
  return undefined;
}

/** 新 fork 在公布前失败时，同步移除其未对外可见的运行态。 */
export function forgetSessionSettings(sessionId: string, cwd?: string): void {
  if (cwd !== undefined) {
    const key = sessionSettingsKey(sessionId, cwd);
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
  resolvedCliSessionSemantics.delete(sessionId);
  globalSessionPermissionGrants.clear(sessionId);
}

export function resetSessionSettingsForTests(): void {
  settingsBySession.clear();
  resolvedCliSessionSemantics.clear();
  globalSessionPermissionGrants.clear();
  persistenceBySettings = new WeakMap<SessionSettings, SessionRuntimePersistence>();
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

  settings.model = normalized;
  delete settings.modelRouteId;
  persistSessionSettings(settings);
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

/** 恢复旧会话时将已解析的兼容路由写回运行态，不因凭证缺失阻断 TUI 自救。 */
export function migrateSessionModelRoute(settings: SessionSettings, route: ModelRoute): void {
  applySessionModelRoute(settings, route);
}

export function resolveRestoredSessionModelRoute(
  router: ModelRouter,
  restored: PersistedSessionSettings | undefined,
  fallbackRouteId?: string,
): ModelRoute {
  return (
    router.resolve(restored?.modelRouteId) ??
    router.resolve(restored?.model) ??
    router.resolve(fallbackRouteId) ??
    router.require(undefined)
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

export function setSessionMode(settings: SessionSettings, mode: string): SessionSettingResult {
  return restoreSessionInteractionMode(settings, mode);
}

/** Rewind 恢复交互模式时，可精确回填进入 plan 前的模式。 */
export function restoreSessionInteractionMode(
  settings: SessionSettings,
  mode: string,
  prePlanMode?: string,
): SessionSettingResult {
  const normalized = normalizeInteractionMode(mode);
  if (normalized === undefined) {
    return {
      ok: false,
      message: `Current mode: ${settings.mode}\nUsage: /mode <default|plan|auto|yolo>`,
    };
  }
  const normalizedPrePlanMode = normalizeInteractionMode(prePlanMode);
  if (
    prePlanMode !== undefined &&
    (normalized !== "plan" ||
      normalizedPrePlanMode === undefined ||
      normalizedPrePlanMode === "plan")
  ) {
    return {
      ok: false,
      message: "prePlanMode must be default, auto, or yolo and requires mode=plan",
    };
  }

  applySessionMode(settings, normalized);
  if (
    normalized === "plan" &&
    normalizedPrePlanMode !== undefined &&
    normalizedPrePlanMode !== "plan"
  ) {
    settings.prePlanMode = normalizedPrePlanMode;
  }
  persistSessionSettings(settings);
  return { ok: true, message: `Mode set to ${settings.mode}` };
}

export function exitSessionPlanMode(settings: SessionSettings): SessionSettingResult {
  if (settings.mode !== "plan") {
    return { ok: true, message: `Mode remains ${settings.mode}` };
  }
  const restored = settings.prePlanMode ?? DEFAULT_INTERACTION_MODE;
  delete settings.prePlanMode;
  settings.mode = restored;
  persistSessionSettings(settings);
  return { ok: true, message: `Mode restored to ${settings.mode}` };
}

export function setSessionPermissionMode(
  settings: SessionSettings,
  mode: string,
): SessionSettingResult {
  const normalized = mode.trim().toLowerCase();
  if (!permissionCommandModes.has(normalized)) {
    return {
      ok: false,
      message: `Current mode: ${settings.mode}\nUsage: /permissions <default|auto|yolo|plan>`,
    };
  }

  const result = setSessionMode(settings, normalized);
  return { ...result, message: `Mode set to ${settings.mode} (/permissions is an alias)` };
}

export function setSessionThinkingEffort(
  settings: SessionSettings,
  effort: string,
  router?: ModelRouter,
): SessionSettingResult {
  if (router) {
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

  if (!isValidThinkingEffort(effort.trim().toLowerCase())) {
    return {
      ok: false,
      message: `Current thinking effort: ${settings.thinkingEffort}\nUsage: /thinking <off|low|medium|high>`,
    };
  }
  const legacyEffort = effort.trim().toLowerCase() as ThinkingEffort;
  const profile = resolveProviderProfile(toProfileProtocol(settings.provider), settings.model);
  if (legacyEffort !== "off" && !profile.supportsThinkingControl) {
    return {
      ok: false,
      message: `${settings.provider}/${settings.model} does not support thinking effort. Current effort: ${settings.thinkingEffort}`,
    };
  }

  settings.thinkingEffort = legacyEffort;
  settings.thinkingEffortExplicit = true;
  persistSessionSettings(settings);
  return { ok: true, message: `Thinking effort set to ${settings.thinkingEffort}` };
}

/** Resolve the effective level that may be sent for the active route. */
export function effectiveSessionReasoningLevel(
  settings: SessionSettings,
  router?: ModelRouter,
): string | undefined {
  if (!router) return settings.thinkingEffort;
  const route = resolveSessionModelRoute(settings, router);
  if (!route) return undefined;
  return coordinateReasoningLevel(
    route.capabilities.reasoningProfile,
    settings.thinkingEffortExplicit ? settings.thinkingEffort : undefined,
  ).level;
}

/** Reconcile startup/restored state with the active route and persist a real fallback level. */
export function coordinateSessionReasoningLevel(
  settings: SessionSettings,
  router: ModelRouter,
): string | undefined {
  const route = resolveSessionModelRoute(settings, router);
  if (!route) return undefined;
  const selection = coordinateReasoningLevel(
    route.capabilities.reasoningProfile,
    settings.thinkingEffortExplicit ? settings.thinkingEffort : undefined,
  );
  if (applyReasoningLevelSelection(settings, selection)) {
    persistSessionSettings(settings);
  }
  return selection.level;
}

export function formatSessionReasoningStatus(
  settings: SessionSettings,
  router?: ModelRouter,
): string {
  if (!router) {
    return [
      `Route: legacy/${settings.provider}/${settings.model}`,
      "Reasoning controls: legacy",
      "Supported levels: off, low, medium, high",
      "Default level: high",
      `Current level: ${settings.thinkingEffort}`,
      "Usage: /thinking <off|low|medium|high>",
    ].join("\n");
  }
  const route = resolveSessionModelRoute(settings, router);
  if (!route) {
    return `Reasoning controls unavailable: model route ${settings.modelRouteId ?? settings.model} was not found.`;
  }
  return formatRouteReasoningStatus(
    route.id,
    route.capabilities.reasoningProfile,
    settings.thinkingEffortExplicit ? settings.thinkingEffort : undefined,
  );
}

export function sessionReasoningCandidates(
  settings: SessionSettings,
  router?: ModelRouter,
): readonly string[] {
  if (!router) return ["off", "low", "medium", "high"];
  return resolveSessionModelRoute(settings, router)?.capabilities.reasoningProfile.levels ?? [];
}

export function parseThinkingEffortArg(raw: string): ThinkingEffort | undefined {
  const value = raw.trim().toLowerCase();
  if (!isValidThinkingEffort(value)) return undefined;
  return value as ThinkingEffort;
}

export function formatSessionStatus(settings: SessionSettings): string {
  return [
    `Mode: ${settings.mode}`,
    `Model: ${settings.model}`,
    `Model route: ${settings.modelRouteId ?? "legacy"}`,
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
    `Mode: ${settings.mode}`,
    "/permissions is a compatibility alias for /mode.",
    "Usage: /permissions <default|auto|yolo|plan>",
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

function toProfileProtocol(provider: ProviderKind): "openai" | "claude" | "gemini" {
  return provider === "openai" ? "openai" : provider;
}

function resolveSessionModelRoute(settings: SessionSettings, router: ModelRouter) {
  return router.resolve(settings.modelRouteId) ?? router.resolve(settings.model);
}

function formatThinkingUsage(capability: ResolvedModelReasoningCapability): string {
  return capability.levels.length > 0 ? `/thinking <${capability.levels.join("|")}>` : "/thinking";
}

function formatRouteReasoningStatus(
  routeId: string,
  capability: ResolvedModelReasoningCapability,
  storedLevel?: string,
): string {
  const lines = [`Route: ${routeId}`];
  if (capability.enabled === false) {
    lines.push("Reasoning: disabled for this model.", "Selectable levels: none");
    return lines.join("\n");
  }
  if (capability.enabled === "unknown") {
    lines.push(
      "Reasoning controls: unknown (the model advertises no reasoning metadata).",
      "Selectable levels: none",
    );
    return lines.join("\n");
  }
  if (capability.levels.length === 0) {
    lines.push("Reasoning: fixed/model-controlled.", "Selectable levels: none");
    return lines.join("\n");
  }
  const selection = coordinateReasoningLevel(capability, storedLevel);
  lines.push(
    `Supported levels: ${capability.levels.join(", ")}`,
    `Default level: ${capability.defaultLevel ?? capability.levels[0]}`,
    `Current level: ${selection.level ?? "none"}`,
    `Usage: ${formatThinkingUsage(capability)}`,
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

export function normalizeInteractionMode(mode: string | undefined): InteractionMode | undefined {
  const normalized = mode?.trim().toLowerCase();
  if (normalized === "ask" || normalized === "default") return "default";
  if (normalized === "auto" || normalized === "acceptedits") return "auto";
  if (normalized === "yolo" || normalized === "bypasspermissions") return "yolo";
  if (normalized === "plan") return "plan";
  return undefined;
}

function createAdditionalDirectorySnapshot(directories: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(directories)]);
}

function sessionSettingsKey(sessionId: string, cwd: string): string {
  return JSON.stringify([resolve(cwd), sessionId]);
}

export function snapshotSessionSettings(settings: SessionSettings): PersistedSessionSettings {
  return {
    ...(settings.title !== undefined ? { title: settings.title } : {}),
    ...(settings.forkFrom !== undefined ? { forkFrom: settings.forkFrom } : {}),
    provider: settings.provider,
    model: settings.model,
    ...(settings.modelRouteId !== undefined ? { modelRouteId: settings.modelRouteId } : {}),
    mode: settings.mode,
    ...(settings.prePlanMode !== undefined ? { prePlanMode: settings.prePlanMode } : {}),
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
  settings.provider = persisted.provider;
  settings.model = persisted.model;
  if (persisted.modelRouteId !== undefined) {
    settings.modelRouteId = persisted.modelRouteId;
  } else {
    delete settings.modelRouteId;
  }
  settings.mode = persisted.mode;
  if (persisted.prePlanMode !== undefined) {
    settings.prePlanMode = persisted.prePlanMode;
  } else {
    delete settings.prePlanMode;
  }
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

function applySessionMode(settings: SessionSettings, mode: InteractionMode): void {
  if (mode === "plan" && settings.mode !== "plan") {
    settings.prePlanMode = settings.mode;
  } else if (mode !== "plan") {
    delete settings.prePlanMode;
  }
  settings.mode = mode;
}

function bindSessionSettingsPersistence(
  settings: SessionSettings,
  persistence: SessionRuntimePersistence | undefined,
): void {
  if (persistence) persistenceBySettings.set(settings, persistence);
}

function persistSessionSettings(settings: SessionSettings): void {
  persistenceBySettings
    .get(settings)
    ?.updateRuntimeState({ settings: snapshotSessionSettings(settings) });
}

function withPermissionModeAlias(
  settings: Omit<SessionSettings, "permissionMode"> &
    Partial<Pick<SessionSettings, "permissionMode">>,
): SessionSettings {
  Object.defineProperty(settings, "permissionMode", {
    enumerable: true,
    configurable: false,
    get: () => settings.mode,
    set: (value: string) => {
      const mode = normalizeInteractionMode(value);
      if (mode !== undefined) {
        applySessionMode(settings as SessionSettings, mode);
        persistSessionSettings(settings as SessionSettings);
      }
    },
  });
  return settings as SessionSettings;
}
