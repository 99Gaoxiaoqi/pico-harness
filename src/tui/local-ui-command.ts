import type {
  LocalCommandResult,
  LocalUiCommandAction,
  LocalUiPanel,
  LocalUiSelector,
} from "../input/types.js";

const LOCAL_UI_PANELS = new Set<LocalUiPanel>(["help", "model", "sessions", "rewind", "hooks"]);
const LOCAL_UI_SELECTORS = new Set<LocalUiSelector>(["model", "session", "rewind"]);

export function hasLocalUiCommandAction(
  result: LocalCommandResult,
): result is LocalCommandResult & { ui: LocalUiCommandAction } {
  return isLocalUiCommandAction(result.ui);
}

export function isLocalUiCommandAction(value: unknown): value is LocalUiCommandAction {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const action = value as Partial<LocalUiCommandAction>;
  if (action.kind === "open-panel") {
    return typeof action.panel === "string" && LOCAL_UI_PANELS.has(action.panel as LocalUiPanel);
  }

  if (action.kind === "open-selector") {
    return (
      typeof action.selector === "string" &&
      LOCAL_UI_SELECTORS.has(action.selector as LocalUiSelector)
    );
  }

  return false;
}
