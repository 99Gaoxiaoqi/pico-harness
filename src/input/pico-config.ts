import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ModelProviderConfig } from "../provider/model-router.js";
import type { ModelCapabilityConfig } from "../provider/model-capabilities.js";
import type {
  JsonValue,
  ModelReasoningCapabilityConfig,
  ReasoningProtocolOptions,
  ReasoningRequestPatch,
  RequestBodyPath,
} from "../provider/reasoning-capability.js";
import type { ProviderKind } from "../provider/factory.js";
import type { LspServerConfig } from "../code-intelligence/lsp-server-discovery.js";
import type { YoloSandboxConfig } from "../safety/yolo-sandbox.js";
import {
  KEYBINDING_ACTIONS,
  KEYBINDING_CONTEXTS,
  type KeybindingAction,
  type KeybindingContext,
  type KeybindingMap,
  type KeybindingValue,
} from "../tui/keybindings/schema.js";

const CONFIG_VERSION = 1 as const;

const KEYBINDING_CONTEXT_SET: ReadonlySet<string> = new Set(KEYBINDING_CONTEXTS);
const KEYBINDING_ACTION_SET: ReadonlySet<string> = new Set(KEYBINDING_ACTIONS);

export interface PicoConfig {
  version: typeof CONFIG_VERSION;
  /** Absolute project command directory resolved from the config file. */
  commandsDir: string;
  additionalDirectories: string[];
  keybindings: KeybindingMap;
  /** Default model route in providerID/modelID form. */
  model?: string;
  providers: Record<string, ModelProviderConfig>;
  sandbox: YoloSandboxConfig;
  lspServers: LspServerConfig[];
}

export async function loadPicoConfig(workDir: string): Promise<PicoConfig> {
  const configPath = join(workDir, ".pico", "config.json");
  let content: string;
  try {
    content = await readFile(configPath, "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return defaultPicoConfig(workDir);
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content) as unknown;
  } catch (error) {
    throw new Error(`${configPath}: invalid JSON`, { cause: error });
  }
  if (!isRecord(parsed)) {
    throw configError(configPath, "root", "must be an object");
  }

  const model = parseDefaultModel(parsed["model"], configPath);
  return {
    version: parseVersion(parsed["version"], configPath),
    commandsDir: parseCommandsDir(parsed["commandsDir"], workDir, configPath),
    additionalDirectories: parseAdditionalDirectories(parsed["permissions"], configPath),
    keybindings: parseKeybindings(parsed["keybindings"], configPath),
    ...(model !== undefined ? { model } : {}),
    providers: parseProviders(parsed["providers"], configPath),
    sandbox: parseSandbox(parsed["sandbox"], configPath),
    lspServers: parseLspServers(parsed["lsp"], configPath),
  };
}

function defaultPicoConfig(workDir: string): PicoConfig {
  return {
    version: CONFIG_VERSION,
    commandsDir: join(workDir, ".pico", "commands"),
    additionalDirectories: [],
    keybindings: {},
    providers: {},
    sandbox: { network: "deny" },
    lspServers: [],
  };
}

function parseSandbox(value: unknown, configPath: string): YoloSandboxConfig {
  if (value === undefined) return { network: "deny" };
  if (!isRecord(value)) throw configError(configPath, "sandbox", "must be an object");
  const network = value["network"] ?? "deny";
  if (network !== "deny" && network !== "allow") {
    throw configError(configPath, "sandbox.network", "must be deny or allow");
  }
  return { network };
}

function parseLspServers(value: unknown, configPath: string): LspServerConfig[] {
  if (value === undefined) return [];
  if (!isRecord(value)) throw configError(configPath, "lsp", "must be an object");
  const servers = value["servers"];
  if (servers === undefined) return [];
  if (!Array.isArray(servers)) {
    throw configError(configPath, "lsp.servers", "must be an array");
  }
  return servers.map((server, index) => parseLspServer(server, configPath, index));
}

