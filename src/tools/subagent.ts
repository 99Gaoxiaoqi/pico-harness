// Subagent 子智能体:任务委派与上下文物理隔离 (第 17 讲)。
//
// 突破单体大模型能力天花板:主 Agent 遇到需读几百个文件的脏活时,不自己读,
// 派出"探索子智能体"。子 Agent 拥有全新纯净的 contextHistory,疯狂试错
// 绝不污染主 Agent 大脑。探索完毕把几万字浓缩成几百字总结回传主 Agent。
//
// 极简哲学:子智能体不是玄学新概念,就是 Tool Registry 里注册的一个普通工具。
// spawn_subagent 执行逻辑:新建一个受限循环,阻塞等待跑完,输出作为 ToolResult 返回。
//
// 防污染机制(爆炸半径限制):子智能体仅挂载只读工具(read_file/bash),
// 绝对不给 edit_file/write_file,防止底层"莽夫"瞎改代码导致物理不可逆破坏。

import { randomUUID } from "node:crypto";
import type { BaseTool, ToolExecutionContext } from "./registry.js";
import { NO_FILE_SIDE_EFFECTS } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { Registry } from "./registry.js";
import type { Reporter, SubagentActivityEvent } from "../engine/reporter.js";
import { logger } from "../observability/logger.js";
import type {
  DelegationBatchResult,
  DelegationCompletionPolicy,
  DelegationResult,
} from "./delegation-manager.js";
import { aggregateDelegationStatus, DelegationManager } from "./delegation-manager.js";
import type { AgentProfile } from "./agent-profile.js";
import { findAgentProfile } from "../agents/catalog.js";
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";
import {
  compactActivityText,
  ScopedSubagentActivityReporter,
  type SubagentActivityScope,
} from "./subagent-activity-reporter.js";
import { SUBAGENT_OUTPUT_BUDGET } from "./subagent-budget.js";
import { parseEphemeralAgentSpec, type EphemeralAgentSpec } from "./subagent-spec.js";
import type { HookService } from "../hooks/service.js";
import type { SubagentModelCatalog } from "../runtime/subagent-model-catalog.js";

/**
 * AgentRunner:打破循环依赖的抽象接口。
 * SubagentTool 在 tools 包,完整 AgentEngine 在 engine 包。
 * 为让 Tool 能拉起 Engine,定义接口供外部注入。
 */
/**
 * 子智能体执行结果。
 * - summary: 最终纯文本总结汇报(主 Agent 直接可见)
 * - artifacts: 探索期间被外部化的大型工具输出磁盘路径(相对 workDir)。
 *   这些文件落在当前 workspace artifacts 内，主 Agent 可用 read_artifact 分页回查，
 *   避免子代理读过大文件后,主 Agent 既看不到原文也无法定位。
 */
export interface SubagentResult {
  /** 未设置时按 completed 兼容旧 runner；partial 表示保留了轮次耗尽前的有效证据。 */
  status?: "completed" | "partial";
  summary: string;
  artifacts: string[];
}

export interface SubagentReportArtifactInput {
  taskPrompt: string;
  report: string;
  status: "completed" | "partial";
  workDir: string;
}

/** 宿主注入的完整子代理报告写入器；返回可供主 Agent 回查的路径。 */
export type SubagentReportArtifactWriter = (
  input: SubagentReportArtifactInput,
) => Promise<string | undefined>;

export interface AgentRunner {
  /**
   * RunSub:启动一个匿名的、一次性子智能体任务,返回其最终梳理的总结及外部化产物引用。
   * @param taskPrompt 主 Agent 下达的明确指令
   * @param readOnlyRegistry 子智能体专属受限只读注册表(爆炸半径限制)
   * @param reporter 可选 Reporter,透传子智能体工作轨迹(打 [Subagent] 前缀)
   */
  runSub(
    taskPrompt: string,
    readOnlyRegistry: Registry,
    reporter?: Reporter,
    opts?: SubagentRunOptions,
  ): Promise<SubagentResult>;
}

export type SubagentRole = "leaf" | "orchestrator";
export type SubagentMode = "explore" | "worker";

export interface SubagentRunOptions {
  depth?: number;
  maxSpawnDepth?: number;
  role?: SubagentRole;
  /**
   * 覆盖默认的子代理最大轮次(默认 10)。
   * 子代理跑满此轮次仍没给出总结会被强制召回。
   */
  maxTurns?: number;
  /**
   * 自定义 system prompt 片段。
   * - systemPromptOverride 未设或 false(默认):此内容**追加拼接**到默认探路者
   *   prompt 之后(对标 kimi-code 的 ROLE_ADDITIONAL 模式),保留基本纪律 +
   *   你的自定义要求。
   * - systemPromptOverride = true:此内容**完全覆盖**默认骨架(对标 hermes 的
   *   ephemeral_system_prompt 替换语义)。用于需要完全定制子代理身份的场景。
   */
  systemPrompt?: string;
  /** true 时 systemPrompt 完全覆盖默认 prompt,而非追加。默认 false(追加)。 */
  systemPromptOverride?: boolean;
  /** 宿主热切换或关闭时取消子代理的统一信号。 */
  signal?: AbortSignal;
  /** 可信宿主注入的实际运行根目录；不得从模型 task context 推导。 */
  workDir?: string;
  /**
   * 可选的持久任务归属。只有掌握 RuntimeStore 真值的宿主才能传入；
   * runSub 不会从 workDir、prompt 或展示层 task id 推导。
   */
  usageAttribution?: {
    jobId?: string;
    attemptId?: string;
  };
  /** 仅携带模型选择意图；Provider、凭证和 endpoint 只能由可信宿主解析。 */
  modelSelection?: SubagentModelSelectionRequest;
  /** 短生命周宿主无法在主轮结束后持有委派运行时，必须拒绝异步交付。 */
  allowAsyncCompletion?: boolean;
}

export interface SubagentModelSelectionRequest {
  ephemeralRouteId?: string | "inherit";
  profileRouteId?: string | "inherit";
  ephemeralThinkingEffort?: string;
  profileThinkingEffort?: string;
}

export interface SubagentRegistryRequest {
  mode: SubagentMode;
  role: SubagentRole;
  depth: number;
  maxSpawnDepth: number;
  /** 持久 Agent Profile 名（来自宿主统一 Agent 目录）。 */
  agentName?: string;
  /** worker 模式下覆盖工具实际操作目录。 */
  workDir?: string;
}

export type SubagentRegistryFactory = (request: SubagentRegistryRequest) => Registry;

/** spawn_subagent 工具的参数 */
interface SubagentArgs {
  task_prompt: string;
}

interface DelegateTaskInput {
  goal?: string;
  context?: string;
  mode?: SubagentMode;
  role?: SubagentRole;
  /** 指定宿主统一 Agent 目录中的持久子代理角色。 */
  agent_name?: string;
  /** 主 Agent 可根据用户自然语言生成的一次性角色；不含工具、endpoint 或凭证。 */
  agent?: unknown;
  /** 子代理允许聚焦的相对根目录；默认 ["."]。 */
  roots?: string[];
  /** 最多检查文件数，硬上限 100；默认 30。 */
  max_files?: number;
  stopping_condition?: string;
  expected_output?: string;
}

