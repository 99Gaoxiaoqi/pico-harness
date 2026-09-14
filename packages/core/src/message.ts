/**
 * Provider-agnostic message and tool-call contracts shared by the Agent Runtime.
 * This package deliberately contains no storage, provider, host, or product dependencies.
 */

export type Role = "system" | "user" | "assistant";

export interface ToolCall {
  id: string;
  name: string;
  arguments: string;
}

export interface Usage {
  promptTokens: number;
  completionTokens: number;
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  reportedFields?: readonly UsageReportedField[];
}

export type UsageReportedField =
  | "prompt"
  | "completion"
  | "input"
  | "cacheRead"
  | "cacheWrite"
  | "reasoning";

export interface CanonicalUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalPromptTokens: number;
  totalCompletionTokens: number;
}

export function toCanonicalUsage(usage: Usage): CanonicalUsage {
  const cacheReadTokens = Math.max(0, usage.cacheReadTokens ?? 0);
  const cacheWriteTokens = Math.max(0, usage.cacheWriteTokens ?? 0);
  const reasoningTokens = Math.max(0, usage.reasoningTokens ?? 0);
  const inputTokens = Math.max(
    0,
    usage.inputTokens ?? usage.promptTokens - cacheReadTokens - cacheWriteTokens,
  );
  const outputTokens = Math.max(0, usage.completionTokens - reasoningTokens);
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalPromptTokens: usage.promptTokens,
    totalCompletionTokens: usage.completionTokens,
  };
}

export const RUNTIME_MESSAGE_EVENT_ID = Symbol("runtimeMessageEventId");

export interface Message {
  [RUNTIME_MESSAGE_EVENT_ID]?: string;
  role: Role;
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
  toolResultEvidenceUri?: string;
  usage?: Usage;
  reasoning?: string;
  providerData?: Record<string, unknown>;
  images?: ImagePart[];
}

export function isMessageHiddenFromTranscript(message: Message): boolean {
  if (message.providerData?.["picoHiddenFromTranscript"] === true) return true;
  if (message.role !== "user" || message.toolCallId !== undefined) return false;
  return (
    message.content.startsWith("[SYSTEM REMINDER") ||
    message.content.startsWith("[SYSTEM] 已达执行预算:")
  );
}

export type ImagePart =
  | { type: "image_base64"; mimeType: string; data: string }
  | { type: "image_url"; url: string };

export interface ToolResult {
  toolCallId: string;
  output: string;
  isError: boolean;
}

export interface ToolDefinition {
  providerTool?: { kind: "openai-web-search" | "anthropic-web-search" };
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export function assistantMessage(content: string, toolCalls?: ToolCall[]): Message {
  return { role: "assistant", content, toolCalls };
}
