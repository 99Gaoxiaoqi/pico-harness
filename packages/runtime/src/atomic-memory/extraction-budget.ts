import { DEFAULT_SAFETY_MARGIN_TOKENS } from "../context-budget.js";
import { estimateRequestTokens } from "../capability-preflight.js";
import { primeTokenizer } from "../token-counter.js";
import type { Message, ToolDefinition } from "@pico/core";

export interface MemoryRequestBudgetInput {
  readonly sourceMessages?: readonly Message[];
  /** Only tools actually sent by this stage, after Provider capability filtering. */
  readonly sourceTools?: readonly ToolDefinition[];
  readonly contextWindowTokens?: number;
  readonly reservedOutputTokens?: number;
}

/** Keep source positions stable; even isolated requests need an ordinary user message. */
export function buildMemoryRequestMessages(
  input: MemoryRequestBudgetInput,
  prompt: string,
  stage: "proposal" | "localized" | "canonicalize",
): Message[] {
  const prefix = stage === "canonicalize" ? [] : (input.sourceMessages ?? []);
  return prefix.length
    ? [...prefix, { role: "user", content: prompt }]
    : [
        { role: "system", content: prompt },
        {
          role: "user",
          content: "Follow the instructions above and return the requested JSON only.",
        },
      ];
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
  const tools = stage === "canonicalize" ? [] : (input.sourceTools ?? []);
  const messages = buildMemoryRequestMessages(input, prompt, stage);
  // Match the preflight check for the request that ProviderAtomicMemoryModel sends.
  const inputTokens = estimateRequestTokens(messages, tools);
  return inputTokens + outputReserve + DEFAULT_SAFETY_MARGIN_TOKENS <= contextWindow;
}
