import assert from "node:assert/strict";
import test from "node:test";
import {
  nextProviderId,
  providerPresets,
  unsupportedProviderPresets,
} from "../../../apps/desktop/src/renderer/provider-presets.js";
import { createProvider } from "../../../src/provider/factory.js";
import { parseStrictRuntimeParams } from "../../../packages/protocol/src/index.js";

// This verifies the catalog-to-wire boundary locally. It does not call a model
// service or claim that a user's key has access to the suggested models.
test("Desktop catalog selections produce the matching Chat, Messages or Responses request", async (context) => {
  const originalFetch = globalThis.fetch;
  context.after(() => {
    globalThis.fetch = originalFetch;
  });
  const documentedMessageEndpoints: Readonly<Record<string, string>> = {
    anthropic: "https://api.anthropic.com/v1/messages",
    "kimi-coding-plan": "https://api.kimi.com/coding/v1/messages",
    MiniMax: "https://api.minimax.io/anthropic/v1/messages",
    "MiniMax-cn": "https://api.minimax.cn/anthropic/v1/messages",
    "minimax-coding-plan": "https://api.minimax.io/anthropic/v1/messages",
    "opencode-anthropic": "https://opencode.ai/zen/v1/messages",
    "opencode-go-anthropic": "https://opencode.ai/zen/go/v1/messages",
  };
  const requests: { url: string; model: string }[] = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const body = JSON.parse(String(init?.body)) as { model: string };
    requests.push({ url, model: body.model });
    if (url.endsWith("/responses")) {
      return Response.json({
        id: "resp_fixture",
        object: "response",
        created_at: 1,
        model: body.model,
        status: "completed",
        output: [
          {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: "catalog-ok", annotations: [] }],
          },
        ],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    }
    return url.endsWith("/messages")
      ? Response.json({
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          model: "claude-fixture",
          content: [{ type: "text", text: "catalog-ok" }],
          stop_reason: "end_turn",
          usage: { input_tokens: 1, output_tokens: 1 },
        })
      : Response.json({
          choices: [
            { finish_reason: "stop", message: { role: "assistant", content: "catalog-ok" } },
          ],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        });
  };

  assert.equal(new Set(providerPresets.map(({ id }) => id)).size, providerPresets.length);
  for (const preset of providerPresets) {
    assert.match(preset.apiKeyEnv, /^[A-Z][A-Z0-9_]*$/u);
    assert.doesNotMatch(
      preset.baseURL,
      /[{}<>$]/u,
      `${preset.id}: templates must only be placeholders`,
    );
    if (preset.baseURLPlaceholder) assert.equal(preset.baseURL, "");
    const baseURL = preset.baseURL || "https://account.example.test/v1";
    const model = preset.models[0] || "user-chosen-model";
    const configured = {
      id: nextProviderId(preset.id, [preset.id]),
      protocol: preset.protocol,
      baseURL,
      apiKeyEnv: preset.apiKeyEnv,
      models: [model],
      discoverModels: false,
    };
    const params = parseStrictRuntimeParams("provider.upsert", {
      provider: configured,
      expectedRevision: "fixture",
    });
    assert.deepEqual(params.provider, configured);
    const provider = createProvider(preset.protocol, {
      baseURL,
      apiKey: "catalog-fixture-key",
      model,
    });
    const response = await provider.generate([{ role: "user", content: "catalog fixture" }], []);
    assert.equal(response.content, "catalog-ok", preset.id);
    const request = requests.at(-1)!;
    assert.equal(request.model, model);
    if (preset.protocol === "claude" && preset.category !== "custom") {
      assert.equal(request.url, documentedMessageEndpoints[preset.id], preset.id);
    }
    assert.equal(
      request.url,
      `${baseURL}/${preset.protocol === "claude" ? "messages" : preset.protocol === "responses" ? "responses" : "chat/completions"}`,
    );
  }

  const byId = new Map(providerPresets.map((preset) => [preset.id, preset]));
  assert.equal(byId.get("opencode-free")?.auth, "none");
  assert.deepEqual(byId.get("opencode-free")?.models, ["nemotron-3-ultra-free"]);
  for (const id of ["ollama", "lm-studio", "localai"]) assert.equal(byId.get(id)?.auth, "none");
  for (const id of ["opencode", "opencode-go"]) {
    assert.equal(byId.get(id)?.protocol, "openai");
    assert.ok(byId.get(id)?.models.includes("qwen3.7-plus"));
    assert.equal(byId.get(id)?.modelProtocols?.["qwen3.7-plus"], "claude");
    assert.equal(byId.has(`${id}-anthropic`), false);
    assert.doesNotMatch(byId.get(id)!.name, /Chat|Messages/u);
  }
  for (const unavailable of unsupportedProviderPresets) {
    assert.ok(!byId.has(unavailable.id));
    assert.ok(unavailable.reason.trim());
    assert.equal("protocol" in unavailable, false);
  }
});
