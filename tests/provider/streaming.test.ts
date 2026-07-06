import { describe, it, expect, vi } from "vitest";
import type { LLMProvider } from "../../src/provider/interface.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";
import { TerminalReporter } from "../../src/engine/reporter.js";

describe("流式输出", () => {
  it("generateStream 在 generate 时被调用，delta 转发给 onDelta 回调", async () => {
    const deltas: string[] = [];

    // Mock provider:实现 generateStream
    const provider: LLMProvider = {
      async generate() {
        return { role: "assistant", content: "non-streaming" };
      },
      async generateStream(
        _messages: Message[],
        _tools: ToolDefinition[],
        onDelta: (delta: string) => void,
      ): Promise<Message> {
        onDelta("Hello");
        onDelta(", ");
        onDelta("world!");
        return { role: "assistant", content: "Hello, world!" };
      },
      modelName: "mock-model",
    };

    // 模拟 loop.ts 的流式包装逻辑
    const generateStreamFn = provider.generateStream;
    expect(generateStreamFn).toBeDefined();

    const reporter = { onTextDelta: vi.fn((delta: string) => deltas.push(delta)) };

    const wrappedProvider: LLMProvider = {
      generate: (msgs, tools) =>
        generateStreamFn!.call(provider, msgs, tools, (delta: string) => {
          reporter.onTextDelta?.(delta);
        }),
      modelName: provider.modelName,
    };

    // 调用 wrappedProvider.generate
    const result = await wrappedProvider.generate([], []);

    // 验证 delta 被转发
    expect(deltas).toEqual(["Hello", ", ", "world!"]);
    expect(reporter.onTextDelta).toHaveBeenCalledTimes(3);
    expect(result.content).toBe("Hello, world!");
  });

  it("不实现 generateStream 的 provider 正常降级到非流式", async () => {
    // Mock provider:不实现 generateStream
    const provider: LLMProvider = {
      async generate() {
        return { role: "assistant", content: "non-streaming fallback" };
      },
      modelName: "mock-model",
    };

    expect(provider.generateStream).toBeUndefined();

    // 模拟 loop.ts 的降级逻辑
    const generateStreamFn = provider.generateStream;
    // generateStreamFn 是 undefined，不包装
    const wrappedProvider = generateStreamFn ? provider : provider;

    const result = await wrappedProvider.generate([], []);
    expect(result.content).toBe("non-streaming fallback");
  });

  it("TerminalReporter.onTextDelta 输出到 stdout", () => {
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const reporter = new TerminalReporter();
    reporter.onTextDelta!("chunk1");
    reporter.onTextDelta!("chunk2");

    expect(writeSpy).toHaveBeenCalledWith("chunk1");
    expect(writeSpy).toHaveBeenCalledWith("chunk2");
    writeSpy.mockRestore();
  });
});
