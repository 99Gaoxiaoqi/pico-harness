// 核心心脏:Agent 的 Main Loop (ReAct 循环)。
// 对应课程第 02 讲 internal/engine/loop.go,经第 03/08/09 讲持续演进。
//
// 驾驭工程的极简之美:loop.ts 根本不关心 bash 怎么运行、Claude 的 HTTP 请求怎么发,
// 它只负责维护这根脆弱但重要的"上下文时间线" (contextHistory)。
// 它像一个忠实的书记员,严格执行 ReAct 范式:
// 把模型的意图 (ToolCall) 交给执行层,再把物理世界的反馈 (Observation) 追加回内存。
//
// 第 09 讲:输出能力剥离为 Reporter 接口,引擎与 I/O 彻底解耦。

import type { LLMProvider } from "../provider/interface.js";
import type { Message, ToolCall } from "../schema/message.js";
import type { Registry } from "../tools/registry.js";
import { SilentReporter, type Reporter } from "./reporter.js";

export interface AgentEngineOptions {
  provider: LLMProvider;
  registry: Registry;
  /** 工作区:借鉴 OpenClaw 理念,Agent 必须有明确的物理边界 */
  workDir: string;
  /** 系统提示词;第 10 讲会改成由 AGENTS.md 动态组装 */
  systemPrompt?: string;
  /**
   * 慢思考模式开关 (第 03 讲)。
   * 开启后,每轮行动前先发起一次不带工具的纯文本请求,强制模型规划。
   */
  enableThinking?: boolean;
  /** 可选的轮次日志回调,便于第 19 讲 Tracing 接入 */
  onTurn?: (info: { turn: number; message: Message }) => void;
  /** 输出 Reporter;默认静默 (第 09 讲) */
  reporter?: Reporter;
}

/** 微型 OS 的核心驱动 */
export class AgentEngine {
  private readonly provider: LLMProvider;
  private readonly registry: Registry;
  private readonly workDir: string;
  private readonly systemPrompt: string;
  private readonly enableThinking: boolean;
  private readonly onTurn?: (info: { turn: number; message: Message }) => void;
  private readonly reporter: Reporter;

  constructor(opts: AgentEngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.workDir = opts.workDir;
    this.systemPrompt =
      opts.systemPrompt ??
      "You are tiny-claw, an expert coding assistant running in a Harness engine. " +
        "You have tools to read, write, edit files and run bash. Think step by step.";
    this.enableThinking = opts.enableThinking ?? false;
    this.onTurn = opts.onTurn;
    this.reporter = opts.reporter ?? new SilentReporter();
  }

  /** 启动 Agent 的生命周期 */
  async run(userPrompt: string): Promise<Message[]> {
    this.reporter.onStart(this.workDir, this.enableThinking);

    // 1. 初始化会话的 Context (上下文内存)
    const contextHistory: Message[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let turnCount = 0;

    // 2. The Main Loop:心跳开始 (Two-Stage ReAct 循环)
    for (;;) {
      turnCount++;
      this.reporter.onTurnStart(turnCount);

      // 获取当前挂载的所有工具定义
      const availableTools = this.registry.getAvailableTools();

      // ====================================================================
      // Phase 1: 慢思考阶段 (Thinking) —— 剥夺工具,强制规划 (第 03 讲)
      // ====================================================================
      if (this.enableThinking) {
        this.reporter.onThinking();

        // 核心机制:传入空的 tools 数组!
        // 大模型看不到任何 JSON Schema,被迫只能输出纯文本的思考过程。
        const thinkResp = await this.provider.generate(contextHistory, []);

        if (thinkResp.content) {
          // 将思考过程作为 assistant 消息追加到上下文
          contextHistory.push(thinkResp);
        }
      }

      // ====================================================================
      // Phase 2: 行动阶段 (Action) —— 恢复工具,顺着规划执行
      // ====================================================================
      // 此时 contextHistory 已包含 Phase 1 模型自己的 Thinking Trace。
      // 自回归特性:模型看到自己刚才的规划,会顺理成章生成对应的工具调用。
      const responseMsg = await this.provider.generate(contextHistory, availableTools);

      // 将模型的响应完整追加到上下文历史中
      contextHistory.push(responseMsg);
      this.onTurn?.({ turn: turnCount, message: responseMsg });

      // 模型回复纯文本时广播 (通常是思考过程或最终结果)
      if (responseMsg.content) {
        this.reporter.onMessage(responseMsg.content);
      }

      // 3. 退出条件:模型没有请求任何工具调用,说明任务完成
      const toolCalls = responseMsg.toolCalls ?? [];
      if (toolCalls.length === 0) {
        this.reporter.onFinish();
        break;
      }

      // 4. 执行行动 (Action) 与 获取观察结果 (Observation)
      // 第 08 讲:Fork-Join 并发执行。
      // 策略:批次全只读则并行 (Promise.all),含写操作则串行。
      // 预分配结果数组按原索引写入,既并发安全又保留工具调用原始顺序。
      const isReadOnly = this.registry.isReadOnlyTool;
      const allReadOnly =
        isReadOnly !== undefined && toolCalls.every((tc) => isReadOnly.call(this.registry, tc.name));

      const observations: Message[] = new Array(toolCalls.length);

      if (allReadOnly) {
        await Promise.all(
          toolCalls.map(async (toolCall, i) => {
            observations[i] = await this.runOneTool(toolCall);
          }),
        );
      } else {
        for (let i = 0; i < toolCalls.length; i++) {
          observations[i] = await this.runOneTool(toolCalls[i]!);
        }
      }

      // 将观察结果按顺序追加到上下文
      for (const obs of observations) {
        contextHistory.push(obs);
      }

      // 循环回到开头,模型带着新加入的 Observation 继续下一轮思考...
    }

    return contextHistory;
  }

  /** 执行单个工具调用并返回观察结果消息 (带日志) */
  private async runOneTool(toolCall: ToolCall): Promise<Message> {
    this.reporter.onToolCall(toolCall.name, toolCall.arguments);
    const result = await this.registry.execute(toolCall);
    this.reporter.onToolResult(toolCall.name, result.output, result.isError);
    // ToolCallId 必须携带!这是维系大模型推理链条的关键
    return {
      role: "user",
      content: result.output,
      toolCallId: toolCall.id,
    };
  }
}
