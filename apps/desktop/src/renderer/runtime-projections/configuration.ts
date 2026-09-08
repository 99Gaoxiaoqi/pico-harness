import type { RuntimeScopedMcpServer, RuntimeScopedSkill } from "@pico/protocol";
import {
  type CapabilitySourceView,
  type CapabilityView,
  type CatalogAgentView,
  type CatalogSkillView,
  type JsonRecord,
  type ModelRouteView,
  type ProviderConfigView,
  type ProviderCredentialSource,
  type ProviderCredentialStatus,
  type ProviderOrigin,
  type ProviderProtocol,
  type ProviderView,
  type UserDefaultsView,
} from "../model.js";
import { booleanValue, isRecord, recordArray, stringValue } from "./values.js";

export function parseModelRoutes(value: unknown): readonly ModelRouteView[] {
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
  return value === "claude" || value === "responses" ? value : "openai";
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
    ...(isRecord(value.modelProtocols)
      ? {
          modelProtocols: Object.fromEntries(
            Object.entries(value.modelProtocols).map(([model, protocol]) => [
              model,
              providerProtocol(protocol),
            ]),
          ),
        }
      : {}),
    ...(value.auth === "none" || value.auth === "api-key" ? { auth: value.auth } : {}),
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

export function parseUserDefaults(value: unknown): UserDefaultsView {
  const defaults = isRecord(value) ? value : {};
  const collaborationMode = defaults.collaborationMode;
  const orchestrationMode = defaults.orchestrationMode;
  const permissionMode = defaults.permissionMode;
  const mode = defaults.mode;
  return {
    ...(stringValue(defaults.modelRouteId)
      ? { modelRouteId: stringValue(defaults.modelRouteId) }
      : {}),
    ...(collaborationMode === "agent" || collaborationMode === "plan" ? { collaborationMode } : {}),
    ...(orchestrationMode === "default" ||
    orchestrationMode === "graph" ||
    orchestrationMode === "swarm"
      ? { orchestrationMode }
      : {}),
    ...(permissionMode === "default" || permissionMode === "auto" || permissionMode === "yolo"
      ? { permissionMode }
      : {}),
    ...(mode === "default" || mode === "plan" || mode === "auto" || mode === "yolo"
      ? { mode }
      : {}),
    ...(stringValue(defaults.thinkingEffort)
      ? { thinkingEffort: stringValue(defaults.thinkingEffort) }
      : {}),
  };
}

export function parseProviderConfig(
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
  const registryProviders = recordArray(registryResult.providers);
  const revision = stringValue(registryResult.revision ?? userResult.revision);
  const writable =
    isRecord(results.providerRegistry) && isRecord(results.userConfig) && revision.length > 0;
  const defaultModelRouteId = stringValue(
    isRecord(userConfig.defaults) ? userConfig.defaults.modelRouteId : undefined,
  );
  return {
    supported: true,
    writable,
    revision,
    ...(defaultModelRouteId ? { defaultModelRouteId } : {}),
    userDefaults: parseUserDefaults(userConfig.defaults),
    providers: registryProviders.map(parseProviderProfile),
  };
}

export function parseCatalogAgents(value: unknown): readonly CatalogAgentView[] {
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

export function parseCatalogSkills(value: unknown): readonly CatalogSkillView[] {
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

export function capability(item: JsonRecord, index: number): CapabilityView {
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

export function scopedSkill(skill: RuntimeScopedSkill, index: number): CapabilityView {
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

export function scopedMcpServer(server: RuntimeScopedMcpServer, index: number): CapabilityView {
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
