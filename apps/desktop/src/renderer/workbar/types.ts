export const WORKBAR_TAB_KINDS = ["overview", "review", "context", "inspector"] as const;

export type WorkbarTabKind = (typeof WORKBAR_TAB_KINDS)[number];

export type PersistedWorkbarTabKind = Exclude<WorkbarTabKind, "inspector">;

/**
 * Renderer-only tab metadata. Session resources are bound outside this state module by tab id.
 */
export interface WorkbarTab {
  readonly id: string;
  readonly kind: WorkbarTabKind;
  readonly label: string;
}

export interface WorkbarState {
  readonly tabs: readonly WorkbarTab[];
  readonly activeTabId: string | null;
  /** Most recently selected tab first. */
  readonly mruTabIds: readonly string[];
  readonly collapsed: boolean;
  readonly width: number;
}

export type WorkbarAction =
  | { readonly type: "open"; readonly tab: WorkbarTab }
  | { readonly type: "select"; readonly tabId: string }
  | { readonly type: "close"; readonly tabId: string }
  | { readonly type: "reorder"; readonly tabId: string; readonly toIndex: number }
  | { readonly type: "setCollapsed"; readonly collapsed: boolean }
  | { readonly type: "setWidth"; readonly width: number };

export interface WorkbarStateOptions {
  readonly tabs?: readonly WorkbarTab[];
  readonly activeTabId?: string | null;
  readonly mruTabIds?: readonly string[];
  readonly collapsed?: boolean;
  readonly width?: number;
}

export function isWorkbarTabKind(value: unknown): value is WorkbarTabKind {
  return typeof value === "string" && WORKBAR_TAB_KINDS.some((kind) => kind === value);
}

export function isPersistedWorkbarTabKind(value: unknown): value is PersistedWorkbarTabKind {
  return value === "overview" || value === "review" || value === "context";
}
