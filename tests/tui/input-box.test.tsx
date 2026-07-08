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
  home: false,
  end: false,
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
    expect(state.cursor).toBe("/skills ".length);
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
    expect(state.cursor).toBe("open @src/tui/suggestions.tsx ".length);
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

  it("moves the cursor with arrows, Home/End, and Ctrl+A/Ctrl+E", () => {
    const options: InputControllerOptions = {};
    let state = typeText("hello", options);

    state = reduceInputControllerEvent(state, "", key({ leftArrow: true }), options).state;
    state = reduceInputControllerEvent(state, "", key({ leftArrow: true }), options).state;
    expect(state.cursor).toBe(3);

    state = reduceInputControllerEvent(state, "", key({ rightArrow: true }), options).state;
    expect(state.cursor).toBe(4);

    state = reduceInputControllerEvent(state, "", key({ leftArrow: true }), options).state;
    state = reduceInputControllerEvent(state, "X", key({}), options).state;
    expect(state.text).toBe("helXlo");
    expect(state.cursor).toBe(4);

    state = reduceInputControllerEvent(state, "", key({ home: true }), options).state;
    expect(state.cursor).toBe(0);

    state = reduceInputControllerEvent(state, "a", key({ ctrl: true }), options).state;
    expect(state.cursor).toBe(0);

    state = reduceInputControllerEvent(state, "", key({ end: true }), options).state;
    expect(state.cursor).toBe(state.text.length);

    state = reduceInputControllerEvent(state, "e", key({ ctrl: true }), options).state;
    expect(state.cursor).toBe(state.text.length);
  });

  it("Ctrl+U clears the line and Ctrl+W deletes the previous word", () => {
    const options: InputControllerOptions = {};
    let state = typeText("open src/tui/input-box.tsx", options);

    state = reduceInputControllerEvent(state, "w", key({ ctrl: true }), options).state;

    expect(state.text).toBe("open ");
    expect(state.cursor).toBe("open ".length);

    state = typeText("one two", options, state);
    state = reduceInputControllerEvent(state, "u", key({ ctrl: true }), options).state;

    expect(state.text).toBe("");
    expect(state.cursor).toBe(0);
  });

  it("keeps pasted multiline text as content and still uses Alt/Shift+Enter for newlines", () => {
    const options: InputControllerOptions = {};
    let state = reduceInputControllerEvent(
      createInputControllerState(),
      "line 1\nline 2",
      key({}),
      options,
    ).state;

    expect(state.text).toBe("line 1\nline 2");
    expect(state.cursor).toBe("line 1\nline 2".length);

    state = reduceInputControllerEvent(state, "", key({ return: true, shift: true }), options).state;
    state = reduceInputControllerEvent(state, "line 3", key({}), options).state;

    expect(state.text).toBe("line 1\nline 2\nline 3");
  });

  it("completes the slash token at the cursor without replacing trailing text", () => {
    const options: InputControllerOptions = {
      slashCommandSuggestions: (query) =>
        [
          { value: "status", description: "显示状态" },
          { value: "skills", description: "列出 skills" },
        ].filter((item) => item.value.startsWith(query)),
    };
    let state = typeText("/st and keep", options);
    for (let i = 0; i < " and keep".length; i++) {
      state = reduceInputControllerEvent(state, "", key({ leftArrow: true }), options).state;
    }

    expect(state.activeSuggestions?.kind).toBe("slash");
    expect(state.activeSuggestions?.query).toBe("st");

    state = reduceInputControllerEvent(state, "", key({ tab: true }), options).state;

    expect(state.text).toBe("/status  and keep");
    expect(state.cursor).toBe("/status ".length);
  });

  it("completes the @ token at the cursor without replacing trailing text", () => {
    const options: InputControllerOptions = {
      fileMentionSuggestions: (query) =>
        [
          { value: "src/tui/input-box.tsx", description: "file" },
          { value: "src/tui/suggestions.tsx", description: "file" },
        ].filter((item) => item.value.startsWith(query)),
    };
    let state = typeText("open @src/t later", options);
    for (let i = 0; i < " later".length; i++) {
      state = reduceInputControllerEvent(state, "", key({ leftArrow: true }), options).state;
    }

    expect(state.activeSuggestions?.kind).toBe("mention");
    expect(state.activeSuggestions?.query).toBe("src/t");

    state = reduceInputControllerEvent(state, "", key({ downArrow: true }), options).state;
    state = reduceInputControllerEvent(state, "", key({ tab: true }), options).state;

    expect(state.text).toBe("open @src/tui/suggestions.tsx  later");
    expect(state.cursor).toBe("open @src/tui/suggestions.tsx ".length);
  });
});
