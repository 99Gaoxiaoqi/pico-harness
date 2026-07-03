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

import type { BaseTool } from "./registry.js";
import type { ToolDefinition } from "../schema/message.js";
import type { Registry } from "./registry.js";
import type { Reporter } from "../engine/reporter.js";
import { logger } from "../observability/logger.js";
import type { DelegationBatchResult } from "./delegation-manager.js";
import { DelegationManager } from "./delegation-manager.js";
import type { AgentProfile } from "./agent-profile.js";

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
}

export interface SubagentRegistryRequest {
  mode: SubagentMode;
  role: SubagentRole;
  depth: number;
  maxSpawnDepth: number;
  /** 自定义角色名(来自 .claw/agents.yaml)。命中时用该角色的工具集和 prompt。 */
  agentName?: string;
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
}

interface DelegateTaskArgs extends DelegateTaskInput {
  tasks?: DelegateTaskInput[];
  background?: boolean;
}

interface NormalizedDelegateTask {
  goal: string;
  context?: string;
  mode: SubagentMode;
  role: SubagentRole;
  agentName?: string;
}

/**
 * SubagentTool:拉起子智能体的特殊"套娃"工具。
 *
 * 主 Agent 调用 spawn_subagent 时,阻塞主线程,利用 runner 接口
 * 在后台跑完一个完整受限 ReAct 子循环。子循环用全新纯净上下文,
 * 几万字的探索化作轻量 Summary,像普通 API 调用返回给主 Agent。
 */
export class SpawnSubagentTool implements BaseTool {
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
  async execute(args: string): Promise<string> {
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
        // 透传调用方注入的自定义参数(程序化扩展点,非 LLM 可控)
        ...pickDefined({
          maxTurns: this.options.maxTurns,
          systemPrompt: this.options.systemPrompt,
          systemPromptOverride: this.options.systemPromptOverride,
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
    return formatSubagentReport("【子智能体探索报告】", result);
  }
}

/**
 * DelegateTaskTool:Hermes 风格的任务委派入口。
 *
 * 相比旧的 spawn_subagent,它支持:
 * - explore/worker 两种工具集,worker 可以在受控边界内写文件
 * - tasks 批量并行委派,适合拆分互不依赖的开发任务
 * - background 后台句柄,长任务可由 delegate_status 查询
 * - role + depth 约束,防止无限递归委派
 */
export class DelegateTaskTool implements BaseTool {
  /** 用户自定义角色库(来自 .claw/agents.yaml),按 agent_name 查询。空=无自定义角色。 */
  private readonly profiles: AgentProfile[];

  constructor(
    private readonly runner: AgentRunner,
    private readonly registryFactory: SubagentRegistryFactory,
    private readonly manager: DelegationManager = new DelegationManager(),
    private readonly options: SubagentRunOptions & { profiles?: AgentProfile[] } = {},
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
        "tasks 可批量并行执行;background=true 会立即返回 delegationId,之后用 delegate_status 查询。",
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
          background: {
            type: "boolean",
            description: "是否后台运行。true 时立即返回 delegationId,后续用 delegate_status 查询。",
          },
        },
      },
    };
  }

  async execute(args: string): Promise<string> {
    const input = parseDelegateArgs(args);
    const depth = this.options.depth ?? 0;
    const maxSpawnDepth = this.options.maxSpawnDepth ?? 2;
    if (depth >= maxSpawnDepth) {
      return JSON.stringify({
        error: `达到最大委派深度 ${maxSpawnDepth},拒绝继续 delegate_task。`,
      });
    }

    const tasks = normalizeDelegateTasks(input);
    if (tasks.length === 0) {
      return JSON.stringify({ error: "delegate_task 需要 goal 或 tasks[].goal。" });
    }

    if (input.background === true) {
      return JSON.stringify(
        this.manager.dispatch(() => this.runBatch(tasks, depth, maxSpawnDepth)),
      );
    }

    return JSON.stringify(await this.runBatch(tasks, depth, maxSpawnDepth));
  }

  private async runBatch(
    tasks: NormalizedDelegateTask[],
    depth: number,
    maxSpawnDepth: number,
  ): Promise<DelegationBatchResult> {
    const startedAt = Date.now();
    const results = await mapLimit(tasks, this.manager.maxConcurrentChildren, (task, index) =>
      this.runOne(task, index, depth, maxSpawnDepth),
    );
    return {
      results,
      totalDurationMs: Date.now() - startedAt,
    };
  }

  private async runOne(
    task: NormalizedDelegateTask,
    taskIndex: number,
    depth: number,
    maxSpawnDepth: number,
  ): Promise<DelegationBatchResult["results"][number]> {
    const startedAt = Date.now();
    const childDepth = depth + 1;
    const prompt = task.context ? `${task.context}\n\n任务: ${task.goal}` : task.goal;

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

      const subResult = await this.runner.runSub(prompt, registry, undefined, {
        depth: childDepth,
        maxSpawnDepth,
        role: task.role,
        ...customization,
      });
      return {
        taskIndex,
        status: "completed",
        summary: subResult.summary,
        ...(subResult.artifacts.length > 0 ? { artifacts: subResult.artifacts } : {}),
        durationMs: Date.now() - startedAt,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        taskIndex,
        status: "error",
        error: message,
        durationMs: Date.now() - startedAt,
      };
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
    }));
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
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let cursor = 0;
  const workerCount = Math.min(Math.max(1, limit), items.length);

  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (cursor < items.length) {
        const index = cursor;
        cursor++;
        results[index] = await worker(items[index]!, index);
      }
    }),
  );

  return results;
}
