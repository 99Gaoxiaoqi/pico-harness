import { createWorkbarToolTab, isStaticWorkbarToolTab } from "./registry.js";
import { createWorkbarState } from "./state.js";
import {
  isPersistedWorkbarTabKind,
  isWorkbarDock,
  type PersistedWorkbarTabKind,
  type WorkbarDock,
  type WorkbarState,
  type WorkbarTab,
} from "./types.js";

export const WORKBAR_PERSISTENCE_VERSION = 2;
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

interface PersistedDockState {
  readonly tabs: readonly PersistedWorkbarTab[];
  readonly activeTabId: string | null;
  readonly mruTabIds: readonly string[];
}

interface PersistedWorkbarStateV2 {
  readonly version: 2;
  readonly layout: {
    readonly focusedDock: WorkbarDock;
    readonly right: { readonly collapsed: boolean; readonly width: number };
    readonly bottom: { readonly collapsed: boolean; readonly height: number };
  };
  readonly docks: Readonly<Record<WorkbarDock, PersistedDockState>>;
}

interface PersistedWorkbarStateV1 {
  readonly version: 1;
  readonly layout: { readonly collapsed: boolean; readonly width: number };
  readonly tabs: readonly LegacyPersistedTab[];
  readonly activeTabId: string | null;
  readonly mruTabIds: readonly string[];
}

interface LegacyPersistedTab {
  readonly id: string;
  readonly kind: "overview" | "review" | "context";
  readonly label: string;
}

export function serializeWorkbarState(state: WorkbarState): string {
  const payload: PersistedWorkbarStateV2 = {
    version: WORKBAR_PERSISTENCE_VERSION,
    layout: {
      focusedDock: state.focusedDock,
      right: { collapsed: state.docks.right.collapsed, width: state.rightWidth },
      bottom: { collapsed: state.docks.bottom.collapsed, height: state.bottomHeight },
    },
    docks: {
      right: serializeDock(
        state.docks.right.tabs,
        state.docks.right.activeTabId,
        state.docks.right.mruTabIds,
      ),
      bottom: serializeDock(
        state.docks.bottom.tabs,
        state.docks.bottom.activeTabId,
        state.docks.bottom.mruTabIds,
      ),
    },
  };
  return JSON.stringify(payload);
}

export function parseWorkbarState(
  serialized: string,
  fallback: WorkbarState = createWorkbarState(),
): WorkbarState {
  try {
    const candidate: unknown = JSON.parse(serialized);
    if (isPersistedWorkbarStateV2(candidate)) return restoreV2(candidate);
    if (isPersistedWorkbarStateV1(candidate)) return migrateV1(candidate);
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

function serializeDock(
  allTabs: readonly WorkbarTab[],
  requestedActiveTabId: string | null,
  requestedMru: readonly string[],
): PersistedDockState {
  const tabs = allTabs.filter(isPersistableTab);
  const persistedIds = new Set(tabs.map((tab) => tab.id));
  const mruTabIds = requestedMru.filter((tabId) => persistedIds.has(tabId));
  const activeTabId = persistedIds.has(requestedActiveTabId ?? "")
    ? requestedActiveTabId
    : (mruTabIds[0] ?? tabs[0]?.id ?? null);
  return { tabs, activeTabId, mruTabIds };
}

function restoreV2(value: PersistedWorkbarStateV2): WorkbarState {
  return createWorkbarState({
    docks: {
      right: {
        ...value.docks.right,
        collapsed: value.layout.right.collapsed,
      },
      bottom: {
        ...value.docks.bottom,
        collapsed: value.layout.bottom.collapsed,
      },
    },
    focusedDock: value.layout.focusedDock,
    rightWidth: value.layout.right.width,
    bottomHeight: value.layout.bottom.height,
  });
}

function migrateV1(value: PersistedWorkbarStateV1): WorkbarState {
  const mappedTabs: WorkbarTab[] = [];
  const mappedIds = new Set<string>();
  for (const legacy of value.tabs) {
    const tab =
      legacy.kind === "review" ? createWorkbarToolTab("review") : createWorkbarToolTab("inspector");
    if (!mappedIds.has(tab.id)) {
      mappedIds.add(tab.id);
      mappedTabs.push(tab);
    }
  }
  const mapLegacyId = (id: string | null): string | null => {
    if (id === null) return null;
    const legacy = value.tabs.find((tab) => tab.id === id);
    if (!legacy) return null;
    return legacy.kind === "review" ? "review" : "inspector";
  };
  const mappedMru = uniqueStrings(
    value.mruTabIds.map(mapLegacyId).filter((tabId): tabId is string => tabId !== null),
  );
  return createWorkbarState({
    docks: {
      right: {
        tabs: mappedTabs,
        activeTabId: mapLegacyId(value.activeTabId),
        mruTabIds: mappedMru,
        collapsed: value.layout.collapsed,
      },
      bottom: { collapsed: true },
    },
    focusedDock: "right",
    rightWidth: value.layout.width,
  });
}

function isPersistableTab(tab: WorkbarTab): tab is PersistedWorkbarTab {
  return isStaticWorkbarToolTab(tab) && isPersistedWorkbarTabKind(tab.kind);
}

function isPersistedWorkbarStateV2(value: unknown): value is PersistedWorkbarStateV2 {
  if (!isRecord(value) || value.version !== WORKBAR_PERSISTENCE_VERSION) return false;
  if (
    !isRecord(value.layout) ||
    !isWorkbarDock(value.layout.focusedDock) ||
    !isPersistedRightLayout(value.layout.right) ||
    !isPersistedBottomLayout(value.layout.bottom) ||
    !isRecord(value.docks)
  ) {
    return false;
  }
  if (!isPersistedDockState(value.docks.right) || !isPersistedDockState(value.docks.bottom)) {
    return false;
  }
  const rightIds = new Set(value.docks.right.tabs.map((tab) => tab.id));
  return !value.docks.bottom.tabs.some((tab) => rightIds.has(tab.id));
}

function isPersistedWorkbarStateV1(value: unknown): value is PersistedWorkbarStateV1 {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    !isRecord(value.layout) ||
    typeof value.layout.collapsed !== "boolean" ||
    typeof value.layout.width !== "number" ||
    !Number.isFinite(value.layout.width) ||
    !Array.isArray(value.tabs) ||
    !value.tabs.every(isLegacyPersistedTab)
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

function isPersistedDockState(value: unknown): value is PersistedDockState {
  if (!isRecord(value) || !Array.isArray(value.tabs) || !value.tabs.every(isPersistedWorkbarTab)) {
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

function isPersistedRightLayout(value: unknown): value is { collapsed: boolean; width: number } {
  return (
    isRecord(value) &&
    typeof value.collapsed === "boolean" &&
    typeof value.width === "number" &&
    Number.isFinite(value.width)
  );
}

function isPersistedBottomLayout(value: unknown): value is { collapsed: boolean; height: number } {
  return (
    isRecord(value) &&
    typeof value.collapsed === "boolean" &&
    typeof value.height === "number" &&
    Number.isFinite(value.height)
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

function isLegacyPersistedTab(value: unknown): value is LegacyPersistedTab {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    value.id.length > 0 &&
    (value.kind === "overview" || value.kind === "review" || value.kind === "context") &&
    typeof value.label === "string" &&
    value.label.length > 0
  );
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
