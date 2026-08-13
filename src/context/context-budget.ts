import type { ProviderProfile } from "../provider/profile.js";
import type { Message, ToolDefinition } from "../schema/message.js";
import { countTokens } from "./token-counter.js";

export const DEFAULT_SAFETY_MARGIN_TOKENS = 1024;
/**
 * 字符→token 反向换算用的经验值。仅在 Compactor 的"token 预算 → 字符水位线"
 * 换算时使用(Compactor 仍以字符为压缩水位单位,保持其内部逻辑稳定);
 * 正向 token 估算已改用精确 BPE 计数(countTokens)。
 *
 * ctx-2: 取值 4 是纯英文经验(1 token ≈ 4 chars),对中文严重失真——
 * 中文 1 字 ≈ 1-2 token(即 1 token ≈ 0.5-1 char),用 4 会把 token 预算换算成
 * 4-8 倍过大的字符水位线,中文内容远超 token 窗口仍不触发压缩。
 * 降到 1.5 是对中文更安全的保守值(对纯英文略偏紧、会稍早压缩,但杜绝 OOM 风险);
 * 子代理首轮压缩另在 compactSubContext 用 BPE token 维度做自适应校正
 * (按实际内容密度反推字符预算),故英文内容在该路径不会被此常数的量级误伤。
 */
export const CHARS_PER_TOKEN = 1.5;

export interface ContextBudget {
  contextWindowTokens: number;
  reservedOutputTokens: number;
  safetyMarginTokens: number;
  inputBudgetTokens: number;
}

export function estimateMessageTokens(msg: Message): number {
  // ctx-1: OpenAI provider 序列化 assistant 消息时透传 msg.reasoning 为 reasoning_content
  // (见 openai.ts)。推理模型(deepseek-v4-pro 等)每轮 reasoning 可达 1k-5k token,
  // 此前未计入预算,导致水位(85%)触发延迟,直到 provider overflow 才紧急压缩。
  // 这里把 reasoning 并入 text 一起喂给 countTokens(toolCalls 累加逻辑保持不变)。
  let text = msg.content + (msg.reasoning ?? "");
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
