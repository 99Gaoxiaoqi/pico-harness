import {
  DEFAULT_SAFETY_MARGIN_TOKENS,
  estimateMessagesTokens,
} from "../../context/context-budget.js";
import { countTokens, primeTokenizer } from "../../context/token-counter.js";
import type { Message, ToolDefinition } from "../../schema/message.js";

export interface MemoryRequestBudgetInput {
  readonly sourceMessages?: readonly Message[];
  /** Only tools actually sent by this stage, after Provider capability filtering. */
  readonly sourceTools?: readonly ToolDefinition[];
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
}

/** Plan the complete auxiliary request before spending its per-range call budget. */
export async function memoryRequestFits(
  input: MemoryRequestBudgetInput,
  prompt: string,
  stage: "proposal" | "localized" | "canonicalize",
): Promise<boolean> {
  const contextWindow = input.contextWindowTokens;
  // Unknown capacity is not evidence of overflow; the Provider remains authoritative.
  if (contextWindow === undefined) return true;
  const outputReserve = input.reservedOutputTokens ?? 4096;
  if (
    !Number.isFinite(contextWindow) ||
    contextWindow <= 0 ||
    !Number.isFinite(outputReserve) ||
    outputReserve < 0
  )
    return false;

  await primeTokenizer();
  const prefix = stage === "canonicalize" ? [] : (input.sourceMessages ?? []);
  const tools = stage === "canonicalize" ? [] : (input.sourceTools ?? []);
  const messages: Message[] = [
    ...prefix,
    { role: prefix.length ? "user" : "system", content: prompt },
  ];
  // Count the serialized catalog, matching capability-preflight's tool accounting.
  const inputTokens =
    estimateMessagesTokens(messages) + (tools.length ? countTokens(JSON.stringify(tools)) : 0);
  return inputTokens + outputReserve + DEFAULT_SAFETY_MARGIN_TOKENS <= contextWindow;
}
