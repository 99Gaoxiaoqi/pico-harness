import { loadAgentCatalog, summarizeAgentProfiles } from "../agents/catalog.js";
import { SkillLoader } from "../context/skill.js";
import { loadPicoConfig } from "../input/pico-config.js";
import { resolveProjectMcpConfigPath } from "../mcp/config-path.js";
import { McpConnectionManager } from "../mcp/manager.js";
import type { PluginRuntimeSnapshot } from "../plugins/plugin-runtime-snapshot.js";

export interface DesktopResourceCatalogOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly picoHome: string;
  /** The caller-owned immutable plugin projection for this workspace. */
  readonly pluginSnapshot?: PluginRuntimeSnapshot;
}

export async function listDesktopAgents(
  workspacePath: string,
  options: DesktopResourceCatalogOptions,
) {
  const config = await loadPicoConfig(workspacePath);
  const compatibility = config.compatibility.claude;
  const agents = await loadAgentCatalog({
    workDir: workspacePath,
    includeBuiltins: true,
    includeClaudeProjectResources: compatibility.enabled && compatibility.projectResources,
    includeClaudeUserResources: compatibility.enabled && compatibility.userResources,
    ...(options.pluginSnapshot?.agentSources
      ? { externalSources: options.pluginSnapshot.agentSources }
      : {}),
    env: options.env,
    picoHome: options.picoHome,
  });
  return summarizeAgentProfiles(agents);
}

export async function listDesktopSkills(
  workspacePath: string,
  includeUserResources: boolean,
  options: DesktopResourceCatalogOptions,
) {
  const loader = includeUserResources
    ? await loadDesktopSkillLoader(workspacePath, options)
    : new SkillLoader(workspacePath, {
        ...(options.pluginSnapshot?.skillSources
          ? { externalSources: options.pluginSnapshot.skillSources }
          : {}),
      });
  const skills = await loader.list();
  return skills.map((skill) => ({
    name: skill.name,
    description: skill.description,
    ...(skill.sourcePath ? { sourcePath: skill.sourcePath } : {}),
    ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
    ...(skill.model ? { model: skill.model } : {}),
  }));
}

export async function listDesktopMcpServers(workspacePath: string) {
  const manager = new McpConnectionManager(undefined, { stdioCwd: workspacePath });
  try {
    const resolution = await resolveProjectMcpConfigPath(workspacePath);
    await manager.loadConfig(resolution.path);
    return manager.getStatusSnapshot().servers;
  } finally {
    await manager.closeAll();
  }
}

async function loadDesktopSkillLoader(
  workspacePath: string,
  options: DesktopResourceCatalogOptions,
): Promise<SkillLoader> {
  const config = await loadPicoConfig(workspacePath);
  const compatibility = config.compatibility.claude;
  return new SkillLoader(workspacePath, {
    includeUserResources: true,
    includeClaudeProjectResources: compatibility.enabled && compatibility.projectResources,
    includeClaudeUserResources: compatibility.enabled && compatibility.userResources,
    ...(options.pluginSnapshot?.skillSources
      ? { externalSources: options.pluginSnapshot.skillSources }
      : {}),
    env: options.env,
    picoHome: options.picoHome,
  });
}
