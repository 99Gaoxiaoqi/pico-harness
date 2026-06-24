import type { ProviderProfile } from "../provider/profile.js";
import type { Message } from "../schema/message.js";

const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;
const CHARS_PER_TOKEN = 4;

export interface ContextBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

export function estimateMessageTokens(msg: Message): number {
  let chars = msg.content.length;
  for (const toolCall of msg.toolCalls ?? []) {
    chars += toolCall.name.length + toolCall.arguments.length;
  }
  return Math.max(1, Math.ceil(chars / CHARS_PER_TOKEN));
}

export function estimateMessagesTokens(messages: Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export function estimateTokenBudgetAsChars(tokens: number): number {
  return Math.max(0, Math.floor(tokens * CHARS_PER_TOKEN));
}

export function createContextBudget(
  profile: ProviderProfile,
  opts: { reservedOutputTokens?: number; safetyMarginTokens?: number } = {},
): ContextBudget {
  const reservedOutputTokens = opts.reservedOutputTokens ?? profile.maxOutputTokens;
  const safetyMarginTokens = opts.safetyMarginTokens ?? DEFAULT_SAFETY_MARGIN_TOKENS;
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

export function isWithinContextBudget(messages: Message[], budget: ContextBudget): boolean {
  return estimateMessagesTokens(messages) <= budget.inputBudgetTokens;
}
