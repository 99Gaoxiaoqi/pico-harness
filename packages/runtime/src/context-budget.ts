import { projectMediaTextForModel } from "@pico/core/media";
import type { Message, ProviderProfile, ProviderProtocol, ToolDefinition } from "@pico/core";

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;
/** Character-based context diagnostic estimate. */
export const CHARS_PER_TOKEN = 4;
export const MATERIALIZED_IMAGE_TOKENS = 2_000;
export const CONTEXT_ESTIMATION_ALGORITHM = "chars_v1" as const;

export interface ContextBudget {
  protocol?: ProviderProtocol | undefined;
  contextWindowTokens: number;
  /** User-declared proactive target; absent means provider-driven overflow recovery only. */
  declaredContextWindowTokens?: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

const rawChars = (value: unknown) => (typeof value === "string" ? value.length : 0);
const textChars = (value: unknown) =>
  typeof value === "string" ? projectMediaTextForModel(value).length : 0;
const jsonChars = (value: unknown) => rawChars(JSON.stringify(value));

/** Count canonical SDK replay parts once; opaque provider metadata is not visible text. */
function savedReplayChars(message: Message, protocol?: ProviderProtocol): number | undefined {
  if (message.role !== "assistant") return undefined;
  const saved = record(message.providerData?.picoAiSdk);
  if (
    !saved ||
    protocol === undefined ||
    saved.wire !== protocol ||
    !Array.isArray(saved.content) ||
    !Array.isArray(saved.toolResults) ||
    saved.projection !==
      JSON.stringify([
        message.content,
        message.reasoning ?? "",
        message.toolCalls ?? [],
        message.images ?? [],
      ])
  )
    return undefined;
  const searchActions = new Map<unknown, unknown>();
  if (saved.wire === "responses") {
    for (const value of saved.content) {
      const part = record(value);
      const item = record(record(record(part?.providerOptions)?.openai)?.picoWebSearchItem);
      if (
        part?.type === "tool-call" &&
        part.providerExecuted === true &&
        part.toolName === "web_search" &&
        item?.type === "web_search_call" &&
        item.id === part.toolCallId
      )
        searchActions.set(part.toolCallId, item.action);
    }
  }
  let chars = 0;
  for (const [index, value] of [...saved.content, ...saved.toolResults].entries()) {
    const part = record(value);
    if (part?.type === "text") chars += textChars(part.text);
    else if (part?.type === "reasoning") chars += rawChars(part.text);
    else if (part?.type === "tool-call") {
      chars +=
        rawChars(part.toolName) +
        jsonChars(
          searchActions.has(part.toolCallId) ? searchActions.get(part.toolCallId) : part.input,
        );
    } else if (part?.type === "tool-result" && !searchActions.has(part.toolCallId)) {
      const output = record(part.output);
      chars += rawChars(part.toolName);
      if (output?.type === "text" || output?.type === "error-text")
        chars +=
          index >= saved.content.length && output.type === "text"
            ? textChars(output.value)
            : rawChars(output.value);
      else if (output?.type === "json" || output?.type === "error-json")
        chars += jsonChars(output.value);
    }
  }
  return chars;
}

function messageChars(message: Message, protocol?: ProviderProtocol): number {
  const replayChars = savedReplayChars(message, protocol);
  if (replayChars !== undefined) return replayChars;
  let chars =
    projectMediaTextForModel(message.content).length +
    (protocol === "claude" ? 0 : (message.reasoning?.length ?? 0));
  for (const call of message.toolCalls ?? []) chars += call.name.length + call.arguments.length;
  return chars;
}

export function estimateMessageTokens(message: Message, protocol?: ProviderProtocol): number {
  return estimateMessagesTokens([message], protocol);
}

export function estimateMessagesTokens(
  messages: readonly Message[],
  protocol?: ProviderProtocol,
): number {
  const names = new Map<string, string>();
  let chars = 0;
  for (const message of messages) {
    chars += messageChars(message, protocol);
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    if (message.toolCallId) chars += names.get(message.toolCallId)?.length ?? 0;
  }
  // Durable image references still materialize pixels and consume model context.
  const images = messages.reduce((total, message) => total + (message.images?.length ?? 0), 0);
  return Math.ceil(chars / CHARS_PER_TOKEN) + images * MATERIALIZED_IMAGE_TOKENS;
}

export function estimateToolDefinitionsTokens(tools: readonly ToolDefinition[]): number {
  return Math.ceil(
    tools.reduce(
      (sum, tool) =>
        sum + tool.name.length + tool.description.length + JSON.stringify(tool.inputSchema).length,
      0,
    ) / CHARS_PER_TOKEN,
  );
}

export function estimateModelInputTokens(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
  protocol?: ProviderProtocol,
): number {
  return estimateMessagesTokens(messages, protocol) + estimateToolDefinitionsTokens(tools);
}

export function createContextBudget(
  profile: ProviderProfile,
  options: { reservedOutputTokens?: number; safetyMarginTokens?: number } = {},
): ContextBudget {
  const reservedOutputTokens = options.reservedOutputTokens ?? profile.maxOutputTokens;
  const safetyMarginTokens = options.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  return {
    protocol: profile.protocol,
    contextWindowTokens: profile.contextWindowTokens,
    reservedOutputTokens,
    safetyMarginTokens,
    inputBudgetTokens: Math.max(
      0,
      profile.contextWindowTokens - reservedOutputTokens - safetyMarginTokens,
    ),
  };
}

export function isWithinContextBudget(
  messages: readonly Message[],
  budget: ContextBudget,
): boolean {
  return estimateMessagesTokens(messages, budget.protocol) <= budget.inputBudgetTokens;
}
