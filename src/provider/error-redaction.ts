import type { LLMProvider, LLMProviderRequestOptions } from "./interface.js";
import type { Message, ToolDefinition } from "../schema/message.js";

const REDACTED = "[REDACTED]";

/**
 * Provider 响应可能回显请求凭证。这里在错误离开网络适配层前统一脱敏，
 * 避免 retry、tracker、Cron ledger 或终端日志持久化明文 secret。
 */
export function redactProviderErrorText(value: string, secrets: readonly string[]): string {
  let redacted = value;
  for (const secret of secrets) {
    if (secret) redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s,;"'}]+/giu, `$1${REDACTED}`)
    .replace(
      /((?:x-api-key|api[_-]?key|token|secret|password)\s*[:=]\s*["']?)[^\s,;"'}]+/giu,
      `$1${REDACTED}`,
    )
    .replace(/([?&](?:key|api[_-]?key|access_token)=)[^&#\s]+/giu, `$1${REDACTED}`);
}

export function redactProviderError(error: unknown, secrets: readonly string[]): unknown {
  if (error instanceof Error) {
    const message = redactProviderErrorText(error.message, secrets);
    const stack = error.stack ? redactProviderErrorText(error.stack, secrets) : undefined;
    if (message !== error.message) {
      Object.defineProperty(error, "message", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: message,
      });
    }
    if (stack && stack !== error.stack) {
      Object.defineProperty(error, "stack", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: stack,
      });
    }
    return error;
  }
  if (typeof error === "string") return new Error(redactProviderErrorText(error, secrets));
  return error;
}

/** 保留 Provider 的重试判定和模型元数据，只收紧错误出口。 */
export function withProviderErrorRedaction(
  provider: LLMProvider,
  secrets: readonly string[],
): LLMProvider {
  const wrapped: LLMProvider = {
    ...(provider.modelName !== undefined ? { modelName: provider.modelName } : {}),
    generate: async (
      messages: Message[],
      availableTools: ToolDefinition[],
      options?: LLMProviderRequestOptions,
    ) => {
      try {
        return await provider.generate(messages, availableTools, options);
      } catch (error) {
        throw redactProviderError(error, secrets);
      }
    },
  };
  if (provider.isRetryableError) {
    wrapped.isRetryableError = (error) => provider.isRetryableError?.(error) ?? false;
  }
  const generateStream = provider.generateStream?.bind(provider);
  if (generateStream) {
    wrapped.generateStream = async (messages, availableTools, onDelta, options) => {
      try {
        return await generateStream(messages, availableTools, onDelta, options);
      } catch (error) {
        throw redactProviderError(error, secrets);
      }
    };
  }
  return wrapped;
}
