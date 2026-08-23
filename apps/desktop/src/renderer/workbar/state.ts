import type { WorkbarAction, WorkbarState, WorkbarStateOptions, WorkbarTab } from "./types.js";

export const WORKBAR_MIN_WIDTH = 320;
export const WORKBAR_MAX_WIDTH = 600;
export const WORKBAR_DEFAULT_WIDTH = 400;

export const DEFAULT_WORKBAR_TABS = [
  { id: "overview", kind: "overview", label: "概览" },
  { id: "review", kind: "review", label: "变更" },
  { id: "context", kind: "context", label: "上下文" },
] as const satisfies readonly WorkbarTab[];

export function clampWorkbarWidth(width: number): number {
  if (!Number.isFinite(width)) {
    return WORKBAR_DEFAULT_WIDTH;
  }
  return Math.min(WORKBAR_MAX_WIDTH, Math.max(WORKBAR_MIN_WIDTH, width));
}

export function createWorkbarState(options: WorkbarStateOptions = {}): WorkbarState {
  const tabs = uniqueTabs(options.tabs ?? DEFAULT_WORKBAR_TABS);
  const requestedActiveId = options.activeTabId ?? tabs[0]?.id ?? null;
  const activeTabId =
    requestedActiveId !== null && tabs.some((tab) => tab.id === requestedActiveId)
      ? requestedActiveId
      : (tabs[0]?.id ?? null);

  return {
    tabs,
    activeTabId,
    mruTabIds: normalizeMru(tabs, activeTabId, options.mruTabIds ?? []),
    collapsed: options.collapsed ?? false,
    width: clampWorkbarWidth(options.width ?? WORKBAR_DEFAULT_WIDTH),
  };
}

export function reduceWorkbarState(state: WorkbarState, action: WorkbarAction): WorkbarState {
  switch (action.type) {
    case "open": {
      const existingIndex = state.tabs.findIndex((tab) => tab.id === action.tab.id);
      const tabs = [...state.tabs];
      if (existingIndex === -1) {
        tabs.push(action.tab);
      } else {
        tabs[existingIndex] = action.tab;
      }
      return createWorkbarState({
        ...state,
        tabs,
        activeTabId: action.tab.id,
        mruTabIds: promoteMru(state.mruTabIds, action.tab.id),
      });
    }

    case "select": {
      if (action.tabId === state.activeTabId || !hasTab(state, action.tabId)) {
        return state;
      }
      return {
        ...state,
        activeTabId: action.tabId,
        mruTabIds: promoteMru(state.mruTabIds, action.tabId),
      };
    }

    case "close": {
      if (!hasTab(state, action.tabId)) {
        return state;
      }
      const tabs = state.tabs.filter((tab) => tab.id !== action.tabId);
      const remainingIds = new Set(tabs.map((tab) => tab.id));
      const mruTabIds = state.mruTabIds.filter((tabId) => remainingIds.has(tabId));
      const activeTabId =
        state.activeTabId === action.tabId
          ? (mruTabIds[0] ?? tabs[0]?.id ?? null)
          : state.activeTabId;
      return createWorkbarState({ ...state, tabs, activeTabId, mruTabIds });
    }

    case "reorder": {
      const fromIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (fromIndex === -1 || !Number.isInteger(action.toIndex)) {
        return state;
      }
      const toIndex = Math.min(state.tabs.length - 1, Math.max(0, action.toIndex));
      if (fromIndex === toIndex) {
        return state;
      }
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      if (!moved) {
        return state;
      }
      tabs.splice(toIndex, 0, moved);
      return { ...state, tabs };
    }

    case "setCollapsed":
      return action.collapsed === state.collapsed
        ? state
        : { ...state, collapsed: action.collapsed };

    case "setWidth": {
      const width = Number.isFinite(action.width) ? clampWorkbarWidth(action.width) : state.width;
      return width === state.width ? state : { ...state, width };
    }
  }
}

function hasTab(state: WorkbarState, tabId: string): boolean {
  return state.tabs.some((tab) => tab.id === tabId);
}

function uniqueTabs(tabs: readonly WorkbarTab[]): readonly WorkbarTab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    if (seen.has(tab.id)) {
      return false;
    }
    seen.add(tab.id);
    return true;
  });
}

function promoteMru(mruTabIds: readonly string[], tabId: string): readonly string[] {
  return [tabId, ...mruTabIds.filter((candidate) => candidate !== tabId)];
}

function normalizeMru(
  tabs: readonly WorkbarTab[],
  activeTabId: string | null,
  requestedMru: readonly string[],
): readonly string[] {
  const tabIds = new Set(tabs.map((tab) => tab.id));
  const seen = new Set<string>();
  const normalized: string[] = [];

  const append = (tabId: string | null): void => {
    if (tabId !== null && tabIds.has(tabId) && !seen.has(tabId)) {
      seen.add(tabId);
      normalized.push(tabId);
    }
  };

  append(activeTabId);
  requestedMru.forEach(append);
  tabs.forEach((tab) => append(tab.id));
  return normalized;
}
