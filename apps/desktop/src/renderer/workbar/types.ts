export const WORKBAR_DOCKS = ["right", "bottom"] as const;

export type WorkbarDock = (typeof WORKBAR_DOCKS)[number];

export const WORKBAR_TOOL_KINDS = [
  "side-chat",
  "review",
  "terminal",
  "browser",
  "files",
  "tasks",
  "inspector",
] as const;

export type WorkbarToolKind = (typeof WORKBAR_TOOL_KINDS)[number];

/** Legacy kinds are accepted only while App and v1 storage migrate to the v2 registry. */
export type LegacyWorkbarTabKind = "overview" | "context";
export type WorkbarTabKind = WorkbarToolKind | LegacyWorkbarTabKind;
export type PersistedWorkbarTabKind = Exclude<WorkbarToolKind, "side-chat" | "terminal">;

/** Renderer-only metadata. Domain resources stay bound outside the workbar state. */
export interface WorkbarTab {
  readonly id: string;
  readonly kind: WorkbarTabKind;
  readonly label: string;
  /** An unpinned preview is replaced by the next preview opened in the same Dock. */
  readonly preview?: boolean;
  readonly pinned?: boolean;
}

export interface WorkbarDockState {
  readonly tabs: readonly WorkbarTab[];
  readonly activeTabId: string | null;
  /** Most recently selected tab first. */
  readonly mruTabIds: readonly string[];
  readonly collapsed: boolean;
  readonly launcherOpen: boolean;
}

export interface WorkbarState {
  readonly docks: Readonly<Record<WorkbarDock, WorkbarDockState>>;
  readonly focusedDock: WorkbarDock;
  readonly rightWidth: number;
  readonly bottomHeight: number;

  /** @deprecated Right-Dock compatibility aliases for the current App integration. */
  readonly tabs: readonly WorkbarTab[];
  readonly activeTabId: string | null;
  readonly mruTabIds: readonly string[];
  readonly collapsed: boolean;
  readonly width: number;
}

export type WorkbarAction =
  | { readonly type: "open"; readonly tab: WorkbarTab; readonly dock?: WorkbarDock }
  | { readonly type: "openPreview"; readonly tab: WorkbarTab; readonly dock: WorkbarDock }
  | { readonly type: "pinPreview"; readonly tabId: string }
  | { readonly type: "select"; readonly tabId: string; readonly dock?: WorkbarDock }
  | { readonly type: "close"; readonly tabId: string }
  | { readonly type: "closeOthers"; readonly tabId: string }
  | { readonly type: "closeRight"; readonly tabId: string }
  | {
      readonly type: "reorder";
      readonly tabId: string;
      readonly toIndex: number;
      readonly dock?: WorkbarDock;
    }
  | {
      readonly type: "moveDock";
      readonly tabId: string;
      readonly toDock: WorkbarDock;
      readonly toIndex?: number;
    }
  | { readonly type: "setLauncherOpen"; readonly dock: WorkbarDock; readonly open: boolean }
  | { readonly type: "setCollapsed"; readonly collapsed: boolean; readonly dock?: WorkbarDock }
  | { readonly type: "setWidth"; readonly width: number }
  | { readonly type: "setHeight"; readonly height: number }
  | { readonly type: "focusDock"; readonly dock: WorkbarDock };

export interface WorkbarDockStateOptions {
  readonly tabs?: readonly WorkbarTab[];
  readonly activeTabId?: string | null;
  readonly mruTabIds?: readonly string[];
  readonly collapsed?: boolean;
  readonly launcherOpen?: boolean;
}

export interface WorkbarStateOptions extends WorkbarDockStateOptions {
  readonly docks?: Partial<Readonly<Record<WorkbarDock, WorkbarDockStateOptions>>>;
  readonly focusedDock?: WorkbarDock;
  readonly rightWidth?: number;
  readonly bottomHeight?: number;
  /** @deprecated Use rightWidth. */
  readonly width?: number;
}

export function isWorkbarDock(value: unknown): value is WorkbarDock {
  return typeof value === "string" && WORKBAR_DOCKS.some((dock) => dock === value);
}

export function isWorkbarToolKind(value: unknown): value is WorkbarToolKind {
  return typeof value === "string" && WORKBAR_TOOL_KINDS.some((kind) => kind === value);
}

export function isWorkbarTabKind(value: unknown): value is WorkbarTabKind {
  return isWorkbarToolKind(value) || value === "overview" || value === "context";
}

export function isPersistedWorkbarTabKind(value: unknown): value is PersistedWorkbarTabKind {
  return (
    value === "review" ||
    value === "browser" ||
    value === "files" ||
    value === "tasks" ||
    value === "inspector"
  );
}
