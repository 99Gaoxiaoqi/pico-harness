// 大模型通信的统一契约 (Provider 接口)。
// 对应课程第 02 讲 internal/provider/interface.go。
// 第 04 讲会提供 Claude 与 OpenAI 兼容的两套实现;第 02 讲先用 Mock 验证 Loop。

import type { Message, ToolDefinition } from "../schema/message.js";

export const DEFAULT_PROVIDER_TIMEOUT_MS = 120_000;

export interface LLMProviderRequestOptions {
  /** 宿主中止信号。Provider 应将它与自身超时合并后传给网络请求。 */
  signal?: AbortSignal;
  /** 仅供已校验的宿主覆盖单次 Provider 硬超时；普通调用保持 120 秒默认值。 */
  timeoutMs?: number;
  /**
   * 禁止本次响应调用工具。支持该语义的 Provider 可保留工具 Schema，
   * 不支持的 Provider 必须由调用方通过 requestCapabilities 能力门控后传空工具集。
   */
  toolChoice?: "none";
  /**
   * Stable, opaque conversation digest used only to choose a configured prompt-cache key shard.
   * Callers must never pass raw prompt text, credentials, or a random Session ID here.
   */
  promptCacheShardSeed?: string;
  /** Route traffic threshold decision, fixed for one logical call and all of its retries. */
  promptCacheShardActive?: boolean;
  /** 仅供显式 Claude 预热请求；Provider 不得把它传播为未知 wire 字段。 */
  promptCachePrewarm?: boolean;
  /** 请求用途，供计费、审计与可观测层区分普通 Agent、预热与 Hook 判定。 */
  purpose?: "hook" | "prewarm";
  /** Provider 返回可展示的 reasoning/thinking 增量时调用；不得混入最终回答正文。 */
  onReasoningDelta?: (delta: string) => void;
  /**
   * Provider 完成协议翻译、即将序列化请求体时触发。
   *
   * 仅供 Harness 可观测层生成无明文的请求指纹；不得传入 headers、URL query
   * 或凭证，也不得在回调中修改 body。
   */
  onRequestPrepared?: (request: PreparedProviderRequest) => void;
}

/** 已完成协议翻译、但尚未发送的无凭证 Provider 请求体。 */
export interface PreparedProviderRequest {
  provider: "claude" | "openai";
  model: string;
  body: Readonly<Record<string, unknown>>;
}

/** Provider 对请求级协议选项的显式支持；未声明一律按不支持处理。 */
export interface LLMProviderRequestCapabilities {
  /** 能否在保留工具 Schema 的同时，通过 wire 参数可靠禁止工具调用。 */
  readonly toolChoiceNoneWithTools: boolean;
  /** Secret-free route identity used for route-scoped prompt-cache traffic accounting. */
  readonly promptCacheRouteIdentity?: string;
  /** Record one logical route request and decide whether key sharding is active for it. */
  readonly preparePromptCacheSharding?: () => boolean;
}

/**
 * 合并宿主中止与 Provider 硬超时，任一触发即取消请求。
 *
 * 已知缺陷(A-P1.3):此处 timeoutMs 是纯 wall-clock 整体超时,从请求发出开始计。
 * 流式场景下,长输出(推理模型长思考链、大代码生成)即使每秒都在稳定产 token,
 * 只要累计超过 120s 就会被确定性截断。更合理的是 idle/progress timeout(每次两个
 * chunk 之间不超过 N 秒才超时),但那需要重做 generateStream 的局部 fullContent 保留
 * 逻辑(目前 throw 时已显示的 token 不落盘),改动较大,暂保留 wall-clock 行为。
 * TODO: 流式应改 idle/progress timeout + 部分响应保留,避免长流式被硬墙截断。
 */
export function providerRequestSignal(
  signal?: AbortSignal,
  timeoutMs: number = DEFAULT_PROVIDER_TIMEOUT_MS,
): AbortSignal {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("Provider request timeout must be a positive integer");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 与大模型通信的统一契约 */
export interface LLMProvider {
  /**
   * 接收当前上下文历史与可用工具列表,发起一次大模型推理。
   * @returns 模型的响应消息 (可能含 toolCalls,也可能只有纯文本最终答案)
   */
  generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message>;
  /** 可选:provider 自治判定哪些错误可重试。未实现则由 retry 层用默认兜底判定。 */
  isRetryableError?(error: unknown): boolean;
  /** 可选:模型名,供重试 / 计费日志打点。 */
  readonly modelName?: string;
  /** 可选:请求级协议能力；装饰器必须透明转发，未声明时调用方安全降级。 */
  readonly requestCapabilities?: LLMProviderRequestCapabilities;
  /**
   * 可选:流式生成。与非流式 generate 行为一致,但每收到一段文本就调 onDelta 回调。
   * 如果 Provider 未实现此方法,loop.ts 自动降级到非流式 generate。
   * @returns 最终的完整 Message(和 generate 一样,含 toolCalls + usage)
   */
  generateStream?(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message>;
}
