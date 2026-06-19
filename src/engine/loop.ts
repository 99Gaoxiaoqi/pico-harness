// 核心心脏:Agent 的 Main Loop (ReAct 循环)。
// 对应课程第 02 讲 internal/engine/loop.go。
//
// 驾驭工程的极简之美:loop.ts 根本不关心 bash 怎么运行、Claude 的 HTTP 请求怎么发,
// 它只负责维护这根脆弱但重要的"上下文时间线" (contextHistory)。
// 它像一个忠实的书记员,严格执行 ReAct 范式:
// 把模型的意图 (ToolCall) 交给执行层,再把物理世界的反馈 (Observation) 追加回内存。

import type { LLMProvider } from "../provider/interface.js";
import type { Message } from "../schema/message.js";
import type { Registry } from "../tools/registry.js";

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
   * 简单任务可关闭以节省 Token;复杂代码任务建议开启。
   */
  enableThinking?: boolean;
  /** 可选的轮次日志回调,便于第 19 讲 Tracing 接入 */
  onTurn?: (info: { turn: number; message: Message }) => void;
}

/** 微型 OS 的核心驱动 */
export class AgentEngine {
  private readonly provider: LLMProvider;
  private readonly registry: Registry;
  private readonly workDir: string;
  private readonly systemPrompt: string;
  private readonly enableThinking: boolean;
  private readonly onTurn?: (info: { turn: number; message: Message }) => void;

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
  }

  /** 启动 Agent 的生命周期 */
  async run(userPrompt: string): Promise<Message[]> {
    console.log(`[Engine] 引擎启动,锁定工作区: ${this.workDir}`);
    console.log(`[Engine] 慢思考模式 (Thinking Phase): ${this.enableThinking}`);

    // 1. 初始化会话的 Context (上下文内存)
    const contextHistory: Message[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: userPrompt },
    ];

    let turnCount = 0;

    // 2. The Main Loop:心跳开始 (Two-Stage ReAct 循环)
    for (;;) {
      turnCount++;
      console.log(`\n========== [Turn ${turnCount}] 开始 ==========`);

      // 获取当前挂载的所有工具定义
      const availableTools = this.registry.getAvailableTools();

      // ====================================================================
      // Phase 1: 慢思考阶段 (Thinking) —— 剥夺工具,强制规划 (第 03 讲)
      // ====================================================================
      if (this.enableThinking) {
        console.log("[Engine][Phase 1] 剥夺工具访问权,强制进入慢思考与规划阶段...");

        // 核心机制:传入空的 tools 数组!
        // 大模型看不到任何 JSON Schema,被迫只能输出纯文本的思考过程。
        const thinkResp = await this.provider.generate(contextHistory, []);

        if (thinkResp.content) {
          console.log(`🧠 [内部思考 Trace]: ${thinkResp.content}`);
          // 将思考过程作为 assistant 消息追加到上下文
          contextHistory.push(thinkResp);
        }
      }

      // ====================================================================
      // Phase 2: 行动阶段 (Action) —— 恢复工具,顺着规划执行
      // ====================================================================
      console.log("[Engine][Phase 2] 恢复工具挂载,等待模型采取行动...");

      // 此时 contextHistory 已包含 Phase 1 模型自己的 Thinking Trace。
      // 自回归特性:模型看到自己刚才的规划,会顺理成章生成对应的工具调用,
      // 大幅降低瞎调工具的概率。
      const responseMsg = await this.provider.generate(contextHistory, availableTools);

      // 将模型的响应完整追加到上下文历史中
      contextHistory.push(responseMsg);
      this.onTurn?.({ turn: turnCount, message: responseMsg });

      // 模型回复纯文本时打印 (通常是思考过程或最终结果)
      if (responseMsg.content) {
        console.log(`🤖 [对外回复]: ${responseMsg.content}`);
      }

      // 3. 退出条件:模型没有请求任何工具调用,说明任务完成
      const toolCalls = responseMsg.toolCalls ?? [];
      if (toolCalls.length === 0) {
        console.log("[Engine] 模型未请求调用工具,任务宣告完成。");
        break;
      }

      // 4. 执行行动 (Action) 与 获取观察结果 (Observation)
      console.log(`[Engine] 模型请求调用 ${toolCalls.length} 个工具...`);

      // 注意:第 08 讲会把这里改成并行执行;第 02/03 讲先保持顺序,贴合课程原始实现。
      for (const toolCall of toolCalls) {
        console.log(`    -> 🛠️ 执行工具: ${toolCall.name}, 参数: ${toolCall.arguments}`);

        const result = await this.registry.execute(toolCall);

        if (result.isError) {
          console.log(`    -> ❌ 工具执行报错: ${result.output}`);
        } else {
          console.log(`    -> ✅ 工具执行成功 (返回 ${result.output.length} 字节)`);
        }

        // 将观察结果封装为 User Message 追加到上下文
        // ToolCallId 必须携带!这是维系大模型推理链条的关键
        contextHistory.push({
          role: "user",
          content: result.output,
          toolCallId: toolCall.id,
        });
      }

      // 循环回到开头,模型带着新加入的 Observation 继续下一轮思考...
    }

    return contextHistory;
  }
}
