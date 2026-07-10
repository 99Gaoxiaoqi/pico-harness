// createAuxSummarizer 工厂函数单元测试(任务 5.3c)。
// 验证:用辅助 provider 构造的 Summarizer 真的会把远期历史喂给小模型,
// 并把小模型返回的 content 原样作为摘要吐出。
//
// 额外验证可装配性:把它注入 Compactor.compactWithSummary,确认走摘要分支而非字符级掩码。

import { describe, expect, it, vi } from "vitest";
import { Compactor, createAuxSummarizer } from "../../src/context/compactor.js";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

/** 可记录调用的 mock 辅助 provider:固定返回摘要文本 */
class MockAuxProvider implements LLMProvider {
  readonly calls: Array<{ messages: Message[]; toolNames: string[] }> = [];
  readonly generate = vi.fn(
    (messages: Message[], availableTools: ToolDefinition[]): Promise<Message> => {
      this.calls.push({
        messages: [...messages],
        toolNames: availableTools.map((t) => t.name),
      });
      return Promise.resolve({ role: "assistant", content: this.summary });
    },
  );
  constructor(private readonly summary: string) {}
}

function userMsg(content: string): Message {
  return { role: "user", content };
}
function assistantMsg(content: string): Message {
  return { role: "assistant", content };
}

describe("createAuxSummarizer", () => {
  it("用辅助 provider 浓缩远期历史,返回其 content 作为摘要", async () => {
    const mockProvider = new MockAuxProvider("摘要:用户讨论了上下文压缩方案");
    const summarizer = createAuxSummarizer(mockProvider);

    const result = await summarizer({
      newMessages: [userMsg("我们要降低 token 成本"), assistantMsg("可以用辅助模型做摘要")],
    });

    // 1. 辅助 provider 被调了一次
    expect(mockProvider.generate).toHaveBeenCalledTimes(1);
    // 2. availableTools 传空(压缩器不需要工具)
    expect(mockProvider.calls[0]!.toolNames).toEqual([]);
    // 3. user prompt 包含历史文本(断言关键字段被喂进去)
    const userPrompt = mockProvider.calls[0]!.messages[1]!.content;
    expect(userPrompt).toContain("降低 token 成本");
    expect(userPrompt).toContain("辅助模型做摘要");
    // 4. 返回值就是辅助 provider 的 content
    expect(result).toBe("摘要:用户讨论了上下文压缩方案");
  });

  it("提供 previousSummary 时拼进 prompt(增量摘要)", async () => {
    const mockProvider = new MockAuxProvider("增量摘要");
    const summarizer = createAuxSummarizer(mockProvider);

    await summarizer({
      newMessages: [userMsg("新增内容")],
      previousSummary: "上一次的摘要内容",
    });

    const userPrompt = mockProvider.calls[0]!.messages[1]!.content;
    expect(userPrompt).toContain("上一次的摘要内容");
    expect(userPrompt).toContain("新增内容");
  });

  it("提供 focusTopic 时拼进 prompt(主题聚焦)", async () => {
    const mockProvider = new MockAuxProvider("聚焦摘要");
    const summarizer = createAuxSummarizer(mockProvider);

    await summarizer({
      newMessages: [userMsg("背景内容")],
      focusTopic: "压缩成本",
    });

    const userPrompt = mockProvider.calls[0]!.messages[1]!.content;
    expect(userPrompt).toContain("压缩成本");
  });

  it("ToolCall/ToolResult 序列化为可读标签,而非裸 JSON", async () => {
    const mockProvider = new MockAuxProvider("ok");
    const summarizer = createAuxSummarizer(mockProvider);

    await summarizer({
      newMessages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.ts"}' }],
        },
        { role: "user", content: "文件内容长文本", toolCallId: "c1" },
      ],
    });

    const userPrompt = mockProvider.calls[0]!.messages[1]!.content;
    expect(userPrompt).toContain("[助手→工具: read_file]");
    expect(userPrompt).toContain("[工具结果]");
    expect(userPrompt).toContain("文件内容长文本");
  });

  it("装配进 Compactor.compactWithSummary 后真的走摘要分支", async () => {
    const mockProvider = new MockAuxProvider("这是 LLM 浓缩出的摘要");
    const summarizer = createAuxSummarizer(mockProvider);
    // 水位线极低,强制触发压缩;保护区小,确保有远期历史被摘要
    const compactor = new Compactor({
      maxChars: 10,
      retainLastMsgs: 1,
      summarizer,
    });

    const msgs: Message[] = [
      userMsg("早期讨论一:压缩策略与辅助模型方案"),
      assistantMsg("早期讨论二:辅助模型方案细节与成本"),
      userMsg("最近一条用户消息"), // 保护区
    ];

    const result = await compactor.compactWithSummary(msgs);

    // 辅助 provider 被调(说明走了摘要分支而非退回字符级掩码)
    expect(mockProvider.generate).toHaveBeenCalledTimes(1);
    // 摘要以 system 消息形式出现在结果开头
    const summaryMsg = result.find((m) => m.role === "system" && m.content.includes("[历史摘要]"));
    expect(summaryMsg).toBeDefined();
    expect(summaryMsg!.content).toContain("这是 LLM 浓缩出的摘要");
    // 保护区最近一条用户消息保留
    expect(result.some((m) => m.content === "最近一条用户消息")).toBe(true);
  });
});
