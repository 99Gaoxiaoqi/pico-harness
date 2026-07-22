import { createHash } from "node:crypto";
import { loadAgentCatalog, summarizeAgentProfiles } from "../agents/catalog.js";
import { SkillLoader } from "../context/skill.js";
import { projectResourceCatalog } from "../catalog/resource-catalog.js";
import { loadPicoConfig } from "../input/pico-config.js";
import { resolveProjectMcpConfigPath } from "../mcp/config-path.js";
import { McpConnectionManager } from "../mcp/manager.js";
import type { PluginRuntimeSnapshot } from "../plugins/plugin-runtime-snapshot.js";

export interface DesktopResourceCatalogOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly picoHome: string;
  readonly homeDir?: string;
  /** The caller-owned immutable plugin projection for this workspace. */
  readonly pluginSnapshot?: PluginRuntimeSnapshot;
}

export interface RuntimeScopedSkill {
  readonly name: string;
  readonly description: string;
  readonly source: {
    readonly scope: "user" | "project" | "plugin";
    readonly sourceId: string;
    readonly sourceLabel: string;
    readonly readOnly: boolean;
    readonly effective: boolean;
    readonly shadowedBy?: string;
  };
  readonly allowedTools?: readonly string[];
  readonly model?: string;
}

export interface DesktopUserSkillCatalog {
  readonly skills: readonly RuntimeScopedSkill[];
  readonly revision: string;
}

export interface DesktopEffectiveSkillCatalog {
  readonly skills: readonly RuntimeScopedSkill[];
  readonly revisions: {
    readonly user: string;
    /** 项目目录与其不可变 Plugin 快照共同构成工作区侧修订。 */
    readonly project: string;
  };
}

/**
 * 用户级枚举没有 workspace 参数，且 SkillLoader 的 user 模式不会构造项目或 Plugin 来源。
 */
export async function listDesktopUserSkills(
  options: DesktopResourceCatalogOptions,
): Promise<DesktopUserSkillCatalog> {
  const loader = new SkillLoader(options.picoHome, {
    catalogScope: "user",
    includeClaudeUserResources: true,
    env: options.env,
    picoHome: options.picoHome,
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
  const snapshot = await loader.snapshot();
  return {
    skills: projectScopedSkills(snapshot.candidates),
    revision: snapshot.scopeRevisions.user,
  };
}

/**
 * 调用方必须先校验并规范化 trustedWorkspacePath；本函数随后才能读取项目配置和资源。
 * Plugin 仅消费调用方提供的不可变快照，不运行其代码。
 */
export async function listDesktopEffectiveSkills(
  trustedWorkspacePath: string,
  options: DesktopResourceCatalogOptions,
): Promise<DesktopEffectiveSkillCatalog> {
  const loader = await loadDesktopSkillLoader(trustedWorkspacePath, options);
  const snapshot = await loader.snapshot();
  return {
    skills: projectScopedSkills(snapshot.candidates),
    revisions: {
      user: snapshot.scopeRevisions.user,
      project: combineRevisions(
        snapshot.scopeRevisions.project,
        snapshot.scopeRevisions.external,
        snapshot.scopeRevisions.builtin,
      ),
    },
  };
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

export async function listDesktopMcpServers(
  workspacePath: string,
  options: DesktopResourceCatalogOptions,
) {
  const manager = new McpConnectionManager(undefined, { stdioCwd: workspacePath });
  try {
    const resolution = await resolveProjectMcpConfigPath(workspacePath);
    await manager.replaceSources([
      {
        id: "project",
        path: resolution.path,
        optional: !resolution.exists,
      },
      ...(options.pluginSnapshot?.mcpSources ?? []),
    ]);
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
    ...(options.homeDir ? { homeDir: options.homeDir } : {}),
  });
}

function projectScopedSkills(
  candidates: Awaited<ReturnType<SkillLoader["snapshot"]>>["candidates"],
): RuntimeScopedSkill[] {
  return projectResourceCatalog(candidates).entries.map(({ candidate, effective, shadowedBy }) => {
    const skill = candidate.value;
    const scope = candidate.source.scope === "external" ? "plugin" : candidate.source.scope;
    if (scope === "builtin") {
      throw new Error(`Skill 来源不支持 builtin scope: ${candidate.source.id}`);
    }
    return {
      name: skill.name,
      description: skill.description,
      source: {
        scope,
        sourceId: candidate.source.id,
        sourceLabel: skillSourceLabel(candidate.source.id),
        readOnly: scope === "plugin",
        effective,
        ...(shadowedBy ? { shadowedBy } : {}),
      },
      ...(skill.allowedTools ? { allowedTools: skill.allowedTools } : {}),
      ...(skill.model ? { model: skill.model } : {}),
    };
  });
}

function skillSourceLabel(sourceId: string): string {
  switch (sourceId) {
    case "user-pico":
      return "Pico 用户级";
    case "user-claude":
      return "Claude 用户级";
    case "project-pico":
      return "Pico 项目级";
    case "project-claw-legacy":
      return "Pico 项目级（.claw 兼容）";
    case "project-claude":
      return "Claude 项目级";
    default: {
      const pluginId = sourceId.match(/^plugin:([^:]+)/)?.[1];
      return pluginId ? `Plugin · ${pluginId}` : `Plugin · ${sourceId}`;
    }
  }
}

function combineRevisions(...revisions: readonly string[]): string {
  return createHash("sha256").update(revisions.join("\n")).digest("hex");
}
