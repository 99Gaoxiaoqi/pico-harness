import { createHash } from "node:crypto";
import { countTokens } from "../context/token-counter.js";
import type { RuntimeToolResultProjection } from "../engine/tool-result-contract.js";
import type { ToolCall, ToolResult } from "../schema/message.js";
import { summarizeToolResult } from "./result-summarizer.js";

const DEFAULT_SUMMARY_MAX_CHARS = 3000;
const DEFAULT_RUNTIME_PROJECTION_THRESHOLD_TOKENS = 2048;
const BOUNDED_READBACK_TOOLS = new Set(["read_evidence"]);

export type { RuntimeToolResultProjection } from "../engine/tool-result-contract.js";

export interface RuntimeToolResultProjectionResult {
  readonly shouldArchive: boolean;
  readonly rawSha256: string;
  readonly rawSizeBytes: number;
  readonly projection: RuntimeToolResultProjection;
}

export interface BuildRuntimeToolResultProjectionInput {
  readonly toolCall: ToolCall;
  readonly result: ToolResult;
  /** Provider-visible output after deterministic Recovery guidance has been injected. */
  readonly modelOutput: string;
  readonly thresholdTokens?: number;
  readonly maxPreviewChars?: number;
}

/**
 * Build the deterministic Provider projection without persisting or mutating ToolResult facts.
 * Integrity metadata always describes the physical tool output; Recovery text is projection-only.
 */
export function buildRuntimeToolResultProjection(
  input: BuildRuntimeToolResultProjectionInput,
): RuntimeToolResultProjectionResult {
  const rawBytes = Buffer.from(input.result.output, "utf8");
  const rawSha256 = createHash("sha256").update(rawBytes).digest("hex");
  const rawSizeBytes = rawBytes.byteLength;

  if (BOUNDED_READBACK_TOOLS.has(input.toolCall.name)) {
    return {
      shouldArchive: false,
      rawSha256,
      rawSizeBytes,
      projection: {
        version: 1,
        mode: "full",
        text: input.modelOutput,
        strategy: "bounded-readback",
        truncated: false,
      },
    };
  }

  const thresholdTokens = normalizeRuntimeProjectionThreshold(input.thresholdTokens);
  if (countTokens(input.modelOutput) <= thresholdTokens) {
    const recoveryInjected = input.modelOutput !== input.result.output;
    return {
      shouldArchive: false,
      rawSha256,
      rawSizeBytes,
      projection: {
        version: 1,
        mode: "full",
        text: input.modelOutput,
        strategy: recoveryInjected ? "recovery-injected" : "original",
        truncated: false,
      },
    };
  }

  const recoveryInjected = input.modelOutput !== input.result.output;
  const summary = summarizeToolResult({
    toolName: input.toolCall.name,
    arguments: input.toolCall.arguments,
    output: input.modelOutput,
    isError: input.result.isError,
    maxChars: input.maxPreviewChars ?? DEFAULT_SUMMARY_MAX_CHARS,
  });
  return {
    shouldArchive: true,
    rawSha256,
    rawSizeBytes,
    projection: {
      version: 1,
      mode: "preview",
      text: summary.text,
      strategy: recoveryInjected ? `recovery:${summary.strategy}` : summary.strategy,
      truncated: summary.truncated,
    },
  };
}

function normalizeRuntimeProjectionThreshold(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_RUNTIME_PROJECTION_THRESHOLD_TOKENS;
  }
  return Math.max(0, Math.floor(value));
}
