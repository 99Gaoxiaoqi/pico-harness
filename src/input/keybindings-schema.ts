/** Shared config schema. It intentionally lives outside src/tui so non-TUI hosts can load .pico/config.json. */
export const KEYBINDING_CONTEXTS = [
  "Global",
  "Chat",
  "Autocomplete",
  "Confirmation",
  "Transcript",
] as const;

export type KeybindingContext = (typeof KEYBINDING_CONTEXTS)[number];

export const KEYBINDING_ACTIONS = [
  "app:interrupt",
  "app:exit",
  "app:redraw",
  "cursor:start",
  "cursor:end",
  "cursor:left",
  "cursor:right",
  "edit:clearBeforeCursor",
  "edit:deletePreviousWord",
  "input:submit",
  "input:newline",
  "history:previous",
  "history:next",
  "suggestion:accept",
  "suggestion:previous",
  "suggestion:next",
  "suggestion:dismiss",
  "confirmation:accept",
  "confirmation:cancel",
  "transcript:exit",
  "transcript:toggleShowAll",
] as const;

export type KeybindingAction = (typeof KEYBINDING_ACTIONS)[number];
export type CommandKeybinding = `command:/${string}`;
export type KeybindingValue = KeybindingAction | CommandKeybinding | null;
export type KeybindingMap = Partial<Record<KeybindingContext, Record<string, KeybindingValue>>>;
