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
import type { WorktreeSupervisor } from "../tasks/worktree-supervisor.js";
import {
  compactActivityText,
  ScopedSubagentActivityReporter,
  type SubagentActivityScope,
} from "./subagent-activity-reporter.js";

/**
 * AgentRunner:打破循环依赖的抽象接口。
 * SubagentTool 在 tools 包,完整 AgentEngine 在 engine 包。
 * 为让 Tool 能拉起 Engine,定义接口供外部注入。
 */
/**
 * 子智能体执行结果。
 * - summary: 最终纯文本总结汇报(主 Agent 直接可见)
 * - artifacts: 探索期间被外部化的大型工具输出磁盘路径(相对 workDir)。
 *   这些文件落在 workDir/.claw/artifacts/ 内,主 Agent 可用 read_file 直接回查,
 *   避免子代理读过大文件后,主 Agent 既看不到原文也无法定位。
 */
export interface SubagentResult {
  /** 未设置时按 completed 兼容旧 runner；partial 表示保留了轮次耗尽前的有效证据。 */
  status?: "completed" | "partial";
  summary: string;
  artifacts: string[];
}

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
}

export interface SubagentRegistryRequest {
  mode: SubagentMode;
  role: SubagentRole;
  depth: number;
  maxSpawnDepth: number;
  /** 自定义角色名(来自 .claw/agents.yaml)。命中时用该角色的工具集和 prompt。 */
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
  /** 指定自定义子代理角色(来自 .claw/agents.yaml)。命中时用该角色的 prompt 和工具集。 */
  agent_name?: string;
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
  roots: string[];
  maxFiles: number;
  stoppingCondition: string;
  expectedOutput: string;
  contractExplicit: boolean;
}

const SUBAGENT_SUMMARY_MAX_CHARS = 5_000;
const REQUIRED_DELEGATION_TEXT_BUDGET_CHARS = 10_000;
const DEFAULT_DELEGATION_ROOTS = ["."];
const DEFAULT_DELEGATION_MAX_FILES = 30;
const MAX_DELEGATION_FILES = 100;
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
  /** 用户自定义角色库(来自 .claw/agents.yaml),按 agent_name 查询。空=无自定义角色。 */
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
    } = {},
  ) {
    this.profiles = options.profiles ?? [];
  }

  name(): string {
    return "delegate_task";
  }

  definition(): ToolDefinition {
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
            description: "多个互不依赖的子任务。每项可单独指定 goal/context/mode/role。",
            items: {
              type: "object",
              properties: {
                goal: { type: "string" },
                context: { type: "string" },
                mode: { type: "string", enum: ["explore", "worker"] },
                role: { type: "string", enum: ["leaf", "orchestrator"] },
                agent_name: { type: "string" },
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
          agent_name: {
            type: "string",
            description:
              "自定义子代理角色名(来自工作区 .claw/agents.yaml 配置)。" +
              "指定后使用该角色的 systemPrompt 和工具集,覆盖 mode 的默认工具集分配。",
          },
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
            enum: ["required", "optional", "detached"],
            description:
              "结果交付策略。required=前台等待(默认);optional=可先结束并在下一个模型边界自动注入结果;detached=独立运行且不进入主上下文。",
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

    const completionPolicy = normalizeCompletionPolicy(input);
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
        capDelegationBatchText(
          await this.runBatch(tasks, activities, depth, maxSpawnDepth, context?.signal),
          REQUIRED_DELEGATION_TEXT_BUDGET_CHARS,
        ),
      );
    }

    let dispatch: ReturnType<DelegationManager["dispatch"]>;
    try {
      dispatch = this.manager.dispatch(
        (signal) => this.runBatch(tasks, activities, depth, maxSpawnDepth, signal),
        { completionPolicy, description: summarizeDelegation(tasks) },
      );
    } catch (error) {
      const message = errorMessage(error);
      this.finishQueuedActivities(activities, "failed", message);
      return JSON.stringify({
        status: "rejected",
        completionPolicy,
        count: tasks.length,
        error: message,
      });
    }
    if (dispatch.status === "rejected") {
      this.finishQueuedActivities(activities, "cancelled", dispatch.error ?? "委派未派发");
    }
    return JSON.stringify({
      status: dispatch.status,
      completionPolicy,
      count: tasks.length,
      ...(dispatch.error !== undefined ? { error: dispatch.error } : {}),
    });
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
        summary: truncateWithMarker(result.summary ?? "", SUBAGENT_SUMMARY_MAX_CHARS),
      };
    } else if (result.status === "partial" && result.summary !== undefined) {
      result = {
        ...result,
        summary: truncateWithMarker(result.summary, SUBAGENT_SUMMARY_MAX_CHARS),
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
      { description: task.goal, branchSlug: task.agentName ?? "worker" },
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
          );
          if (delegatedResult.status !== "completed" && delegatedResult.status !== "partial") {
            throw new Error(
              delegatedResult.error ?? `worker 子代理追加指令以 ${delegatedResult.status} 收口`,
            );
          }
          context.appendOutput(`${delegatedResult.summary ?? "follow-up completed"}\n`);
        }
        return { summary: delegatedResult.summary };
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
    const profile = task.agentName
      ? this.profiles.find((p) => p.name === task.agentName)
      : undefined;

    const registry = this.registryFactory({
      mode: task.mode,
      role: task.role,
      depth: childDepth,
      maxSpawnDepth,
      ...(task.agentName ? { agentName: task.agentName } : {}),
      ...(effectiveWorkDir ? { workDir: effectiveWorkDir } : {}),
    });

    try {
      // 自定义角色命中时,用 profile 的 prompt/maxTurns;否则用 Tool 级 options
      const customization = profile
        ? pickDefined({
            systemPrompt: profile.systemPrompt,
            systemPromptOverride: profile.systemPromptOverride,
            maxTurns: profile.maxTurns,
          })
        : pickDefined({
            maxTurns: this.options.maxTurns,
            systemPrompt: this.options.systemPrompt,
            systemPromptOverride: this.options.systemPromptOverride,
          });

      const childReporter = this.options.reporter
        ? new ScopedSubagentActivityReporter(this.options.reporter, activity)
        : undefined;
      const subResult = await this.runner.runSub(prompt, registry, childReporter, {
        depth: childDepth,
        maxSpawnDepth,
        role: task.role,
        ...(signal ? { signal } : {}),
        ...(effectiveWorkDir ? { workDir: effectiveWorkDir } : {}),
        ...customization,
      });
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
      ...(task.agentName ? { agentName: task.agentName } : {}),
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
    summary: truncateWithMarker(result.summary, SUBAGENT_SUMMARY_MAX_CHARS),
  };
}

