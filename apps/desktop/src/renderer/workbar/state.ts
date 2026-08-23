import { WORKBAR_TOOL_REGISTRY } from "./registry.js";
import type {
  WorkbarAction,
  WorkbarDock,
  WorkbarDockState,
  WorkbarDockStateOptions,
  WorkbarState,
  WorkbarStateOptions,
  WorkbarTab,
} from "./types.js";

export const WORKBAR_MIN_WIDTH = 320;
export const WORKBAR_MAX_WIDTH = 600;
export const WORKBAR_DEFAULT_WIDTH = 400;
export const WORKBAR_MIN_HEIGHT = 180;
export const WORKBAR_MAX_HEIGHT = 520;
export const WORKBAR_DEFAULT_HEIGHT = 300;

/** A fresh install deliberately starts with no implicitly opened tools. */
export const DEFAULT_WORKBAR_TABS: readonly WorkbarTab[] = [];

export function clampWorkbarWidth(width: number): number {
  if (!Number.isFinite(width)) return WORKBAR_DEFAULT_WIDTH;
  return Math.min(WORKBAR_MAX_WIDTH, Math.max(WORKBAR_MIN_WIDTH, Math.round(width)));
}

export function clampWorkbarHeight(height: number): number {
  if (!Number.isFinite(height)) return WORKBAR_DEFAULT_HEIGHT;
  return Math.min(WORKBAR_MAX_HEIGHT, Math.max(WORKBAR_MIN_HEIGHT, Math.round(height)));
}

export interface WorkbarPanelActivationContext {
  readonly sessionBound: boolean;
  readonly shellObscured?: boolean;
}

/** Domain panels use this gate to pause queries/subscriptions while remaining mounted. */
export function isWorkbarPanelActive(
  state: WorkbarState,
  dock: WorkbarDock,
  tabId: string,
  context: WorkbarPanelActivationContext,
): boolean {
  const dockState = state.docks[dock];
  return (
    context.sessionBound &&
    context.shellObscured !== true &&
    !dockState.collapsed &&
    !dockState.launcherOpen &&
    dockState.activeTabId === tabId
  );
}

export function createWorkbarState(options: WorkbarStateOptions = {}): WorkbarState {
  const rightOptions: WorkbarDockStateOptions = {
    tabs: options.docks?.right?.tabs ?? options.tabs ?? DEFAULT_WORKBAR_TABS,
    activeTabId: options.docks?.right?.activeTabId ?? options.activeTabId,
    mruTabIds: options.docks?.right?.mruTabIds ?? options.mruTabIds,
    collapsed: options.docks?.right?.collapsed ?? options.collapsed,
    launcherOpen: options.docks?.right?.launcherOpen,
  };
  const right = createDockState(rightOptions);
  const rightIds = new Set(right.tabs.map((tab) => tab.id));
  const bottom = createDockState({
    ...options.docks?.bottom,
    tabs: options.docks?.bottom?.tabs?.filter((tab) => !rightIds.has(tab.id)),
  });

  return withCompatibilityAliases({
    docks: { right, bottom },
    focusedDock: options.focusedDock ?? "right",
    rightWidth: clampWorkbarWidth(options.rightWidth ?? options.width ?? WORKBAR_DEFAULT_WIDTH),
    bottomHeight: clampWorkbarHeight(options.bottomHeight ?? WORKBAR_DEFAULT_HEIGHT),
  });
}

