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
import type { Message, ToolCall, ToolResult } from "../schema/message.js";
import type { Registry } from "../tools/registry.js";
import type { AgentRunner } from "../tools/subagent.js";
import type { Compactor } from "../context/compactor.js";
import { PromptComposer } from "../context/composer.js";
import { RecoveryManager } from "../context/recovery.js";
import { SilentReporter, type Reporter } from "./reporter.js";
import { ReminderInjector } from "./reminder.js";
import { Tracer, exportTraceToFile, truncate, type Span } from "../observability/trace.js";
import type { Session } from "./session.js";

/** WorkingMemory 滑动窗口大小:截取最近 N 条消息供压缩器判断(含远期历史) */
const DEFAULT_WORKING_MEMORY_LIMIT = 20;

export interface AgentEngineOptions {
  provider: LLMProvider;
  registry: Registry;
  /** 工作区:借鉴 OpenClaw 理念,Agent 必须有明确的物理边界 */
  workDir: string;
  /** 系统提示词;由 PromptComposer 动态组装。planMode 开启时此项被忽略 */
  systemPrompt?: string;
  /**
   * 慢思考模式开关 (第 03 讲)。
   * 开启后,每轮行动前先发起一次不带工具的纯文本请求,强制模型规划。
   */
  enableThinking?: boolean;
  /**
   * 计划模式开关 (第 13 讲)。
   * 开启后,每次 run 动态用 PromptComposer 组装 System Prompt,
   * 注入"状态外部化强制规范",引导大模型读写 PLAN.md / TODO.md 管理长程任务。
   */
  planMode?: boolean;
  /** WorkingMemory 滑动窗口大小(默认 20 条,给压缩器留判断空间) */
  workingMemoryLimit?: number;
  /**
   * 上下文压缩器:在向 Provider 发起推理前过一遍,防 OOM (第 12 讲)。
   * 未提供则不压缩(纯靠 WorkingMemory 条数截断)。
   */
  compactor?: Compactor;
  /**
   * 错误自愈管理器:工具执行失败时注入锦囊妙计 (第 14 讲)。
   * 未提供则默认创建一个,对所有工具报错都尝试匹配恢复建议。
   */
  recovery?: RecoveryManager;
  /**
   * 死循环探测器:连续同参数失败时注入 [SYSTEM REMINDER] 强行打断 (第 15 讲)。
   * 未提供则默认创建一个,阈值 3 次同参数失败触发干预。
   */
  reminderInjector?: ReminderInjector;
  /** 可选的轮次日志回调,便于第 19 讲 Tracing 接入 */
  onTurn?: (info: { turn: number; message: Message }) => void;
  /** 输出 Reporter;默认静默 (第 09 讲) */
  reporter?: Reporter;
  /**
   * 链路追踪器:记录决策树到 .claw/traces/ (第 19 讲)。
   * 未提供则不追踪。
   */
  tracer?: Tracer;
}

/** 微型 OS 的核心驱动 */
export class AgentEngine implements AgentRunner {
  private readonly provider: LLMProvider;
  private readonly registry: Registry;
  private readonly workDir: string;
  private readonly systemPrompt: string;
  private readonly enableThinking: boolean;
  private readonly planMode: boolean;
  private readonly workingMemoryLimit: number;
  private readonly compactor?: Compactor;
  private readonly recovery: RecoveryManager;
  private readonly reminderInjector: ReminderInjector;
  private readonly onTurn?: (info: { turn: number; message: Message }) => void;
  private readonly reporter: Reporter;
  private readonly tracer?: Tracer;

  constructor(opts: AgentEngineOptions) {
    this.provider = opts.provider;
    this.registry = opts.registry;
    this.workDir = opts.workDir;
    this.systemPrompt =
      opts.systemPrompt ??
      "You are tiny-claw, an expert coding assistant running in a Harness engine. " +
        "You have tools to read, write, edit files and run bash. Think step by step.";
    this.enableThinking = opts.enableThinking ?? false;
    this.planMode = opts.planMode ?? false;
    this.workingMemoryLimit = opts.workingMemoryLimit ?? DEFAULT_WORKING_MEMORY_LIMIT;
    this.compactor = opts.compactor;
    this.recovery = opts.recovery ?? new RecoveryManager();
    this.reminderInjector = opts.reminderInjector ?? new ReminderInjector();
    this.onTurn = opts.onTurn;
    this.reporter = opts.reporter ?? new SilentReporter();
    this.tracer = opts.tracer;
  }

