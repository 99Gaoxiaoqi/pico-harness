import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
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

  return {
    version: parseVersion(parsed["version"], configPath),
    commandsDir: parseCommandsDir(parsed["commandsDir"], workDir, configPath),
    additionalDirectories: parseAdditionalDirectories(parsed["permissions"], configPath),
    keybindings: parseKeybindings(parsed["keybindings"], configPath),
  };
}

function defaultPicoConfig(workDir: string): PicoConfig {
  return {
    version: CONFIG_VERSION,
    commandsDir: join(workDir, ".pico", "commands"),
    additionalDirectories: [],
    keybindings: {},
  };
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
