import { SkillLoader, SkillViewTool, type Skill } from "../context/skill.js";
import { TodoStore } from "../context/todo-store.js";
import type { PlanHandoffController } from "../engine/plan-handoff.js";
import { GoalManager } from "../engine/goal-manager.js";
import { BackgroundManager } from "./background-manager.js";
import {
  BashTool,
  EditFileTool,
  ReadFileTool,
  TaskListTool,
  TaskOutputTool,
  TaskStopTool,
  ToolRegistry,
  WriteFileTool,
} from "./registry-impl.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import {
  CancelPlanTool,
  SubmitPlanTool,
  UpdatePlanTool,
  type PlanCoordinatorFactory,
} from "./plan-exit.js";
import { TodoTool } from "./todo.js";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "./goal.js";
import { FetchURLTool, WebSearchTool } from "./web.js";
import { ToolDisclosure } from "./tool-disclosure.js";
import { LoadToolsTool } from "./load-tools.js";
import { SearchToolsTool } from "./search-tools.js";
import { getAvailableDeferredGroups, type ToolHostKind } from "./tool-surface.js";
import { registerAskUserTool } from "./ask-user.js";
import type { AskUserHandler } from "./ask-user.js";
import { WorkspaceRoots, buildWorkspaceBoundaryMiddleware } from "./workspace-roots.js";
import type { CodeIntelligenceService } from "../code-intelligence/types.js";
import { createCodeIntelligenceTools } from "./code-intelligence.js";
import type { YoloSandboxConfig } from "../safety/yolo-sandbox.js";
import { ExploreRepoTool } from "./explore-repo.js";
import { createSessionTaskTools, type BoundSessionTaskAuthority } from "./session-tasks.js";

export interface DefaultToolRegistryOptions {
  /** Read/Write/Edit/Glob/Grep 与请求边界共享的工作区根集合。 */
  workspaceRoots?: WorkspaceRoots;
  /** Host 将工作区 ask/yolo 与审批合并处理时，关闭这里的严格前置拒绝。 */
  deferWorkspaceBoundary?: boolean;
  /** 仅可信宿主在 YOLO 运行态显式注入；未传时保持旧 Bash 行为。 */
  yoloSandbox?: { config?: Partial<YoloSandboxConfig> };
  backgroundManager?: BackgroundManager;
  /** Session-scoped durable task authority shared by model tools and prompt injection. */
  sessionTasks?: BoundSessionTaskAuthority;
  /**
   * Goal Manager 单例(ROADMAP 3.5)。三个 Goal 工具共享此实例,
   * host 创建后同时传给 engine(经 AgentEngineOptions.goalManager),
   * 确保工具改的状态与 PromptComposer / Grace Call 看到的一致。
   * 未提供则不注册 Goal 工具(向后兼容:无 Goal Mode 能力)。
   */
  goalManager?: GoalManager;
  /**
   * TodoStore 单例(ROADMAP 补充任务 2026-07-07)。
   * host 创建后同时传给 registry(TodoTool)与 PromptComposer,
   * 确保工具改的状态与 Composer 注入 prompt 时看到的一致——
   * 对标 GoalManager 注入范式,根治历史上 TodoTool/Composer 各 new 各的跨实例不可见 bug。
   * 未提供则内部 new(向后兼容,单实例场景仍可用)。
   */
  todoStore?: TodoStore;
  /**
   * 工具渐进披露状态机(ROADMAP 5.4)。
   * 注入后:额外注册 load_tools + search_tools 元工具。
   * load_tools 组级激活（枚举选择），search_tools 兜底检索动态工具。
   * 必须与 AgentEngine 传入的是同一实例,确保 registry 的 disclose 与 loop 的 pickForLLM 同步。
   * 未提供则不启用渐进披露(全量工具喂给 LLM,行为不变)。
   */
  toolDisclosure?: ToolDisclosure;
  /**
   * 宿主类型（surface 亲和性过滤用）。默认 "cli"。
   * background/headless 宿主下部分工具不注册；deferred 组列表按宿主过滤。
   */
  hostKind?: ToolHostKind;
  /**
   * load_tools 组级激活成功的 durable 回调（写入 RuntimeEvent ledger，
   * crash/重开后由 seedFromEvents 重播恢复披露状态）。
   */
  onToolGroupLoaded?: (groupId: string, toolNames: readonly string[]) => void;
  /** 仅在宿主提供结构化交互 UI 时注册 ask_user，避免无 UI 的运行永久等待。 */
  askUserHandler?: AskUserHandler;
  /** Plan/只读子代理可动态隐藏凭据文件；YOLO 主会话保持完整读权。 */
  excludeSensitiveGrepFiles?: boolean | ((path: string | undefined) => boolean);
  /** 宿主启动后注入的 LSP / Repo Map 统一服务。 */
  codeIntelligence?: CodeIntelligenceService;
  /** Skill frontmatter hooks 只在当前 Agent run 激活。 */
  activateSkillHooks?: (skill: Skill) => void | Promise<void>;
  /** 宿主冻结的统一 Skill Catalog（含受信 Plugin 来源）。 */
  skillLoader?: SkillLoader;
  /** Plan 模式的 durable coordinator 与 run-scoped handoff latch。 */
  plan?: {
    coordinator: PlanCoordinatorFactory;
    handoff: PlanHandoffController;
    sessionId: string;
    runId: () => string;
    mode: "planning" | "execution";
    planId?: string;
  };
  /** Host-owned process environment for tools that intentionally inherit it. */
  env?: NodeJS.ProcessEnv;
  /** Host-owned foreground Bash deadline; omitted callers retain the 30s default. */
  bashTimeoutMs?: number;
}

