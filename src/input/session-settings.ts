import type { ProviderKind } from "../provider/factory.js";
import { resolveProviderProfile } from "../provider/profile.js";
import {
  isValidThinkingEffort,
  type ThinkingEffort,
} from "../provider/thinking.js";
import type { Registry } from "../tools/registry.js";

export interface SessionToolStatus {
  name: string;
  readOnly: boolean;
}

export interface SessionSettings {
  sessionId: string;
  cwd: string;
  provider: ProviderKind;
  model: string;
  thinkingEffort: ThinkingEffort;
  thinkingEffortExplicit: boolean;
  permissionMode: string;
  tools: readonly SessionToolStatus[];
}

export interface SessionSettingsDefaults {
  sessionId: string;
  cwd: string;
  provider: ProviderKind;
  model: string;
  thinkingEffort?: ThinkingEffort;
  permissionMode?: string;
  tools?: readonly SessionToolStatus[];
}

export interface SessionSettingResult {
  ok: boolean;
  message: string;
}

const settingsBySession = new Map<string, SessionSettings>();

export function createDefaultSessionSettings(defaults: SessionSettingsDefaults): SessionSettings {
  return {
    sessionId: defaults.sessionId,
    cwd: defaults.cwd,
    provider: defaults.provider,
    model: defaults.model,
    thinkingEffort: defaults.thinkingEffort ?? "off",
    thinkingEffortExplicit: defaults.thinkingEffort !== undefined,
    permissionMode: defaults.permissionMode ?? "ask",
    tools: defaults.tools ?? [],
  };
}

export function getOrCreateSessionSettings(defaults: SessionSettingsDefaults): SessionSettings {
  const existing = settingsBySession.get(defaults.sessionId);
  if (existing !== undefined) {
    existing.cwd = defaults.cwd;
    existing.provider = defaults.provider;
    existing.permissionMode = defaults.permissionMode ?? existing.permissionMode;
    existing.tools = defaults.tools ?? existing.tools;
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

export function getStoredSessionSettings(sessionId: string): SessionSettings | undefined {
  return settingsBySession.get(sessionId);
}

export function resetSessionSettingsForTests(): void {
  settingsBySession.clear();
}

export function setSessionModel(settings: SessionSettings, model: string): SessionSettingResult {
  const normalized = model.trim();
  if (!normalized) {
    return { ok: false, message: `Current model: ${settings.model}` };
  }

  settings.model = normalized;
  return { ok: true, message: `Model set to ${settings.model}` };
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
    `Model: ${settings.model}`,
    `Effort: ${settings.thinkingEffort}`,
    `Session: ${settings.sessionId}`,
    `CWD: ${settings.cwd}`,
    `Permission: ${settings.permissionMode}`,
  ].join("\n");
}

export function formatToolStatus(tools: readonly SessionToolStatus[]): string {
  if (tools.length === 0) {
    return "No tools are available.";
  }

  return tools
    .map((tool) => `${tool.name} - ${tool.readOnly ? "read-only" : "write"}`)
    .join("\n");
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