  /**
   * 组装本轮 System Prompt。
   * Plan Mode 开启时,每次 run 动态用 PromptComposer 重新组装,
   * 以反映工作区最新的 AGENTS.md / Skills / 外部化规范状态;
   * 关闭时使用构造时固定的 systemPrompt。
   */
  private async buildSystemPrompt(): Promise<string> {
    if (this.planMode) {
      return new PromptComposer(this.workDir, true).build();
    }
    return this.systemPrompt;
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
  async run(
    session: Session,
    runtimeReporter?: Reporter,
    runtimeTracer?: Tracer,
  ): Promise<Message[]> {
    const reporter = runtimeReporter ?? this.reporter;
    const tracer = runtimeTracer ?? this.tracer;
    const rootSpan = tracer?.startRoot("Agent.Run", {
      sessionId: session.id,
      workDir: session.workDir,
      planMode: this.planMode,
      enableThinking: this.enableThinking,
    });
    reporter.onStart(this.workDir, this.enableThinking);
    console.log(
      `[Engine] 唤醒会话 [${session.id}],锁定工作区: ${session.workDir} (PlanMode: ${this.planMode})`,
    );

    // Plan Mode 开启时,每次 run 动态组装 System Prompt(反映最新工作区状态)
    const systemPrompt = await this.buildSystemPrompt();

    const beforeLen = session.length;
    let turnCount = 0;

    // The Main Loop:心跳开始 (Two-Stage ReAct 循环)
    try {
      for (;;) {
        turnCount++;
        reporter.onTurnStart(turnCount);
        const turnSpan = rootSpan?.startChild(`Turn-${turnCount}`);

        try {
          // 获取当前挂载的所有工具定义
          const availableTools = this.registry.getAvailableTools();

          // ====================================================================
          // 1. 上下文组装:System Prompt + 截取最近 N 条作为 WorkingMemory
          // 无论聊多久,发给大模型的 Context 规模始终被严格控制。
          // ====================================================================
          const workingMemory = session.getWorkingMemory(this.workingMemoryLimit);
          const contextHistory: Message[] = [
            { role: "system", content: systemPrompt },
            ...workingMemory,
          ];

          // ====================================================================
          // 2. 【核心注入点】:在向 Provider 发起推理前,过一遍内存压缩器!
          // 无论带出多少上下文,若字符总数超标,早期日志将被掩码化,
          // 超大日志将被掐头去尾。Compact 只作用于本轮发给大模型的临时 Context,
          // 写入 Session 的永远是全量真实数据。
          // ====================================================================
          const contextChars = estimateTraceLength(contextHistory);
          const compactedContext = this.compactor
            ? this.compactor.compact(contextHistory)
            : contextHistory;
          const compactedChars = estimateTraceLength(compactedContext);
          turnSpan?.addAttributes({
            contextMessageCount: contextHistory.length,
            compactedMessageCount: compactedContext.length,
            contextChars,
            compactedChars,
            availableToolCount: availableTools.length,
          });
          recordCompaction(turnSpan, contextChars, compactedChars);

          // ====================================================================
          // Phase 1: 慢思考阶段 (Thinking) —— 剥夺工具,强制规划 (第 03 讲)
          // ====================================================================
          if (this.enableThinking) {
            reporter.onThinking();

            // 核心机制:传入空的 tools 数组!
            // 大模型看不到任何 JSON Schema,被迫只能输出纯文本的思考过程。
            const thinkingSpan = turnSpan?.startChild("LLM.Thinking", {
              inputMessageCount: compactedContext.length,
              availableToolCount: 0,
            });
            let thinkResp: Message;
            try {
              thinkResp = await this.provider.generate(compactedContext, []);
              recordLlmResponse(thinkingSpan, thinkResp);
            } catch (err) {
              recordTraceError(thinkingSpan, err);
              throw err;
            } finally {
              thinkingSpan?.end();
            }

            if (thinkResp.content) {
              // 将思考过程持久化到 Session,并追加到本轮临时上下文供 Action 使用
              session.append(thinkResp);
              compactedContext.push(thinkResp);
            }
          }

          // ====================================================================
          // Phase 2: 行动阶段 (Action) —— 恢复工具,顺着规划执行
          // ====================================================================
          // 此时 compactedContext 已包含 Phase 1 模型自己的 Thinking Trace。
          // 自回归特性:模型看到自己刚才的规划,会顺理成章生成对应的工具调用。
          const actionSpan = turnSpan?.startChild("LLM.Action", {
            inputMessageCount: compactedContext.length,
            availableToolCount: availableTools.length,
          });
          let responseMsg: Message;
          try {
            responseMsg = await this.provider.generate(compactedContext, availableTools);
            recordLlmResponse(actionSpan, responseMsg);
          } catch (err) {
            recordTraceError(actionSpan, err);
            throw err;
          } finally {
            actionSpan?.end();
          }

          // 将大模型的行动响应持久化到 Session
          session.append(responseMsg);
          compactedContext.push(responseMsg);
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
            isReadOnly !== undefined &&
            toolCalls.every((tc) => isReadOnly.call(this.registry, tc.name));

          const observations: Message[] = new Array(toolCalls.length);
          // 收集本轮最后一个工具调用 + 结果,供 Reminder 探测器分析
          // (并发场景下取索引 0;真实工业级可逐个分析报错的那个)
          let lastToolCall: ToolCall | null = null;
          let lastToolResult: ToolResult | null = null;

          if (allReadOnly) {
            await Promise.all(
              toolCalls.map(async (toolCall, i) => {
                const { message, result } = await this.runOneTool(toolCall, reporter, turnSpan);
                observations[i] = message;
                if (i === 0) {
                  lastToolCall = toolCall;
                  lastToolResult = result;
                }
              }),
            );
          } else {
            for (let i = 0; i < toolCalls.length; i++) {
              const { message, result } = await this.runOneTool(toolCalls[i]!, reporter, turnSpan);
              observations[i] = message;
              if (i === 0) {
                lastToolCall = toolCalls[i]!;
                lastToolResult = result;
              }
            }
          }

          // 将所有 Observation 持久化到 Session,开启下一轮复盘与推理
          session.append(...observations);

          // 【核心防线】第 15 讲:在准备进入下一轮之前,进行死循环探测!
          // 大模型"思考完毕、行动受挫"和"重燃执念再次思考"的空隙处安插安全阀。
          // 若检测到连续同参数失败,注入 [SYSTEM REMINDER 警告] 作为 User 消息
          // 追加到 Session 最末尾,凭最高近因效应击碎局部执念。
          if (lastToolCall && lastToolResult) {
            const reminderMsg = this.reminderInjector.checkAndInject(lastToolCall, lastToolResult);
            if (reminderMsg) {
              session.append(reminderMsg);
            }
          }
        } finally {
          turnSpan?.end();
        }
      }
    } finally {
      rootSpan?.end();
      if (rootSpan) {
        const tracePath = exportTraceToFile(rootSpan, session.workDir, session.id);
        console.log(`[Tracing] 本次任务的执行回放链路已保存: ${tracePath}`);
      }
    }

    // 返回本轮新增的消息序列(从用户输入起到最终答案止)
    return session.getHistory().slice(beforeLen);
  }

  /** 执行单个工具调用并返回观察结果消息 + 原始结果 (带日志 + 错误自愈注入) */
  private async runOneTool(
    toolCall: ToolCall,
    reporter: Reporter,
    parentSpan?: Span,
  ): Promise<{ message: Message; result: ToolResult }> {
    const toolSpan = parentSpan?.startChild("Tool.Execute", {
      toolName: toolCall.name,
      toolCallId: toolCall.id,
      arguments: toolCall.arguments,
    });
    try {
      reporter.onToolCall(toolCall.name, toolCall.arguments);
      const result = await this.registry.execute(toolCall);

      // 【核心拦截与注入】工具执行失败时,交由 RecoveryManager 诊断并注入"锦囊妙计"。
      // 化被动为主动:不再冷冰冰陈述报错,而是给出带强烈倾向性的行动指南,
      // 引导大模型进入标准排障 SOP(如"请先使用 read_file 重新查看文件")。
      let finalOutput = result.output;
      if (result.isError) {
        finalOutput = this.recovery.analyzeAndInject(toolCall.name, result.output);
        console.warn(`  -> [Recovery] ❌ 注入救援指南: ${toolCall.name}`);
      }

      toolSpan?.addAttributes({
        isError: result.isError,
        outputPreview: truncate(finalOutput, 500),
        rawOutputPreview: finalOutput === result.output ? undefined : truncate(result.output, 500),
      });

      reporter.onToolResult(toolCall.name, finalOutput, result.isError);
      // ToolCallId 必须携带!这是维系大模型推理链条的关键
      return {
        message: {
          role: "user",
          content: finalOutput,
          toolCallId: toolCall.id,
        },
        result,
      };
    } catch (err) {
      recordTraceError(toolSpan, err);
      throw err;
    } finally {
      toolSpan?.end();
    }
  }

  /**
   * RunSub:专为 Subagent 拉起的一次性受限循环 (第 17 讲)。
   *
   * 不依赖外部 Session,打完就跑。子智能体拥有全新纯净上下文,
   * 无论怎么折腾犯错,主干 contextHistory 依然纯洁如初。
   *
   * 防污染机制:
   * - 仅传入 readOnlyRegistry(只读工具,爆炸半径限制)
   * - 专属 System Prompt 严厉警告必须用工具不许偷懒
   * - maxSubTurns=10 防卡死
   * - 强制关闭慢思考(子任务急速响应)
   * - 退出条件:不调工具 = 做好总结,返回 content
   *
   * @returns 子智能体的纯文本总结汇报
   */
  async runSub(
    taskPrompt: string,
    readOnlyRegistry: Registry,
    reporter?: Reporter,
  ): Promise<string> {
    const rep = reporter ?? new SilentReporter();
    console.log(`[Subagent] 🚀 拉起探路者,任务: ${taskPrompt.slice(0, 100)}`);

    // 子智能体专属 System Prompt:严厉警告必须用工具,不许凭空猜测
    const subSystemPrompt = `你是专门负责深度探索的探路者 (Explorer Subagent)。
你的任务是根据主架构师的指令,在当前工作区内仔细阅读代码、查阅日志,搜集足够的信息。
【核心纪律】
1. 你必须、且只能依靠内置工具(如 bash 的 find/grep,或 read_file)去寻找答案。绝对不允许凭空猜测。
2. 如果你没有找到确切的答案,你必须继续使用工具深入搜索。
3. 当且仅当你找到了确切的线索后,停止调用工具,直接输出一段纯文本作为你的终极汇报。主架构师会根据你的汇报决定下一步。`;

    // 全新纯净上下文:不共享主 Agent 的 Session
    const contextHistory: Message[] = [
      { role: "system", content: subSystemPrompt },
      { role: "user", content: taskPrompt },
    ];

    const maxSubTurns = 10;
    let turnCount = 0;

    for (;;) {
      turnCount++;
      if (turnCount > maxSubTurns) {
        throw new Error(
          `子智能体探索过于深入,超过 ${maxSubTurns} 轮被强制召回,请主 Agent 缩小探索范围或拆分任务。`,
        );
      }

      // 【驾驭底线】子智能体仅能获取传入的只读工具注册表
      const availableTools = readOnlyRegistry.getAvailableTools();

      // Compactor 仍生效(子智能体也可能读大文件触发 OOM)
      const compactedContext = this.compactor
        ? this.compactor.compact(contextHistory)
        : contextHistory;

      // 子任务急速响应:强制关闭慢思考,直接预测行动
      const actionResp = await this.provider.generate(compactedContext, availableTools);
      contextHistory.push(actionResp);

      if (actionResp.content) {
        rep.onMessage(`[Subagent] ${actionResp.content}`);
      }

      // 【核心退出条件】子智能体不调工具了,说明做好了总结汇报
      const toolCalls = actionResp.toolCalls ?? [];
      if (toolCalls.length === 0) {
        console.log(`[Subagent] ✅ 探路者完成 ${turnCount} 轮探索,返回总结。`);
        return actionResp.content;
      }

      // 执行只读工具的并发循环(Fork-Join,复用主循环的并发策略)
      const isReadOnly = readOnlyRegistry.isReadOnlyTool;
      const allReadOnly =
        isReadOnly !== undefined &&
        toolCalls.every((tc) => isReadOnly.call(readOnlyRegistry, tc.name));

      const observations: Message[] = new Array(toolCalls.length);
      const execSubTool = async (toolCall: ToolCall, i: number): Promise<void> => {
        rep.onToolCall(`[Subagent] ${toolCall.name}`, toolCall.arguments);
        const result = await readOnlyRegistry.execute(toolCall);
        let finalOutput = result.output;
        if (result.isError) {
          finalOutput = this.recovery.analyzeAndInject(toolCall.name, result.output);
        }
        rep.onToolResult(`[Subagent] ${toolCall.name}`, finalOutput, result.isError);
        observations[i] = {
          role: "user",
          content: finalOutput,
          toolCallId: toolCall.id,
        };
      };

      if (allReadOnly) {
        await Promise.all(toolCalls.map((tc, i) => execSubTool(tc, i)));
      } else {
        for (let i = 0; i < toolCalls.length; i++) {
          await execSubTool(toolCalls[i]!, i);
        }
      }

      contextHistory.push(...observations);
    }
  }
}

function estimateTraceLength(messages: Message[]): number {
  let length = 0;
  for (const message of messages) {
    length += message.content.length;
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        length += toolCall.name.length + toolCall.arguments.length;
      }
    }
  }
  return length;
}

function recordCompaction(span: Span | undefined, beforeChars: number, afterChars: number): void {
  if (!span || beforeChars === afterChars) {
    return;
  }
  const compactionSpan = span.startChild("Context.Compaction", {
    beforeChars,
    afterChars,
  });
  compactionSpan.end();
}

function recordLlmResponse(span: Span | undefined, response: Message): void {
  span?.addAttributes({
    outputContentLength: response.content.length,
    toolCallCount: response.toolCalls?.length ?? 0,
    promptTokens: response.usage?.promptTokens,
    completionTokens: response.usage?.completionTokens,
  });
}

function recordTraceError(span: Span | undefined, error: unknown): void {
  span?.addAttributes({
    isError: true,
    outputPreview: truncate(error instanceof Error ? error.message : String(error), 500),
  });
}
