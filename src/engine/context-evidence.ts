import type { Message } from "../schema/message.js";
import { FULL_COMPACTION_SUMMARY_MARKER } from "../context/compaction-markers.js";
import { truncate } from "../observability/trace.js";
/**
 * 从消息历史构造结构化证据快照。
 * @param messages 完整消息历史
 * @param skipPrefix 跳过前 N 条(system/task prompt),只处理其后消息
 * @param header 快照头部标识
 * @returns 证据快照文本,或 undefined(无证据可提取)
 */
export function buildEvidenceSnapshot(
  messages: readonly Message[],
  skipPrefix: number,
  header: string,
): string | undefined {
  const toolNames = new Map<string, string>();
  const evidence: string[] = [];
  for (const message of messages.slice(skipPrefix)) {
    if (message.role === "assistant") {
      // 跳过上一轮 checkpoint summary（压缩产物而非真实对话），避免把截断的旧摘要当工作线索。
      if (message.content.startsWith(FULL_COMPACTION_SUMMARY_MARKER)) continue;
      for (const call of message.toolCalls ?? []) toolNames.set(call.id, call.name);
      if (message.content.trim()) {
        evidence.push(`[assistant checkpoint] ${truncate(message.content.trim(), 400)}`);
      }
      continue;
    }
    if (message.role === "user" && message.toolCallId) {
      const toolName = toolNames.get(message.toolCallId) ?? "unknown_tool";
      evidence.push(
        `[tool evidence: ${toolName}; call=${message.toolCallId}] ${truncate(message.content, 700)}`,
      );
      continue;
    }
    // 纯 user 消息（用户原始请求/约束）:必须保留,否则硬重置后模型丢失任务目标和用户意图。
    if (message.role === "user") {
      evidence.push(`[user request] ${truncate(message.content.trim(), 300)}`);
    }
  }
  if (evidence.length === 0) return undefined;
  return [
    `${header} 上下文已重置；以下是压缩前已收集的结构化证据，不要重复探索同一范围。`,
    ...evidence.slice(-8),
  ].join("\n");
}

export function estimateTraceLength(messages: Message[]): number {
  let length = 0;
  for (const message of messages) {
    length += message.content.length;
    if (message.toolCalls) {
      for (const toolCall of message.toolCalls) {
        length += toolCall.name.length + toolCall.arguments.length;
      }
    }
  }
  return length;
}
