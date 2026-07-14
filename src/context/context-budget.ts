import type { ProviderProfile } from "../provider/profile.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import { countTokens } from "./token-counter.js";

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;
/**
 * 字符→token 反向换算用的经验值。仅在 Compactor 的"token 预算 → 字符水位线"
 * 换算时使用(Compactor 仍以字符为压缩水位单位,保持其内部逻辑稳定);
 * 正向 token 估算已改用精确 BPE 计数(countTokens)。
 */
export const CHARS_PER_TOKEN = 4;

export interface ContextBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

export function estimateMessageTokens(msg: Message): number {
  let text = msg.content;
  for (const toolCall of msg.toolCalls ?? []) {
    text += toolCall.name + toolCall.arguments;
  }
  return countTokens(text);
}

export function estimateMessagesTokens(messages: readonly Message[]): number {
  return messages.reduce((sum, msg) => sum + estimateMessageTokens(msg), 0);
}

export function estimateToolDefinitionsTokens(tools: readonly ToolDefinition[]): number {
  return tools.reduce(
    (sum, tool) => sum + countTokens(tool.name + tool.description + JSON.stringify(tool.inputSchema)),
    0,
  );
}

export function estimateModelInputTokens(
  messages: readonly Message[],
  tools: readonly ToolDefinition[],
): number {
  return estimateMessagesTokens(messages) + estimateToolDefinitionsTokens(tools);
}

/**
 * 把 token 预算换算成字符水位线(供 Compactor 的字符级压缩用)。
 * 注意:这是反向近似,用经验 chars/token;正向估算请用 estimateMessagesTokens。
 * 保留字符水位线是为了不改动 Compactor 内部的字符比较逻辑。
 */
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
