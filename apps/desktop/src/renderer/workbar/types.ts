export const WORKBAR_TOOL_KINDS = [
  "side-chat",
  "review",
  "terminal",
  "browser",
  "files",
  "tasks",
  "inspector",
  "graph",
] as const;

export type WorkbarToolKind = (typeof WORKBAR_TOOL_KINDS)[number];

export type WorkbarTabKind = WorkbarToolKind;
export type PersistedWorkbarTabKind = Exclude<WorkbarToolKind, "side-chat" | "terminal">;

/** Renderer-only metadata. Domain resources stay bound outside the workbar state. */
export interface WorkbarTab {
  readonly id: string;
  readonly kind: WorkbarTabKind;
  readonly label: string;
  /** An unpinned preview is replaced by the next preview. */
  readonly preview?: boolean;
  readonly pinned?: boolean;
}

export interface WorkbarState {
  readonly tabs: readonly WorkbarTab[];
  readonly activeTabId: string | null;
  /** Most recently selected tab first. */
  readonly mruTabIds: readonly string[];
  readonly collapsed: boolean;
  readonly launcherOpen: boolean;
  readonly width: number;
}

export type WorkbarAction =
  | { readonly type: "open"; readonly tab: WorkbarTab }
  | {
      readonly type: "openTerminal";
      readonly tab: WorkbarTab;
      readonly mode: "open" | "toggle" | "new";
    }
  | { readonly type: "openPreview"; readonly tab: WorkbarTab }
  | { readonly type: "pinPreview"; readonly tabId: string }
  | { readonly type: "select"; readonly tabId: string }
  | { readonly type: "close"; readonly tabId: string }
  | { readonly type: "closeOthers"; readonly tabId: string }
  | { readonly type: "closeRight"; readonly tabId: string }
  | {
      readonly type: "reorder";
      readonly tabId: string;
      readonly toIndex: number;
    }
  | { readonly type: "setLauncherOpen"; readonly open: boolean }
  | { readonly type: "setCollapsed"; readonly collapsed: boolean }
  | { readonly type: "setWidth"; readonly width: number };

export interface WorkbarStateOptions {
  readonly tabs?: readonly WorkbarTab[];
  readonly activeTabId?: string | null;
  readonly mruTabIds?: readonly string[];
  readonly collapsed?: boolean;
  readonly launcherOpen?: boolean;
  readonly width?: number;
}

export function isWorkbarToolKind(value: unknown): value is WorkbarToolKind {
  return typeof value === "string" && WORKBAR_TOOL_KINDS.some((kind) => kind === value);
}

export function isWorkbarTabKind(value: unknown): value is WorkbarTabKind {
  return isWorkbarToolKind(value);
}

export function isPersistedWorkbarTabKind(value: unknown): value is PersistedWorkbarTabKind {
  return (
    value === "review" ||
    value === "browser" ||
    value === "files" ||
    value === "tasks" ||
    value === "inspector" ||
    value === "graph"
  );
}
