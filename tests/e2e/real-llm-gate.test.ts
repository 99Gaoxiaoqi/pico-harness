import { describe, expect, it } from "vitest";
import { OpenAIProvider } from "../../src/provider/openai.js";

describe("real model execution sentinel", () => {
  it("[real-llm-gate] executes a provider request and receives assistant text", async () => {
    const provider = new OpenAIProvider({
      baseURL: process.env.LLM_BASE_URL!,
      apiKey: process.env.LLM_API_KEY!,
      model: process.env.LLM_MODEL!,
    });

    const result = await provider.generate(
      [{ role: "user", content: "Reply exactly PICO_REAL_LLM_SENTINEL_OK" }],
      [],
    );

    expect(result.content.trim().length).toBeGreaterThan(0);
  });
});
