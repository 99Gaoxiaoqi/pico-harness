import type { LLMProvider, LLMProviderRequestOptions } from "../provider/interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import type { Reporter } from "./reporter.js";
/**
 * 为单次运行构造绑定 Reporter 的流式 Provider 视图。
 *
 * Reporter 是调用级状态，不能存在 AgentEngine 的可变字段上：同一 Engine
 * 可能并行运行多个子代理，共享 reporter 会把 child delta 泄漏到主流或
 * 另一个 child。这个包装器每次 generate 都闭包当前调用的 sink，无全局可变状态。
 */
export function providerForReporter(
  provider: LLMProvider,
  reporter: Reporter,
  signal?: AbortSignal,
): LLMProvider {
  const generateStreamFn = provider.generateStream;
  if (!generateStreamFn) return provider;
  return {
    generate: (msgs: Message[], tools: ToolDefinition[], options?: LLMProviderRequestOptions) =>
      generateStreamFn.call(
        provider,
        msgs,
        tools,
        (delta: string) => {
          if (!signal?.aborted) reporter.onTextDelta?.(delta);
        },
        {
          ...options,
          onReasoningDelta: (delta: string) => {
            if (!signal?.aborted) reporter.onReasoningDelta?.(delta);
            options?.onReasoningDelta?.(delta);
          },
        },
      ),
    get modelName() {
      return provider.modelName;
    },
    get requestCapabilities() {
      return provider.requestCapabilities;
    },
    ...(provider.isRetryableError
      ? { isRetryableError: provider.isRetryableError.bind(provider) }
      : {}),
    generateStream: generateStreamFn.bind(provider),
  };
}
