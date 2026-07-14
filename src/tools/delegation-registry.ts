import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  ToolRegistry,
  WriteFileTool,
} from "./registry-impl.js";
import type { BaseTool, RequestMiddleware } from "./registry.js";
import { isDangerousCommand, isHardlineCommand } from "../approval/manager.js";
import { isSensitiveCredentialPath } from "../approval/session-permissions.js";
import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { TodoStore } from "../context/todo-store.js";
import { findAgentProfile } from "../agents/catalog.js";
import type { AgentRunner, SubagentRegistryFactory, SubagentRegistryRequest } from "./subagent.js";
import { DelegateTaskTool } from "./subagent.js";
import { DelegateStatusTool, type DelegationManager } from "./delegation-manager.js";
import type { AgentProfile } from "./agent-profile.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { FetchURLTool, WebSearchTool } from "./web.js";
import { WorkspaceRoots } from "./workspace-roots.js";
import { evaluateYoloToolCall, type YoloSandboxConfig } from "../safety/yolo-sandbox.js";
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";
import { classifyBashCommand } from "../approval/bash-safety.js";
import { bashCommandFromArgs } from "../approval/bash-paths.js";
import { buildMinimalChildProcessEnv } from "../os/child-process-env.js";
import { TodoTool } from "./todo.js";
import type { HookService } from "../hooks/service.js";

export interface SubagentRegistryFactoryConfig {
  workDir: string;
  /** 主 Agent 的共享授权根集合，包含 /add-dir 动态授权的目录。 */
  workspaceRoots?: WorkspaceRoots;
  runner: AgentRunner;
  manager: DelegationManager;
  maxSpawnDepth?: number;
  /** 宿主统一 Agent 目录。显式 agent_name 未命中时 fail closed。 */
  profiles?: AgentProfile[];
  /** 可写 worker/explore 的独立宿主边界；TUI 无论主会话 mode 都应注入。 */
  yoloSandbox?: { config?: Partial<YoloSandboxConfig> };
  worktreeSupervisor?: WorktreeSupervisor;
  ownerSessionId?: string;
  /** 是否由长生命周期宿主持有 optional/detached 委派。 */
  allowAsyncCompletion?: boolean;
  /** 与宿主同源的 Skill Catalog，保留用户、Plugin 与兼容开关语义。 */
  skillLoaderFactory?: (workDir: string) => SkillLoader;
  /** 子代理工具调用与主会话共享同一 HookService 快照。 */
  hookService?: HookService;
  /** 持久 Agent 按每次运行激活内联 Hook 的租约工厂。 */
  activateAgentHooks?: (profile: AgentProfile) => Promise<() => void | Promise<void>>;
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
      env: buildMinimalChildProcessEnv(),
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
  grep: (wd, roots) => new GrepTool(roots ?? wd, { excludeSensitiveFiles: true }),
  fetch_url: () => new FetchURLTool(),
  web_search: () => new WebSearchTool(),
  todo: (wd) => new TodoTool(new TodoStore(wd)),
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
    const activeConfig = request.workDir
      ? {
          ...resolvedConfig,
          workDir: request.workDir,
          workspaceRoots: WorkspaceRoots.createSync(request.workDir),
        }
      : resolvedConfig;

    // 优先分支:自定义角色(agent_name 命中 profile)
    const profile = request.agentName ? findAgentProfile(profiles, request.agentName) : undefined;
    if (profile) {
      return buildProfileRegistry(activeConfig, request, profile);
    }

    if (request.agentName) {
      throw new Error(`未找到 Agent Profile: ${request.agentName}，已拒绝回落到默认工具集。`);
    }