function parseLspServer(value: unknown, configPath: string, index: number): LspServerConfig {
  const field = `lsp.servers.${index}`;
  if (!isRecord(value)) throw configError(configPath, field, "must be an object");
  const id = parseRequiredString(value["id"], configPath, `${field}.id`);
  const command = parseRequiredString(value["command"], configPath, `${field}.command`);
  const args = parseOptionalStringArray(value["args"], configPath, `${field}.args`);
  const languages = parseOptionalStringArray(value["languages"], configPath, `${field}.languages`);
  const requestTimeoutMs = parseOptionalPositiveInteger(
    value["requestTimeoutMs"],
    configPath,
    `${field}.requestTimeoutMs`,
  );
  const startupTimeoutMs = parseOptionalPositiveInteger(
    value["startupTimeoutMs"],
    configPath,
    `${field}.startupTimeoutMs`,
  );
  return {
    id,
    command,
    ...(args ? { args } : {}),
    ...(languages ? { languages } : {}),
    ...(requestTimeoutMs !== undefined ? { requestTimeoutMs } : {}),
    ...(startupTimeoutMs !== undefined ? { startupTimeoutMs } : {}),
  };
}

function parseOptionalStringArray(
  value: unknown,
  configPath: string,
  field: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw configError(configPath, field, "must be a string array");
  }
  return value.map((item) => item.trim()).filter(Boolean);
}

function parseOptionalPositiveInteger(
  value: unknown,
  configPath: string,
  field: string,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    throw configError(configPath, field, "must be a positive integer");
  }
  return value as number;
}

function parseDefaultModel(value: unknown, configPath: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !/^[^/\s]+\/.+$/u.test(value.trim())) {
    throw configError(configPath, "model", "must use providerID/modelID format");
  }
  return value.trim();
}

function parseProviders(value: unknown, configPath: string): Record<string, ModelProviderConfig> {
  if (value === undefined) return {};
  if (!isRecord(value)) throw configError(configPath, "providers", "must be an object");

  const providers: Record<string, ModelProviderConfig> = {};
  for (const [rawId, rawProvider] of Object.entries(value)) {
    const id = rawId.trim();
    const field = `providers.${rawId}`;
    if (!id || id.includes("/")) {
      throw configError(configPath, field, "id must be non-empty and must not contain /");
    }
    if (!isRecord(rawProvider)) throw configError(configPath, field, "must be an object");
    const protocol = rawProvider["protocol"] ?? "openai";
    if (!isProviderKind(protocol)) {
      throw configError(configPath, `${field}.protocol`, "must be openai, claude, or gemini");
    }
    const baseURL = parseRequiredString(rawProvider["baseURL"], configPath, `${field}.baseURL`);
    const apiKeyEnv = parseRequiredString(
      rawProvider["apiKeyEnv"],
      configPath,
      `${field}.apiKeyEnv`,
    );
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv)) {
      throw configError(configPath, `${field}.apiKeyEnv`, "must be an environment variable name");
    }
    const parsedModels = parseModels(rawProvider["models"], configPath, `${field}.models`);
    const discoverModels = rawProvider["discoverModels"];
    if (discoverModels !== undefined && typeof discoverModels !== "boolean") {
      throw configError(configPath, `${field}.discoverModels`, "must be a boolean");
    }
    providers[id] = {
      protocol,
      baseURL,
      apiKeyEnv,
      models: parsedModels.models,
      discoverModels: discoverModels ?? protocol === "openai",
      ...(Object.keys(parsedModels.capabilities).length > 0
        ? { modelCapabilities: parsedModels.capabilities }
        : {}),
    };
  }
  return providers;
}

