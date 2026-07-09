import { describe, expect, it } from "vitest";
import {
  resolveKeybinding,
  type KeybindingEvent,
  type UserKeybindingConfig,
} from "../../src/tui/keybindings/resolver.js";

function event(input = "", key: Partial<KeybindingEvent["key"]> = {}): KeybindingEvent {
  return {
    input,
    key: {
      ctrl: false,
      shift: false,
      tab: false,
      return: false,
      upArrow: false,
      downArrow: false,
      leftArrow: false,
      rightArrow: false,
      home: false,
      end: false,
      backspace: false,
      delete: false,
      meta: false,
      ...key,
    },
  };
}

describe("keybinding resolver", () => {
  it("resolves default Chat editing shortcuts", () => {
    expect(resolveKeybinding(event("a", { ctrl: true }), "Chat")).toEqual({
      kind: "action",
      action: "cursor:start",
    });
  });

  it("resolves default Autocomplete shortcuts", () => {
    expect(resolveKeybinding(event("", { tab: true }), "Autocomplete")).toEqual({
      kind: "action",
      action: "suggestion:accept",
    });
  });

  it("lets user bindings map a key to a slash command", () => {
    const userBindings: UserKeybindingConfig = {
      Chat: {
        "ctrl+m": "command:/model",
      },
    };

    expect(resolveKeybinding(event("m", { ctrl: true }), "Chat", userBindings)).toEqual({
      kind: "command",
      command: "/model",
    });
  });

  it("lets user bindings override a default key with another action", () => {
    const userBindings: UserKeybindingConfig = {
      Chat: {
        "ctrl+a": "cursor:end",
      },
    };

    expect(resolveKeybinding(event("a", { ctrl: true }), "Chat", userBindings)).toEqual({
      kind: "action",
      action: "cursor:end",
    });
  });

  it("lets user bindings disable a default shortcut with null", () => {
    const userBindings: UserKeybindingConfig = {
      Chat: {
        "ctrl+a": null,
      },
    };

    expect(resolveKeybinding(event("a", { ctrl: true }), "Chat", userBindings)).toBeNull();
  });
});
