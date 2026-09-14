import type {
  LLMProvider,
  LLMProviderRequestOptions,
  Message,
  ProviderStreamReporter,
  ToolDefinition,
} from "@pico/core";

/**
 * 为单次运行构造绑定输出端口的流式 Provider 视图。
 *
 * 输出端口是调用级状态，不能存在共享 Provider 的可变字段上：同一运行时可并行执行
 * 子代理，每个包装器都只闭包其当前调用的 sink。
 */
export function providerForReporter(
  provider: LLMProvider,
  reporter: ProviderStreamReporter,
  signal?: AbortSignal,
): LLMProvider {
  const generateStreamFn = provider.generateStream;
  if (!generateStreamFn) return provider;
  const reported: LLMProvider = {
    generate: (messages: Message[], tools: ToolDefinition[], options?: LLMProviderRequestOptions) =>
      generateStreamFn.call(
        provider,
        messages,
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
    ...(provider.isRetryableError
      ? { isRetryableError: provider.isRetryableError.bind(provider) }
      : {}),
    generateStream: generateStreamFn.bind(provider),
  };
  // Preserve optional metadata as live accessors without materializing an `undefined` optional
  // field (the package boundary enables exactOptionalPropertyTypes).
  Object.defineProperties(reported, {
    modelName: { enumerable: true, get: () => provider.modelName },
    requestCapabilities: { enumerable: true, get: () => provider.requestCapabilities },
  });
  return reported;
}
