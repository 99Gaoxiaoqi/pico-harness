import type { WorkbarAction, WorkbarState, WorkbarStateOptions, WorkbarTab } from "./types.js";

export const WORKBAR_MIN_WIDTH = 320;
export const WORKBAR_MAX_WIDTH = 960;
export const WORKBAR_DEFAULT_WIDTH = 600;

export function clampWorkbarWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKBAR_DEFAULT_WIDTH;
  return Math.min(WORKBAR_MAX_WIDTH, Math.max(WORKBAR_MIN_WIDTH, Math.round(width)));
}

export interface WorkbarPanelActivationContext {
  readonly sessionBound: boolean;
  readonly shellObscured?: boolean;
}

/** Domain panels use this gate to pause queries/subscriptions while remaining mounted. */
export function isWorkbarPanelActive(
  state: WorkbarState,
  tabId: string,
  context: WorkbarPanelActivationContext,
): boolean {
  return (
    context.sessionBound &&
    context.shellObscured !== true &&
    !state.collapsed &&
    !state.launcherOpen &&
    state.activeTabId === tabId
  );
}

export function createWorkbarState(options: WorkbarStateOptions = {}): WorkbarState {
  const tabs = uniqueTabs(options.tabs ?? []);
  const requestedActiveId = options.activeTabId ?? tabs[0]?.id ?? null;
  const activeTabId =
    requestedActiveId !== null && tabs.some((tab) => tab.id === requestedActiveId)
      ? requestedActiveId
      : (tabs[0]?.id ?? null);
  return {
    tabs,
    activeTabId,
    mruTabIds: normalizeMru(tabs, activeTabId, options.mruTabIds ?? []),
    collapsed: options.collapsed ?? true,
    launcherOpen: options.launcherOpen ?? false,
    width: clampWorkbarWidth(options.width ?? WORKBAR_DEFAULT_WIDTH),
  };
}

