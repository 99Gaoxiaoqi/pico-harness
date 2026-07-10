import {
  markerForKind,
  stripMarker,
  type ActiveSuggestionSession,
  type InputSuggestion,
  type SuggestionKind,
} from "./suggestions.js";
import {
  resolveKeybinding,
  type ResolvedKeybinding,
  type UserKeybindingConfig,
} from "./keybindings/resolver.js";

const HISTORY_MAX = 20;

export type SuggestionSourceResult =
  | readonly InputSuggestion[]
  | Promise<readonly InputSuggestion[]>;

export type SuggestionSource = (query: string) => SuggestionSourceResult;
export type SlashArgumentSuggestionSource = (
  command: string,
  query: string,
) => SuggestionSourceResult;

export interface InputKey {
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
}

export interface InputControllerOptions {
  disabled?: boolean;
  slashCommandSuggestions?: SuggestionSource;
  slashArgumentSuggestions?: SlashArgumentSuggestionSource;
  fileMentionSuggestions?: SuggestionSource;
  keybindings?: UserKeybindingConfig;
}

export interface InputControllerState {
  text: string;
  cursor: number;
  activeSuggestions: ActiveSuggestionSession | null;
  history: string[];
  historyIndex: number | null;
  draft: string;
}

export interface InputControllerResult {
  state: InputControllerState;
  submittedText?: string;
}

export interface SuggestionContext {
  kind: SuggestionKind;
  query: string;
  replaceStart: number;
  replaceEnd: number;
  command?: string;
}

export function createInputControllerState(): InputControllerState {
  return {
    text: "",
    cursor: 0,
    activeSuggestions: null,
    history: [],
    historyIndex: null,
    draft: "",
  };
}

export function reduceInputControllerEvent(
  state: InputControllerState,
  input: string,
  key: InputKey,
  options: InputControllerOptions = {},
): InputControllerResult {
  if (options.disabled) return { state };

  const batchedReturn = splitTrailingReturnInput(input);
  if (batchedReturn !== null && !key.ctrl) {
    const nextState = batchedReturn.prefix
      ? insertText(state, normalizeInput(batchedReturn.prefix), options).state
      : state;
    if (key.meta || key.shift) {
      return insertText(nextState, "\n", options);
    }
    if (hasSelectableSuggestion(nextState)) {
      return completeSuggestion(nextState, options);
    }
    return submit(nextState);
  }

  const keybindingResult = reduceKeybindingInput(state, input, key, options);
  if (keybindingResult) return keybindingResult;

  if (key.backspace) {
    if (state.cursor === 0) return { state };
    return withText(
      state,
      state.text.slice(0, state.cursor - 1) + state.text.slice(state.cursor),
      state.cursor - 1,
      options,
      { clearHistoryBrowse: true },
    );
  }

  if (key.delete) {
    if (state.cursor >= state.text.length) return { state };
    return withText(
      state,
      state.text.slice(0, state.cursor) + state.text.slice(state.cursor + 1),
      state.cursor,
      options,
      { clearHistoryBrowse: true },
    );
  }

  if (state.activeSuggestions && state.activeSuggestions.items.length > 0) {
    if (key.upArrow || key.downArrow) {
      return moveSuggestionSelection(state, key.upArrow ? -1 : 1);
    }
  }

  if (isPrintableInput(input, key)) {
    return insertText(state, normalizeInput(input), options);
  }

  return { state };
}