export function buildDefaultToolRegistry(
  workDir: string,
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const {
    backgroundManager = new BackgroundManager(),
    sessionTasks,
    goalManager,
    todoStore,
    toolDisclosure,
    askUserHandler,
    excludeSensitiveGrepFiles,
    codeIntelligence,
    activateSkillHooks,
    skillLoader,
    plan,
    env,
    bashTimeoutMs,
    workspaceRoots,
    deferWorkspaceBoundary = false,
    yoloSandbox,
    hostKind = "cli",
    onToolGroupLoaded,
  } = options;
  const roots = workspaceRoots ?? WorkspaceRoots.createSync(workDir);
  const registry = new ToolRegistry();
  // 必须先于 host 后续挂载的审批中间件,避免一次审批扩大文件系统边界。
  if (!deferWorkspaceBoundary) registry.useRequest(buildWorkspaceBoundaryMiddleware(roots));
  registry.register(new ReadFileTool(roots));
  registry.register(new WriteFileTool(roots));
  registry.register(new EditFileTool(roots));
  registry.register(
    new BashTool(workDir, backgroundManager, {
      ...(yoloSandbox
        ? {
            sandbox: {
              workspaceRoots: roots,
              ...(yoloSandbox.config ? { config: yoloSandbox.config } : {}),
            },
          }
        : {}),
      ...(env ? { env } : {}),
      ...(bashTimeoutMs !== undefined ? { timeoutMs: bashTimeoutMs } : {}),
    }),
  );
  registry.register(
    new TaskListTool(
      backgroundManager,
      sessionTasks
        ? {
            list: () =>
              sessionTasks.repository.queryTasks({ sessionId: sessionTasks.sessionId, limit: 200 }),
          }
        : undefined,
    ),
  );
  registry.register(new TaskOutputTool(backgroundManager));
  registry.register(new TaskStopTool(backgroundManager));
  if (sessionTasks) {
    for (const tool of createSessionTaskTools(sessionTasks)) registry.register(tool);
  }
  registry.register(new SkillViewTool(skillLoader ?? new SkillLoader(workDir), activateSkillHooks));
  registry.register(new GlobTool(roots));
  registry.register(
    new GrepTool(roots, {
      ...(excludeSensitiveGrepFiles !== undefined
        ? { excludeSensitiveFiles: excludeSensitiveGrepFiles }
        : {}),
    }),
  );
  // TodoTool 持有 host 注入的 TodoStore 单例,与 PromptComposer 共享同一实例。
  // 未注入时降级为内部 new,保持向后兼容(单实例场景不受跨实例 bug 影响)。
  registry.register(new TodoTool(todoStore ?? new TodoStore(workDir)));
  if (plan) {
    if (plan.mode === "planning") {
      registry.register(
        new SubmitPlanTool(plan.coordinator, plan.handoff, plan.sessionId, plan.runId),
      );
    } else {
      if (!plan.planId) throw new Error("Execution plan registry requires planId");
      registry.register(new UpdatePlanTool(plan.coordinator, plan.planId));
      registry.register(new CancelPlanTool(plan.coordinator, plan.planId));
    }
  }
  // Goal Mode 工具:三工具共享同一个 goalManager 单例(由 host 注入)。
  // 单例约束:goalManager 必须与传给 AgentEngine 的是同一实例,
  // 否则工具改的状态 PromptComposer/Grace Call 看不到。
  // 注:TodoStore 自 2026-07-07 起也走 host 注入单例,同一问题已根治。
  if (goalManager) {
    registry.register(new CreateGoalTool(goalManager));
    registry.register(new GetGoalTool(goalManager));
    registry.register(new UpdateGoalTool(goalManager));
  }
  if (askUserHandler) registerAskUserTool(registry, askUserHandler);
  registry.register(new FetchURLTool());
  registry.register(new WebSearchTool(env));
  if (codeIntelligence) {
    for (const tool of createCodeIntelligenceTools(workDir, codeIntelligence)) {
      registry.register(tool);
    }
    registry.register(new ExploreRepoTool(workDir, codeIntelligence));
  }
  // 渐进披露(ROADMAP 5.4):注入 disclosure 时注册 load_tools + search_tools。
  // load_tools 组级激活（枚举选择当前宿主可用的 deferred 组，零歧义）；
  // search_tools 兜底检索动态工具（MCP/Plugin，实时数据源保证后续注册可检索）。
  if (toolDisclosure) {
    const deferredGroups = getAvailableDeferredGroups(hostKind);
    if (deferredGroups.length > 0) {
      registry.register(
        new LoadToolsTool(
          deferredGroups,
          toolDisclosure,
          () => registry.getAvailableTools().map((tool) => tool.name),
          {
            ...(onToolGroupLoaded ? { onGroupLoaded: onToolGroupLoaded } : {}),
          },
        ),
      );
    }
    registry.register(new SearchToolsTool(() => registry.getAvailableTools(), toolDisclosure));
  }
  return registry;
}