interface DelegateTaskArgs extends DelegateTaskInput {
  tasks?: DelegateTaskInput[];
  completion_policy?: DelegationCompletionPolicy;
  /** @deprecated 兼容旧模型调用；true 等价于 completion_policy=optional。 */
  background?: boolean;
}

interface NormalizedDelegateTask {
  goal: string;
  context?: string;
  mode: SubagentMode;
  role: SubagentRole;
  agentName?: string;
  ephemeralAgent?: EphemeralAgentSpec;
  roots: string[];
  maxFiles: number;
  stoppingCondition: string;
  expectedOutput: string;
  contractExplicit: boolean;
}

const DEFAULT_DELEGATION_ROOTS = ["."];
const DEFAULT_DELEGATION_MAX_FILES = 30;
const MAX_DELEGATION_FILES = 100;
const MAX_DISCLOSED_MODEL_ALIASES = 8;
const MAX_DISCLOSED_MODEL_ALIAS_LENGTH = 80;
const MAX_MODEL_ROUTE_CATALOG_DESCRIPTION = 7_000;
const DEFAULT_STOPPING_CONDITION = "找到足以回答目标的证据，或达到文件上限时立即停止。";
const DEFAULT_EXPECTED_OUTPUT = "给出结论、关键证据路径和仍待确认的风险。";

/**
 * SubagentTool:拉起子智能体的特殊"套娃"工具。
 *
 * 主 Agent 调用 spawn_subagent 时,阻塞主线程,利用 runner 接口
 * 在后台跑完一个完整受限 ReAct 子循环。子循环用全新纯净上下文,
 * 几万字的探索化作轻量 Summary,像普通 API 调用返回给主 Agent。
 */
export class SpawnSubagentTool implements BaseTool {
  readonly fileSideEffects = NO_FILE_SIDE_EFFECTS;
  readonly handlesAbortSignal = true;

  constructor(
    private readonly runner: AgentRunner,
    private readonly readOnlyRegistry: Registry,
    private readonly options: SubagentRunOptions = {},
  ) {}

  name(): string {
    return "spawn_subagent";
  }

  /** 向主 Agent 暴露这个工具的强大能力 */
  definition(): ToolDefinition {
    return {
      name: "spawn_subagent",
      description:
        "派出一个专门用于深度探索(Exploration)的子智能体。当你需要阅读大量代码文件、" +
        "搜索关键词、排查报错等可能污染主上下文的探索任务时使用。子智能体拥有独立纯净的上下文," +
        "探索完毕会返回精炼总结,绝不污染你的主上下文。参数 task_prompt 是给子智能体的明确指令。",
      inputSchema: {
        type: "object",
        properties: {
          task_prompt: {
            type: "string",
            description: "给子智能体下达的明确指令,描述需要探索/查找/分析的具体任务。",
          },
        },
        required: ["task_prompt"],
      },
    };
  }

  /** 拉起完全物理隔离的子循环,仅提供 readOnlyRegistry */
  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    let input: SubagentArgs;
    try {
      input = JSON.parse(args) as SubagentArgs;
    } catch {
      throw new Error("解析 spawn_subagent 参数失败:需 JSON 格式 {task_prompt: string}");
    }
    if (!input.task_prompt) {
      throw new Error("spawn_subagent 缺少 task_prompt 参数");
    }

    logger.info(
      `[Subagent] 🚀 主 Agent 发起委派!正在拉起探路者: [${input.task_prompt.slice(0, 80)}...]`,
    );

    const depth = this.options.depth ?? 0;
    const maxSpawnDepth = this.options.maxSpawnDepth ?? 2;
    if (depth >= maxSpawnDepth) {
      return `子智能体执行失败: 超过最大委派深度 ${maxSpawnDepth},拒绝继续 spawn_subagent。`;
    }

    let result: SubagentResult;
    try {
      result = await this.runner.runSub(input.task_prompt, this.readOnlyRegistry, undefined, {
        depth: depth + 1,
        maxSpawnDepth,
        role: "leaf",
        ...(context?.signal ? { signal: context.signal } : {}),
        // 透传调用方注入的自定义参数(程序化扩展点,非 LLM 可控)
        ...pickDefined({
          maxTurns: this.options.maxTurns,
          systemPrompt: this.options.systemPrompt,
          systemPromptOverride: this.options.systemPromptOverride,
          workDir: this.options.workDir,
        }),
      });
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `子智能体执行失败: ${errMsg}`;
    }

    logger.info(`[Subagent] ✅ 子智能体任务结束。报告返回给主干...`);
    // 几万字的代码探索,化作轻量级 Summary,像普通 API 调用返回给主 Agent。
    // 附带被外部化的大型工具输出磁盘路径:主 Agent 可用 read_file 回查原文,
    // 避免子代理读过大文件后,主 Agent 既看不到原文也无法定位。
    return formatSubagentReport("【子智能体探索报告】", capSubagentResult(result));
  }
}

/**
 * DelegateTaskTool:Hermes 风格的任务委派入口。
 *
 * 相比旧的 spawn_subagent,它支持:
 * - explore/worker 两种工具集,worker 可以在受控边界内写文件
 * - tasks 批量并行委派,适合拆分互不依赖的开发任务
 * - completion_policy 控制最终答案是否必须等待结果
 * - role + depth 约束,防止无限递归委派
 */
export class DelegateTaskTool implements BaseTool {
  /** 宿主统一 Agent 目录，按 agent_name 查询。 */
  private readonly profiles: AgentProfile[];
  readonly handlesAbortSignal = true;

  constructor(
    private readonly runner: AgentRunner,
    private readonly registryFactory: SubagentRegistryFactory,
    private readonly manager: DelegationManager = new DelegationManager(),
    private readonly options: SubagentRunOptions & {
      profiles?: AgentProfile[];
      worktreeSupervisor?: WorktreeSupervisor;
      reporter?: Reporter;
      ownerSessionId?: string;
      activateAgentHooks?: (profile: AgentProfile) => Promise<() => void | Promise<void>>;
      hookService?: HookService;
      modelCatalog?: SubagentModelCatalog;
    } = {},
  ) {
    this.profiles = options.profiles ?? [];
  }

  name(): string {
    return "delegate_task";
  }

