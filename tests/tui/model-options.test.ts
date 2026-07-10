import { describe, expect, it } from "vitest";
import { createModelSelectorState } from "../../src/tui/model-selector.js";
import { buildModelOptions, modelSelectionToCommand } from "../../src/tui/model-options.js";
import type { ModelRoute } from "../../src/provider/model-router.js";

const ROUTES: ModelRoute[] = [
  route("deepseek/deepseek-v4-pro", "deepseek", "deepseek-v4-pro"),
  route("deepseek/deepseek-v4-flash", "deepseek", "deepseek-v4-flash"),
  route("anthropic/claude-3-5-sonnet", "anthropic", "claude-3-5-sonnet", "claude"),
];

describe("model options adapter", () => {
  it("builds selector options from slash model argument hints", () => {
    const options = buildModelOptions(ROUTES);

    expect(options).toEqual([
      {
        id: "deepseek/deepseek-v4-pro",
        name: "deepseek-v4-pro",
        description: "deepseek · openai",
      },
      {
        id: "deepseek/deepseek-v4-flash",
        name: "deepseek-v4-flash",
        description: "deepseek · openai",
      },
      {
        id: "anthropic/claude-3-5-sonnet",
        name: "claude-3-5-sonnet",
        description: "anthropic · claude",
      },
    ]);
  });

  it("lets the model selector choose the current model by id", () => {
    const options = buildModelOptions(ROUTES);

    expect(createModelSelectorState(options, "anthropic/claude-3-5-sonnet")).toEqual({
      selectedIndex: 2,
      status: "selecting",
    });
  });

  it("formats a model selection as the slash command to run", () => {
    expect(modelSelectionToCommand("deepseek/deepseek-v4-flash")).toBe(
      "/model deepseek/deepseek-v4-flash",
    );
  });
});

function route(
  id: string,
  providerId: string,
  model: string,
  provider: ModelRoute["provider"] = "openai",
): ModelRoute {
  return {
    id,
    providerId,
    provider,
    model,
    baseURL: "https://example.test/v1",
    apiKeyEnv: "TEST_API_KEY",
    source: "config",
  };
}