function parseModels(
  value: unknown,
  configPath: string,
  field: string,
): { models: string[]; capabilities: Record<string, ModelCapabilityConfig> } {
  if (value === undefined) return { models: [], capabilities: {} };
  if (Array.isArray(value)) {
    if (value.some((model) => typeof model !== "string")) {
      throw configError(configPath, field, "must be a string array or model capability object");
    }
    return {
      models: value.map((model) => model.trim()).filter(Boolean),
      capabilities: {},
    };
  }
  if (!isRecord(value)) {
    throw configError(configPath, field, "must be a string array or model capability object");
  }

  const models: string[] = [];
  const capabilities: Record<string, ModelCapabilityConfig> = {};
  for (const [rawModel, rawCapabilities] of Object.entries(value)) {
    const model = rawModel.trim();
    const modelField = `${field}.${rawModel}`;
    if (!model) throw configError(configPath, modelField, "model id must not be empty");
    if (!isRecord(rawCapabilities)) {
      throw configError(configPath, modelField, "must be a capability object");
    }
    models.push(model);
    capabilities[model] = parseModelCapabilities(rawCapabilities, configPath, modelField);
  }
  return { models, capabilities };
}

function parseModelCapabilities(
  value: Record<string, unknown>,
  configPath: string,
  field: string,
): ModelCapabilityConfig {
  const result: ModelCapabilityConfig = {};
  for (const key of ["context", "output"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (!Number.isSafeInteger(candidate) || (candidate as number) <= 0) {
      throw configError(configPath, `${field}.${key}`, "must be a positive integer");
    }
    result[key] = candidate as number;
  }
  for (const key of ["vision", "toolCall", "cache"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "boolean") {
      throw configError(configPath, `${field}.${key}`, "must be a boolean");
    }
    result[key] = candidate;
  }

  const reasoning = value["reasoning"];
  if (reasoning !== undefined) {
    result.reasoning = parseModelReasoning(reasoning, configPath, `${field}.reasoning`);
  }

  const fallback = value["fallback"];
  if (fallback !== undefined) {
    if (fallback !== false && (typeof fallback !== "string" || fallback.trim().length === 0)) {
      throw configError(configPath, `${field}.fallback`, "must be a non-empty string or false");
    }
    result.fallback = typeof fallback === "string" ? fallback.trim() : false;
  }

  const price = value["price"];
  if (price !== undefined) {
    if (!isRecord(price)) throw configError(configPath, `${field}.price`, "must be an object");
    result.price = parseModelPrice(price, configPath, `${field}.price`);
  }
  if (
    result.context !== undefined &&
    result.output !== undefined &&
    result.output >= result.context
  ) {
    throw configError(configPath, field, "output must be smaller than context");
  }
  return result;
}

function parseModelReasoning(
  value: unknown,
  configPath: string,
  field: string,
): boolean | ModelReasoningCapabilityConfig {
  if (typeof value === "boolean") return value;
  if (!isRecord(value)) {
    throw configError(configPath, field, "must be a boolean or reasoning capability object");
  }
  const enabled = value["enabled"];
  if (typeof enabled !== "boolean") {
    throw configError(configPath, `${field}.enabled`, "must be a boolean");
  }

  const levels = parseOptionalStringArray(value["levels"], configPath, `${field}.levels`) ?? [];
  const normalizedLevels = new Set(levels.map((level) => level.toLowerCase()));
  if (normalizedLevels.size !== levels.length) {
    throw configError(configPath, `${field}.levels`, "must not contain duplicate levels");
  }
  const defaultLevel = parseOptionalNonEmptyString(
    value["defaultLevel"],
    configPath,
    `${field}.defaultLevel`,
  );
  if (defaultLevel && !normalizedLevels.has(defaultLevel.toLowerCase())) {
    throw configError(configPath, `${field}.defaultLevel`, "must be present in levels");
  }
  const providerOptionsByLevel = parseProviderOptionsByLevel(
    value["providerOptionsByLevel"],
    configPath,
    `${field}.providerOptionsByLevel`,
    normalizedLevels,
  );
  if (!enabled && (levels.length > 0 || defaultLevel || providerOptionsByLevel)) {
    throw configError(configPath, field, "disabled reasoning must not declare levels or options");
  }
  return {
    enabled,
    ...(levels.length > 0 ? { levels } : {}),
    ...(defaultLevel ? { defaultLevel } : {}),
    ...(providerOptionsByLevel ? { providerOptionsByLevel } : {}),
  };
}

function parseProviderOptionsByLevel(
  value: unknown,
  configPath: string,
  field: string,
  levels: ReadonlySet<string>,
): Readonly<Record<string, ReasoningProtocolOptions>> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw configError(configPath, field, "must be an object");
  const result: Record<string, ReasoningProtocolOptions> = {};
  for (const [level, rawProtocols] of Object.entries(value)) {
    if (!levels.has(level.toLowerCase())) {
      throw configError(configPath, `${field}.${level}`, "level must be declared in levels");
    }
    if (!isRecord(rawProtocols)) {
      throw configError(configPath, `${field}.${level}`, "must be an object");
    }
    const protocols: Partial<Record<ProviderKind, ReasoningRequestPatch>> = {};
    for (const [protocol, rawPatch] of Object.entries(rawProtocols)) {
      if (!isProviderKind(protocol)) {
        throw configError(
          configPath,
          `${field}.${level}.${protocol}`,
          "must be openai, claude, or gemini",
        );
      }
      protocols[protocol] = parseReasoningRequestPatch(
        rawPatch,
        configPath,
        `${field}.${level}.${protocol}`,
      );
    }
    result[level] = protocols;
  }
  return result;
}

