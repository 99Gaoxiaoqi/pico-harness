import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { PlanStore } from "../context/plan-store.js";
import { TodoStore } from "../context/todo-store.js";
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
  type ToolRegistryOptions,
  WriteFileTool,
} from "./registry-impl.js";
import { GlobTool } from "./glob.js";
import { GrepTool } from "./grep.js";
import { ExitPlanModeTool } from "./plan-exit.js";
import { TodoTool } from "./todo.js";
import { CreateGoalTool, GetGoalTool, UpdateGoalTool } from "./goal.js";
import { FetchURLTool, WebSearchTool } from "./web.js";
import { ToolDisclosure } from "./tool-disclosure.js";
import { SearchToolsTool } from "./search-tools.js";
import { registerAskUserTool } from "./ask-user.js";
import type { AskUserHandler } from "./ask-user.js";
import { WorkspaceRoots, buildWorkspaceBoundaryMiddleware } from "./workspace-roots.js";
import type { CodeIntelligenceService } from "../code-intelligence/types.js";
import { createCodeIntelligenceTools } from "./code-intelligence.js";

export interface DefaultToolRegistryOptions extends ToolRegistryOptions {
  /** Read/Write/Edit/Glob/Grep 与请求边界共享的工作区根集合。 */
  workspaceRoots?: WorkspaceRoots;
  /** Host 将工作区 ask/yolo 与审批合并处理时，关闭这里的严格前置拒绝。 */
  deferWorkspaceBoundary?: boolean;
  backgroundManager?: BackgroundManager;
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
   * 注入后:额外注册 search_tools 元工具,模型用它按需激活扩展工具。
   * 必须与 AgentEngine 传入的是同一实例,确保 registry 的 disclose 与 loop 的 pickForLLM 同步。
   * 未提供则不启用渐进披露(全量工具喂给 LLM,行为不变)。
   */
  toolDisclosure?: ToolDisclosure;
  /** 仅在宿主提供结构化交互 UI 时注册 ask_user，避免无 UI 的运行永久等待。 */
  askUserHandler?: AskUserHandler;
  /** 宿主启动后注入的 LSP / Repo Map 统一服务。 */
  codeIntelligence?: CodeIntelligenceService;
}

export function buildDefaultToolRegistry(
  workDir: string,
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const {
    backgroundManager = new BackgroundManager(),
    goalManager,
    todoStore,
    toolDisclosure,
    askUserHandler,
    codeIntelligence,
    workspaceRoots,
    deferWorkspaceBoundary = false,
    ...registryOptions
  } = options;
  const roots = workspaceRoots ?? WorkspaceRoots.createSync(workDir);
  const registry = new ToolRegistry(registryOptions);
  // 必须先于 host 后续挂载的审批中间件,避免一次审批扩大文件系统边界。
  if (!deferWorkspaceBoundary) registry.useRequest(buildWorkspaceBoundaryMiddleware(roots));
  registry.register(new ReadFileTool(roots));
  registry.register(new WriteFileTool(roots));
  registry.register(new EditFileTool(roots));
  registry.register(
    new BashTool(workDir, backgroundManager, {
      sandbox: { workspaceRoots: roots },
    }),
  );
  registry.register(new TaskListTool(backgroundManager));
  registry.register(new TaskOutputTool(backgroundManager));
  registry.register(new TaskStopTool(backgroundManager));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  registry.register(new GlobTool(roots));
  registry.register(new GrepTool(roots));
  // TodoTool 持有 host 注入的 TodoStore 单例,与 PromptComposer 共享同一实例。
  // 未注入时降级为内部 new,保持向后兼容(单实例场景不受跨实例 bug 影响)。
  registry.register(new TodoTool(todoStore ?? new TodoStore(workDir)));
  // ExitPlanModeTool:onExit 回调在 default-registry 构造时无法注入(无 engine 引用)。
  // host(run-agent.ts / main.ts)构造 engine 后需遍历工具调 setExitCallback 注入,
  // 否则审批通过也不会真正切换 planMode。Plan Mode 关闭时该工具不被模型调用。
  registry.register(new ExitPlanModeTool(new PlanStore(workDir)));
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
  registry.register(new WebSearchTool());
  if (codeIntelligence) {
    for (const tool of createCodeIntelligenceTools(workDir, codeIntelligence)) {
      registry.register(tool);
    }
  }
  // 渐进披露(ROADMAP 5.4):注入 disclosure 时注册 search_tools 元工具。
  // search_tools 持有 registry 的实时定义数据源,execute 时才筛选扩展工具。
  // 因此 host 后续注册的委派/MCP 工具也会立即可检索。
  if (toolDisclosure) {
    registry.register(new SearchToolsTool(() => registry.getAvailableTools(), toolDisclosure));
  }
  return registry;
}
