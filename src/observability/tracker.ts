// 成本与耗时追踪:Harness 层无侵入式拦截大模型 Token 消耗与执行耗时。
//
// 解决痛点:Agent 部署到生产,月底老板拿着几万元账单质问"哪个任务消耗最多 Token"。
// 传统开发在每次 API 请求前后手动写计时代码,侵入性太强 —— 10 个地方调 Generate
// (含 Subagent)就得复制 10 次。
//
// 驾驭工程追求对上层业务绝对透明:用装饰器模式(Decorator)实现一个"假"的
// LLMProvider,内部包裹"真"的 Provider。Main Loop 根本不知道自己被监控了,
// 所有 Token 和耗时数据在 Tracker 中被截获记录。类似 AOP 面向切面编程。
//
// 算明经济账是落地的关键:衡量 Agent 优秀与否除看代码能否跑通,更看 Token 效率。
// 不把成本监控落到实处,就无法优化 System Prompt 长度,也无从判断上下文压缩是否省钱。

import type { LLMProvider } from "../provider/interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { Session } from "../engine/session.js";

/** 模型计费表(美元/1M Tokens) */
const PRICING: Record<string, { input: number; output: number }> = {
  "glm-5.2": { input: 0.5, output: 0.5 },
  "glm-4.5-air": { input: 0.15, output: 0.15 },
  "claude-3-5-sonnet": { input: 3.0, output: 15.0 },
  // 默认兜底价
};

const USD_TO_CNY = 7.2;

/**
 * CostTracker:包装了真实 LLMProvider 的装饰器中间件。
 *
 * 实现了 LLMProvider 接口,可被无缝注入 Main Loop(Engine 毫不知情)。
 * 像安检门:数据必须先经过它,它盖上"时间戳"和"成本戳",再原封不动还给你。
 */
export class CostTracker implements LLMProvider {
  constructor(
    private readonly next: LLMProvider,
    private readonly modelName: string,
    private readonly session?: Session,
  ) {}

  async generate(messages: Message[], availableTools: ToolDefinition[]): Promise<Message> {
    const start = Date.now();
    const resp = await this.next.generate(messages, availableTools);
    const latencyMs = Date.now() - start;

    if (resp.usage) {
      const { promptTokens, completionTokens } = resp.usage;
      const price = PRICING[this.modelName] ?? { input: 0.5, output: 0.5 };
      const costUSD =
        (promptTokens * price.input + completionTokens * price.output) / 1_000_000;
      const costCNY = costUSD * USD_TO_CNY;
      console.log(
        `[Tracker] 📊 API 完成 | 耗时: ${latencyMs}ms | 输入: ${promptTokens} tk | 输出: ${completionTokens} tk | 花费: ¥${costCNY.toFixed(6)}`,
      );
      if (this.session) {
        this.session.recordUsage(promptTokens, completionTokens, costCNY);
        console.log(
          `[Tracker] 💰 会话 (${this.session.id}) 累计: 输入 ${this.session.totalPromptTokens} tk | 输出 ${this.session.totalCompletionTokens} tk | ¥${this.session.totalCostCNY.toFixed(6)}`,
        );
      }
    } else {
      console.log(`[Tracker] ⚠ API 完成但无 Usage 数据 | 耗时: ${latencyMs}ms`);
    }
    return resp;
  }
}
