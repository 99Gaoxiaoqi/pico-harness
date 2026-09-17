import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { AiSdkProvider } from "@pico/pico-host/provider/ai-sdk-provider";
import { loadUserDefaultRealModel } from "./real-llm-user-model.js";

// Explicit opt-in. Only synthetic content is sent; returned tool calls are never executed.
test(
  "configured real model streams a tool call and continues after a synthetic tool result",
  {
    skip: process.env.PICO_PROVIDER_STREAM_E2E !== "1",
    timeout: 130_000,
  },
  async () => {
    const model = await loadUserDefaultRealModel();
    const provider = new AiSdkProvider(model.provider, {
      ...model.config,
      sessionId: randomUUID(),
    });
    const tools = [
      {
        name: "synthetic_check",
        description: "Return the status of a synthetic diagnostic record.",
        inputSchema: {
          type: "object" as const,
          properties: { label: { type: "string" } },
          required: ["label"],
          additionalProperties: false,
        },
      },
    ];
    const messages = [
      {
        role: "user" as const,
        content:
          "This is a synthetic connectivity test. Call synthetic_check once with label GO_CHECK. After its tool result, respond with exactly GO_CONTINUATION_OK.",
      },
    ];
    const first = await provider.generateStream(messages, tools, () => {}, {
      timeoutMs: 60_000,
    });
    assert.equal(first.toolCalls?.length, 1);
    const call = first.toolCalls![0]!;
    assert.equal(call.name, "synthetic_check");
    assert.deepEqual(JSON.parse(call.arguments), { label: "GO_CHECK" });
    let streamed = "";
    const final = await provider.generateStream(
      [
        ...messages,
        first,
        {
          role: "user",
          toolCallId: call.id,
          content: "Synthetic status: OK. Reply GO_CONTINUATION_OK.",
        },
      ],
      [],
      (delta) => {
        streamed += delta;
      },
      { timeoutMs: 60_000, toolChoice: "none" },
    );
    assert.equal(final.toolCalls?.length ?? 0, 0);
    assert.match(final.content ?? "", /GO_CONTINUATION_OK/u);
    assert.match(streamed, /GO_CONTINUATION_OK/u);
  },
);
