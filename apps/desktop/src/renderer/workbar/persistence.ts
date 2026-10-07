import { isStaticWorkbarToolTab } from "./registry.js";
import { createWorkbarState } from "./state.js";
import {
  isPersistedWorkbarTabKind,
  type PersistedWorkbarTabKind,
  type WorkbarState,
  type WorkbarTab,
} from "./types.js";

export const WORKBAR_PERSISTENCE_VERSION = 3;
export const WORKBAR_STORAGE_KEY = "pico.desktop.workbar";

export interface WorkbarStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface PersistedWorkbarTab {
  readonly id: string;
  readonly kind: PersistedWorkbarTabKind;
  readonly label: string;
}

interface PersistedWorkbarState {
  readonly version: 3;
  readonly layout: { readonly collapsed: boolean; readonly width: number };
  readonly tabs: readonly PersistedWorkbarTab[];
  readonly activeTabId: string | null;
  readonly mruTabIds: readonly string[];
}

export function serializeWorkbarState(state: WorkbarState): string {
  const tabs = state.tabs.filter(isPersistableTab);
  const persistedIds = new Set(tabs.map((tab) => tab.id));
  const mruTabIds = state.mruTabIds.filter((tabId) => persistedIds.has(tabId));
  const activeTabId = persistedIds.has(state.activeTabId ?? "")
    ? state.activeTabId
    : (mruTabIds[0] ?? tabs[0]?.id ?? null);
  const payload: PersistedWorkbarState = {
    version: WORKBAR_PERSISTENCE_VERSION,
    layout: { collapsed: state.collapsed, width: state.width },
    tabs,
    activeTabId,
    mruTabIds,
  };
  return JSON.stringify(payload);
}

export function parseWorkbarState(
  serialized: string,
  fallback: WorkbarState = createWorkbarState(),
): WorkbarState {
  try {
    const candidate: unknown = JSON.parse(serialized);
    if (isPersistedWorkbarState(candidate)) {
      return createWorkbarState({
        tabs: candidate.tabs,
        activeTabId: candidate.activeTabId,
        mruTabIds: candidate.mruTabIds,
        collapsed: candidate.layout.collapsed,
        width: candidate.layout.width,
      });
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export function loadWorkbarState(
  storage: WorkbarStorage,
  fallback: WorkbarState = createWorkbarState(),
  key = WORKBAR_STORAGE_KEY,
): WorkbarState {
  try {
    const serialized = storage.getItem(key);
    return serialized === null ? fallback : parseWorkbarState(serialized, fallback);
  } catch {
    return fallback;
  }
}

export function saveWorkbarState(
  storage: WorkbarStorage,
  state: WorkbarState,
  key = WORKBAR_STORAGE_KEY,
): boolean {
  try {
    storage.setItem(key, serializeWorkbarState(state));
    return true;
  } catch {
    return false;
  }
}

function isPersistableTab(tab: WorkbarTab): tab is PersistedWorkbarTab {
  return isStaticWorkbarToolTab(tab) && isPersistedWorkbarTabKind(tab.kind);
}

function isPersistedWorkbarState(value: unknown): value is PersistedWorkbarState {
  if (
    !isRecord(value) ||
    value.version !== WORKBAR_PERSISTENCE_VERSION ||
    !isPersistedLayout(value.layout) ||
    !Array.isArray(value.tabs) ||
    !value.tabs.every(isPersistedWorkbarTab)
  ) {
    return false;
  }
  const tabIds = new Set(value.tabs.map((tab) => tab.id));
  return (
    tabIds.size === value.tabs.length &&
    (value.activeTabId === null ||
      (typeof value.activeTabId === "string" && tabIds.has(value.activeTabId))) &&
    Array.isArray(value.mruTabIds) &&
    value.mruTabIds.every((tabId) => typeof tabId === "string" && tabIds.has(tabId)) &&
    new Set(value.mruTabIds).size === value.mruTabIds.length
  );
}

function isPersistedLayout(value: unknown): value is { collapsed: boolean; width: number } {
  return (
    isRecord(value) &&
    typeof value.collapsed === "boolean" &&
    typeof value.width === "number" &&
    Number.isFinite(value.width)
  );
}

function isPersistedWorkbarTab(value: unknown): value is PersistedWorkbarTab {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    isPersistedWorkbarTabKind(value.kind) &&
    value.id === value.kind &&
    typeof value.label === "string" &&
    value.label.length > 0
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