export function reduceWorkbarState(state: WorkbarState, action: WorkbarAction): WorkbarState {
  switch (action.type) {
    case "openTerminal": {
      if (action.tab.kind !== "terminal") return state;
      const existing = state.mruTabIds
        .map((id) => state.tabs.find((tab) => tab.id === id && tab.kind === "terminal"))
        .find((tab) => tab !== undefined);
      if (action.mode !== "new" && existing) {
        if (
          action.mode === "toggle" &&
          state.activeTabId === existing.id &&
          !state.collapsed &&
          !state.launcherOpen
        ) {
          return reduceWorkbarState(state, { type: "setCollapsed", collapsed: true });
        }
        return reduceWorkbarState(state, { type: "select", tabId: existing.id });
      }
      const terminals = state.tabs.filter((tab) => tab.kind === "terminal");
      const ordinal =
        terminals.reduce((maximum, tab) => {
          const index = Number(tab.label.match(/ · (\d+)$/u)?.[1] ?? 0);
          return Math.max(maximum, index);
        }, 0) + 1;
      return reduceWorkbarState(
        terminals.length === 0
          ? { ...state, width: Math.max(state.width, WORKBAR_DEFAULT_WIDTH) }
          : state,
        { type: "open", tab: { ...action.tab, label: `${action.tab.label} · ${ordinal}` } },
      );
    }
    case "open": {
      const exists = hasTab(state, action.tab.id);
      return {
        ...state,
        tabs: exists
          ? state.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab))
          : [...state.tabs, action.tab],
        activeTabId: action.tab.id,
        mruTabIds: promoteMru(state.mruTabIds, action.tab.id),
        collapsed: false,
        launcherOpen: false,
      };
    }

    case "openPreview": {
      const preview = { ...action.tab, preview: true, pinned: false } satisfies WorkbarTab;
      let next = closeTabs(state, new Set([preview.id]));
      const replaceableIds = new Set(
        next.tabs.filter((tab) => tab.preview && !tab.pinned).map((tab) => tab.id),
      );
      const tabs = [...next.tabs.filter((tab) => !replaceableIds.has(tab.id)), preview];
      next = {
        ...next,
        tabs,
        activeTabId: preview.id,
        mruTabIds: normalizeMru(tabs, preview.id, [
          preview.id,
          ...next.mruTabIds.filter((tabId) => !replaceableIds.has(tabId)),
        ]),
        collapsed: false,
        launcherOpen: false,
      };
      return next;
    }

    case "pinPreview": {
      const tab = state.tabs.find((candidate) => candidate.id === action.tabId);
      if (!tab?.preview) return state;
      return {
        ...state,
        tabs: state.tabs.map((candidate) =>
          candidate.id === action.tabId
            ? { ...candidate, preview: false, pinned: true }
            : candidate,
        ),
      };
    }

    case "select": {
      if (!hasTab(state, action.tabId)) return state;
      if (state.activeTabId === action.tabId && !state.collapsed && !state.launcherOpen) {
        return state;
      }
      return {
        ...state,
        activeTabId: action.tabId,
        mruTabIds: promoteMru(state.mruTabIds, action.tabId),
        collapsed: false,
        launcherOpen: false,
      };
    }

    case "close": {
      return closeTabs(state, new Set([action.tabId]));
    }

    case "closeOthers": {
      if (!hasTab(state, action.tabId)) return state;
      const closeIds = new Set(
        state.tabs.filter((tab) => tab.id !== action.tabId).map((tab) => tab.id),
      );
      return closeTabs(state, closeIds);
    }

    case "closeRight": {
      const index = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index === -1) return state;
      return closeTabs(state, new Set(state.tabs.slice(index + 1).map((tab) => tab.id)));
    }

    case "reorder": {
      if (!Number.isInteger(action.toIndex)) return state;
      const fromIndex = state.tabs.findIndex((tab) => tab.id === action.tabId);
      if (fromIndex === -1 || state.tabs.length < 2) return state;
      const toIndex = Math.min(state.tabs.length - 1, Math.max(0, action.toIndex));
      if (fromIndex === toIndex) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      if (!moved) return state;
      tabs.splice(toIndex, 0, moved);
      return { ...state, tabs };
    }

    case "setLauncherOpen": {
      if (state.launcherOpen === action.open && !(action.open && state.collapsed)) {
        return state;
      }
      return {
        ...state,
        launcherOpen: action.open,
        collapsed: action.open ? false : state.collapsed,
      };
    }

    case "setCollapsed": {
      if (state.collapsed === action.collapsed) return state;
      return {
        ...state,
        collapsed: action.collapsed,
        launcherOpen: action.collapsed ? false : state.launcherOpen,
      };
    }

    case "setWidth": {
      const width = Number.isFinite(action.width) ? clampWorkbarWidth(action.width) : state.width;
      return width === state.width ? state : { ...state, width };
    }
  }
}

function closeTabs(state: WorkbarState, closeIds: ReadonlySet<string>): WorkbarState {
  if (closeIds.size === 0) return state;
  const current = state;
  const tabs = current.tabs.filter((tab) => !closeIds.has(tab.id));
  if (tabs.length === current.tabs.length) return state;
  const remainingIds = new Set(tabs.map((tab) => tab.id));
  const mruTabIds = current.mruTabIds.filter((tabId) => remainingIds.has(tabId));
  const activeTabId =
    current.activeTabId !== null && remainingIds.has(current.activeTabId)
      ? current.activeTabId
      : (mruTabIds[0] ?? tabs[0]?.id ?? null);
  return {
    ...state,
    tabs,
    activeTabId,
    mruTabIds: normalizeMru(tabs, activeTabId, mruTabIds),
    collapsed: tabs.length === 0,
    launcherOpen: false,
  };
}

function hasTab(state: WorkbarState, tabId: string): boolean {
  return state.tabs.some((tab) => tab.id === tabId);
}

function uniqueTabs(tabs: readonly WorkbarTab[]): readonly WorkbarTab[] {
  const seen = new Set<string>();
  return tabs.filter((tab) => {
    if (seen.has(tab.id)) return false;
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
