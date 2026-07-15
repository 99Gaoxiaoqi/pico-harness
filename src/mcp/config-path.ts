import { lstat } from "node:fs/promises";
import { join, resolve } from "node:path";

export const PICO_PROJECT_MCP_RELATIVE_PATH = ".pico/mcp.json";
export const LEGACY_PROJECT_MCP_RELATIVE_PATH = ".claw/mcp.json";

export type ProjectMcpConfigSource = "pico" | "claw-compat";

export interface ProjectMcpConfigPathResolution {
  readonly path: string;
  readonly source: ProjectMcpConfigSource;
  readonly exists: boolean;
}

/**
 * Resolves the read authority for project MCP configuration. Pico-native config always wins;
 * legacy `.claw` is consulted only when the native path is absent and is never a write target.
 */
export async function resolveProjectMcpConfigPath(
  workspacePath: string,
): Promise<ProjectMcpConfigPathResolution> {
  const workspace = resolve(workspacePath);
  const picoPath = join(workspace, PICO_PROJECT_MCP_RELATIVE_PATH);
  if (await pathEntryExists(picoPath)) {
    return { path: picoPath, source: "pico", exists: true };
  }

  const legacyPath = join(workspace, LEGACY_PROJECT_MCP_RELATIVE_PATH);
  if (await pathEntryExists(legacyPath)) {
    return { path: legacyPath, source: "claw-compat", exists: true };
  }

  return { path: picoPath, source: "pico", exists: false };
}

async function pathEntryExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isNodeCode(error, "ENOENT") || isNodeCode(error, "ENOTDIR")) return false;
    throw error;
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
