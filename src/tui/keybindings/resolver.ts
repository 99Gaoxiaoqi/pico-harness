import { DEFAULT_KEYBINDINGS } from "./defaults.js";
import type {
  CommandKeybinding,
  KeybindingAction,
  KeybindingContext,
  KeybindingMap,
  KeybindingValue,
} from "./schema.js";

export type UserKeybindingConfig = KeybindingMap;

export interface KeybindingEvent {
  input: string;
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    leftArrow?: boolean;
    rightArrow?: boolean;
    home?: boolean;
    end?: boolean;
    return?: boolean;
    ctrl?: boolean;
    shift?: boolean;
    tab?: boolean;
    backspace?: boolean;
    delete?: boolean;
    meta?: boolean;
    escape?: boolean;
  };
}

export type ResolvedKeybinding =
  | { kind: "action"; action: KeybindingAction }
  | { kind: "command"; command: `/${string}` };

export function resolveKeybinding(
  event: KeybindingEvent,
  context: KeybindingContext,
  userBindings: UserKeybindingConfig = {},
): ResolvedKeybinding | null {
  const normalizedKey = normalizeKeybindingEvent(event);
  if (!normalizedKey) return null;

  const contextBinding = lookupBinding(normalizedKey, context, userBindings);
  if (contextBinding !== undefined) return parseBinding(contextBinding);

  if (context !== "Global") {
    const globalBinding = lookupBinding(normalizedKey, "Global", userBindings);
    if (globalBinding !== undefined) return parseBinding(globalBinding);
  }

  return null;
}

export function normalizeKeybindingEvent(event: KeybindingEvent): string | null {
  const base = baseKeyName(event);
  if (!base) return null;

  const modifiers = [];
  if (event.key.ctrl) modifiers.push("ctrl");
  if (event.key.shift) modifiers.push("shift");
  if (event.key.meta) modifiers.push("meta");

  return [...modifiers, base].join("+");
}

function lookupBinding(
  key: string,
  context: KeybindingContext,
  userBindings: UserKeybindingConfig,
): KeybindingValue | undefined {
  const userContextBindings = userBindings[context];
  if (userContextBindings && hasOwn(userContextBindings, key)) {
    return userContextBindings[key];
  }

  const defaultContextBindings = DEFAULT_KEYBINDINGS[context];
  if (defaultContextBindings && hasOwn(defaultContextBindings, key)) {
    return defaultContextBindings[key];
  }

  return undefined;
}

function parseBinding(binding: KeybindingValue): ResolvedKeybinding | null {
  if (binding === null) return null;
  if (isCommandBinding(binding)) {
    return { kind: "command", command: binding.slice("command:".length) as `/${string}` };
  }
  return { kind: "action", action: binding };
}

function isCommandBinding(binding: KeybindingValue): binding is CommandKeybinding {
  return typeof binding === "string" && binding.startsWith("command:/");
}

function baseKeyName(event: KeybindingEvent): string | null {
  const { input, key } = event;

  if (key.tab) return "tab";
  if (key.return) return "enter";
  if (key.upArrow) return "up";
  if (key.downArrow) return "down";
  if (key.leftArrow) return "left";
  if (key.rightArrow) return "right";
  if (key.home) return "home";
  if (key.end) return "end";
  if (key.backspace) return "backspace";
  if (key.delete) return "delete";
  if (key.escape || input === "\u001b") return "escape";
  if (input === " ") return "space";
  if (input.length === 1) return input.toLowerCase();

  return null;
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

