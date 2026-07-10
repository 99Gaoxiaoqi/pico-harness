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

import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { Session } from "../engine/session.js";
import { estimateCost, type BillingRoute } from "./pricing.js";
import { logger } from "./logger.js";

/**
 * CostTracker:包装了真实 LLMProvider 的装饰器中间件。
 *
 * 实现了 LLMProvider 接口,可被无缝注入 Main Loop(Engine 毫不知情)。
 * 像安检门:数据必须先经过它,它盖上"时间戳"和"成本戳",再原封不动还给你。
 */
export class CostTracker implements LLMProvider {
  constructor(
    private readonly next: LLMProvider,
    private readonly modelRoute: string | BillingRoute,
    private readonly session?: Session,
  ) {}

  /** 暴露模型名供重试/日志打点;计费路由可能是 BillingRoute 对象,取其 model 字段。 */
  get modelName(): string {
    return typeof this.modelRoute === "string" ? this.modelRoute : this.modelRoute.model;
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    const start = Date.now();
    const resp = await this.next.generate(messages, availableTools, options);
    const latencyMs = Date.now() - start;

    if (resp.usage) {
      const { promptTokens, completionTokens } = resp.usage;
      const cost = estimateCost(this.modelRoute, resp.usage);
      logger.info(
        {
          latencyMs,
          promptTokens,
          completionTokens,
          cacheRead: cost.usage.cacheReadTokens,
          cacheWrite: cost.usage.cacheWriteTokens,
          reasoning: cost.usage.reasoningTokens,
          costStatus: cost.status,
          costCNY: cost.costCNY,
        },
        "[Tracker] API 完成",
      );
      if (this.session) {
        this.session.recordUsage(
          promptTokens,
          completionTokens,
          cost.costCNY,
          cost.usage,
          cost.status,
        );
        logger.info(
          {
            sessionId: this.session.id,
            totalPromptTokens: this.session.totalPromptTokens,
            totalCompletionTokens: this.session.totalCompletionTokens,
            totalCostCNY: this.session.totalCostCNY,
          },
          "[Tracker] 会话累计",
        );
      }
    } else {
      logger.warn({ latencyMs }, "[Tracker] API 完成但无 Usage 数据");
    }
    return resp;
  }

  /** 转发流式生成（透传 onDelta，同时用 generate 的成本追踪逻辑） */
  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    // 内部 provider 不支持流式时，降级到非流式 generate
    if (!this.next.generateStream) {
      return this.generate(messages, availableTools, options);
    }

    const start = Date.now();
    const resp = await this.next.generateStream(messages, availableTools, onDelta, options);
    const latencyMs = Date.now() - start;

    if (resp.usage) {
      const cost = estimateCost(this.modelRoute, resp.usage);
      if (this.session) {
        this.session.recordUsage(
          resp.usage.promptTokens,
          resp.usage.completionTokens,
          cost.costCNY,
          cost.usage,
          cost.status,
        );
      }
      logger.info({ latencyMs, costCNY: cost.costCNY }, "[Tracker] 流式 API 完成");
    }
    return resp;
  }
}
