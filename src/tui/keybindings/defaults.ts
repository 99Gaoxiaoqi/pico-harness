import type { KeybindingMap } from "./schema.js";

export const DEFAULT_KEYBINDINGS: KeybindingMap = {
  Global: {
    "ctrl+c": "app:interrupt",
    "ctrl+d": "app:exit",
    "ctrl+l": "app:redraw",
  },
  Chat: {
    "ctrl+a": "cursor:start",
    "ctrl+e": "cursor:end",
    "ctrl+u": "edit:clearBeforeCursor",
    "ctrl+w": "edit:deletePreviousWord",
    left: "cursor:left",
    right: "cursor:right",
    home: "cursor:start",
    end: "cursor:end",
    enter: "input:submit",
    "shift+enter": "input:newline",
    "meta+enter": "input:newline",
    up: "history:previous",
    down: "history:next",
    tab: "suggestion:accept",
  },
  Autocomplete: {
    tab: "suggestion:accept",
    enter: "suggestion:accept",
    up: "suggestion:previous",
    down: "suggestion:next",
    escape: "suggestion:dismiss",
  },
  Confirmation: {
    y: "confirmation:accept",
    enter: "confirmation:accept",
    n: "confirmation:cancel",
    escape: "confirmation:cancel",
  },
  Transcript: {
    "ctrl+e": "transcript:toggleShowAll",
    "ctrl+c": "transcript:exit",
    escape: "transcript:exit",
    q: "transcript:exit",
  },
};

