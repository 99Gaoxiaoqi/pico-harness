import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { addSessionAdditionalDirectory, type SessionSettings } from "./session-settings.js";
import type { LocalCommandResult, SlashCommand } from "./types.js";

export interface AddDirectoryResult {
  added: boolean;
  path: string;
  reason?: string;
}

export interface AdditionalDirectoryManager {
  list(): readonly string[];
  addDirectory(path: string): Promise<AddDirectoryResult>;
}

export async function loadConfiguredAdditionalDirectories(workDir: string): Promise<string[]> {
  let content: string;
  try {
    content = await readFile(join(workDir, ".pico", "config.json"), "utf8");
  } catch (error) {
    if (isErrnoCode(error, "ENOENT")) return [];
    throw error;
  }

  const parsed = JSON.parse(content) as unknown;
  if (!isRecord(parsed) || !isRecord(parsed["permissions"])) return [];
  const directories = parsed["permissions"]["additionalDirectories"];
  if (directories === undefined) return [];
  if (!Array.isArray(directories) || directories.some((item) => typeof item !== "string")) {
    throw new Error(".pico/config.json permissions.additionalDirectories 必须是字符串数组。");
  }
  return directories.map((item) => item.trim()).filter(Boolean);
}

export function createAddDirectoryCommand(
  settings: SessionSettings,
  manager?: AdditionalDirectoryManager,
): SlashCommand {
  return {
    name: "add-dir",
    description: "Add a directory to the current session workspace",
    usage: "/add-dir [directory]",
    argumentHint: "[directory]",
    category: "workspace",
    kind: "local",
    availability: "idle",
    execute: async (input): Promise<LocalCommandResult> => {
      if (manager === undefined) {
        return localMessage(
          "Add directory unavailable: no workspace directory manager was provided.",
          { available: false },
        );
      }

      if (input.args.length === 0) {
        const roots = [...manager.list()];
        return localMessage(formatWorkspaceRoots(roots), { roots });
      }

      try {
        const result = await manager.addDirectory(input.args);
        const roots = [...manager.list()];
        if (!result.added) {
          return localMessage(
            `Directory not added: ${result.reason ?? result.path}`,
            { ...result, roots },
          );
        }

        const additionalDirectories = addSessionAdditionalDirectory(settings, result.path);
        return localMessage(`Workspace directory added: ${result.path}`, {
          ...result,
          roots,
          additionalDirectories,
        });
      } catch (error) {
        return localMessage(
          `Add directory failed: ${error instanceof Error ? error.message : String(error)}`,
          { added: false },
        );
      }
    },
  };
}

function formatWorkspaceRoots(roots: readonly string[]): string {
  if (roots.length === 0) {
    return "No workspace roots are currently authorized.";
  }
  return ["Authorized workspace roots:", ...roots.map((root) => `- ${root}`)].join("\n");
}

function localMessage(message: string, data?: unknown): LocalCommandResult {
  return {
    type: "local",
    action: "message",
    message,
    ...(data === undefined ? {} : { data }),
  };
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