  definition(): ToolDefinition {
    const agentNameSchema = persistentAgentNameSchema(this.profiles);
    const agentSchema = ephemeralAgentSchema(this.options.modelCatalog);
    return {
      name: "delegate_task",
      description:
        "把一个或多个互不依赖的任务委派给隔离子智能体执行。默认 explore 模式只读分析;" +
        "mode=worker 时子智能体可使用受控 write_file/edit_file/bash 完成局部开发;" +
        "tasks 可批量并行执行。默认 completion_policy=required:以前台方式等待全部结果后再交还主 Agent;" +
        "required 委派必须是该响应的唯一工具调用,不要同时输出解释正文或调用其他工具;" +
        "optional 允许本轮先结束,完成结果会在下一个模型边界自动进入主上下文;" +
        "detached 成功仅更新活动面板，失败会自动唤醒主 Agent。不要主动轮询内部任务 ID;" +
        "禁止下达‘阅读整个项目/所有文件’之类无边界任务，必须用 roots/max_files/停止条件拆小。",
      inputSchema: {
        type: "object",
        properties: {
          goal: {
            type: "string",
            description: "单个子任务目标。使用 tasks 批量委派时可省略。",
          },
          context: {
            type: "string",
            description: "补充上下文,会随任务目标一起交给子智能体。",
          },
          tasks: {
            type: "array",
            description: "多个互不依赖的子任务。每项可单独指定 goal/context/mode/role/agent。",
            items: {
              type: "object",
              properties: {
                goal: { type: "string" },
                context: { type: "string" },
                mode: { type: "string", enum: ["explore", "worker"] },
                role: { type: "string", enum: ["leaf", "orchestrator"] },
                agent_name: agentNameSchema,
                agent: agentSchema,
                roots: { type: "array", items: { type: "string" } },
                max_files: { type: "number", minimum: 1, maximum: MAX_DELEGATION_FILES },
                stopping_condition: { type: "string" },
                expected_output: { type: "string" },
              },
              required: ["goal"],
            },
          },
          mode: {
            type: "string",
            enum: ["explore", "worker"],
            description: "子智能体工具集。explore=只读探索,worker=受控读写开发。",
          },
          agent_name: agentNameSchema,
          agent: agentSchema,
          role: {
            type: "string",
            enum: ["leaf", "orchestrator"],
            description: "leaf 不再继续委派;orchestrator 在深度允许时可继续拆分任务。",
          },
          roots: {
            type: "array",
            items: { type: "string" },
            description: '允许聚焦的目录或文件根，默认 ["."]；批量任务可逐项覆盖。',
          },
          max_files: {
            type: "number",
            minimum: 1,
            maximum: MAX_DELEGATION_FILES,
            description: `最多检查文件数，默认 ${DEFAULT_DELEGATION_MAX_FILES}，上限 ${MAX_DELEGATION_FILES}。`,
          },
          stopping_condition: {
            type: "string",
            description: "何时停止继续搜索，避免无界探索。",
          },
          expected_output: {
            type: "string",
            description: "子代理最终应返回的结构和验收内容。",
          },
          completion_policy: {
            type: "string",
            enum:
              this.options.allowAsyncCompletion === false
                ? ["required"]
                : ["required", "optional", "detached"],
            description:
              this.options.allowAsyncCompletion === false
                ? "当前宿主仅支持 required：前台等待子代理收口。"
                : "结果交付策略。required=前台等待(默认);optional=可先结束并在下一个模型边界自动注入结果;detached=独立运行且不进入主上下文。",
          },
        },
      },
    };
  }

  async execute(args: string, context?: ToolExecutionContext): Promise<string> {
    const input = parseDelegateArgs(args);
    const depth = this.options.depth ?? 0;
    const maxSpawnDepth = this.options.maxSpawnDepth ?? 2;
    if (depth >= maxSpawnDepth) {
      return JSON.stringify({
        status: "error",
        error: `达到最大委派深度 ${maxSpawnDepth},拒绝继续 delegate_task。`,
      });
    }

    const tasks = normalizeDelegateTasks(input);
    if (tasks.length === 0) {
      return JSON.stringify({
        status: "error",
        error: "delegate_task 需要 goal 或 tasks[].goal。",
      });
    }

    const unknownAgent = tasks.find(
      (task) => task.agentName && !findAgentProfile(this.profiles, task.agentName),
    )?.agentName;
    if (unknownAgent) {
      return JSON.stringify({
        status: "error",
        error: `未找到 Agent Profile: ${unknownAgent}，已拒绝回落到默认工具集。`,
      });
    }

    const completionPolicy = normalizeCompletionPolicy(input);
    if (this.options.allowAsyncCompletion === false && completionPolicy !== "required") {
      return JSON.stringify({
        status: "rejected",
        completionPolicy,
        error: `当前宿主不持有跨轮子代理运行时，已拒绝 ${completionPolicy}；请使用 required。`,
      });
    }
    const activities = tasks.map((task) => this.createActivity(task, completionPolicy));
    for (const activity of activities) {
      this.emitActivity(activity, "queued", {
        currentAction: `等待执行：${compactActivityText(activity.task, 48)}`,
      });
    }

    // required 是前台委派：工具结果本身就是硬屏障，主 Agent 在拿到汇总前
    // 不会进入下一次推理，也就不可能提前结束整轮。
    if (completionPolicy === "required") {
      return JSON.stringify(
        await this.runBudgetedBatch(tasks, activities, depth, maxSpawnDepth, context?.signal),
      );
    }

    let dispatch: ReturnType<DelegationManager["dispatch"]>;
    try {
      dispatch = this.manager.dispatch(
        (signal) => this.runBudgetedBatch(tasks, activities, depth, maxSpawnDepth, signal),
        {
          completionPolicy,
          description: summarizeDelegation(tasks),
          activityIds: activities.map((activity) => activity.activityId),
          ...(this.options.ownerSessionId ? { ownerSessionId: this.options.ownerSessionId } : {}),
        },
      );
    } catch (error) {
      const message = errorMessage(error);
      this.finishQueuedActivities(activities, "failed", message);
      this.claimActivities(activities);
      return JSON.stringify({
        status: "rejected",
        completionPolicy,
        count: tasks.length,
        error: message,
      });
    }
    if (dispatch.status === "rejected") {
      this.finishQueuedActivities(activities, "cancelled", dispatch.error ?? "委派未派发");
      this.claimActivities(activities);
    }
    return JSON.stringify({
      status: dispatch.status,
      completionPolicy,
      count: tasks.length,
      ...(dispatch.error !== undefined ? { error: dispatch.error } : {}),
    });
  }

  private async runBudgetedBatch(
    tasks: NormalizedDelegateTask[],
    activities: SubagentActivityScope[],
    depth: number,
    maxSpawnDepth: number,
    signal?: AbortSignal,
  ): Promise<DelegationBatchResult> {
    return capDelegationBatchText(
      await this.runBatch(tasks, activities, depth, maxSpawnDepth, signal),
    );
  }