export function reduceWorkbarState(state: WorkbarState, action: WorkbarAction): WorkbarState {
  switch (action.type) {
    case "open": {
      const existingDock = findTabDock(state, action.tab.id);
      const dock = action.dock ?? existingDock ?? defaultDockForTab(action.tab);
      if (existingDock === dock) {
        const current = state.docks[dock];
        return updateDock(state, dock, {
          ...current,
          tabs: current.tabs.map((tab) => (tab.id === action.tab.id ? action.tab : tab)),
          activeTabId: action.tab.id,
          mruTabIds: promoteMru(current.mruTabIds, action.tab.id),
          collapsed: false,
          launcherOpen: false,
        });
      }
      const withoutTab = removeTabFromBoth(state, action.tab.id);
      const nextDock = withoutTab.docks[dock];
      return updateDock(withoutTab, dock, {
        ...nextDock,
        tabs: [...nextDock.tabs, action.tab],
        activeTabId: action.tab.id,
        mruTabIds: promoteMru(nextDock.mruTabIds, action.tab.id),
        collapsed: false,
        launcherOpen: false,
      });
    }

    case "openPreview": {
      const preview = { ...action.tab, preview: true, pinned: false } satisfies WorkbarTab;
      let next = removeTabFromBoth(state, preview.id);
      const dockState = next.docks[action.dock];
      const replaceableIds = new Set(
        dockState.tabs.filter((tab) => tab.preview && !tab.pinned).map((tab) => tab.id),
      );
      const tabs = [...dockState.tabs.filter((tab) => !replaceableIds.has(tab.id)), preview];
      next = updateDock(next, action.dock, {
        ...dockState,
        tabs,
        activeTabId: preview.id,
        mruTabIds: normalizeMru(tabs, preview.id, [
          preview.id,
          ...dockState.mruTabIds.filter((tabId) => !replaceableIds.has(tabId)),
        ]),
        collapsed: false,
        launcherOpen: false,
      });
      return next;
    }

    case "pinPreview": {
      const dock = findTabDock(state, action.tabId);
      if (!dock) return state;
      const dockState = state.docks[dock];
      const tab = dockState.tabs.find((candidate) => candidate.id === action.tabId);
      if (!tab?.preview) return state;
      return updateDock(state, dock, {
        ...dockState,
        tabs: dockState.tabs.map((candidate) =>
          candidate.id === action.tabId
            ? { ...candidate, preview: false, pinned: true }
            : candidate,
        ),
      });
    }

    case "select": {
      const dock = action.dock ?? findTabDock(state, action.tabId);
      if (!dock || !hasTab(state.docks[dock], action.tabId)) return state;
      const dockState = state.docks[dock];
      if (
        dockState.activeTabId === action.tabId &&
        !dockState.collapsed &&
        state.focusedDock === dock
      ) {
        return state;
      }
      return updateDock(state, dock, {
        ...dockState,
        activeTabId: action.tabId,
        mruTabIds: promoteMru(dockState.mruTabIds, action.tabId),
        collapsed: false,
        launcherOpen: false,
      });
    }

    case "close": {
      const dock = findTabDock(state, action.tabId);
      return dock ? closeTabs(state, dock, new Set([action.tabId])) : state;
    }

    case "closeOthers": {
      const dock = findTabDock(state, action.tabId);
      if (!dock) return state;
      const closeIds = new Set(
        state.docks[dock].tabs.filter((tab) => tab.id !== action.tabId).map((tab) => tab.id),
      );
      return closeTabs(state, dock, closeIds);
    }

    case "closeRight": {
      const dock = findTabDock(state, action.tabId);
      if (!dock) return state;
      const dockState = state.docks[dock];
      const index = dockState.tabs.findIndex((tab) => tab.id === action.tabId);
      if (index === -1) return state;
      return closeTabs(state, dock, new Set(dockState.tabs.slice(index + 1).map((tab) => tab.id)));
    }

    case "reorder": {
      const dock = action.dock ?? findTabDock(state, action.tabId);
      if (!dock || !Number.isInteger(action.toIndex)) return state;
      const dockState = state.docks[dock];
      const fromIndex = dockState.tabs.findIndex((tab) => tab.id === action.tabId);
      if (fromIndex === -1 || dockState.tabs.length < 2) return state;
      const toIndex = Math.min(dockState.tabs.length - 1, Math.max(0, action.toIndex));
      if (fromIndex === toIndex) return state;
      const tabs = [...dockState.tabs];
      const [moved] = tabs.splice(fromIndex, 1);
      if (!moved) return state;
      tabs.splice(toIndex, 0, moved);
      return updateDock(state, dock, { ...dockState, tabs });
    }

    case "moveDock": {
      const fromDock = findTabDock(state, action.tabId);
      if (!fromDock || fromDock === action.toDock) return state;
      const tab = state.docks[fromDock].tabs.find((candidate) => candidate.id === action.tabId);
      if (!tab) return state;
      let next = closeTabs(state, fromDock, new Set([action.tabId]));
      const target = next.docks[action.toDock];
      const toIndex = Math.min(
        target.tabs.length,
        Math.max(0, action.toIndex ?? target.tabs.length),
      );
      const tabs = [...target.tabs];
      tabs.splice(toIndex, 0, tab);
      next = updateDock(next, action.toDock, {
        ...target,
        tabs,
        activeTabId: tab.id,
        mruTabIds: promoteMru(target.mruTabIds, tab.id),
        collapsed: false,
        launcherOpen: false,
      });
      return next;
    }

    case "setLauncherOpen": {
      const dockState = state.docks[action.dock];
      if (dockState.launcherOpen === action.open && !(action.open && dockState.collapsed)) {
        return state;
      }
      return updateDock(state, action.dock, {
        ...dockState,
        launcherOpen: action.open,
        collapsed: action.open ? false : dockState.collapsed,
      });
    }

    case "setCollapsed": {
      const dock = action.dock ?? "right";
      const dockState = state.docks[dock];
      if (dockState.collapsed === action.collapsed) return state;
      return updateDock(state, dock, {
        ...dockState,
        collapsed: action.collapsed,
        launcherOpen: action.collapsed ? false : dockState.launcherOpen,
      });
    }

    case "setWidth": {
      const rightWidth = Number.isFinite(action.width)
        ? clampWorkbarWidth(action.width)
        : state.rightWidth;
      return rightWidth === state.rightWidth
        ? state
        : withCompatibilityAliases({ ...state, rightWidth });
    }

    case "setHeight": {
      const bottomHeight = Number.isFinite(action.height)
        ? clampWorkbarHeight(action.height)
        : state.bottomHeight;
      return bottomHeight === state.bottomHeight
        ? state
        : withCompatibilityAliases({ ...state, bottomHeight });
    }

    case "focusDock":
      return state.focusedDock === action.dock
        ? state
        : withCompatibilityAliases({ ...state, focusedDock: action.dock });
  }
}

