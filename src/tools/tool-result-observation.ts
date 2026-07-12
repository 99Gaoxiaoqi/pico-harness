import { logger } from "../observability/logger.js";
import type { ToolCall, ToolResult } from "../schema/message.js";
import { summarizeToolResult } from "./result-summarizer.js";
import { SUBAGENT_OUTPUT_BUDGET } from "./subagent-budget.js";

/**
 * 未知与扩展工具的通用上下文保护阈值。
 * Bash 大段日志和 delegate_task 批量结果分别使用更保守的独立阈值。
 */
const DEFAULT_EXTERNALIZE_THRESHOLD_CHARS = 50_000;
const BASH_EXTERNALIZE_THRESHOLD_CHARS = 30_000;
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
  const summaryMaxChars = opts.summaryMaxChars ?? DEFAULT_SUMMARY_MAX_CHARS;
  const cleanupAfterWrite = opts.cleanupAfterWrite ?? opts.cleanup ?? true;

  return async ({ toolCall, result, output, sessionId }) => {
    // read_file 自身提供行分页和页大小上限。如果再走通用外部化，
    // 读 artifact 的结果会被写成新 artifact，形成 artifact→read→artifact 循环。
    if (toolCall.name === "read_file") {
      return output;
    }

    const threshold =
      opts.externalizeThresholdChars ??
      (toolCall.name === "bash"
        ? BASH_EXTERNALIZE_THRESHOLD_CHARS
        : toolCall.name === "delegate_task"
          ? SUBAGENT_OUTPUT_BUDGET.batch.hardMax
          : DEFAULT_EXTERNALIZE_THRESHOLD_CHARS);
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
        // quota 是全局硬上限；若只扫当前 session，多 session 会无界累积。
        await opts.store.cleanup();
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
