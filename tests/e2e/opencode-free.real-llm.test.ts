import assert from "node:assert/strict";
import test from "node:test";
import {
  OPENCODE_FREE_PROVIDER,
  OPENCODE_FREE_ROUTE_ID,
} from "../../src/input/default-provider.js";
import { loadModelRouter } from "../../src/provider/model-router.js";
import { AiSdkProvider } from "../../src/provider/ai-sdk-provider.js";

// Explicit opt-in: sends only a synthetic, non-sensitive prompt to the public free endpoint.
test(
  "OpenCode Free anonymous route receives a real streaming model response",
  {
    skip: process.env.PICO_PUBLIC_FREE_E2E !== "1",
    timeout: 130_000,
  },
  async () => {
    const router = await loadModelRouter({
      config: {
        model: OPENCODE_FREE_ROUTE_ID,
        providers: { "opencode-free": OPENCODE_FREE_PROVIDER },
      },
      env: {},
    });
    const selected = router.providerConfig(OPENCODE_FREE_ROUTE_ID);
    assert.equal(selected.config.auth, "none");
    assert.equal(selected.config.apiKey, "");
    const provider = new AiSdkProvider("openai", {
      ...selected.config,
      sessionId: "pico-public-free-smoke",
    });
    let streamed = "";
    const response = await provider.generateStream(
      [{ role: "user", content: "Reply with exactly PICO_FREE_OK. Do not use tools." }],
      [],
      (delta) => {
        streamed += delta;
      },
      { timeoutMs: 120_000, toolChoice: "none" },
    );
    assert.match(streamed, /PICO_FREE_OK/u);
    assert.match(response.content ?? "", /PICO_FREE_OK/u);
  },
);
