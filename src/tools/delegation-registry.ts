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
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { FetchURLTool, WebSearchTool } from "./web.js";
import { WorkspaceRoots } from "./workspace-roots.js";
import { evaluateYoloToolCall, type YoloSandboxConfig } from "../safety/yolo-sandbox.js";

export interface SubagentRegistryFactoryConfig {
  workDir: string;
  /** 主 Agent 的共享授权根集合，包含 /add-dir 动态授权的目录。 */
  workspaceRoots?: WorkspaceRoots;
  runner: AgentRunner;
  manager: DelegationManager;
  maxSpawnDepth?: number;
  /** 用户自定义角色库(来自 .claw/agents.yaml)。agent_name 命中时优先使用。 */
  profiles?: AgentProfile[];
  /** 主 TUI 为 YOLO 时注入同一宿主边界，子代理不得绕过。 */
  yoloSandbox?: { config?: Partial<YoloSandboxConfig> };
}

/**
 * 工具名 → 构造器的映射(对标 kimi-code profile.tools 的工具实例化)。
 * 自定义角色的 tools 列表里的名字按此映射实例化。
 * 白名单由 agent-profile.ts 的 KNOWN_TOOL_NAMES 约束,这里只列已知的。
 */
type ToolCtor = (
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
  yoloSandbox?: { config?: Partial<YoloSandboxConfig> },
) => BaseTool;
// exported 供测试按名字断言实例化结果;自定义角色按 profile.tools 实例化时查此 map。
export const TOOL_CONSTRUCTORS: Record<string, ToolCtor> = {
  read_file: (wd, roots) => new ReadFileTool(roots ?? wd),
  write_file: (wd, roots) => new WriteFileTool(roots ?? wd),
  edit_file: (wd, roots) => new EditFileTool(roots ?? wd),
  bash: (wd, roots, yoloSandbox) =>
    new BashTool(wd, undefined, {
      allowBackground: false,
      ...(roots && yoloSandbox
        ? {
            sandbox: {
              workspaceRoots: roots,
              ...(yoloSandbox.config ? { config: yoloSandbox.config } : {}),
            },
          }
        : {}),
    }),
  skill_view: (wd) => new SkillViewTool(new SkillLoader(wd)),
  glob: (wd, roots) => new GlobTool(roots ?? wd),
  grep: (wd, roots) => new GrepTool(roots ?? wd),
  fetch_url: () => new FetchURLTool(),
  web_search: () => new WebSearchTool(),
};

export function createSubagentRegistryFactory(
  config: SubagentRegistryFactoryConfig,
): SubagentRegistryFactory {
  const resolvedConfig: ResolvedSubagentRegistryFactoryConfig = {
    ...config,
    workspaceRoots: config.workspaceRoots ?? WorkspaceRoots.createSync(config.workDir),
  };
  const profiles = resolvedConfig.profiles ?? [];

  return (request: SubagentRegistryRequest) => {
    const registry = new ToolRegistry();

    // 优先分支:自定义角色(agent_name 命中 profile)
    const profile = request.agentName
      ? profiles.find((p) => p.name === request.agentName)
      : undefined;
    if (profile) {
      return buildProfileRegistry(resolvedConfig, request, profile);
    }

    // 默认分支:explore/worker 二档(向后兼容,未传 agent_name 或未命中时走此)
    return buildModeRegistry(resolvedConfig, request, registry);
  };
}

interface ResolvedSubagentRegistryFactoryConfig extends SubagentRegistryFactoryConfig {
  workspaceRoots: WorkspaceRoots;
}

/** 按 profile.tools 构造自定义角色的 registry */
function buildProfileRegistry(
  config: ResolvedSubagentRegistryFactoryConfig,
  request: SubagentRegistryRequest,
  profile: AgentProfile,
): ToolRegistry {
  const registry = new ToolRegistry();
  for (const toolName of profile.tools) {
    const ctor = TOOL_CONSTRUCTORS[toolName];
    if (ctor) registry.register(ctor(config.workDir, config.workspaceRoots, config.yoloSandbox));
  }
  // 自定义角色仍挂安全 Middleware:高危命令拦截不因自定义放开
  // 用 worker 档的 Middleware(允许普通写,拦 rm -rf / git push --force 等)
  registry.use(buildSubagentSafetyMiddleware("worker", config));
  registry.register(new DelegateStatusTool(config.manager));

  // orchestrator 仍可递归委派(若角色允许且未超深度)
  maybeRegisterDelegateTool(config, request, registry);
  return registry;
}

/** 默认的 explore/worker 二档构造(原有逻辑) */
function buildModeRegistry(
  config: ResolvedSubagentRegistryFactoryConfig,
  request: SubagentRegistryRequest,
  registry: ToolRegistry,
): ToolRegistry {
  registry.register(new ReadFileTool(config.workspaceRoots));
  registry.register(new SkillViewTool(new SkillLoader(config.workDir)));

  const bash = new BashTool(config.workDir, undefined, {
    allowBackground: false,
    ...(config.yoloSandbox
      ? {
          sandbox: {
            workspaceRoots: config.workspaceRoots,
            ...(config.yoloSandbox.config ? { config: config.yoloSandbox.config } : {}),
          },
        }
      : {}),
  });
  if (request.mode === "explore") {
    (bash as BashTool & { readOnly?: boolean }).readOnly = true;
  }
  registry.register(bash);

  // 阶段 2 只读工具:explore/worker 都需要搜文件,worker 写代码也要先定位文件
  registry.register(new GlobTool(config.workspaceRoots));
  registry.register(new GrepTool(config.workspaceRoots));

  if (request.mode === "explore") {
    // 探索语义:联网搜索是 explore 的合理扩展(全只读,无副作用)
    registry.register(new FetchURLTool());
    registry.register(new WebSearchTool());
  }

  if (request.mode === "worker") {
    registry.register(new WriteFileTool(config.workspaceRoots));
    registry.register(new EditFileTool(config.workspaceRoots));
  }

  registry.use(buildSubagentSafetyMiddleware(request.mode, config));
  registry.register(new DelegateStatusTool(config.manager));

  maybeRegisterDelegateTool(config, request, registry);
  return registry;
}

/** orchestrator 角色且未超深度时,注册 delegate_task(允许递归委派) */
function maybeRegisterDelegateTool(
  config: ResolvedSubagentRegistryFactoryConfig,
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

function buildSubagentSafetyMiddleware(
  mode: "explore" | "worker",
  config: ResolvedSubagentRegistryFactoryConfig,
): RequestMiddleware {
  return async (call) => {
    if (config.yoloSandbox) {
      const decision = evaluateYoloToolCall(
        call,
        config.workDir,
        config.workspaceRoots,
        config.yoloSandbox.config,
      );
      if (!decision.allowed) {
        return { allowed: false, reason: decision.reason ?? "YOLO 子代理边界拒绝。" };
      }
    }
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