export function getSuggestionContext(
  text: string,
  cursor = text.length,
): SuggestionContext | null {
  const safeCursor = clampCursor(cursor, text);
  const lineStart = text.lastIndexOf("\n", safeCursor - 1) + 1;
  const nextLineBreak = text.indexOf("\n", safeCursor);
  const lineEnd = nextLineBreak === -1 ? text.length : nextLineBreak;
  const line = text.slice(lineStart, lineEnd);
  const cursorInLine = safeCursor - lineStart;

  if (line.startsWith("/") && cursorInLine > 0) {
    const commandMatch = /^\/([^\s]+)\s+([^\s]*)$/.exec(line.slice(0, cursorInLine));
    if (commandMatch !== null) {
      const argStart = lineStart + cursorInLine - (commandMatch[2]?.length ?? 0);
      return {
        kind: "slash-argument",
        command: commandMatch[1] ?? "",
        query: commandMatch[2] ?? "",
        replaceStart: argStart,
        replaceEnd: lineStart + findTokenEnd(line, cursorInLine),
      };
    }

    const tokenEnd = findTokenEnd(line, cursorInLine);
    if (cursorInLine <= tokenEnd && !/\s/.test(line.slice(0, cursorInLine))) {
      return {
        kind: "slash",
        query: line.slice(1, cursorInLine),
        replaceStart: lineStart,
        replaceEnd: lineStart + tokenEnd,
      };
    }
  }

  const tokenStart = findTokenStart(line, cursorInLine);
  const tokenEnd = findTokenEnd(line, cursorInLine);
  const tokenBeforeCursor = line.slice(tokenStart, cursorInLine);
  if (!tokenBeforeCursor.startsWith("@")) return null;

  return {
    kind: "mention",
    query: tokenBeforeCursor.slice(1),
    replaceStart: lineStart + tokenStart,
    replaceEnd: lineStart + tokenEnd,
  };
}

function reduceKeybindingInput(
  state: InputControllerState,
  input: string,
  key: InputKey,
  options: InputControllerOptions,
): InputControllerResult | null {
  if (!isKeybindingManagedEvent(input, key)) return null;

  const context =
    hasSelectableSuggestion(state) && !(key.return && (key.meta || key.shift))
      ? "Autocomplete"
      : "Chat";
  const resolved = resolveKeybinding({ input, key }, context, options.keybindings);
  if (!resolved) return isPrintableInput(input, key) ? null : { state };

  return applyResolvedKeybinding(state, resolved, options);
}

function applyResolvedKeybinding(
  state: InputControllerState,
  resolved: ResolvedKeybinding,
  options: InputControllerOptions,
): InputControllerResult {
  if (resolved.kind === "command") return submitCommand(state, resolved.command);

  switch (resolved.action) {
    case "cursor:start":
      return setCursor(state, 0, options);
    case "cursor:end":
      return setCursor(state, state.text.length, options);
    case "cursor:left":
      return setCursor(state, state.cursor - 1, options);
    case "cursor:right":
      return setCursor(state, state.cursor + 1, options);
    case "edit:clearBeforeCursor":
      return clearBeforeCursorOnLine(state, options);
    case "edit:deletePreviousWord":
      return deletePreviousWord(state, options);
    case "input:newline":
      return insertText(state, "\n", options);
    case "input:submit":
      return submit(state);
    case "suggestion:accept":
      return hasSelectableSuggestion(state) ? completeSuggestion(state, options) : { state };
    case "suggestion:previous":
      return moveSuggestionSelection(state, -1);
    case "suggestion:next":
      return moveSuggestionSelection(state, 1);
    case "suggestion:dismiss":
      return { state: { ...state, activeSuggestions: null } };
    case "history:previous":
      return browseHistory(state, -1, options);
    case "history:next":
      return browseHistory(state, 1, options);
    default:
      return { state };
  }
}

function isKeybindingManagedEvent(input: string, key: InputKey): boolean {
  return Boolean(
    key.ctrl ||
      key.meta ||
      key.shift ||
      key.tab ||
      key.return ||
      key.upArrow ||
      key.downArrow ||
      key.leftArrow ||
      key.rightArrow ||
      key.home ||
      key.end ||
      input === "\u001b",
  );
}

function clearBeforeCursorOnLine(
  state: InputControllerState,
  options: InputControllerOptions,
): InputControllerResult {
  const lineStart = state.text.lastIndexOf("\n", state.cursor - 1) + 1;
  return withText(
    state,
    state.text.slice(0, lineStart) + state.text.slice(state.cursor),
    lineStart,
    options,
    { clearHistoryBrowse: true },
  );
}

