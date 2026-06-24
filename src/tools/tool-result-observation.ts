import { logger } from "../observability/logger.js";
import type { ToolCall, ToolResult } from "../schema/message.js";
import { summarizeToolResult } from "./result-summarizer.js";

const DEFAULT_EXTERNALIZE_THRESHOLD_CHARS = 4000;
const DEFAULT_SUMMARY_MAX_CHARS = 1600;
const DEFAULT_ARTIFACT_SESSION_ID = "default";

export interface ToolObservationProcessorInput {
  toolCall: ToolCall;
  result: ToolResult;
  output: string;
  sessionId?: string;
}

export type ToolObservationProcessor = (
  input: ToolObservationProcessorInput,
) => Promise<string> | string;

export interface ToolResultObservationArtifactStore {
  write(input: WriteToolResultObservationArtifactInput): Promise<ToolResultObservationArtifactMeta>;
  cleanup(sessionId?: string): Promise<unknown>;
}

export interface WriteToolResultObservationArtifactInput {
  sessionId?: string;
  toolName: string;
  args: unknown;
  output: string;
  summary?: string;
  ttlHours?: number;
  pinned?: boolean;
}

export interface ToolResultObservationArtifactMeta {
  id: string;
  sessionId?: string;
  path?: string;
}

export interface ToolResultObservationProcessorOptions {
  store: ToolResultObservationArtifactStore;
  externalizeThresholdChars?: number;
  summaryMaxChars?: number;
  cleanupAfterWrite?: boolean;
  /** @deprecated Use cleanupAfterWrite. */
  cleanup?: boolean;
  ttlHours?: number;
}

export function createToolResultObservationProcessor(
  opts: ToolResultObservationProcessorOptions,
): ToolObservationProcessor {
  const threshold = opts.externalizeThresholdChars ?? DEFAULT_EXTERNALIZE_THRESHOLD_CHARS;
  const summaryMaxChars = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  const cleanupAfterWrite = opts.cleanupAfterWrite ?? opts.cleanup ?? true;

  return async ({ toolCall, result, output, sessionId }) => {
    if (output.length <= threshold) {
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

    if (cleanupAfterWrite) {
      try {
        await opts.store.cleanup(meta.sessionId ?? sessionId ?? DEFAULT_ARTIFACT_SESSION_ID);
      } catch (err) {
        logger.warn({ err }, "[ToolResult] artifact cleanup failed");
      }
    }

    return [
      "[大型工具输出已外部化]",
      `tool: ${toolCall.name}`,
      `toolCallId: ${toolCall.id}`,
      `artifactUri: ${buildArtifactUri(meta.sessionId ?? sessionId, meta.id)}`,
      `artifactId: ${meta.id}`,
      ...(meta.path !== undefined ? [`artifactPath: ${meta.path}`] : []),
      `originalChars: ${summary.originalChars}`,
      `summaryStrategy: ${summary.strategy}`,
      "summary:",
      summary.text,
    ].join("\n");
  };
}

function buildArtifactUri(sessionId: string | undefined, artifactId: string): string {
  const scopedSessionId =
    sessionId && sessionId.length > 0 ? sessionId : DEFAULT_ARTIFACT_SESSION_ID;
  return `artifact://${encodeURIComponent(scopedSessionId)}/${encodeURIComponent(artifactId)}`;
}

function parseArgs(args: string): unknown {
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return { raw: args };
  }
}