function parseReasoningRequestPatch(
  value: unknown,
  configPath: string,
  field: string,
): ReasoningRequestPatch {
  if (!isRecord(value)) throw configError(configPath, field, "must be an object");
  const setValue = value["set"];
  const unsetValue = value["unset"];
  if (setValue !== undefined && !Array.isArray(setValue)) {
    throw configError(configPath, `${field}.set`, "must be an array");
  }
  if (unsetValue !== undefined && !Array.isArray(unsetValue)) {
    throw configError(configPath, `${field}.unset`, "must be an array");
  }
  const set = (setValue ?? []).map((operation, index) => {
    if (!isRecord(operation)) {
      throw configError(configPath, `${field}.set.${index}`, "must be an object");
    }
    const path = parseRequestBodyPath(operation["path"], configPath, `${field}.set.${index}.path`);
    const patchValue = operation["value"];
    if (!isJsonValue(patchValue)) {
      throw configError(configPath, `${field}.set.${index}.value`, "must be a JSON value");
    }
    return { path, value: patchValue };
  });
  const unset = (unsetValue ?? []).map((path, index) =>
    parseRequestBodyPath(path, configPath, `${field}.unset.${index}`),
  );
  return {
    ...(set.length > 0 ? { set } : {}),
    ...(unset.length > 0 ? { unset } : {}),
  };
}

function parseRequestBodyPath(value: unknown, configPath: string, field: string): RequestBodyPath {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some(
      (segment) =>
        typeof segment !== "string" ||
        segment.length === 0 ||
        segment === "__proto__" ||
        segment === "prototype" ||
        segment === "constructor",
    )
  ) {
    throw configError(configPath, field, "must be a safe, non-empty string path array");
  }
  const [first, ...rest] = value as string[];
  return [first!, ...rest];
}

function parseOptionalNonEmptyString(
  value: unknown,
  configPath: string,
  field: string,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(configPath, field, "must be a non-empty string");
  }
  return value.trim();
}