function deletePreviousWord(
  state: InputControllerState,
  options: InputControllerOptions,
): InputControllerResult {
  if (state.cursor === 0) return { state };

  let start = state.cursor;
  while (start > 0 && /\s/.test(state.text[start - 1] ?? "")) start--;
  while (start > 0 && !/\s/.test(state.text[start - 1] ?? "")) start--;

  return withText(
    state,
    state.text.slice(0, start) + state.text.slice(state.cursor),
    start,
    options,
    { clearHistoryBrowse: true },
  );
}

function insertText(
  state: InputControllerState,
  input: string,
  options: InputControllerOptions,
): InputControllerResult {
  const text = normalizeInput(input);
  return withText(
    state,
    state.text.slice(0, state.cursor) + text + state.text.slice(state.cursor),
    state.cursor + text.length,
    options,
    { clearHistoryBrowse: true },
  );
}

function setCursor(
  state: InputControllerState,
  cursor: number,
  options: InputControllerOptions,
): InputControllerResult {
  return withText(state, state.text, cursor, options);
}

function findTokenStart(line: string, cursorInLine: number): number {
  let start = Math.min(cursorInLine, line.length);
  while (start > 0 && !/\s/.test(line[start - 1] ?? "")) start--;
  return start;
}

function findTokenEnd(line: string, cursorInLine: number): number {
  let end = Math.min(cursorInLine, line.length);
  while (end < line.length && !/\s/.test(line[end] ?? "")) end++;
  return end;
}

function clampCursor(cursor: number, text: string): number {
  return Math.max(0, Math.min(cursor, text.length));
}

function normalizeInput(input: string): string {
  return input.replace(/\r\n?/g, "\n");
}

function splitTrailingReturnInput(input: string): { prefix: string } | null {
  if (!input.endsWith("\r") && !input.endsWith("\n")) return null;
  const withoutReturn = input.replace(/(?:\r\n?|\n)$/, "");
  return { prefix: withoutReturn };
}

function withText(
  state: InputControllerState,
  text: string,
  cursor: number,
  options: InputControllerOptions,
  flags: { clearHistoryBrowse?: boolean } = {},
): InputControllerResult {
  const nextCursor = clampCursor(cursor, text);
  const next = {
    ...state,
    text,
    cursor: nextCursor,
    activeSuggestions: buildSuggestionSession(text, nextCursor, options),
  };

  if (flags.clearHistoryBrowse) {
    next.historyIndex = null;
  }

  return { state: next };
}

function submit(state: InputControllerState): InputControllerResult {
  const trimmed = state.text.trim();
  const next = {
    ...state,
    text: "",
    cursor: 0,
    activeSuggestions: null,
    historyIndex: null,
    draft: "",
  };

  if (!trimmed) return { state: next };

  return {
    state: {
      ...next,
      history: pushHistory(state.history, trimmed),
    },
    submittedText: trimmed,
  };
}

function submitCommand(state: InputControllerState, command: `/${string}`): InputControllerResult {
  return {
    state: {
      ...state,
      text: "",
      cursor: 0,
      activeSuggestions: null,
      historyIndex: null,
      draft: "",
      history: pushHistory(state.history, command),
    },
    submittedText: command,
  };
}

function completeSuggestion(
  state: InputControllerState,
  options: InputControllerOptions,
): InputControllerResult {
  const session = state.activeSuggestions;
  if (!session) return { state };

  const item = session.items[session.selectedIndex];
  if (!item) return { state };

  const marker = markerForKind(session.kind);
  const replacement = `${marker}${stripMarker(item.insertText ?? item.value, session.kind)} `;
  const nextText =
    state.text.slice(0, session.replaceStart) + replacement + state.text.slice(session.replaceEnd);
  const nextCursor = session.replaceStart + replacement.length;

  return withText(
    {
      ...state,
      historyIndex: null,
    },
    nextText,
    nextCursor,
    options,
  );
}

