import { describe, expect, it } from "vitest";
import {
  findSafeCompactionCut,
  hasIncompleteToolExchange,
  isSafeCompactionCut,
} from "../src/context/safe-compaction-boundary.js";
import type { Message, ToolCall } from "../src/schema/message.js";

function assistantWithTools(...toolCalls: ToolCall[]): Message {
  return { role: "assistant", content: "", toolCalls };
}

function result(toolCallId: string): Message {
  return { role: "user", content: `result-${toolCallId}`, toolCallId };
}

describe("safe compaction boundary", () => {
  it("不在并发工具批次中间切分", () => {
    const calls = [
      { id: "c1", name: "read_file", arguments: "{}" },
      { id: "c2", name: "read_file", arguments: "{}" },
    ];
    const messages: Message[] = [
      { role: "user", content: "task" },
      assistantWithTools(...calls),
      result("c1"),
      result("c2"),
      { role: "assistant", content: "done" },
      { role: "user", content: "next" },
    ];

    expect(isSafeCompactionCut(messages, 2)).toBe(false);
    expect(isSafeCompactionCut(messages, 3)).toBe(false);
    expect(isSafeCompactionCut(messages, 4)).toBe(true);
  });

  it("保留目标 token 不足时向前扩展到安全边界", () => {
    const messages: Message[] = [
      { role: "user", content: "old task" },
      { role: "assistant", content: "old answer" },
      assistantWithTools(
        { id: "c1", name: "read_file", arguments: "{}" },
        { id: "c2", name: "read_file", arguments: "{}" },
      ),
      result("c1"),
      result("c2"),
      { role: "assistant", content: "latest conclusion" },
    ];

    const cut = findSafeCompactionCut(messages, 1);
    expect(cut?.compactedCount).toBe(5);
  });

  it("拒绝让无来源 ToolResult 留在尾部", () => {
    const messages: Message[] = [
      { role: "assistant", content: "old" },
      result("orphan"),
      { role: "assistant", content: "done" },
    ];
    expect(isSafeCompactionCut(messages, 1)).toBe(false);
  });

  it("尾部并发工具结果未到齐时禁止压缩", () => {
    const messages: Message[] = [
      { role: "user", content: "task" },
      { role: "assistant", content: "ack" },
      assistantWithTools(
        { id: "c1", name: "read_file", arguments: "{}" },
        { id: "c2", name: "read_file", arguments: "{}" },
      ),
      result("c1"),
    ];

    expect(hasIncompleteToolExchange(messages)).toBe(true);
    expect(findSafeCompactionCut(messages, 1)).toBeUndefined();
  });

  it("不同已完成批次可重复使用同一 ToolCall ID", () => {
    const messages: Message[] = [
      assistantWithTools({ id: "gemini-call-0", name: "read_file", arguments: "{}" }),
      result("gemini-call-0"),
      { role: "assistant", content: "first done" },
      assistantWithTools({ id: "gemini-call-0", name: "bash", arguments: "{}" }),
      result("gemini-call-0"),
      { role: "assistant", content: "second done" },
    ];

    expect(hasIncompleteToolExchange(messages)).toBe(false);
    expect(isSafeCompactionCut(messages, 3)).toBe(true);
  });
});