function createDockState(options: WorkbarDockStateOptions = {}): WorkbarDockState {
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
  };
}

function closeTabs(
  state: WorkbarState,
  dock: WorkbarDock,
  closeIds: ReadonlySet<string>,
): WorkbarState {
  if (closeIds.size === 0) return state;
  const current = state.docks[dock];
  const tabs = current.tabs.filter((tab) => !closeIds.has(tab.id));
  if (tabs.length === current.tabs.length) return state;
  const remainingIds = new Set(tabs.map((tab) => tab.id));
  const mruTabIds = current.mruTabIds.filter((tabId) => remainingIds.has(tabId));
  const activeTabId =
    current.activeTabId !== null && remainingIds.has(current.activeTabId)
      ? current.activeTabId
      : (mruTabIds[0] ?? tabs[0]?.id ?? null);
  return updateDock(state, dock, {
    ...current,
    tabs,
    activeTabId,
    mruTabIds: normalizeMru(tabs, activeTabId, mruTabIds),
    collapsed: tabs.length === 0,
    launcherOpen: false,
  });
}

function removeTabFromBoth(state: WorkbarState, tabId: string): WorkbarState {
  let next = state;
  for (const dock of ["right", "bottom"] as const) {
    if (hasTab(next.docks[dock], tabId)) next = closeTabs(next, dock, new Set([tabId]));
  }
  return next;
}

function updateDock(
  state: WorkbarState,
  dock: WorkbarDock,
  dockState: WorkbarDockState,
): WorkbarState {
  return withCompatibilityAliases({
    ...state,
    docks: { ...state.docks, [dock]: dockState },
    focusedDock: dock,
  });
}

function withCompatibilityAliases(
  state: Omit<WorkbarState, "tabs" | "activeTabId" | "mruTabIds" | "collapsed" | "width"> &
    Partial<Pick<WorkbarState, "tabs" | "activeTabId" | "mruTabIds" | "collapsed" | "width">>,
): WorkbarState {
  const right = state.docks.right;
  return {
    ...state,
    tabs: right.tabs,
    activeTabId: right.activeTabId,
    mruTabIds: right.mruTabIds,
    collapsed: right.collapsed,
    width: state.rightWidth,
  };
}

function defaultDockForTab(tab: WorkbarTab): WorkbarDock {
  return WORKBAR_TOOL_REGISTRY.find((tool) => tool.kind === tab.kind)?.defaultDock ?? "right";
}

function findTabDock(state: WorkbarState, tabId: string): WorkbarDock | undefined {
  if (hasTab(state.docks.right, tabId)) return "right";
  if (hasTab(state.docks.bottom, tabId)) return "bottom";
  return undefined;
}

function hasTab(state: WorkbarDockState, tabId: string): boolean {
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