function hasSelectableSuggestion(state: InputControllerState): boolean {
  return Boolean(state.activeSuggestions && state.activeSuggestions.items.length > 0);
}

function moveSuggestionSelection(
  state: InputControllerState,
  delta: number,
): InputControllerResult {
  const session = state.activeSuggestions;
  if (!session) return { state };

  const count = session.items.length;
  const selectedIndex = (session.selectedIndex + delta + count) % count;
  return {
    state: {
      ...state,
      activeSuggestions: {
        ...session,
        selectedIndex,
      },
    },
  };
}

function browseHistory(
  state: InputControllerState,
  direction: -1 | 1,
  options: InputControllerOptions,
): InputControllerResult {
  if (state.history.length === 0) return { state };

  if (direction === -1) {
    const historyIndex =
      state.historyIndex === null ? state.history.length - 1 : Math.max(0, state.historyIndex - 1);
    const draft = state.historyIndex === null ? state.text : state.draft;
    return {
      state: {
        ...state,
        text: state.history[historyIndex] ?? "",
        cursor: (state.history[historyIndex] ?? "").length,
        activeSuggestions: buildSuggestionSession(
          state.history[historyIndex] ?? "",
          (state.history[historyIndex] ?? "").length,
          options,
        ),
        historyIndex,
        draft,
      },
    };
  }

  if (state.historyIndex === null) return { state };

  if (state.historyIndex < state.history.length - 1) {
    const historyIndex = state.historyIndex + 1;
    return {
      state: {
        ...state,
        text: state.history[historyIndex] ?? "",
        cursor: (state.history[historyIndex] ?? "").length,
        activeSuggestions: buildSuggestionSession(
          state.history[historyIndex] ?? "",
          (state.history[historyIndex] ?? "").length,
          options,
        ),
        historyIndex,
      },
    };
  }

  return {
    state: {
      ...state,
      text: state.draft,
      cursor: state.draft.length,
      activeSuggestions: buildSuggestionSession(state.draft, state.draft.length, options),
      historyIndex: null,
    },
  };
}

function buildSuggestionSession(
  text: string,
  cursor: number,
  options: InputControllerOptions,
): ActiveSuggestionSession | null {
  const context = getSuggestionContext(text, cursor);
  if (!context) return null;

  const items = suggestionItemsForContext(context, options);
  if (items.length === 0) return null;

  return {
    kind: context.kind,
    query: context.query,
    replaceStart: context.replaceStart,
    replaceEnd: context.replaceEnd,
    selectedIndex: 0,
    items: [...items],
  };
}

function suggestionItemsForContext(
  context: SuggestionContext,
  options: InputControllerOptions,
): readonly InputSuggestion[] {
  if (context.kind === "slash") {
    return syncSuggestionItems(options.slashCommandSuggestions?.(context.query) ?? []);
  }
  if (context.kind === "slash-argument") {
    return syncSuggestionItems(
      options.slashArgumentSuggestions?.(context.command ?? "", context.query) ?? [],
    );
  }
  return syncSuggestionItems(options.fileMentionSuggestions?.(context.query) ?? []);
}

function syncSuggestionItems(result: SuggestionSourceResult): readonly InputSuggestion[] {
  return isPromiseLike(result) ? [] : result;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return Boolean(
    typeof value === "object" &&
      value !== null &&
      "then" in value &&
      typeof (value as { then?: unknown }).then === "function",
  );
}

function pushHistory(history: string[], entry: string): string[] {
  if (history[history.length - 1] === entry) return history;
  const next = [...history, entry];
  if (next.length > HISTORY_MAX) next.shift();
  return next;
}

function isPrintableInput(input: string, key: InputKey): boolean {
  return Boolean(
    input &&
      !key.ctrl &&
      !key.meta &&
      !key.return &&
      !key.backspace &&
      !key.delete &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      !key.home &&
      !key.end &&
      input.length > 0 &&
      !hasUnsupportedControlCharacter(input),
  );
}

function hasUnsupportedControlCharacter(input: string): boolean {
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (ch === "\n" || ch === "\r") continue;
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
