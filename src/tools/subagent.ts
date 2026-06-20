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

/**
 * AgentRunner:打破循环依赖的抽象接口。
 * SubagentTool 在 tools 包,完整 AgentEngine 在 engine 包。
 * 为让 Tool 能拉起 Engine,定义接口供外部注入。
 */
export interface AgentRunner {
  /**
   * RunSub:启动一个匿名的、一次性子智能体任务,返回其最终梳理的纯文本总结。
   * @param taskPrompt 主 Agent 下达的明确指令
   * @param readOnlyRegistry 子智能体专属受限只读注册表(爆炸半径限制)
   * @param reporter 可选 Reporter,透传子智能体工作轨迹(打 [Subagent] 前缀)
   */
  runSub(taskPrompt: string, readOnlyRegistry: Registry, reporter?: Reporter): Promise<string>;
}

/** spawn_subagent 工具的参数 */
interface SubagentArgs {
  task_prompt: string;
}

/**
 * SubagentTool:拉起子智能体的特殊"套娃"工具。
 *
 * 主 Agent 调用 spawn_subagent 时,阻塞主线程,利用 runner 接口
 * 在后台跑完一个完整受限 ReAct 子循环。子循环用全新纯净上下文,
 * 几万字的探索化作轻量 Summary,像普通 API 调用返回给主 Agent。
 */
export class SubagentTool implements BaseTool {
  constructor(
    private readonly runner: AgentRunner,
    private readonly readOnlyRegistry: Registry,
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

    let summary: string;
    try {
      summary = await this.runner.runSub(input.task_prompt, this.readOnlyRegistry);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `子智能体执行失败: ${errMsg}`;
    }

    logger.info(`[Subagent] ✅ 子智能体任务结束。报告返回给主干...`);
    // 几万字的代码探索,化作轻量级 Summary,像普通 API 调用返回给主 Agent
    return `【子智能体探索报告】:\n${summary}`;
  }
}
