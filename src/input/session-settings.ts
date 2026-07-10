import type { ProviderKind } from "../provider/factory.js";
import type { ModelRouter } from "../provider/model-router.js";
import { resolveProviderProfile } from "../provider/profile.js";
import { isValidThinkingEffort, type ThinkingEffort } from "../provider/thinking.js";
import type { Registry } from "../tools/registry.js";

export interface SessionToolStatus {
  name: string;
  readOnly: boolean;
}

export type InteractionMode = "default" | "plan" | "auto" | "yolo";
export type SessionMode = "new" | "continue" | "resume" | "fork";

export interface SessionSettings {
  sessionId: string;
  sessionMode: SessionMode;
  forkFrom?: string;
  cwd: string;
  provider: ProviderKind;
  mode: InteractionMode;
  model: string;
  /** Stable providerID/modelID identity. Endpoint and credentials stay in ModelRouter. */
  modelRouteId?: string;
  thinkingEffort: ThinkingEffort;
  thinkingEffortExplicit: boolean;
  permissionMode: string;
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

const settingsBySession = new Map<string, SessionSettings>();
const resolvedCliSessionSemantics = new Map<
  string,
  { sessionMode: SessionMode; forkFrom?: string }
>();
const permissionCommandModes = new Set(["ask", "default", "auto", "yolo", "plan"]);

export function createDefaultSessionSettings(defaults: SessionSettingsDefaults): SessionSettings {
  const resolvedSemantics = resolvedCliSessionSemantics.get(defaults.sessionId);
  const forkFrom = defaults.forkFrom ?? resolvedSemantics?.forkFrom;
  return {
    sessionId: defaults.sessionId,
    sessionMode: defaults.sessionMode ?? resolvedSemantics?.sessionMode ?? "new",
    ...(forkFrom !== undefined ? { forkFrom } : {}),
    cwd: defaults.cwd,
    provider: defaults.provider,
    mode: defaults.mode ?? "default",
    model: defaults.model,
    ...(defaults.modelRouteId !== undefined ? { modelRouteId: defaults.modelRouteId } : {}),
    thinkingEffort: defaults.thinkingEffort ?? "off",
    thinkingEffortExplicit: defaults.thinkingEffort !== undefined,
    permissionMode: defaults.permissionMode ?? "ask",
    tools: defaults.tools ?? [],
    additionalDirectories: createAdditionalDirectorySnapshot(defaults.additionalDirectories ?? []),
  };
}

export function getOrCreateSessionSettings(defaults: SessionSettingsDefaults): SessionSettings {
  const existing = settingsBySession.get(defaults.sessionId);
  if (existing !== undefined) {
    if (existing.cwd !== defaults.cwd) {
      // session id 可能被不同项目复用；目录授权绝不能跨 cwd 继承。
      existing.additionalDirectories = createAdditionalDirectorySnapshot([]);
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
    existing.provider = defaults.provider;
    existing.mode = defaults.mode ?? existing.mode;
    if (
      defaults.permissionMode !== undefined &&
      shouldApplyPermissionModeDefault(existing.permissionMode, defaults.permissionMode)
    ) {
      existing.permissionMode = defaults.permissionMode;
    }
    existing.tools = defaults.tools ?? existing.tools;
    for (const directory of defaults.additionalDirectories ?? []) {
      addSessionAdditionalDirectory(existing, directory);
    }
    if (defaults.thinkingEffort !== undefined) {
      existing.thinkingEffort = defaults.thinkingEffort;
      existing.thinkingEffortExplicit = true;
    }
    return existing;
  }

  const created = createDefaultSessionSettings(defaults);
  settingsBySession.set(defaults.sessionId, created);
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

export function resetSessionSettingsForTests(): void {
  settingsBySession.clear();
  resolvedCliSessionSemantics.clear();
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
  return settings.additionalDirectories;
}

export function setSessionAdditionalDirectories(
  settings: SessionSettings,
  directories: readonly string[],
): readonly string[] {
  settings.additionalDirectories = createAdditionalDirectorySnapshot(directories);
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
  return { ok: true, message: `Model set to ${route.id}` };
}

export function setSessionMode(settings: SessionSettings, mode: string): SessionSettingResult {
  const normalized = mode.trim().toLowerCase();
  if (!isInteractionMode(normalized)) {
    return {
      ok: false,
      message: `Current mode: ${settings.mode}\nUsage: /mode <default|plan|auto|yolo>`,
    };
  }

  settings.mode = normalized;
  return { ok: true, message: `Mode set to ${settings.mode}` };
}

export function setSessionPermissionMode(
  settings: SessionSettings,
  mode: string,
): SessionSettingResult {
  const normalized = mode.trim().toLowerCase();
  if (!permissionCommandModes.has(normalized)) {
    return {
      ok: false,
      message: `Current permission mode: ${settings.permissionMode}\nUsage: /permissions <ask|default|auto|yolo|plan>`,
    };
  }

  settings.permissionMode = normalized;
  return { ok: true, message: `Permission mode set to ${settings.permissionMode}` };
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
    `Permission mode: ${settings.permissionMode}`,
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
    `Permission mode: ${settings.permissionMode}`,
    "Session approvals: unavailable",
    "Usage: /permissions <ask|default|auto|yolo|plan>",
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

function isInteractionMode(mode: string): mode is InteractionMode {
  return mode === "default" || mode === "plan" || mode === "auto" || mode === "yolo";
}

function shouldApplyPermissionModeDefault(current: string, next: string): boolean {
  if (current === next) return true;
  if (current === "ask") return true;
  return next !== "ask";
}

function createAdditionalDirectorySnapshot(directories: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(directories)]);
}