function isJsonValue(value: unknown): value is JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return true;
  }
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function parseModelPrice(
  value: Record<string, unknown>,
  configPath: string,
  field: string,
): NonNullable<ModelCapabilityConfig["price"]> {
  const keys = [
    "inputPerMillion",
    "outputPerMillion",
    "cacheReadPerMillion",
    "cacheWritePerMillion",
  ] as const;
  const result = {} as Record<(typeof keys)[number], number | null>;
  for (const key of keys) {
    const candidate = value[key];
    if (
      candidate !== null &&
      (typeof candidate !== "number" || !Number.isFinite(candidate) || candidate < 0)
    ) {
      throw configError(configPath, `${field}.${key}`, "must be a non-negative number or null");
    }
    result[key] = candidate as number | null;
  }
  return result;
}

function parseRequiredString(value: unknown, configPath: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(configPath, field, "must be a non-empty string");
  }
  return value.trim();
}

function isProviderKind(value: unknown): value is ProviderKind {
  return value === "openai" || value === "claude" || value === "gemini";
}

function parseVersion(value: unknown, configPath: string): typeof CONFIG_VERSION {
  if (value === undefined || value === CONFIG_VERSION) return CONFIG_VERSION;
  throw configError(configPath, "version", `must equal ${CONFIG_VERSION}`);
}

function parseCommandsDir(value: unknown, workDir: string, configPath: string): string {
  if (value === undefined) return join(workDir, ".pico", "commands");
  if (typeof value !== "string" || value.trim().length === 0) {
    throw configError(configPath, "commandsDir", "must be a non-empty string");
  }

  const resolved = resolve(workDir, value.trim());
  const relativePath = relative(workDir, resolved);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw configError(configPath, "commandsDir", "must stay inside the project directory");
  }
  return resolved;
}

function parseAdditionalDirectories(value: unknown, configPath: string): string[] {
  if (value === undefined) return [];
  if (!isRecord(value)) {
    throw configError(configPath, "permissions", "must be an object");
  }
  const directories = value["additionalDirectories"];
  if (directories === undefined) return [];
  if (!Array.isArray(directories) || directories.some((item) => typeof item !== "string")) {
    throw configError(configPath, "permissions.additionalDirectories", "must be a string array");
  }
  return directories.map((item) => item.trim()).filter(Boolean);
}

function parseKeybindings(value: unknown, configPath: string): KeybindingMap {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw configError(configPath, "keybindings", "must be an object");
  }

  const keybindings: KeybindingMap = {};
  for (const [rawContext, rawBindings] of Object.entries(value)) {
    if (!isKeybindingContext(rawContext)) {
      throw configError(configPath, `keybindings.${rawContext}`, "is not a known context");
    }
    if (!isRecord(rawBindings)) {
      throw configError(configPath, `keybindings.${rawContext}`, "must be an object");
    }

    const bindings: Record<string, KeybindingValue> = {};
    for (const [rawKey, rawBinding] of Object.entries(rawBindings)) {
      const key = rawKey.trim().toLowerCase();
      const fieldPath = `keybindings.${rawContext}.${rawKey}`;
      if (key.length === 0) {
        throw configError(configPath, fieldPath, "key must not be empty");
      }
      if (Object.hasOwn(bindings, key)) {
        throw configError(configPath, fieldPath, `duplicates normalized key ${key}`);
      }
      if (!isKeybindingValue(rawBinding)) {
        throw configError(configPath, fieldPath, "must be an action, command:/..., or null");
      }
      bindings[key] = rawBinding;
    }
    keybindings[rawContext] = bindings;
  }
  return keybindings;
}

function isKeybindingContext(value: string): value is KeybindingContext {
  return KEYBINDING_CONTEXT_SET.has(value);
}

function isKeybindingValue(value: unknown): value is KeybindingValue {
  if (value === null) return true;
  if (typeof value !== "string") return false;
  return isKeybindingAction(value) || /^command:\/.+/u.test(value);
}

function isKeybindingAction(value: string): value is KeybindingAction {
  return KEYBINDING_ACTION_SET.has(value);
}

function configError(configPath: string, fieldPath: string, detail: string): Error {
  return new Error(`${configPath}: ${fieldPath} ${detail}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