  private async runBatch(
    tasks: NormalizedDelegateTask[],
    activities: SubagentActivityScope[],
    depth: number,
    maxSpawnDepth: number,
    signal?: AbortSignal,
  ): Promise<DelegationBatchResult> {
    const startedAt = Date.now();
    const results = await mapLimit(
      tasks,
      this.manager.maxConcurrentChildren,
      (task, index) => this.runOne(task, activities[index]!, index, depth, maxSpawnDepth, signal),
      (error, index) => {
        const result = delegationResultFromError(index, error, 0, signal);
        this.emitResultActivity(activities[index]!, result);
        return result;
      },
    );
    return {
      status: aggregateDelegationStatus(results),
      results,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  private async runOne(
    task: NormalizedDelegateTask,
    activity: SubagentActivityScope,
    taskIndex: number,
    depth: number,
    maxSpawnDepth: number,
    signal?: AbortSignal,
  ): Promise<DelegationBatchResult["results"][number]> {
    const startedAt = Date.now();
    if (signal?.aborted) {
      const cancelled = delegationResultFromError(taskIndex, signal.reason, 0, signal);
      this.emitResultActivity(activity, cancelled);
      return cancelled;
    }
    this.emitActivity(activity, "running", {
      currentAction: `开始执行：${compactActivityText(task.goal, 48)}`,
    });
    let result: DelegationBatchResult["results"][number];
    try {
      if (task.mode === "worker") {
        if (this.options.worktreeSupervisor) {
          result = await this.runOneInWorktree(
            task,
            activity,
            taskIndex,
            depth,
            maxSpawnDepth,
            signal,
          );
        } else {
          result = {
            taskIndex,
            status: "error",
            error:
              "worker 需要 Git worktree 隔离，当前仓库监督器不可用。请先初始化 Git 并建立基线提交，然后重启 Pico；已拒绝降级为直接写主工作区。",
            durationMs: 0,
          };
        }
      } else {
        result = await this.runOneDirect(
          task,
          activity,
          taskIndex,
          depth,
          maxSpawnDepth,
          undefined,
          signal,
        );
      }
    } catch (error) {
      result = delegationResultFromError(taskIndex, error, Date.now() - startedAt, signal);
    }
    if (result.status === "completed") {
      result = {
        ...result,
        summary: truncateWithMarker(result.summary ?? "", SUBAGENT_OUTPUT_BUDGET.summary.hardMax),
      };
    } else if (result.status === "partial" && result.summary !== undefined) {
      result = {
        ...result,
        summary: truncateWithMarker(result.summary, SUBAGENT_OUTPUT_BUDGET.summary.hardMax),
      };
    }
    this.emitResultActivity(activity, result);
    return result;
  }

  private async runOneInWorktree(
    task: NormalizedDelegateTask,
    activity: SubagentActivityScope,
    taskIndex: number,
    depth: number,
    maxSpawnDepth: number,
    signal?: AbortSignal,
  ): Promise<DelegationBatchResult["results"][number]> {
    const supervisor = this.options.worktreeSupervisor!;
    const worktreeTask: NormalizedDelegateTask = {
      ...task,
      context: [
        task.context,
        "你正在独立 Git worktree 中开发。完成后运行最小相关验证；不要 git commit、push 或合并，宿主会在你退出后原子打包当前 worktree 变更。",
      ]
        .filter(Boolean)
        .join("\n\n"),
    };
    let delegatedResult: DelegationBatchResult["results"][number] | undefined;
    const supervised = supervisor.start(
      {
        description: task.goal,
        branchSlug: task.agentName ?? "worker",
        completionMode: "merge_to_host",
        data: {
          completionPolicy: "detached",
          internalCompletion: true,
          ...(this.options.ownerSessionId ? { ownerSessionId: this.options.ownerSessionId } : {}),
        },
      },
      async (context) => {
        const combinedSignal = signal ? AbortSignal.any([signal, context.signal]) : context.signal;
        delegatedResult = await this.runOneDirect(
          worktreeTask,
          activity,
          taskIndex,
          depth,
          maxSpawnDepth,
          context.worktreePath,
          combinedSignal,
          { jobId: context.taskId },
        );
        if (delegatedResult.status !== "completed" && delegatedResult.status !== "partial") {
          throw new Error(
            delegatedResult.error ?? `worker 子代理以 ${delegatedResult.status} 收口`,
          );
        }
        context.appendOutput(`${delegatedResult.summary ?? "worker completed"}\n`);

        const messages = context.drainMessages();
        if (messages.length > 0) {
          delegatedResult = await this.runOneDirect(
            {
              ...worktreeTask,
              context: [worktreeTask.context, `主代理追加指令:\n${messages.join("\n")}`]
                .filter(Boolean)
                .join("\n\n"),
            },
            activity,
            taskIndex,
            depth,
            maxSpawnDepth,
            context.worktreePath,
            combinedSignal,
            { jobId: context.taskId },
          );
          if (delegatedResult.status !== "completed" && delegatedResult.status !== "partial") {
            throw new Error(
              delegatedResult.error ?? `worker 子代理追加指令以 ${delegatedResult.status} 收口`,
            );
          }
          context.appendOutput(`${delegatedResult.summary ?? "follow-up completed"}\n`);
        }
        return {
          summary: delegatedResult.summary,
          data: { delegatedStatus: delegatedResult.status },
        };
      },
    );
    const stopOnAbort = (): void => {
      void supervisor
        .stop(supervised.taskId, errorMessage(signal?.reason ?? "delegation cancelled"))
        .catch(() => undefined);
    };
    if (signal?.aborted) stopOnAbort();
    else signal?.addEventListener("abort", stopOnAbort, { once: true });
    const snapshot = await supervisor.wait(supervised.taskId).finally(() => {
      signal?.removeEventListener("abort", stopOnAbort);
    });
    if (snapshot.status !== "completed") {
      if (
        snapshot.finalization?.status === "blocked" &&
        delegatedResult &&
        (delegatedResult.status === "completed" || delegatedResult.status === "partial")
      ) {
        return {
          ...delegatedResult,
          status: "partial",
          error: snapshot.error ?? "worker 变更已保留，但宿主合并被阻塞",
          durationMs: snapshot.updatedAt - snapshot.startedAt,
        };
      }
      if (
        delegatedResult &&
        delegatedResult.status !== "completed" &&
        delegatedResult.status !== "partial"
      ) {
        return {
          ...delegatedResult,
          durationMs: snapshot.updatedAt - snapshot.startedAt,
        };
      }
      return delegationResultFromError(
        taskIndex,
        snapshot.error ?? `worktree worker ended as ${snapshot.status}`,
        snapshot.updatedAt - snapshot.startedAt,
        signal?.aborted
          ? signal
          : snapshot.status === "stopped"
            ? abortedSignal(snapshot.error)
            : undefined,
      );
    }
    if (!delegatedResult) {
      return {
        taskIndex,
        status: "error",
        error: snapshot.error ?? `worktree worker ended as ${snapshot.status}`,
        durationMs: snapshot.updatedAt - snapshot.startedAt,
      };
    }
    return {
      ...delegatedResult,
      summary: `${delegatedResult.summary ?? ""}\n\n[worktree task: ${snapshot.taskId}; branch: ${snapshot.branch}]`,
    };
  }

  private async runOneDirect(
    task: NormalizedDelegateTask,
    activity: SubagentActivityScope,
    taskIndex: number,
    depth: number,
    maxSpawnDepth: number,
    workDir?: string,
    signal?: AbortSignal,
    usageAttribution?: SubagentRunOptions["usageAttribution"],
  ): Promise<DelegationBatchResult["results"][number]> {
    signal?.throwIfAborted();
    const startedAt = Date.now();
    const childDepth = depth + 1;
    const effectiveWorkDir = workDir ?? this.options.workDir;
    const prompt =
      task.contractExplicit || effectiveWorkDir
        ? renderBoundedTaskPrompt(task)
        : task.context
          ? `${task.context}\n\n任务: ${task.goal}`
          : task.goal;

    // 自定义角色查询:agent_name 命中 profile 时,用其 prompt/maxTurns 覆盖 Tool 级默认
    const profile = task.agentName ? findAgentProfile(this.profiles, task.agentName) : undefined;

    let releaseAgentHooks: (() => void | Promise<void>) | undefined;
    try {
      if (profile?.hooks !== undefined && profile.sourcePath && this.options.activateAgentHooks) {
        releaseAgentHooks = await this.options.activateAgentHooks(profile);
      }
      const registry = this.registryFactory({
        mode: task.mode,
        role: task.role,
        depth: childDepth,
        maxSpawnDepth,
        ...(task.agentName ? { agentName: task.agentName } : {}),
        ...(effectiveWorkDir ? { workDir: effectiveWorkDir } : {}),
      });

      // 自定义角色命中时,用 profile 的 prompt/maxTurns;否则用 Tool 级 options
      const customization = profile
        ? pickDefined({
            systemPrompt: appendEphemeralInstructions(
              profile.systemPrompt,
              task.ephemeralAgent?.instructions,
            ),
            systemPromptOverride: profile.systemPromptOverride,
            maxTurns: task.ephemeralAgent?.maxTurns ?? profile.maxTurns,
          })
        : pickDefined({
            maxTurns: task.ephemeralAgent?.maxTurns ?? this.options.maxTurns,
            systemPrompt: appendEphemeralInstructions(
              this.options.systemPrompt,
              task.ephemeralAgent?.instructions,
            ),
            systemPromptOverride: this.options.systemPromptOverride,
          });

      const childReporter = this.options.reporter
        ? new ScopedSubagentActivityReporter(this.options.reporter, activity)
        : undefined;
      const runSub = async (): Promise<SubagentResult> =>
        await this.runner.runSub(prompt, registry, childReporter, {
          depth: childDepth,
          maxSpawnDepth,
          role: task.role,
          ...(signal ? { signal } : {}),
          ...(effectiveWorkDir ? { workDir: effectiveWorkDir } : {}),
          ...(usageAttribution ? { usageAttribution } : {}),
          ...modelSelectionOptions(task.ephemeralAgent, profile),
          ...customization,
        });
      const subResult =
        profile?.sourcePath && this.options.hookService
          ? await this.options.hookService.runInAgentComponentScope(
              {
                kind: "agent",
                componentId: profile.name,
                path: profile.sourcePath,
              },
              runSub,
            )
          : await runSub();
      signal?.throwIfAborted();
      return {
        taskIndex,
        status: subResult.status ?? "completed",
        summary: subResult.summary,
        ...(subResult.artifacts.length > 0 ? { artifacts: subResult.artifacts } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      return delegationResultFromError(taskIndex, err, Date.now() - startedAt, signal);
    } finally {
      if (releaseAgentHooks) {
        try {
          await releaseAgentHooks();
        } catch (error) {
          logger.warn({ error: String(error) }, "[Subagent] Agent Hook 租约释放失败");
        }
      }
    }
  }

  private createActivity(
    task: NormalizedDelegateTask,
    completionPolicy: DelegationCompletionPolicy,
  ): SubagentActivityScope {
    return {
      activityId: randomUUID(),
      task: compactActivityText(task.goal, 120),
      mode: task.mode,
      completionPolicy,
      ...(task.ephemeralAgent?.name || task.agentName
        ? { agentName: task.ephemeralAgent?.name ?? task.agentName }
        : {}),
      ...(task.ephemeralAgent?.modelRouteId || profileRouteForTask(task, this.profiles)
        ? {
            requestedModelRoute:
              task.ephemeralAgent?.modelRouteId ?? profileRouteForTask(task, this.profiles),
          }
        : {}),
    };
  }

  private emitActivity(
    activity: SubagentActivityScope,
    status: SubagentActivityEvent["status"],
    update: { currentAction?: string; summary?: string } = {},
  ): void {
    try {
      this.options.reporter?.onSubagentActivity?.({ ...activity, status, ...update });
    } catch (error) {
      // 展示层是 best-effort，不能让 activity reporter 异常丢失 batch 已完成结果。
      void error;
    }
  }

  private emitResultActivity(activity: SubagentActivityScope, result: DelegationResult): void {
    const summary =
      result.summary ??
      result.error ??
      (result.status === "completed" ? "子代理已完成" : "子代理未完成");
    this.emitActivity(activity, activityStatusForResult(result.status), {
      summary: compactActivityText(summary, 160),
    });
  }

  private finishQueuedActivities(
    activities: readonly SubagentActivityScope[],
    status: Extract<SubagentActivityEvent["status"], "failed" | "cancelled">,
    summary: string,
  ): void {
    for (const activity of activities) {
      this.emitActivity(activity, status, { summary: compactActivityText(summary, 160) });
    }
  }

  private claimActivities(activities: readonly SubagentActivityScope[]): void {
    try {
      this.options.reporter?.onSubagentActivitiesClaimed?.(
        activities.map((activity) => activity.activityId),
      );
    } catch (error) {
      // 展示层 claim 是 best-effort，不能改变同步 rejection 的工具结果。
      void error;
    }
  }
}

export { SpawnSubagentTool as SubagentTool };

/**
 * 把子智能体执行结果格式化为回传给主 Agent 的文本。
 * summary 是轻量总结;若有被外部化的大型工具输出,附上其磁盘路径,
 * 提示主 Agent 可用 read_file 回查原文(路径均在 workDir 内)。
 */
function formatSubagentReport(header: string, result: SubagentResult): string {
  const lines = [`${header}:`, result.summary];
  if (result.artifacts.length > 0) {
    lines.push(
      "",
      `[大型探索输出已外部化,可用 read_file 回查原文]:`,
      ...result.artifacts.map((path) => `  - ${path}`),
    );
  }
  return lines.join("\n");
}

function capSubagentResult(result: SubagentResult): SubagentResult {
  return {
    ...result,
    summary: truncateWithMarker(result.summary, SUBAGENT_OUTPUT_BUDGET.summary.hardMax),
  };
}

type DelegationTextPriority = 1 | 2 | 3 | 4;

interface DelegationTextField {
  resultIndex: number;
  key: "summary" | "error";
  value: string;
  priority: DelegationTextPriority;
  protectedChars: number;
  preferredChars: number;
}

/**
 * 批量委派的正常结果按 6k–8k 动态软目标收口。12k 只是硬熔断：
 * 在软目标容纳不下失败原因、partial 证据或 artifact 引用时才使用。
 * 状态和耗时始终保留，文本按“失败 > partial > 带证据完成 > 普通完成”
 * 分配，避免长日志与关键证据被等额切割。
 */
function capDelegationBatchText(batch: DelegationBatchResult): DelegationBatchResult {
  const { softMin, softMax, hardMax } = SUBAGENT_OUTPUT_BUDGET.batch;
  const serializedChars = JSON.stringify(batch).length;
  const softTarget = calculateDelegationSoftTarget(batch, softMin, softMax);
  if (serializedChars <= softTarget) return batch;

  const textFields = batch.results.flatMap((result, resultIndex) => {
    const fields: DelegationTextField[] = [];
    if (result.summary !== undefined) {
      fields.push(buildDelegationTextField(result, resultIndex, "summary", result.summary));
    }
    if (result.error !== undefined) {
      fields.push(buildDelegationTextField(result, resultIndex, "error", result.error));
    }
    return fields;
  });
  let results = batch.results.map((result) => ({ ...result }));
  for (const field of textFields) {
    results[field.resultIndex]![field.key] = "";
  }

  let omittedArtifacts = 0;
  let structuralBatch: DelegationBatchResult = { ...batch, results };
  if (JSON.stringify(structuralBatch).length > hardMax) {
    omittedArtifacts = results.reduce(
      (count, result) => count + (result.artifacts?.length ?? 0),
      0,
    );
    results = results.map(({ artifacts: _artifacts, ...result }) => result);
    structuralBatch = {
      ...batch,
      results,
      ...(omittedArtifacts > 0 ? { omittedArtifacts } : {}),
    };
  }

  if (JSON.stringify(structuralBatch).length > hardMax) {
    return omitDelegationResults(batch, omittedArtifacts);
  }

  const fixedChars = JSON.stringify(structuralBatch).length;
  const protectedChars = textFields.reduce(
    (sum, field) => sum + Math.min(jsonStringPayloadChars(field.value), field.protectedChars),
    0,
  );
  const effectiveTarget = Math.min(hardMax, Math.max(softTarget, fixedChars + protectedChars));
  const budgets = allocatePriorityTextBudgets(
    textFields,
    Math.max(0, effectiveTarget - fixedChars),
  );
  for (let index = 0; index < textFields.length; index++) {
    const field = textFields[index]!;
    results[field.resultIndex]![field.key] = truncateForJsonBudget(
      field.value,
      budgets[index] ?? 0,
    );
  }
  const capped = { ...structuralBatch, results };
  if (JSON.stringify(capped).length <= hardMax) return capped;

  logger.warn(
    { hardMax, actualChars: JSON.stringify(capped).length },
    "[Subagent] 批量委派结果超出硬上限，已启用结构化降级。",
  );
  return omitDelegationResults(batch, omittedArtifacts);
}

function calculateDelegationSoftTarget(
  batch: DelegationBatchResult,
  softMin: number,
  softMax: number,
): number {
  const nonCompleted = batch.results.filter((result) => result.status !== "completed").length;
  const withArtifacts = batch.results.filter(
    (result) => (result.artifacts?.length ?? 0) > 0,
  ).length;
  const resultAllowance = Math.min(1_200, batch.results.length * 200);
  const evidenceAllowance = nonCompleted * 400 + withArtifacts * 200;
  return Math.min(softMax, softMin + resultAllowance + evidenceAllowance);
}

function buildDelegationTextField(
  result: DelegationResult,
  resultIndex: number,
  key: "summary" | "error",
  value: string,
): DelegationTextField {
  if (key === "error" || !["completed", "partial"].includes(result.status)) {
    return {
      resultIndex,
      key,
      value,
      priority: 4,
      protectedChars: 800,
      preferredChars: 1_500,
    };
  }
  if (result.status === "partial") {
    return {
      resultIndex,
      key,
      value,
      priority: 3,
      protectedChars: 1_200,
      preferredChars: 2_200,
    };
  }
  if ((result.artifacts?.length ?? 0) > 0) {
    return {
      resultIndex,
      key,
      value,
      priority: 2,
      protectedChars: 900,
      preferredChars: 1_800,
    };
  }
  return {
    resultIndex,
    key,
    value,
    priority: 1,
    protectedChars: 400,
    preferredChars: 1_200,
  };
}

function allocatePriorityTextBudgets(
  fields: readonly DelegationTextField[],
  totalBudget: number,
): number[] {
  const lengths = fields.map((field) => jsonStringPayloadChars(field.value));
  const budgets = new Array<number>(fields.length).fill(0);
  let remaining = totalBudget;

  remaining = grantTowardTargets(
    budgets,
    lengths.map((length) => Math.min(length, 120)),
    fields.map((_, index) => index),
    remaining,
  );

  for (const priority of [4, 3, 2, 1] as const) {
    const indices = fields.flatMap((field, index) => (field.priority === priority ? [index] : []));
    remaining = grantTowardTargets(
      budgets,
      fields.map((field, index) => Math.min(lengths[index]!, field.protectedChars)),
      indices,
      remaining,
    );
  }

  for (const priority of [4, 3, 2, 1] as const) {
    const indices = fields.flatMap((field, index) => (field.priority === priority ? [index] : []));
    remaining = grantTowardTargets(
      budgets,
      fields.map((field, index) => Math.min(lengths[index]!, field.preferredChars)),
      indices,
      remaining,
    );
  }

  allocateWeightedRemainder(budgets, lengths, fields, remaining);
  return budgets;
}

function grantTowardTargets(
  budgets: number[],
  targets: readonly number[],
  indices: readonly number[],
  remaining: number,
): number {
  if (remaining <= 0 || indices.length === 0) return remaining;
  const capacities = indices.map((index) => Math.max(0, targets[index]! - budgets[index]!));
  const grants = allocateFairTextBudgets(capacities, remaining);
  let spent = 0;
  for (let offset = 0; offset < indices.length; offset++) {
    const grant = grants[offset] ?? 0;
    budgets[indices[offset]!]! += grant;
    spent += grant;
  }
  return Math.max(0, remaining - spent);
}

function allocateWeightedRemainder(
  budgets: number[],
  lengths: readonly number[],
  fields: readonly DelegationTextField[],
  initialRemaining: number,
): void {
  let remaining = initialRemaining;
  while (remaining > 0) {
    const active = fields
      .map((field, index) => ({ field, index }))
      .filter(({ index }) => budgets[index]! < lengths[index]!);
    if (active.length === 0) return;
    const totalWeight = active.reduce((sum, { field }) => sum + field.priority, 0);
    const unit = Math.max(1, Math.floor(remaining / totalWeight));
    let spent = 0;
    for (const { field, index } of active) {
      if (remaining - spent <= 0) break;
      const capacity = lengths[index]! - budgets[index]!;
      const grant = Math.min(capacity, unit * field.priority, remaining - spent);
      budgets[index]! += grant;
      spent += grant;
    }
    if (spent === 0) return;
    remaining -= spent;
  }
}

function omitDelegationResults(
  batch: DelegationBatchResult,
  omittedArtifacts: number,
): DelegationBatchResult {
  return {
    status: batch.status,
    results: [],
    totalDurationMs: batch.totalDurationMs,
    omittedResults: batch.results.length,
    ...(omittedArtifacts > 0 ? { omittedArtifacts } : {}),
  };
}

function truncateForJsonBudget(value: string, payloadBudget: number): string {
  if (jsonStringPayloadChars(value) <= payloadBudget) return value;
  if (payloadBudget <= 0) return "";

  const marker = `\n[已截断：原始 ${value.length} 字符]`;
  if (jsonStringPayloadChars(marker) > payloadBudget) {
    return jsonStringPayloadChars("…") <= payloadBudget ? "…" : "";
  }

  const codePoints = Array.from(value);
  let low = 0;
  let high = codePoints.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (
      jsonStringPayloadChars(`${codePoints.slice(0, middle).join("")}${marker}`) <= payloadBudget
    ) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${codePoints.slice(0, low).join("")}${marker}`;
}

function jsonStringPayloadChars(value: string): number {
  return JSON.stringify(value).length - 2;
}

function allocateFairTextBudgets(lengths: readonly number[], totalBudget: number): number[] {
  const budgets = new Array<number>(lengths.length).fill(0);
  const pending = lengths.map((_, index) => index);
  let remaining = totalBudget;

  while (pending.length > 0 && remaining > 0) {
    const share = Math.floor(remaining / pending.length);
    const fulfilled = pending.filter((index) => lengths[index]! <= share);
    if (fulfilled.length === 0) {
      for (let offset = 0; offset < pending.length; offset++) {
        const index = pending[offset]!;
        budgets[index] = share + (offset < remaining % pending.length ? 1 : 0);
      }
      break;
    }
    for (const index of fulfilled) {
      budgets[index] = lengths[index]!;
      remaining -= lengths[index]!;
      pending.splice(pending.indexOf(index), 1);
    }
  }
  return budgets;
}

function truncateWithMarker(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  if (maxChars <= 0) return "";
  const marker = `\n[已截断：原始 ${value.length} 字符]`;
  if (marker.length >= maxChars) {
    return "[已截断]".slice(0, maxChars);
  }
  return `${sliceUtf16Safe(value, maxChars - marker.length)}${marker}`;
}

function sliceUtf16Safe(value: string, maxChars: number): string {
  let end = Math.max(0, Math.min(value.length, maxChars));
  if (end > 0 && end < value.length) {
    const previous = value.charCodeAt(end - 1);
    const next = value.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) {
      end--;
    }
  }
  return value.slice(0, end);
}

function parseDelegateArgs(args: string): DelegateTaskArgs {
  try {
    return JSON.parse(args) as DelegateTaskArgs;
  } catch {
    throw new Error("解析 delegate_task 参数失败:需 JSON 格式");
  }
}

function normalizeDelegateTasks(input: DelegateTaskArgs): NormalizedDelegateTask[] {
  const defaultMode = normalizeMode(input.mode);
  const defaultRole = normalizeRole(input.role);
  const defaultRoots = normalizeDelegationRoots(input.roots, DEFAULT_DELEGATION_ROOTS);
  const defaultMaxFiles = normalizeMaxFiles(input.max_files, DEFAULT_DELEGATION_MAX_FILES);
  const defaultStoppingCondition = normalizeContractText(
    input.stopping_condition,
    DEFAULT_STOPPING_CONDITION,
  );
  const defaultExpectedOutput = normalizeContractText(
    input.expected_output,
    DEFAULT_EXPECTED_OUTPUT,
  );
  const topLevelContractExplicit = hasExplicitTaskContract(input);
  const defaultAgent = parseDelegateAgent(input.agent, "agent");
  const rawTasks =
    input.tasks && input.tasks.length > 0
      ? input.tasks
      : [
          {
            goal: input.goal,
            context: input.context,
            mode: input.mode,
            role: input.role,
            agent_name: input.agent_name,
            agent: input.agent,
            roots: input.roots,
            max_files: input.max_files,
            stopping_condition: input.stopping_condition,
            expected_output: input.expected_output,
          },
        ];

  return rawTasks
    .filter((task): task is DelegateTaskInput & { goal: string } => Boolean(task.goal?.trim()))
    .map((task) => ({
      goal: task.goal.trim(),
      ...(task.context ? { context: task.context } : {}),
      mode: normalizeMode(task.mode, defaultMode),
      role: normalizeRole(task.role, defaultRole),
      ...(task.agent_name?.trim() ? { agentName: task.agent_name.trim() } : {}),
      ...normalizeEphemeralAgent(task.agent, defaultAgent),
      roots: normalizeDelegationRoots(task.roots, defaultRoots),
      maxFiles: normalizeMaxFiles(task.max_files, defaultMaxFiles),
      stoppingCondition: normalizeContractText(task.stopping_condition, defaultStoppingCondition),
      expectedOutput: normalizeContractText(task.expected_output, defaultExpectedOutput),
      contractExplicit: topLevelContractExplicit || hasExplicitTaskContract(task),
    }));
}

function parseDelegateAgent(value: unknown, field: string): EphemeralAgentSpec | undefined {
  const parsed = parseEphemeralAgentSpec(value);
  if (!parsed.ok) throw new Error(`${field}: ${parsed.error}`);
  return parsed.spec;
}

function normalizeEphemeralAgent(
  value: unknown,
  fallback: EphemeralAgentSpec | undefined,
): { ephemeralAgent?: EphemeralAgentSpec } {
  if (value === undefined) return fallback ? { ephemeralAgent: fallback } : {};
  const parsed = parseDelegateAgent(value, "tasks[].agent");
  return parsed ? { ephemeralAgent: parsed } : {};
}

function appendEphemeralInstructions(base: string | undefined, instructions: string | undefined) {
  if (!instructions) return base;
  return [
    base,
    "[一次性角色附加要求]",
    instructions,
    "以上附加要求不能覆盖系统安全边界、工作区限制或工具权限。",
  ]
    .filter((part): part is string => part !== undefined && part.length > 0)
    .join("\n\n");
}

function modelSelectionOptions(
  ephemeral: EphemeralAgentSpec | undefined,
  profile: AgentProfile | undefined,
): Pick<SubagentRunOptions, "modelSelection"> | Record<string, never> {
  const selection: SubagentModelSelectionRequest = {
    ...(ephemeral?.modelRouteId !== undefined ? { ephemeralRouteId: ephemeral.modelRouteId } : {}),
    ...(profile?.modelRouteId !== undefined ? { profileRouteId: profile.modelRouteId } : {}),
    ...(ephemeral?.thinkingEffort !== undefined
      ? { ephemeralThinkingEffort: ephemeral.thinkingEffort }
      : {}),
    ...(profile?.thinkingEffort !== undefined
      ? { profileThinkingEffort: profile.thinkingEffort }
      : {}),
  };
  return Object.keys(selection).length > 0 ? { modelSelection: selection } : {};
}

function profileRouteForTask(
  task: NormalizedDelegateTask,
  profiles: readonly AgentProfile[],
): string | undefined {
  if (!task.agentName) return undefined;
  return findAgentProfile(profiles, task.agentName)?.modelRouteId;
}

function ephemeralAgentSchema(catalog?: SubagentModelCatalog): Record<string, unknown> {
  return {
    type: "object",
    description:
      "根据用户自然语言创建的一次性子代理。instructions 只能追加；模型必须引用宿主已有 route。",
    properties: {
      name: { type: "string", description: "一次性角色显示名。" },
      instructions: { type: "string", description: "追加到安全骨架后的角色要求。" },
      model_route: {
        type: "string",
        ...modelRouteSchema(catalog),
      },
      thinking_effort: { type: "string", description: "由所选模型能力校验的思考档位。" },
      max_turns: { type: "number", minimum: 1, maximum: 50 },
    },
    additionalProperties: false,
  };
}

function modelRouteSchema(catalog?: SubagentModelCatalog): Record<string, unknown> {
  if (!catalog) {
    return {
      description: "宿主已有 provider/model 路由或 inherit；不能携带 endpoint/凭证。",
    };
  }

  if (!catalog.allowRouteOverride) {
    return {
      enum: ["inherit"],
      description: [
        "当前宿主不允许子代理覆盖模型，只能使用 inherit；不能携带 endpoint/凭证。",
        `inherit 将继承父 Agent 路由 ${catalog.parentRouteId}。`,
      ].join("\n"),
    };
  }

  const routeIds = [...new Set(catalog.routes.map((route) => route.id))];
  const routeLines = catalog.routes.map((route) => {
    const disclosedAliases = route.aliases.slice(0, MAX_DISCLOSED_MODEL_ALIASES);
    const aliases = disclosedAliases
      .map(
        (alias) => `${singleLine(alias).slice(0, MAX_DISCLOSED_MODEL_ALIAS_LENGTH)} → ${route.id}`,
      )
      .join("，");
    const omittedAliases = route.aliases.length - disclosedAliases.length;
    return [
      `- ${route.id}: model=${route.model}; reasoning=${formatReasoning(route.reasoning)}`,
      aliases ? `; aliases=${aliases}` : "",
      omittedAliases > 0 ? `（另有 ${omittedAliases} 个 alias 未披露）` : "",
    ].join("");
  });
  const disclosedRouteLines = boundedCatalogLines(routeLines);
  const routeDescriptionNotice =
    disclosedRouteLines.length < routeLines.length
      ? `模型说明受长度限制，当前说明 ${disclosedRouteLines.length}/${routeLines.length} 条；enum 仍包含全部已披露规范路由。`
      : undefined;
  const truncationNotice = catalog.truncated
    ? `模型目录已截断：共 ${catalog.totalSelectableRoutes} 条可选路由，当前披露 ${catalog.routes.length} 条；未披露模型可使用完整 provider/model 路由。`
    : undefined;

  return {
    ...(catalog.truncated ? {} : { enum: ["inherit", ...routeIds] }),
    description: [
      "选择 inherit 或下列规范 provider/model 路由；alias 仅帮助理解自然语言，不可作为参数值；不能携带 endpoint/凭证。",
      `inherit → ${catalog.parentRouteId}`,
      disclosedRouteLines.length > 0
        ? `可用规范路由：\n${disclosedRouteLines.join("\n")}`
        : "当前没有可覆盖的模型路由。",
      routeDescriptionNotice,
      truncationNotice,
    ]
      .filter((line): line is string => line !== undefined)
      .join("\n"),
  };
}

function boundedCatalogLines(lines: readonly string[]): string[] {
  const disclosed: string[] = [];
  let length = 0;
  for (const line of lines) {
    const nextLength = length + line.length + (disclosed.length > 0 ? 1 : 0);
    if (nextLength > MAX_MODEL_ROUTE_CATALOG_DESCRIPTION) break;
    disclosed.push(line);
    length = nextLength;
  }
  return disclosed;
}

function formatReasoning(reasoning: boolean | "unknown"): string {
  if (reasoning === "unknown") return "unknown";
  return reasoning ? "supported" : "unsupported";
}

function persistentAgentNameSchema(profiles: readonly AgentProfile[]): Record<string, unknown> {
  const names = profiles.map((profile) => profile.name);
  const catalog = profiles
    .map((profile) => `${profile.name}: ${singleLine(profile.description).slice(0, 160)}`)
    .join("\n")
    .slice(0, 8_000);
  return {
    type: "string",
    ...(names.length > 0 ? { enum: names } : {}),
    description: [
      "持久子代理角色名（来自宿主统一 Agent Catalog）。",
      "指定后使用该角色的 systemPrompt 和工具集；未找到时 fail closed。",
      catalog ? `可用 Agent:\n${catalog}` : "当前没有可用的持久 Agent。",
    ].join("\n"),
  };
}

function singleLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function normalizeDelegationRoots(value: string[] | undefined, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback];
  const roots = [
    ...new Set(
      value
        .filter((root): root is string => typeof root === "string")
        .map(normalizeDelegationRoot)
        .filter((root): root is string => root !== undefined),
    ),
  ].slice(0, 20);
  return roots.length > 0 ? roots : [...fallback];
}

function normalizeDelegationRoot(value: string): string | undefined {
  const root = value.trim().replaceAll("\\", "/");
  if (!root || root.includes("\0")) return undefined;
  // roots 是相对可信 workspace 的聚焦范围，不接受宿主绝对路径或路径穿越。
  if (root.startsWith("/") || /^[A-Za-z]:\//u.test(root)) return undefined;
  const segments = root.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.includes("..")) return undefined;
  return (segments.length > 0 ? segments.join("/") : ".").slice(0, 240);
}

function normalizeMaxFiles(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(MAX_DELEGATION_FILES, Math.max(1, Math.floor(value)));
}

function normalizeContractText(value: string | undefined, fallback: string): string {
  const normalized = value?.replace(/\s+/gu, " ").trim();
  return normalized ? normalized.slice(0, 500) : fallback;
}

function hasExplicitTaskContract(task: DelegateTaskInput): boolean {
  return (
    task.roots !== undefined ||
    task.max_files !== undefined ||
    task.stopping_condition !== undefined ||
    task.expected_output !== undefined
  );
}

function renderBoundedTaskPrompt(task: NormalizedDelegateTask): string {
  return [
    task.context,
    `任务: ${task.goal}`,
    "",
    "[有界任务契约]",
    `允许根: ${task.roots.join(", ")}`,
    `最多检查文件: ${task.maxFiles}`,
    `停止条件: ${task.stoppingCondition}`,
    `期望输出: ${task.expectedOutput}`,
    "禁止扩展为阅读整个项目或所有文件；超出边界时返回已确认内容和剩余风险。",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function normalizeMode(
  value: string | undefined,
  fallback: SubagentMode = "explore",
): SubagentMode {
  return value === "worker" || value === "explore" ? value : fallback;
}

function normalizeRole(value: string | undefined, fallback: SubagentRole = "leaf"): SubagentRole {
  return value === "orchestrator" || value === "leaf" ? value : fallback;
}

function normalizeCompletionPolicy(input: DelegateTaskArgs): DelegationCompletionPolicy {
  if (
    input.completion_policy === "required" ||
    input.completion_policy === "optional" ||
    input.completion_policy === "detached"
  ) {
    return input.completion_policy;
  }
  return input.background === true ? "optional" : "required";
}

function summarizeDelegation(tasks: readonly NormalizedDelegateTask[]): string {
  const first = tasks[0]?.goal ?? "delegate_task";
  return tasks.length === 1 ? first : `${first} 等 ${tasks.length} 个子任务`;
}

function delegationResultFromError(
  taskIndex: number,
  error: unknown,
  durationMs: number,
  signal?: AbortSignal,
): DelegationResult {
  const reason = signal?.aborted ? signal.reason : error;
  const status =
    reason instanceof Error && reason.name === "TimeoutError"
      ? "timed_out"
      : signal?.aborted || (error instanceof Error && error.name === "AbortError")
        ? "cancelled"
        : "error";
  return {
    taskIndex,
    status,
    error: errorMessage(reason),
    durationMs,
  };
}

function activityStatusForResult(
  status: DelegationResult["status"],
): SubagentActivityEvent["status"] {
  if (status === "error") return "failed";
  return status;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortedSignal(reason?: string): AbortSignal {
  return AbortSignal.abort(new DOMException(reason ?? "cancelled", "AbortError"));
}

/**
 * 从对象中挑出值不为 undefined 的字段,用于构造可选 opts(避免重复的
 * `...(x !== undefined ? { x } : {})` 模式)。
 */
function pickDefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value !== undefined) result[key] = value;
  }
  return result as Partial<T>;
}

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  onRejected: (error: unknown, index: number) => R,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor++;
        try {
          results[index] = await worker(items[index]!, index);
        } catch (error) {
          results[index] = onRejected(error, index);
        }
      }
    }),
  );

  return results;
}
