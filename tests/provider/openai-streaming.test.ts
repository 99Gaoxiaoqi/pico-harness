import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAIProvider } from "../../src/provider/openai.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

const cfg = { baseURL: "https://test.local/v1", apiKey: "sk-test", model: "glm-5.2" };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

const history: Message[] = [{ role: "user", content: "call tool" }];
const echoTool: ToolDefinition = {
  name: "echo",
  description: "回显",
  inputSchema: { type: "object", properties: { text: { type: "string" } } },
};

function sseStream(sse: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sse));
      controller.close();
    },
  });
}

function sseData(data: unknown): string {
  return `data: ${JSON.stringify(data)}\n\n`;
}

function mockStreamFetch(sse: string): void {
  globalThis.fetch = vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      headers: new Headers(),
      body: sseStream(sse),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe("OpenAIProvider.generateStream", () => {
  it("tool_call 分片后续 delta 会补写 id/name 并追加 arguments", async () => {
    mockStreamFetch(
      sseData({
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, function: { arguments: '{"text"' } }],
            },
          },
        ],
      }) +
        sseData({
          choices: [
            {
              delta: {
                tool_calls: [
                  {
                    index: 0,
                    id: "call_1",
                    function: { name: "echo", arguments: ':"hi"}' },
                  },
                ],
              },
            },
          ],
        }) +
        "data: [DONE]\n\n",
    );

    const p = new OpenAIProvider(cfg);
    const msg = await p.generateStream(history, [echoTool], () => {});

    expect(msg.toolCalls).toEqual([
      { id: "call_1", name: "echo", arguments: '{"text":"hi"}' },
    ]);
  });
});
