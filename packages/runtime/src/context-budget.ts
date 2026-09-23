import type { Message, ProviderProfile, ToolDefinition } from "@pico/core";

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;
/** Maka character-based context diagnostic estimate. */
export const CHARS_PER_TOKEN = 4;
export const MATERIALIZED_IMAGE_TOKENS = 2_000;
export const CONTEXT_ESTIMATION_ALGORITHM = "chars_v1" as const;

export interface ContextBudget {
  contextWindowTokens: number;
  /** User-declared proactive target; absent means provider-driven overflow recovery only. */
  declaredContextWindowTokens?: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

function messageChars(message: Message): number {
  let chars = message.content.length + (message.reasoning?.length ?? 0);
  for (const call of message.toolCalls ?? []) chars += call.name.length + call.arguments.length;
  return chars;
}

export function estimateMessageTokens(message: Message): number {
  return estimateMessagesTokens([message]);
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  const names = new Map<string, string>();
  let chars = 0;
  for (const message of messages) {
    chars += messageChars(message);
    for (const call of message.toolCalls ?? []) names.set(call.id, call.name);
    if (message.toolCallId) chars += names.get(message.toolCallId)?.length ?? 0;
  }
  // User attachments are accounted by request composition. This diagnostic mirrors
  // Maka's effective history estimator, which counts materialized tool images only.
  const images = messages.reduce(
    (total, message) => total + (message.toolCallId ? (message.images?.length ?? 0) : 0),
    0,
  );
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
): number {
  return estimateMessagesTokens(messages) + estimateToolDefinitionsTokens(tools);
}

export function createContextBudget(
  profile: ProviderProfile,
  options: { reservedOutputTokens?: number; safetyMarginTokens?: number } = {},
): ContextBudget {
  const reservedOutputTokens = options.reservedOutputTokens ?? profile.maxOutputTokens;
  const safetyMarginTokens = options.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
  return {
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
  return estimateMessagesTokens(messages) <= budget.inputBudgetTokens;
}
