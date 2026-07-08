import { describe, expect, it, vi } from "vitest";
import {
  createInputControllerState,
  reduceInputControllerEvent,
  type InputControllerOptions,
  type InputKey,
} from "../../src/tui/input-controller.js";

const baseKey: InputKey = {
  upArrow: false,
  downArrow: false,
  leftArrow: false,
  rightArrow: false,
  return: false,
  ctrl: false,
  shift: false,
  tab: false,
  backspace: false,
  delete: false,
  meta: false,
};

function key(overrides: Partial<InputKey>): InputKey {
  return { ...baseKey, ...overrides };
}

function typeText(
  value: string,
  options: InputControllerOptions,
  initial = createInputControllerState(),
) {
  return reduceInputControllerEvent(initial, value, key({}), options).state;
}

describe("InputBox input controller", () => {
  it("/sk + Tab completes the selected slash command", () => {
    const options: InputControllerOptions = {
      slashCommandSuggestions: (query) =>
        [
          { value: "help", description: "显示帮助" },
          { value: "skills", description: "列出 skills" },
        ].filter((item) => item.value.startsWith(query)),
    };
    let state = typeText("/sk", options);

    expect(state.activeSuggestions?.kind).toBe("slash");
    expect(state.activeSuggestions?.items).toEqual([
      { value: "skills", description: "列出 skills" },
    ]);

    state = reduceInputControllerEvent(state, "", key({ tab: true }), options).state;

    expect(state.text).toBe("/skills ");
    expect(state.activeSuggestions).toBeNull();
  });

  it("@src/t + Tab completes the selected file mention", () => {
    const options: InputControllerOptions = {
      fileMentionSuggestions: (query) =>
        [
          { value: "src/tui/input-box.tsx", description: "file" },
          { value: "src/tui/suggestions.tsx", description: "file" },
        ].filter((item) => item.value.startsWith(query)),
    };
    let state = typeText("open @src/t", options);

    expect(state.activeSuggestions?.kind).toBe("mention");
    expect(state.activeSuggestions?.items).toHaveLength(2);

    state = reduceInputControllerEvent(state, "", key({ downArrow: true }), options).state;
    state = reduceInputControllerEvent(state, "", key({ tab: true }), options).state;

    expect(state.text).toBe("open @src/tui/suggestions.tsx ");
    expect(state.activeSuggestions).toBeNull();
  });

  it("arrow keys move suggestion selection before falling back to history", () => {
    const options: InputControllerOptions = {
      slashCommandSuggestions: () => [
        { value: "help", description: "显示帮助" },
        { value: "status", description: "显示状态" },
      ],
    };
    let state = createInputControllerState();
    let result = reduceInputControllerEvent(state, "first", key({}), options);
    state = result.state;
    result = reduceInputControllerEvent(state, "", key({ return: true }), options);
    state = result.state;

    state = reduceInputControllerEvent(state, "/", key({}), options).state;
    state = reduceInputControllerEvent(state, "", key({ downArrow: true }), options).state;

    expect(state.activeSuggestions?.selectedIndex).toBe(1);
    expect(state.text).toBe("/");

    state = reduceInputControllerEvent(state, "\b", key({ backspace: true }), options).state;
    state = reduceInputControllerEvent(state, "", key({ upArrow: true }), options).state;

    expect(state.text).toBe("first");
  });

  it("Enter submits current text and keeps multiline/history behavior", () => {
    const onSubmit = vi.fn();
    const options: InputControllerOptions = { onSubmit };
    let state = typeText("line 1", options);
    state = reduceInputControllerEvent(state, "", key({ return: true, shift: true }), options).state;
    state = typeText("line 2", options, state);

    const result = reduceInputControllerEvent(state, "", key({ return: true }), options);

    expect(onSubmit).toHaveBeenCalledWith("line 1\nline 2");
    expect(result.submittedText).toBe("line 1\nline 2");
    expect(result.state.text).toBe("");

    const historyState = reduceInputControllerEvent(
      result.state,
      "",
      key({ upArrow: true }),
      options,
    ).state;
    expect(historyState.text).toBe("line 1\nline 2");
  });

  it("disabled input ignores typing, candidates, completion, and submit", () => {
    const onSubmit = vi.fn();
    const options: InputControllerOptions = {
      disabled: true,
      onSubmit,
      slashCommandSuggestions: () => [{ value: "help", description: "显示帮助" }],
    };

    let state = typeText("/", options);
    state = reduceInputControllerEvent(state, "", key({ tab: true }), options).state;
    state = reduceInputControllerEvent(state, "", key({ return: true }), options).state;

    expect(state.text).toBe("");
    expect(state.activeSuggestions).toBeNull();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
