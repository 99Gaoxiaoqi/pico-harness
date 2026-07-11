import { countTokens } from "../context/token-counter.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import { ModelCapabilityError } from "./errors.js";
import type { LLMProvider, LLMProviderRequestOptions } from "./interface.js";
import type { ModelRouteCapabilities } from "./model-capabilities.js";
import type { ThinkingEffort } from "./thinking.js";
import { defaultIsRetryableError } from "./retry.js";

const CONTEXT_SAFETY_MARGIN_TOKENS = 1024;

export interface CapabilityPreflightRequest {
  messages: readonly Message[];
  availableTools: readonly ToolDefinition[];
  thinkingEffort: ThinkingEffort;
}

export interface CapabilityPreflightResult {
  estimatedInputTokens: number;
  reservedOutputTokens: number;
  contextWindowTokens: number;
  remainingTokens: number;
  estimation: "cl100k_or_char_fallback";
}

export function preflightModelRequest(
  routeId: string,
  capabilities: ModelRouteCapabilities,
  request: CapabilityPreflightRequest,
): CapabilityPreflightResult {
  if (
    capabilities.vision === false &&
    request.messages.some((message) => (message.images?.length ?? 0) > 0)
  ) {
    throw new ModelCapabilityError(routeId, "vision", `模型路由 ${routeId} 不支持图像输入。`);
  }
  if (capabilities.toolCall === false && request.availableTools.length > 0) {
    throw new ModelCapabilityError(routeId, "tool_call", `模型路由 ${routeId} 不支持工具调用。`);
  }
  if (capabilities.reasoning === false && request.thinkingEffort !== "off") {
    throw new ModelCapabilityError(
      routeId,
      "reasoning",
      `模型路由 ${routeId} 不支持 reasoning，请将 thinking effort 设为 off。`,
    );
  }

  const estimatedInputTokens = estimateRequestTokens(request.messages, request.availableTools);
  const reservedOutputTokens = capabilities.maxOutputTokens;
  const remainingTokens =
    capabilities.contextWindowTokens -
    estimatedInputTokens -
    reservedOutputTokens -
    CONTEXT_SAFETY_MARGIN_TOKENS;
  if (remainingTokens < 0) {
    throw new ModelCapabilityError(
      routeId,
      "context_window",
      `模型路由 ${routeId} 请求前预检失败：估算输入 ${estimatedInputTokens} tokens + 预留输出 ${reservedOutputTokens} tokens 超过 context ${capabilities.contextWindowTokens} tokens。`,
    );
  }
  return {
    estimatedInputTokens,
    reservedOutputTokens,
    contextWindowTokens: capabilities.contextWindowTokens,
    remainingTokens,
    estimation: "cl100k_or_char_fallback",
  };
}

export class CapabilityPreflightProvider implements LLMProvider {
  constructor(
    private readonly next: LLMProvider,
    private readonly routeId: string,
    private readonly capabilities: ModelRouteCapabilities,
    private readonly thinkingEffort: ThinkingEffort,
  ) {}

  get modelName(): string | undefined {
    return this.next.modelName;
  }

  isRetryableError(error: unknown): boolean {
    if (error instanceof ModelCapabilityError) return false;
    return this.next.isRetryableError?.(error) ?? defaultIsRetryableError(error);
  }

  async generate(
    messages: Message[],
    availableTools: ToolDefinition[],
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    preflightModelRequest(this.routeId, this.capabilities, {
      messages,
      availableTools,
      thinkingEffort: this.thinkingEffort,
    });
    return this.next.generate(messages, availableTools, options);
  }

  async generateStream(
    messages: Message[],
    availableTools: ToolDefinition[],
    onDelta: (delta: string) => void,
    options?: LLMProviderRequestOptions,
  ): Promise<Message> {
    preflightModelRequest(this.routeId, this.capabilities, {
      messages,
      availableTools,
      thinkingEffort: this.thinkingEffort,
    });
    return this.next.generateStream
      ? this.next.generateStream(messages, availableTools, onDelta, options)
      : this.next.generate(messages, availableTools, options);
  }
}

function estimateRequestTokens(
  messages: readonly Message[],
  availableTools: readonly ToolDefinition[],
): number {
  let total = 0;
  for (const message of messages) {
    total += countTokens(message.content);
    for (const toolCall of message.toolCalls ?? []) {
      total += countTokens(toolCall.name) + countTokens(toolCall.arguments);
    }
  }
  if (availableTools.length > 0) total += countTokens(JSON.stringify(availableTools));
  return total;
}
