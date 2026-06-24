import { logger } from "../observability/logger.js";
import type { ToolCall, ToolResult } from "../schema/message.js";
import type { ToolResultArtifactStore } from "../context/artifact-store.js";
import { summarizeToolResult } from "./result-summarizer.js";

const DEFAULT_EXTERNALIZE_THRESHOLD_CHARS = 4000;
const DEFAULT_SUMMARY_MAX_CHARS = 1600;

export interface ToolObservationProcessorInput {
  toolCall: ToolCall;
  result: ToolResult;
  output: string;
  sessionId?: string;
}

export type ToolObservationProcessor = (
  input: ToolObservationProcessorInput,
) => Promise<string> | string;

export interface ToolResultObservationProcessorOptions {
  store: ToolResultArtifactStore;
  externalizeThresholdChars?: number;
  summaryMaxChars?: number;
  cleanup?: boolean;
  ttlHours?: number;
}

export function createToolResultObservationProcessor(
  opts: ToolResultObservationProcessorOptions,
): ToolObservationProcessor {
  const threshold = opts.externalizeThresholdChars ?? DEFAULT_EXTERNALIZE_THRESHOLD_CHARS;
  const summaryMaxChars = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  const cleanup = opts.cleanup ?? true;

  return async ({ toolCall, result, output, sessionId }) => {
    if (output.length < threshold) {
      return output;
    }

    const summary = summarizeToolResult({
      toolName: toolCall.name,
      arguments: toolCall.arguments,
      output,
      isError: result.isError,
      maxChars: summaryMaxChars,
    });
    const meta = await opts.store.write({
      sessionId,
      toolName: toolCall.name,
      args: parseArgs(toolCall.arguments),
      output,
      summary: summary.text,
      ...(opts.ttlHours !== undefined ? { ttlHours: opts.ttlHours } : {}),
      pinned: result.isError,
    });

    if (cleanup) {
      try {
        await opts.store.cleanup();
      } catch (err) {
        logger.warn({ err }, "[ToolResult] artifact cleanup failed");
      }
    }

    return [
      "[大型工具输出已外部化]",
      `tool: ${toolCall.name}`,
      `toolCallId: ${toolCall.id}`,
      `artifactId: ${meta.id}`,
      `artifactPath: ${meta.path}`,
      `originalChars: ${summary.originalChars}`,
      `summaryStrategy: ${summary.strategy}`,
      "summary:",
      summary.text,
    ].join("\n");
  };
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { raw: args };
  }
}
