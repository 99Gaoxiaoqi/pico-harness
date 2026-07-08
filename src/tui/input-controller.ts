import {
  MAX_SUGGESTIONS,
  markerForKind,
  stripMarker,
  type ActiveSuggestionSession,
  type InputSuggestion,
  type SuggestionKind,
} from "./suggestions.js";

const HISTORY_MAX = 20;

export type SuggestionSource = (query: string) => readonly InputSuggestion[];

export interface InputKey {
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
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
  fileMentionSuggestions?: SuggestionSource;
  onSubmit?: (text: string) => void;
}

export interface InputControllerState {
  text: string;
  activeSuggestions: ActiveSuggestionSession | null;
  history: string[];
  historyIndex: number | null;
  draft: string;
}

export interface InputControllerResult {
  state: InputControllerState;
  submittedText?: string;
}

interface SuggestionContext {
  kind: SuggestionKind;
  query: string;
  replaceStart: number;
  replaceEnd: number;
}

export function createInputControllerState(): InputControllerState {
  return {
    text: "",
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

  if (key.return && (key.meta || key.shift)) {
    return withText(state, `${state.text}\n`, options);
  }

  if (key.return) {
    return submit(state, options);
  }

  if (key.tab && state.activeSuggestions && state.activeSuggestions.items.length > 0) {
    return completeSuggestion(state, options);
  }

  if (key.backspace || key.delete) {
    return withText(state, state.text.slice(0, -1), options, { clearHistoryBrowse: true });
  }

  if (state.activeSuggestions && state.activeSuggestions.items.length > 0) {
    if (key.upArrow || key.downArrow) {
      return moveSuggestionSelection(state, key.upArrow ? -1 : 1);
    }
  }

  if (key.upArrow || key.downArrow) {
    return browseHistory(state, key.upArrow ? -1 : 1, options);
  }

  if (isPrintableInput(input, key)) {
    return withText(state, state.text + input, options, { clearHistoryBrowse: true });
  }

  return { state };
}

export function getSuggestionContext(text: string): SuggestionContext | null {
  const lineStart = text.lastIndexOf("\n") + 1;
  const line = text.slice(lineStart);

  if (line.startsWith("/") && !/\s/.test(line)) {
    return {
      kind: "slash",
      query: line.slice(1),
      replaceStart: lineStart,
      replaceEnd: text.length,
    };
  }

  const mention = /(^|\s)@([^\s]*)$/.exec(line);
  if (!mention) return null;

  const prefixLength = mention[1]?.length ?? 0;
  const query = mention[2] ?? "";
  const replaceStart = lineStart + mention.index + prefixLength;
  return {
    kind: "mention",
    query,
    replaceStart,
    replaceEnd: text.length,
  };
}

function withText(
  state: InputControllerState,
  text: string,
  options: InputControllerOptions,
  flags: { clearHistoryBrowse?: boolean } = {},
): InputControllerResult {
  const next = {
    ...state,
    text,
    activeSuggestions: buildSuggestionSession(text, options),
  };

  if (flags.clearHistoryBrowse) {
    next.historyIndex = null;
  }

  return { state: next };
}

function submit(
  state: InputControllerState,
  options: InputControllerOptions,
): InputControllerResult {
  const trimmed = state.text.trim();
  const next = {
    ...state,
    text: "",
    activeSuggestions: null,
    historyIndex: null,
    draft: "",
  };

  if (!trimmed) return { state: next };

  options.onSubmit?.(trimmed);
  return {
    state: {
      ...next,
      history: pushHistory(state.history, trimmed),
    },
    submittedText: trimmed,
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

  return withText(
    {
      ...state,
      historyIndex: null,
    },
    nextText,
    options,
  );
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
        activeSuggestions: buildSuggestionSession(state.history[historyIndex] ?? "", options),
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
        activeSuggestions: buildSuggestionSession(state.history[historyIndex] ?? "", options),
        historyIndex,
      },
    };
  }

  return {
    state: {
      ...state,
      text: state.draft,
      activeSuggestions: buildSuggestionSession(state.draft, options),
      historyIndex: null,
    },
  };
}

function buildSuggestionSession(
  text: string,
  options: InputControllerOptions,
): ActiveSuggestionSession | null {
  const context = getSuggestionContext(text);
  if (!context) return null;

  const source =
    context.kind === "slash" ? options.slashCommandSuggestions : options.fileMentionSuggestions;
  if (!source) return null;

  const items = source(context.query).slice(0, MAX_SUGGESTIONS);
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
      !key.shift &&
      !key.return &&
      !key.backspace &&
      !key.delete &&
      !key.upArrow &&
      !key.downArrow &&
      !key.leftArrow &&
      !key.rightArrow &&
      input.length > 0 &&
      !hasControlCharacter(input),
  );
}

function hasControlCharacter(input: string): boolean {
  for (const ch of input) {
    const code = ch.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}
