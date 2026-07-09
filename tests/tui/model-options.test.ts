import { describe, expect, it } from "vitest";
import { createModelSelectorState } from "../../src/tui/model-selector.js";
import { buildModelOptions, modelSelectionToCommand } from "../../src/tui/model-options.js";

describe("model options adapter", () => {
  it("builds selector options from slash model argument hints", () => {
    const options = buildModelOptions();

    expect(options).toEqual([
      {
        id: "glm-5.2",
        name: "glm-5.2",
        description: "OpenAI-compatible default model",
      },
      {
        id: "kimi-k2.5",
        name: "kimi-k2.5",
        description: "OpenAI-compatible fallback model",
      },
      {
        id: "claude-3-5-sonnet",
        name: "claude-3-5-sonnet",
        description: "Claude default model",
      },
      {
        id: "gemini-2.0-flash",
        name: "gemini-2.0-flash",
        description: "Gemini default model",
      },
    ]);
  });

  it("lets the model selector choose the current model by id", () => {
    const options = buildModelOptions();

    expect(createModelSelectorState(options, "claude-3-5-sonnet")).toEqual({
      selectedIndex: 2,
      status: "selecting",
    });
  });

  it("formats a model selection as the slash command to run", () => {
    expect(modelSelectionToCommand("kimi-k2.5")).toBe("/model kimi-k2.5");
  });
});
