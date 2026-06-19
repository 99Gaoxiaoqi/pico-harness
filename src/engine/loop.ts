// 核心心脏:Agent 的 Main Loop (ReAct 循环)。
// 经第 02/03/08/09 讲持续演进,本讲(第 11 讲)重构为 Session 驱动。
//
// 驾驭工程的极简之美:loop.ts 根本不关心 bash 怎么运行、Claude 的 HTTP 请求怎么发,
// 它只负责维护这根脆弱但重要的"上下文时间线" (contextHistory)。
// 它像一个忠实的书记员,严格执行 ReAct 范式:
// 把模型的意图 (ToolCall) 交给执行层,再把物理世界的反馈 (Observation) 追加回内存。
//
// 第 11 讲:引擎彻底沦为"打工执行器"。它不内部维护状态,
// 而是依靠喂给它的 Session 实例进行推理 —— 随时休眠、随时被唤醒的记忆连续体。
// 每轮组装 = SystemPrompt + Session.GetWorkingMemory(N),严格限制 Context 规模。

import type { LLMProvider } from "../provider/interface.js";
import type { Message, ToolCall } from "../schema/message.js";
import type { Registry } from "../tools/registry.js";
import { SilentReporter, type Reporter } from "./reporter.js";
import type { Session } from "./session.js";

/** WorkingMemory 滑动窗口大小:截取最近 N 条消息发给大模型 */
const DEFAULT_WORKING_MEMORY_LIMIT = 6;

export interface AgentEngineOptions {
  provider: LLMProvider;
  registry: Registry;
  /** 工作区:借鉴 OpenClaw 理念,Agent 必须有明确的物理边界 */
  workDir: string;
  /** 系统提示词;由 PromptComposer 动态组装 */
  systemPrompt?: string;
  /**
   * 慢思考模式开关 (第 03 讲)。
   * 开启后,每轮行动前先发起一次不带工具的纯文本请求,强制模型规划。
   */
  enableThinking?: boolean;
  /** WorkingMemory 滑动窗口大小(默认 6 条) */
  workingMemoryLimit?: number;
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
  private readonly workingMemoryLimit: number;
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
    this.workingMemoryLimit = opts.workingMemoryLimit ?? DEFAULT_WORKING_MEMORY_LIMIT;
    this.onTurn = opts.onTurn;
    this.reporter = opts.reporter ?? new SilentReporter();
  }

  /**
   * 启动 Agent 的生命周期(Session 驱动)。
   *
   * 引擎不再"用完即毁":它以传入的 Session 作为上下文承载体,
   * 从 Session.GetWorkingMemory 恢复记忆,而非从零开始。
   * 所有 Thinking / Action / Observation 均持久化回 Session。
   *
   * @param session 当前会话(已 append 用户本轮输入)
   * @param runtimeReporter 可选的运行时 Reporter,覆盖构造时的默认值
   *                        (第 09 讲:飞书每次会话用独立 reporter 回写)
   * @returns 本轮新增的消息序列(从用户输入起)
   */
  async run(session: Session, runtimeReporter?: Reporter): Promise<Message[]> {
    const reporter = runtimeReporter ?? this.reporter;
    reporter.onStart(this.workDir, this.enableThinking);
    console.log(`[Engine] 唤醒会话 [${session.id}],锁定工作区: ${session.workDir}`);

    const beforeLen = session.length;
    let turnCount = 0;

    // The Main Loop:心跳开始 (Two-Stage ReAct 循环)
    for (;;) {
      turnCount++;
      reporter.onTurnStart(turnCount);

      // 获取当前挂载的所有工具定义
      const availableTools = this.registry.getAvailableTools();

      // ====================================================================
      // 1. 上下文组装:System Prompt + 截取最近 N 条作为 WorkingMemory
      // 无论聊多久,发给大模型的 Context 规模始终被严格控制。
      // ====================================================================
      const workingMemory = session.getWorkingMemory(this.workingMemoryLimit);
      const contextHistory: Message[] = [
        { role: "system", content: this.systemPrompt },
        ...workingMemory,
      ];

      // ====================================================================
      // Phase 1: 慢思考阶段 (Thinking) —— 剥夺工具,强制规划 (第 03 讲)
      // ====================================================================
      if (this.enableThinking) {
        reporter.onThinking();

        // 核心机制:传入空的 tools 数组!
        // 大模型看不到任何 JSON Schema,被迫只能输出纯文本的思考过程。
        const thinkResp = await this.provider.generate(contextHistory, []);

        if (thinkResp.content) {
          // 将思考过程持久化到 Session,并追加到本轮临时上下文供 Action 使用
          session.append(thinkResp);
          contextHistory.push(thinkResp);
        }
      }

      // ====================================================================
      // Phase 2: 行动阶段 (Action) —— 恢复工具,顺着规划执行
      // ====================================================================
      // 此时 contextHistory 已包含 Phase 1 模型自己的 Thinking Trace。
      // 自回归特性:模型看到自己刚才的规划,会顺理成章生成对应的工具调用。
      const responseMsg = await this.provider.generate(contextHistory, availableTools);

      // 将大模型的行动响应持久化到 Session
      session.append(responseMsg);
      contextHistory.push(responseMsg);
      this.onTurn?.({ turn: turnCount, message: responseMsg });

      // 模型回复纯文本时广播 (通常是思考过程或最终结果)
      if (responseMsg.content) {
        reporter.onMessage(responseMsg.content);
      }

      // 3. 退出条件:模型没有请求任何工具调用,说明任务完成,挂起等待下一条指令
      const toolCalls = responseMsg.toolCalls ?? [];
      if (toolCalls.length === 0) {
        reporter.onFinish();
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
            observations[i] = await this.runOneTool(toolCall, reporter);
          }),
        );
      } else {
        for (let i = 0; i < toolCalls.length; i++) {
          observations[i] = await this.runOneTool(toolCalls[i]!, reporter);
        }
      }

      // 将所有 Observation 持久化到 Session,开启下一轮复盘与推理
      session.append(...observations);
    }

    // 返回本轮新增的消息序列(从用户输入起到最终答案止)
    return session.getHistory().slice(beforeLen);
  }

  /** 执行单个工具调用并返回观察结果消息 (带日志) */
  private async runOneTool(toolCall: ToolCall, reporter: Reporter): Promise<Message> {
    reporter.onToolCall(toolCall.name, toolCall.arguments);
    const result = await this.registry.execute(toolCall);
    reporter.onToolResult(toolCall.name, result.output, result.isError);
    // ToolCallId 必须携带!这是维系大模型推理链条的关键
    return {
      role: "user",
      content: result.output,
      toolCallId: toolCall.id,
    };
  }
}