/**
 * required 批量委派先保留状态和耗时，再将剩余预算在
 * summary/error 之间公平分配。artifact 路径本身导致结构超额时，
 * 只返回省略计数；极端大批次连最小结果结构都容纳不下时，改为返回
 * 省略的结果数。这样 JSON.stringify 后的实际工具结果始终不超过总预算。
 */
function capDelegationBatchText(
  batch: DelegationBatchResult,
  totalBudget: number,
): DelegationBatchResult {
  const textFields = batch.results.flatMap((result, resultIndex) => {
    const fields: Array<{ resultIndex: number; key: "summary" | "error"; value: string }> = [];
    if (result.summary !== undefined) {
      fields.push({ resultIndex, key: "summary", value: result.summary });
    }
    if (result.error !== undefined) {
      fields.push({ resultIndex, key: "error", value: result.error });
    }
    return fields;
  });
  let results = batch.results.map((result) => ({ ...result }));
  for (const field of textFields) {
    results[field.resultIndex]![field.key] = "";
  }

  let omittedArtifacts = 0;
  let structuralBatch: DelegationBatchResult = { ...batch, results };
  if (JSON.stringify(structuralBatch).length > totalBudget) {
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

  if (JSON.stringify(structuralBatch).length > totalBudget) {
    return {
      status: batch.status,
      results: [],
      totalDurationMs: batch.totalDurationMs,
      omittedResults: batch.results.length,
      ...(omittedArtifacts > 0 ? { omittedArtifacts } : {}),
    };
  }

  const fixedChars = JSON.stringify(structuralBatch).length;
  const budgets = allocateFairTextBudgets(
    textFields.map((field) => jsonStringPayloadChars(field.value)),
    Math.max(0, totalBudget - fixedChars),
  );
  for (let index = 0; index < textFields.length; index++) {
    const field = textFields[index]!;
    results[field.resultIndex]![field.key] = truncateForJsonBudget(
      field.value,
      budgets[index] ?? 0,
    );
  }
  return { ...structuralBatch, results };
}

function truncateForJsonBudget(value: string, payloadBudget: number): string {
  if (jsonStringPayloadChars(value) <= payloadBudget) return value;
  if (payloadBudget <= 0) return "";

  const marker = `\n[已截断：原始 ${value.length} 字符]`;
  if (jsonStringPayloadChars(marker) > payloadBudget) {
    return jsonStringPayloadChars("…") <= payloadBudget ? "…" : "";
  }

  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (jsonStringPayloadChars(`${value.slice(0, middle)}${marker}`) <= payloadBudget) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return `${value.slice(0, low)}${marker}`;
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
  return `${value.slice(0, maxChars - marker.length)}${marker}`;
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
      roots: normalizeDelegationRoots(task.roots, defaultRoots),
      maxFiles: normalizeMaxFiles(task.max_files, defaultMaxFiles),
      stoppingCondition: normalizeContractText(task.stopping_condition, defaultStoppingCondition),
      expectedOutput: normalizeContractText(task.expected_output, defaultExpectedOutput),
      contractExplicit: topLevelContractExplicit || hasExplicitTaskContract(task),
    }));
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
