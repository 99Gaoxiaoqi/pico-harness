import { afterEach, describe, expect, it, vi } from "vitest";
import { createBuiltinCommandRegistry } from "../src/input/builtin-commands.js";
import { Session } from "../src/engine/session.js";
import { OpenAIProvider } from "../src/provider/openai.js";
import type { ImagePart } from "../src/schema/message.js";
import { handleTuiRunningInputSubmission } from "../src/tui/repl.js";
import { RunningInputQueue } from "../src/tui/running-input-queue.js";
import { TuiReporter } from "../src/tui/tui-reporter.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("TUI image submission integration", () => {
  it("keeps an idle image attachment through session storage and the OpenAI-compatible body", async () => {
    const requests: Record<string, unknown>[] = [];
    globalThis.fetch = vi.fn(async (_url: string | URL, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content: "image received" } }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const image: ImagePart = {
      type: "image_base64",
      mimeType: "image/png",
      data: "iVBORw0KGgo=",
    };
    const session = new Session("image-integration", process.cwd(), { persistence: false });
    const provider = new OpenAIProvider({
      baseURL: "https://ark.example.test/api/coding/v3",
      apiKey: "test-key",
      model: "doubao-seed-2-0-pro-260215",
    });

    await handleTuiRunningInputSubmission(
      "请查看这张图片。",
      {
        reporter: new TuiReporter(() => undefined),
        registry: createBuiltinCommandRegistry(),
        workDir: process.cwd(),
        exit: () => undefined,
        guard: {
          getSnapshot: () => "idle",
          tryStart: () => 1,
          end: () => true,
        },
        queue: new RunningInputQueue(),
        runAgent: async (prompt, options) => {
          session.append({ role: "user", content: prompt, images: options?.images });
          await provider.generate(session.getWorkingMemory(10), []);
        },
      },
      [image],
    );

    expect(session.getHistory().at(-1)?.images).toEqual([image]);
    const messages = requests[0]?.["messages"] as Array<Record<string, unknown>>;
    expect(messages.at(-1)?.["content"]).toEqual([
      { type: "text", text: "请查看这张图片。" },
      {
        type: "image_url",
        image_url: { url: "data:image/png;base64,iVBORw0KGgo=" },
      },
    ]);
  });
});
