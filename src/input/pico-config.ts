import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ModelProviderConfig } from "../provider/model-router.js";
import type { ModelCapabilityConfig } from "../provider/model-capabilities.js";
import type { ProviderKind } from "../provider/factory.js";
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
  };
}

function defaultPicoConfig(workDir: string): PicoConfig {
  return {
    version: CONFIG_VERSION,
    commandsDir: join(workDir, ".pico", "commands"),
    additionalDirectories: [],
    keybindings: {},
    providers: {},
  };
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
  for (const key of ["vision", "reasoning", "toolCall", "cache"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "boolean") {
      throw configError(configPath, `${field}.${key}`, "must be a boolean");
    }
    result[key] = candidate;
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
