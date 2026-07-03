import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "./registry-impl.js";
import type { BaseTool, RequestMiddleware } from "./registry.js";
import { isDangerousCommand, isHardlineCommand } from "../approval/manager.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import type { AgentRunner, SubagentRegistryFactory, SubagentRegistryRequest } from "./subagent.js";
import { DelegateTaskTool } from "./subagent.js";
import { DelegateStatusTool, type DelegationManager } from "./delegation-manager.js";
import type { AgentProfile } from "./agent-profile.js";

export interface SubagentRegistryFactoryConfig {
  workDir: string;
  runner: AgentRunner;
  manager: DelegationManager;
  maxSpawnDepth?: number;
  /** 用户自定义角色库(来自 .claw/agents.yaml)。agent_name 命中时优先使用。 */
  profiles?: AgentProfile[];
}

/**
 * 工具名 → 构造器的映射(对标 kimi-code profile.tools 的工具实例化)。
 * 自定义角色的 tools 列表里的名字按此映射实例化。
 * 白名单由 agent-profile.ts 的 KNOWN_TOOL_NAMES 约束,这里只列已知的。
 */
type ToolCtor = (workDir: string) => BaseTool;
const TOOL_CONSTRUCTORS: Record<string, ToolCtor> = {
  read_file: (wd) => new ReadFileTool(wd),
  write_file: (wd) => new WriteFileTool(wd),
  edit_file: (wd) => new EditFileTool(wd),
  bash: (wd) => new BashTool(wd),
  skill_view: (wd) => new SkillViewTool(new SkillLoader(wd)),
};

export function createSubagentRegistryFactory(
  config: SubagentRegistryFactoryConfig,
): SubagentRegistryFactory {
  const profiles = config.profiles ?? [];

  return (request: SubagentRegistryRequest) => {
    const registry = new ToolRegistry();

    // 优先分支:自定义角色(agent_name 命中 profile)
    const profile = request.agentName
      ? profiles.find((p) => p.name === request.agentName)
      : undefined;
    if (profile) {
      return buildProfileRegistry(config, request, profile);
    }

    // 默认分支:explore/worker 二档(向后兼容,未传 agent_name 或未命中时走此)
    return buildModeRegistry(config, request, registry);
  };
}

/** 按 profile.tools 构造自定义角色的 registry */
function buildProfileRegistry(
  config: SubagentRegistryFactoryConfig,
  request: SubagentRegistryRequest,
  profile: AgentProfile,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const toolName of profile.tools) {
    const ctor = TOOL_CONSTRUCTORS[toolName];
    if (ctor) registry.register(ctor(config.workDir));
  }
  // 自定义角色仍挂安全 Middleware:高危命令拦截不因自定义放开
  // 用 worker 档的 Middleware(允许普通写,拦 rm -rf / git push --force 等)
  registry.use(buildSubagentSafetyMiddleware("worker"));
  registry.register(new DelegateStatusTool(config.manager));

  // orchestrator 仍可递归委派(若角色允许且未超深度)
  maybeRegisterDelegateTool(config, request, registry);
  return registry;
}

/** 默认的 explore/worker 二档构造(原有逻辑) */
function buildModeRegistry(
  config: SubagentRegistryFactoryConfig,
  request: SubagentRegistryRequest,
  registry: ToolRegistry,
): ToolRegistry {
  registry.register(new ReadFileTool(config.workDir));
  registry.register(new SkillViewTool(new SkillLoader(config.workDir)));

  const bash = new BashTool(config.workDir);
  if (request.mode === "explore") {
    (bash as BashTool & { readOnly?: boolean }).readOnly = true;
  }
  registry.register(bash);

  if (request.mode === "worker") {
    registry.register(new WriteFileTool(config.workDir));
    registry.register(new EditFileTool(config.workDir));
  }

  registry.use(buildSubagentSafetyMiddleware(request.mode));
  registry.register(new DelegateStatusTool(config.manager));

  maybeRegisterDelegateTool(config, request, registry);
  return registry;
}

/** orchestrator 角色且未超深度时,注册 delegate_task(允许递归委派) */
function maybeRegisterDelegateTool(
  config: SubagentRegistryFactoryConfig,
  request: SubagentRegistryRequest,
  registry: ToolRegistry,
): void {
  const maxSpawnDepth = request.maxSpawnDepth ?? config.maxSpawnDepth ?? 2;
  if (request.role === "orchestrator" && request.depth < maxSpawnDepth) {
    registry.register(
      new DelegateTaskTool(config.runner, createSubagentRegistryFactory(config), config.manager, {
        depth: request.depth,
        maxSpawnDepth,
        role: request.role,
        ...(config.profiles ? { profiles: config.profiles } : {}),
      }),
    );
  }
}

function buildSubagentSafetyMiddleware(mode: "explore" | "worker"): RequestMiddleware {
  return async (call) => {
    if (mode === "explore" && call.name === "bash" && isBashMutation(call.arguments)) {
      return {
        allowed: false,
        reason: "子代理只读模式禁止 bash 写入或破坏性命令。",
      };
    }

    if (
      mode === "worker" &&
      (isHardlineCommand(call.name, call.arguments) ||
        isDangerousCommand(call.name, call.arguments))
    ) {
      return {
        allowed: false,
        reason: "worker 子代理禁止执行高危命令;请由主 Agent 或人工审批处理。",
      };
    }

    return { allowed: true };
  };
}

function isBashMutation(args: string): boolean {
  const command = extractBashCommand(args);
  return BASH_MUTATION_PATTERNS.some((pattern) => pattern.test(command));
}

function extractBashCommand(args: string): string {
  try {
    const parsed = JSON.parse(args) as { command?: string };
    return parsed.command ?? args;
  } catch {
    return args;
  }
}

const BASH_MUTATION_PATTERNS: RegExp[] = [
  />|>>|&>|2>/,
  /\btee\b/i,
  /\btouch\b/i,
  /\bmkdir\b/i,
  /\bmv\b/i,
  /\bcp\b/i,
  /\brm\b/i,
  /\brmdir\b/i,
  /\bchmod\b/i,
  /\bchown\b/i,
  /\bsed\s+-i\b/i,
  /\bperl\s+-pi\b/i,
  /\bpython(?:3)?\b.*\b(open|write_text|unlink|rmtree|remove)\b/i,
  /\bnode\b.*\b(writeFile|rmSync|unlinkSync|mkdirSync)\b/i,
  /\bgit\s+(commit|push|reset|checkout|switch|merge|rebase|clean|apply|am)\b/i,
  /\b(?:npm|pnpm|yarn)\s+(install|i|add|remove|uninstall|update|upgrade)\b/i,
];
