import type { Message } from "@pico/core";

export function sanitizeToolPairs(msgs: Message[]): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i]!;
    // A ToolResult is only valid in the consecutive result segment directly
    // following its assistant batch. Late/orphan results are request-only noise.
    if (msg.role === "user" && msg.toolCallId !== undefined) continue;
    out.push({ ...msg });
    if (msg.role !== "assistant" || !msg.toolCalls || msg.toolCalls.length === 0) {
      continue;
    }

    const callsById = new Map(msg.toolCalls.map((toolCall) => [toolCall.id, toolCall]));
    const seen = new Set<string>();
    while (i + 1 < msgs.length) {
      const nextMsg = msgs[i + 1]!;
      if (nextMsg.role !== "user" || nextMsg.toolCallId === undefined) break;
      i++;
      if (!callsById.has(nextMsg.toolCallId) || seen.has(nextMsg.toolCallId)) continue;
      seen.add(nextMsg.toolCallId);
      out.push({ ...nextMsg });
    }
    for (const toolCall of msg.toolCalls) {
      if (!seen.has(toolCall.id)) {
        out.push({
          role: "user",
          toolCallId: toolCall.id,
          content: `[早期工具结果已归档] 工具 ${toolCall.name} 的结果已被上下文压缩器替换为占位符。`,
        });
      }
    }
  }
  return out;
}
