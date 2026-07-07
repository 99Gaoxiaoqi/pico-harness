import { SkillLoader, SkillViewTool } from "../context/skill.js";
import { PlanStore } from "../context/plan-store.js";
import { TodoStore } from "../context/todo-store.js";
import { GoalManager } from "../engine/goal-manager.js";
import { BackgroundManager } from "./background-manager.js";
import {
  BashTool,
  EditFileTool,
  EchoTool,
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

export interface DefaultToolRegistryOptions extends ToolRegistryOptions {
  backgroundManager?: BackgroundManager;
  /**
   * Goal Manager 单例(ROADMAP 3.5)。三个 Goal 工具共享此实例,
   * host 创建后同时传给 engine(经 AgentEngineOptions.goalManager),
   * 确保工具改的状态与 PromptComposer / Grace Call 看到的一致。
   * 未提供则不注册 Goal 工具(向后兼容:无 Goal Mode 能力)。
   */
  goalManager?: GoalManager;
}

export function buildDefaultToolRegistry(
  workDir: string,
  options: DefaultToolRegistryOptions = {},
): ToolRegistry {
  const { backgroundManager = new BackgroundManager(), goalManager, ...registryOptions } = options;
  const registry = new ToolRegistry(registryOptions);
  registry.register(new EchoTool());
  registry.register(new ReadFileTool(workDir));
  registry.register(new WriteFileTool(workDir));
  registry.register(new EditFileTool(workDir));
  registry.register(new BashTool(workDir, backgroundManager));
  registry.register(new TaskListTool(backgroundManager));
  registry.register(new TaskOutputTool(backgroundManager));
  registry.register(new TaskStopTool(backgroundManager));
  registry.register(new SkillViewTool(new SkillLoader(workDir)));
  registry.register(new GlobTool(workDir));
  registry.register(new GrepTool(workDir));
  registry.register(new TodoTool(new TodoStore(workDir)));
  // ExitPlanModeTool:onExit 回调在 default-registry 构造时无法注入(无 engine 引用)。
  // host(run-agent.ts / main.ts)构造 engine 后需遍历工具调 setExitCallback 注入,
  // 否则审批通过也不会真正切换 planMode。Plan Mode 关闭时该工具不被模型调用。
  registry.register(new ExitPlanModeTool(new PlanStore(workDir)));
  // Goal Mode 工具:三工具共享同一个 goalManager 单例(由 host 注入)。
  // 单例约束:goalManager 必须与传给 AgentEngine 的是同一实例,
  // 否则工具改的状态 PromptComposer/Grace Call 看不到(对标 TodoStore 跨实例 bug 的教训)。
  if (goalManager) {
    registry.register(new CreateGoalTool(goalManager));
    registry.register(new GetGoalTool(goalManager));
    registry.register(new UpdateGoalTool(goalManager));
  }
  registry.register(new FetchURLTool());
  registry.register(new WebSearchTool());
  return registry;
}
