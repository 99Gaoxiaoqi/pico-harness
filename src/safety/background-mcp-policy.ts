import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

export const BACKGROUND_MCP_CONFIG_RELATIVE_PATH = ".claw/mcp.json";

export async function fingerprintBackgroundMcpConfig(workspacePath: string): Promise<string> {
  const configPath = await resolveBackgroundMcpConfigPath(workspacePath);
  const content = await readFile(configPath);
  return createHash("sha256").update(content).digest("hex");
}

export async function verifyBackgroundMcpConfig(input: {
  workspacePath: string;
  expectedFingerprint: string;
}): Promise<string> {
  const configPath = await resolveBackgroundMcpConfigPath(input.workspacePath);
  const content = await readFile(configPath);
  const actual = createHash("sha256").update(content).digest("hex");
  if (actual !== input.expectedFingerprint) {
    throw new Error("后台 MCP 配置已变化，必须重新确认定时任务");
  }
  return configPath;
}

async function resolveBackgroundMcpConfigPath(workspacePath: string): Promise<string> {
  const workspace = await realpath(workspacePath);
  const configPath = await realpath(join(workspace, BACKGROUND_MCP_CONFIG_RELATIVE_PATH));
  const rel = relative(workspace, configPath);
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("后台 MCP 配置必须位于真实工作区的 .claw/mcp.json");
  }
  return configPath;
}
