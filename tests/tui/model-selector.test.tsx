import { renderToString } from "ink";
import { describe, expect, it, vi } from "vitest";
import {
  ModelSelector,
  cancelModelSelection,
  confirmModelSelection,
  createModelSelectorState,
  formatModelSelector,
  moveModelSelection,
  resolveModelSelectorKey,
  type ModelOption,
} from "../../src/tui/model-selector.js";

const models: ModelOption[] = [
  {
    id: "gpt-5",
    name: "GPT-5",
    description: "Fast default coding model with a deliberately long note",
    efforts: ["low", "medium", "high"],
  },
  {
    id: "gpt-5-thinking",
    name: "GPT-5 Thinking",
    description: "Deep reasoning",
    efforts: ["medium", "high"],
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
  },
];

describe("ModelSelector", () => {
  it("renders available models with current and selected markers", () => {
    const output = formatModelSelector(models, {
      currentModelId: "gpt-5",
      state: createModelSelectorState(models, "gpt-5-thinking"),
    });

    expect(output).toContain("Models");
    expect(output).toContain("› GPT-5 Thinking");
    expect(output).toContain("GPT-5 [current]");
    expect(output).toContain("effort: medium/high");
    expect(output).toContain("Enter to select · Esc to cancel");
  });

  it("truncates long descriptions for terminal-friendly rows", () => {
    const output = formatModelSelector(models, {
      maxDescriptionLength: 18,
      state: createModelSelectorState(models, "gpt-5"),
    });

    expect(output).toContain("Fast default co...");
    expect(output).not.toContain("deliberately long note");
  });

  it("creates selection state from the current model when possible", () => {
    expect(createModelSelectorState(models, "gpt-5-thinking")).toEqual({
      selectedIndex: 1,
      status: "selecting",
    });
  });

  it("moves selection with wrapping", () => {
    const state = createModelSelectorState(models, "gpt-5");

    expect(moveModelSelection(state, models, "up").selectedIndex).toBe(2);
    expect(moveModelSelection(state, models, "down").selectedIndex).toBe(1);
  });

  it("confirm and cancel return closed states and call callbacks", () => {
    const state = createModelSelectorState(models, "gpt-5-thinking");
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    const confirmed = confirmModelSelection(state, models, { onConfirm, onCancel });
    expect(confirmed).toEqual({
      selectedIndex: 1,
      selectedModelId: "gpt-5-thinking",
      status: "confirmed",
    });
    expect(onConfirm).toHaveBeenCalledWith(models[1]);

    const canceled = cancelModelSelection(state, { onConfirm, onCancel });
    expect(canceled).toEqual({ selectedIndex: 1, status: "cancelled" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("resolves key events into selection state transitions", () => {
    const state = createModelSelectorState(models, "gpt-5");
    const onConfirm = vi.fn();
    const onCancel = vi.fn();

    expect(
      resolveModelSelectorKey(state, models, { input: "", key: { downArrow: true } }),
    ).toMatchObject({ selectedIndex: 1, status: "selecting" });

    resolveModelSelectorKey(state, models, { input: "", key: { return: true } }, { onConfirm });
    expect(onConfirm).toHaveBeenCalledWith(models[0]);

    const canceled = resolveModelSelectorKey(
      state,
      models,
      { input: "\u001b", key: { escape: true } },
      { onCancel },
    );
    expect(canceled.status).toBe("cancelled");
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("renders formatted rows as an Ink component", () => {
    const output = renderToString(
      <ModelSelector
        currentModelId="gpt-5"
        models={models}
        state={createModelSelectorState(models, "gpt-5")}
      />,
    );

    expect(output).toContain("GPT-5");
    expect(output).toContain("current");
  });
});
