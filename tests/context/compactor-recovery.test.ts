import { describe, expect, it, vi } from "vitest";
import { Compactor } from "../../src/context/compactor.js";
import type { Message } from "../../src/schema/message.js";

function userMsg(content: string): Message {
  return { role: "user", content };
}

function assistantMsg(content: string, toolCalls?: Message["toolCalls"]): Message {
  return { role: "assistant", content, toolCalls };
}

function toolResultMsg(toolCallId: string, output: string): Message {
  return { role: "user", content: output, toolCallId };
}

describe("Compactor compact recovery", () => {
  it("summarizer 抛错时退回预算压缩兜底,并保留 toolCalls/toolCallId 配对", async () => {
    const summarizer = vi.fn(async () => {
      throw new Error("prompt too long");
    });
    const compactor = new Compactor({
      maxChars: 420,
      retainLastMsgs: 2,
      summarizer,
    });
    const msgs: Message[] = [
      userMsg("早期需求:" + "A".repeat(3000)),
      assistantMsg("读取大日志", [
        { id: "c1", name: "read_file", arguments: '{"path":"large.log"}' },
      ]),
      toolResultMsg("c1", "LOG\n" + "B".repeat(6000)),
      userMsg("继续基于日志定位问题"),
    ];

    const out = await compactor.compactWithSummary(msgs);

    expect(summarizer).toHaveBeenCalledTimes(1);
    expect(compactor.estimateLength(out)).toBeLessThanOrEqual(420);
    const assistantWithCall = out.find((m) => m.role === "assistant" && m.toolCalls);
    expect(assistantWithCall?.toolCalls?.map((tc) => tc.id)).toEqual(["c1"]);
    expect(out.filter((m) => m.toolCallId).map((m) => m.toolCallId)).toEqual(["c1"]);
    expect(out.some((m) => m.content.includes("工具输出已被预算压缩"))).toBe(true);
  });

  it("摘要压缩成功后追加 postCompactRestore 恢复消息", async () => {
    const summarizer = vi.fn(async () => "已完成 Compact Recovery 计划梳理");
    const postCompactRestore = vi.fn((): Message[] => [
      userMsg("[恢复] 当前计划:docs/plans/2026-07-09-claude-code-runtime-parity-stage6.md"),
      userMsg("[恢复] 最近关键文件:src/context/compactor.ts"),
    ]);
    const compactor = new Compactor({
      maxChars: 80,
      retainLastMsgs: 1,
      summarizer,
      postCompactRestore,
    });
    const msgs: Message[] = [
      userMsg("早期历史:" + "A".repeat(200)),
      assistantMsg("早期分析:" + "B".repeat(200)),
      userMsg("最近任务"),
    ];

    const out = await compactor.compactWithSummary(msgs);

    expect(postCompactRestore).toHaveBeenCalledTimes(1);
    expect(out.at(-2)?.content).toContain("当前计划");
    expect(out.at(-1)?.content).toContain("最近关键文件");
    expect(out.some((m) => m.role === "system" && m.content.includes("[历史摘要]"))).toBe(true);
    expect(out.some((m) => m.content === "最近任务")).toBe(true);
  });
});
