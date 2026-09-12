import assert from "node:assert/strict";
import test from "node:test";
import { AiSdkProvider } from "../../src/provider/ai-sdk-provider.js";
import type { Message, ToolDefinition } from "../../src/schema/message.js";

// Opt in with PICO_NATIVE_SEARCH_E2E=1 and PICO_NATIVE_SEARCH_{WIRE,MODEL,BASE_URL,API_KEY}.
// The probe sends synthetic prompts and never prints credentials, request bodies or raw errors.
test(
  "real native search emits provider-executed search and citations, then replays without server storage",
  {
    skip: process.env.PICO_NATIVE_SEARCH_E2E !== "1",
    timeout: 250_000,
  },
  async () => {
    const wire = process.env.PICO_NATIVE_SEARCH_WIRE ?? "responses";
    assert.ok(
      wire === "responses" || wire === "claude",
      "native search requires Responses or Anthropic Messages",
    );
    const model = process.env.PICO_NATIVE_SEARCH_MODEL;
    const baseURL = process.env.PICO_NATIVE_SEARCH_BASE_URL;
    const apiKey = process.env.PICO_NATIVE_SEARCH_API_KEY;
    assert.ok(model && baseURL && apiKey, "Set PICO_NATIVE_SEARCH_MODEL, BASE_URL and API_KEY");
    const provider = new AiSdkProvider(wire, { model, baseURL, apiKey });
    const tools: ToolDefinition[] = [
      {
        name: "web_search",
        description: "Search the live web",
        inputSchema: { type: "object", properties: {} },
        providerTool: { kind: wire === "responses" ? "openai-web-search" : "anthropic-web-search" },
      },
    ];
    const messages: Message[] = [
      {
        role: "user",
        content:
          "Use the native web_search tool now to find the latest release shown on https://nodejs.org/en/blog/release and cite its source URL. You must perform a fresh web search; keep the answer to two sentences.",
      },
    ];
    const response = await provider.generateStream(messages, tools, () => {}, {
      timeoutMs: 120_000,
    });
    const search = response.providerData?.picoWebSearch as
      | {
          calls?: { status?: string }[];
          sources?: { url?: string }[];
        }
      | undefined;
    assert.ok(
      search?.calls?.some((call) => call.status === "completed"),
      "No completed provider-executed search event: a text-only HTTP 200 does not prove native search support",
    );
    assert.ok(
      search?.sources?.some((source) => source.url?.startsWith("https://")),
      "Native search must return source URLs",
    );
    assert.equal(response.toolCalls, undefined, "Native search must never request local execution");
    const replayed = await provider.generate(
      [
        ...messages,
        JSON.parse(JSON.stringify(response)),
        {
          role: "user",
          content:
            "Without searching again, repeat the source URL from your previous answer in one sentence.",
        },
      ],
      tools,
      { timeoutMs: 120_000, toolChoice: "none" },
    );
    assert.ok(replayed.content.length > 0, "Replay must produce an answer");
    assert.equal(replayed.toolCalls, undefined);
    assert.equal(
      replayed.providerData?.picoWebSearch,
      undefined,
      "toolChoice none must not run another search",
    );
  },
);
