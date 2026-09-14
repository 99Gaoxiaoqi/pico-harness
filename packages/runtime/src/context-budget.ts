import type { Message, ProviderProfile, ToolDefinition } from "@pico/core";
import { countTokens } from "./token-counter.js";

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;
/** Conservative character-to-token conversion used only for character-watermark compaction. */
export const CHARS_PER_TOKEN = 1.5;

export interface ContextBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

export function estimateMessageTokens(message: Message): number {
  let text = message.content + (message.reasoning ?? "");
  for (const toolCall of message.toolCalls ?? []) {
    text += toolCall.name + toolCall.arguments;
  }
  return countTokens(text);
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
}

export function estimateToolDefinitionsTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce(
    (sum, tool) =>
      sum + countTokens(tool.name + tool.description + JSON.stringify(tool.inputSchema)),
    0,
  );
}

export function estimateModelInputTokens(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
): number {
  return estimateMessagesTokens(messages) + estimateToolDefinitionsTokens(tools);
}

/** Converts a token budget to the existing character-level Compactor watermark. */
export function estimateTokenBudgetAsChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
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
