import type { ProviderKind } from "../provider/factory.js";
import type { ModelRouter } from "../provider/model-router.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { isValidThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
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
  thinkingEffort: ThinkingEffort;
  thinkingEffortExplicit: boolean;
  /** @deprecated `/permissions` 兼容别名；读写都代理到 mode，不保存第二份状态。 */
  permissionMode: InteractionMode;
  tools: readonly SessionToolStatus[];
  additionalDirectories: readonly string[];
}

export interface SessionSettingsDefaults {
  sessionId: string;
  sessionMode?: SessionMode;
  forkFrom?: string;
  cwd: string;
  provider: ProviderKind;
  mode?: InteractionMode;
  model: string;
  modelRouteId?: string;
  thinkingEffort?: ThinkingEffort;
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
  const mode =
    normalizeInteractionMode(defaults.mode ?? defaults.permissionMode) ?? DEFAULT_INTERACTION_MODE;
  const compatibilityPreviousMode = normalizeInteractionMode(defaults.permissionMode);
  const settings = {
    sessionId: defaults.sessionId,
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
  const existing = settingsBySession.get(defaults.sessionId);
  if (existing !== undefined) {
    if (existing.cwd !== defaults.cwd) {
      // session id 可能被不同项目复用；目录授权绝不能跨 cwd 继承。
      existing.additionalDirectories = createAdditionalDirectorySnapshot([]);
      globalSessionPermissionGrants.clear(existing.sessionId);
      persistenceBySettings.delete(existing);
    }
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
    existing.cwd = defaults.cwd;
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
  settingsBySession.set(defaults.sessionId, created);
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

export function getStoredSessionSettings(sessionId: string): SessionSettings | undefined {
  return settingsBySession.get(sessionId);
}

/** 新 fork 在公布前失败时，同步移除其未对外可见的运行态。 */
export function forgetSessionSettings(sessionId: string): void {
  const settings = settingsBySession.get(sessionId);
  if (settings) persistenceBySettings.delete(settings);
  settingsBySession.delete(sessionId);
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

export function setSessionModelRoute(
  settings: SessionSettings,
  router: ModelRouter,
  query: string,
): SessionSettingResult {
  const validation = router.validate(query);
  if (!validation.ok) return { ok: false, message: validation.message };

  const { route } = validation;
  settings.modelRouteId = route.id;
  settings.provider = route.provider;
  settings.model = route.model;
  persistSessionSettings(settings);
  return { ok: true, message: `Model set to ${route.id}` };
}

export function setSessionMode(settings: SessionSettings, mode: string): SessionSettingResult {
  const normalized = normalizeInteractionMode(mode);
  if (normalized === undefined) {
    return {
      ok: false,
      message: `Current mode: ${settings.mode}\nUsage: /mode <default|plan|auto|yolo>`,
    };
  }

  applySessionMode(settings, normalized);
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
  effort: ThinkingEffort,
): SessionSettingResult {
  const profile = resolveProviderProfile(toProfileProtocol(settings.provider), settings.model);
  if (effort !== "off" && !profile.supportsThinkingControl) {
    return {
      ok: false,
      message: `${settings.provider}/${settings.model} does not support thinking effort. Current effort: ${settings.thinkingEffort}`,
    };
  }

  settings.thinkingEffort = effort;
  settings.thinkingEffortExplicit = true;
  persistSessionSettings(settings);
  return { ok: true, message: `Thinking effort set to ${settings.thinkingEffort}` };
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

export function snapshotSessionSettings(settings: SessionSettings): PersistedSessionSettings {
  return {
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