    // 默认分支仅服务未显式指定 agent_name 的临时 Agent。
    return buildModeRegistry(activeConfig, request, registry);
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
    if (request.mode === "explore" && EXPLORE_WRITE_TOOLS.has(toolName)) continue;
    if (toolName === "skill_view" && config.skillLoaderFactory) {
      registry.register(new SkillViewTool(config.skillLoaderFactory(config.workDir)));
      continue;
    }
    const ctor = TOOL_CONSTRUCTORS[toolName];
    if (ctor) registry.register(ctor(config.workDir, config.workspaceRoots, config.yoloSandbox));
  }
  // 自定义角色不得扩大请求 mode：explore 过滤写工具并使用只读 Bash 守卫，
  // worker 才允许在独立 worktree 中普通写入。
  registry.use(buildSubagentSafetyMiddleware(request.mode, config));
  registry.register(new DelegateStatusTool(config.manager));

  // orchestrator 仍可递归委派(若角色允许且未超深度)
  maybeRegisterDelegateTool(config, request, registry);
  return attachHookService(registry, config.hookService);
}

/** 默认的 explore/worker 二档构造(原有逻辑) */
function buildModeRegistry(
  config: ResolvedSubagentRegistryFactoryConfig,
  request: SubagentRegistryRequest,
  registry: ToolRegistry,
): ToolRegistry {
  registry.register(new ReadFileTool(config.workspaceRoots));
  registry.register(
    new SkillViewTool(
      config.skillLoaderFactory?.(config.workDir) ?? new SkillLoader(config.workDir),
    ),
  );

  const bash = new BashTool(config.workDir, undefined, {
    allowBackground: false,
    env: buildMinimalChildProcessEnv(),
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
  registry.register(new GrepTool(config.workspaceRoots, { excludeSensitiveFiles: true }));

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
  return attachHookService(registry, config.hookService);
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
        workDir: config.workDir,
        ...(config.profiles ? { profiles: config.profiles } : {}),
        ...(config.worktreeSupervisor ? { worktreeSupervisor: config.worktreeSupervisor } : {}),
        ...(config.ownerSessionId ? { ownerSessionId: config.ownerSessionId } : {}),
        ...(config.allowAsyncCompletion !== undefined
          ? { allowAsyncCompletion: config.allowAsyncCompletion }
          : {}),
        ...(config.activateAgentHooks ? { activateAgentHooks: config.activateAgentHooks } : {}),
      }),
    );
  }
}

function attachHookService(registry: ToolRegistry, hookService?: HookService): ToolRegistry {
  if (hookService) registry.setHookService(hookService);
  return registry;
}

function buildSubagentSafetyMiddleware(
  mode: "explore" | "worker",
  config: ResolvedSubagentRegistryFactoryConfig,
): RequestMiddleware {
  return async (call) => {
    if (call.name === "read_file" || call.name === "grep") {
      const path = jsonStringField(call.arguments, "path");
      if (
        path !== undefined &&
        isSensitiveCredentialPath(config.workspaceRoots.resolveUnchecked(path))
      ) {
        return { allowed: false, reason: "子代理不允许读取密钥、.env 或凭据路径。" };
      }
    }
    if (config.yoloSandbox) {
      const decision = evaluateYoloToolCall(
        call,
        config.workDir,
        config.workspaceRoots,
        config.yoloSandbox.config,
      );
      if (!decision.allowed) {
        return { allowed: false, reason: decision.reason ?? "子代理沙箱边界拒绝。" };
      }
    }
    if (mode === "explore" && call.name === "bash") {
      const command = bashCommandFromArgs(call.arguments);
      const classification = command ? classifyBashCommand(command) : undefined;
      if (classification?.kind !== "read-only") {
        return {
          allowed: false,
          reason: `子代理只读模式只允许可证明只读的 Bash${classification ? `；${classification.reason}` : ""}。`,
        };
      }
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

const EXPLORE_WRITE_TOOLS = new Set(["write_file", "edit_file"]);

function jsonStringField(args: string, field: string): string | undefined {
  try {
    const value = (JSON.parse(args) as Record<string, unknown>)[field];
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}
