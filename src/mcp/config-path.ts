import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

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
  const requestedWorkspace = resolve(workspacePath);
  const realWorkspace = await realpath(requestedWorkspace);
  const picoPath = join(requestedWorkspace, PICO_PROJECT_MCP_RELATIVE_PATH);
  const picoConfig = await resolveSafeConfigFile(realWorkspace, picoPath);
  if (picoConfig !== undefined) {
    return { path: picoConfig, source: "pico", exists: true };
  }

  const legacyPath = join(requestedWorkspace, LEGACY_PROJECT_MCP_RELATIVE_PATH);
  const legacyConfig = await resolveSafeConfigFile(realWorkspace, legacyPath);
  if (legacyConfig !== undefined) {
    return { path: legacyConfig, source: "claw-compat", exists: true };
  }

  return { path: picoPath, source: "pico", exists: false };
}

async function resolveSafeConfigFile(workspace: string, path: string): Promise<string | undefined> {
  let entry: Awaited<ReturnType<typeof lstat>>;
  try {
    entry = await lstat(path);
  } catch (error) {
    if (isNodeCode(error, "ENOENT") || isNodeCode(error, "ENOTDIR")) return undefined;
    throw error;
  }

  if (entry.isSymbolicLink()) {
    throw new Error(`项目 MCP 配置不允许使用符号链接: ${path}`);
  }
  if (!entry.isFile()) {
    throw new Error(`项目 MCP 配置必须是普通文件: ${path}`);
  }

  const canonicalPath = await realpath(path);
  const rel = relative(workspace, canonicalPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`项目 MCP 配置必须位于真实工作区内: ${path}`);
  }
  return path;
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
