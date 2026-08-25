import {
  ArrowDownToLine,
  ArrowRightToLine,
  GripVertical,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Plus,
  X,
} from "lucide-react";
import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from "react";

import {
  WORKBAR_MAX_HEIGHT,
  WORKBAR_MAX_WIDTH,
  WORKBAR_MIN_HEIGHT,
  WORKBAR_MIN_WIDTH,
  clampWorkbarHeight,
  clampWorkbarWidth,
} from "./state.js";
import type { WorkbarAction, WorkbarDock, WorkbarState, WorkbarTabKind } from "./types.js";

const KEYBOARD_RESIZE_STEP = 16;
const WORKBAR_DRAG_TYPE = "application/x-pico-workbar-tab";

export interface SessionWorkbarTab {
  readonly id: string;
  readonly label: string;
  readonly kind: WorkbarTabKind | string;
  readonly closable: boolean;
  readonly badge?: string | number | undefined;
  readonly preview?: boolean | undefined;
  readonly pinned?: boolean | undefined;
}

export interface SessionWorkbarDockProps {
  readonly dock: WorkbarDock;
  readonly tabs: readonly SessionWorkbarTab[];
  readonly activeTabId: string | undefined;
  readonly collapsed: boolean;
  readonly size: number;
  readonly showRestoreButton?: boolean | undefined;
  readonly launcher?: ReactNode | undefined;
  readonly renderPanel: (tab: SessionWorkbarTab, dock: WorkbarDock) => ReactNode;
  readonly onSelect: (tabId: string, dock: WorkbarDock) => void;
  readonly onClose: (tabId: string) => void;
  readonly onCloseOthers: (tabId: string) => void;
  readonly onCloseRight: (tabId: string) => void;
  readonly onReorder: (tabId: string, targetIndex: number, dock: WorkbarDock) => void;
  readonly onMoveDock: (tabId: string, targetDock: WorkbarDock, targetIndex?: number) => void;
  readonly onPinPreview: (tabId: string) => void;
  readonly onToggleCollapsed: (dock: WorkbarDock) => void;
  readonly onResize: (size: number, dock: WorkbarDock) => void;
  readonly onOpenLauncher: (dock: WorkbarDock) => void;
}

/** Legacy right-Dock props retained while App.tsx is migrated to SessionWorkbarLayout. */
export interface SessionWorkbarProps {
  readonly tabs: readonly SessionWorkbarTab[];
  readonly activeTabId: string | undefined;
  readonly collapsed: boolean;
  readonly width: number;
  readonly showRestoreButton?: boolean | undefined;
  readonly launcher?: ReactNode | undefined;
  readonly renderPanel: (tab: SessionWorkbarTab) => ReactNode;
  readonly onSelect: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onReorder: (tabId: string, targetIndex: number) => void;
  readonly onToggleCollapsed: () => void;
  readonly onResize: (width: number) => void;
  readonly onOpenLauncher: () => void;
}

export interface SessionWorkbarLayoutProps {
  readonly state: WorkbarState;
  readonly children: ReactNode;
  /** New tasks stay focused until a real session exists. */
  readonly enabled?: boolean | undefined;
  readonly launcher?: ((dock: WorkbarDock) => ReactNode) | undefined;
  readonly presentTab?:
    | ((
        tab: WorkbarState["docks"][WorkbarDock]["tabs"][number],
      ) => Partial<Pick<SessionWorkbarTab, "closable" | "badge">> | undefined)
    | undefined;
  readonly renderPanel: (
    tab: WorkbarState["docks"][WorkbarDock]["tabs"][number],
    dock: WorkbarDock,
  ) => ReactNode;
  readonly onAction: (action: WorkbarAction) => void;
}

interface ContextMenuState {
  readonly tabId: string;
  readonly x: number;
  readonly y: number;
}

function tabDomId(rootId: string, tabId: string): string {
  return `${rootId}-tab-${encodeURIComponent(tabId)}`;
}

function panelDomId(rootId: string, tabId: string): string {
  return `${rootId}-panel-${encodeURIComponent(tabId)}`;
}

function otherDock(dock: WorkbarDock): WorkbarDock {
  return dock === "right" ? "bottom" : "right";
}

export function SessionWorkbarDock({
  dock,
  tabs,
  activeTabId,
  collapsed,
  size,
  showRestoreButton = true,
  launcher,
  renderPanel,
  onSelect,
  onClose,
  onCloseOthers,
  onCloseRight,
  onReorder,
  onMoveDock,
  onPinPreview,
  onToggleCollapsed,
  onResize,
  onOpenLauncher,
}: SessionWorkbarDockProps) {
  const generatedId = useId();
  const rootId = useMemo(
    () => `session-workbar-${dock}-${generatedId.replaceAll(":", "")}`,
    [dock, generatedId],
  );
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const launcherButtonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const expandedFocusRef = useRef<HTMLElement | null>(null);
  const closeFocusPendingRef = useRef(false);
  const previousCollapsedRef = useRef(collapsed);
  const resizeRef = useRef<{
    pointerId: number;
    startCoordinate: number;
    startSize: number;
  } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const selectedTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;
  const controlledSize = dock === "right" ? clampWorkbarWidth(size) : clampWorkbarHeight(size);
  const targetDock = otherDock(dock);

  useLayoutEffect(() => {
    if (!closeFocusPendingRef.current) return;
    closeFocusPendingRef.current = false;
    if (selectedTabId) tabRefs.current.get(selectedTabId)?.focus();
    else launcherButtonRef.current?.focus();
  }, [selectedTabId, tabs]);

  useLayoutEffect(() => {
    if (previousCollapsedRef.current === collapsed) return;
    previousCollapsedRef.current = collapsed;
    if (collapsed) {
      if (showRestoreButton) restoreButtonRef.current?.focus();
      return;
    }
    const target = expandedFocusRef.current;
    if (target?.isConnected) target.focus();
    else if (selectedTabId) tabRefs.current.get(selectedTabId)?.focus();
  }, [collapsed, selectedTabId, showRestoreButton]);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      const coordinate = dock === "right" ? event.clientX : event.clientY;
      const nextSize = resize.startSize + resize.startCoordinate - coordinate;
      onResize(dock === "right" ? clampWorkbarWidth(nextSize) : clampWorkbarHeight(nextSize), dock);
    };
    const finishResize = (event: globalThis.PointerEvent) => {
      if (resizeRef.current?.pointerId !== event.pointerId) return;
      resizeRef.current = null;
      setResizing(false);
    };
    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", finishResize);
    window.addEventListener("pointercancel", finishResize);
    return () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", finishResize);
      window.removeEventListener("pointercancel", finishResize);
    };
  }, [dock, onResize]);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    const closeOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("pointerdown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [contextMenu]);

  const focusTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onSelect(tab.id, dock);
    tabRefs.current.get(tab.id)?.focus();
  };

  const openKeyboardContextMenu = (tabId: string) => {
    const bounds = tabRefs.current.get(tabId)?.getBoundingClientRect();
    setContextMenu({ tabId, x: bounds?.left ?? 0, y: bounds?.bottom ?? 0 });
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const currentTab = tabs[index];
    if (!currentTab) return;
    if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
      event.preventDefault();
      openKeyboardContextMenu(currentTab.id);
      return;
    }
    if (event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
      event.preventDefault();
      onMoveDock(currentTab.id, targetDock);
      return;
    }
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const targetIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
      if (targetIndex >= 0 && targetIndex < tabs.length) {
        onReorder(currentTab.id, targetIndex, dock);
      }
      return;
    }
    let nextIndex: number | undefined;
    switch (event.key) {
      case "ArrowLeft":
        nextIndex = (index - 1 + tabs.length) % tabs.length;
        break;
      case "ArrowRight":
        nextIndex = (index + 1) % tabs.length;
        break;
      case "Home":
        nextIndex = 0;
        break;
      case "End":
        nextIndex = tabs.length - 1;
        break;
      default:
        return;
    }
    event.preventDefault();
    focusTab(nextIndex);
  };

  const handleClose = (tabId: string) => {
    closeFocusPendingRef.current = true;
    onClose(tabId);
  };

  const handleCollapse = () => {
    expandedFocusRef.current = document.activeElement as HTMLElement | null;
    onToggleCollapsed(dock);
  };

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = {
      pointerId: event.pointerId,
      startCoordinate: dock === "right" ? event.clientX : event.clientY,
      startSize: controlledSize,
    };
    setResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = dock === "right" ? "ArrowRight" : "ArrowDown";
    const increaseKey = dock === "right" ? "ArrowLeft" : "ArrowUp";
    if (event.key !== decreaseKey && event.key !== increaseKey) return;
    event.preventDefault();
    const nextSize = controlledSize + (event.key === increaseKey ? 1 : -1) * KEYBOARD_RESIZE_STEP;
    onResize(dock === "right" ? clampWorkbarWidth(nextSize) : clampWorkbarHeight(nextSize), dock);
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, tabId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKBAR_DRAG_TYPE, JSON.stringify({ tabId, dock }));
    event.dataTransfer.setData("text/plain", tabId);
  };

  const resetDrag = () => setDropTargetId(null);

  const handleDrop = (event: DragEvent<HTMLElement>, targetIndex: number) => {
    event.preventDefault();
    const transfer = parseTabTransfer(event.dataTransfer.getData(WORKBAR_DRAG_TYPE));
    const tabId = transfer?.tabId ?? event.dataTransfer.getData("text/plain");
    resetDrag();
    if (!tabId) return;
    if (transfer?.dock === dock || tabs.some((tab) => tab.id === tabId)) {
      onReorder(tabId, targetIndex, dock);
    } else {
      onMoveDock(tabId, dock, targetIndex);
    }
  };

  const rootStyle = {
    "--session-workbar-width": `${dock === "right" ? controlledSize : 400}px`,
    "--session-workbar-height": `${dock === "bottom" ? controlledSize : 300}px`,
  } as CSSProperties;
  const contextTab = tabs.find((tab) => tab.id === contextMenu?.tabId);

  return (
    <div
      className="session-workbar-shell"
      data-slot="session-workbar-shell"
      data-dock={dock}
      data-state={collapsed ? "collapsed" : "expanded"}
      data-has-restore={showRestoreButton}
      style={rootStyle}
    >
      <button
        ref={restoreButtonRef}
        type="button"
        className="session-workbar-restore"
        aria-label={`展开${dock === "right" ? "右侧" : "底部"}任务工作栏`}
        aria-controls={rootId}
        aria-expanded={!collapsed}
        hidden={!collapsed || !showRestoreButton}
        onClick={() => onToggleCollapsed(dock)}
      >
        {dock === "right" ? (
          <PanelRightOpen aria-hidden="true" size={18} />
        ) : (
          <PanelBottomOpen aria-hidden="true" size={18} />
        )}
      </button>

      <aside
        id={rootId}
        className="session-workbar"
        data-slot="session-workbar"
        data-dock={dock}
        data-resizing={resizing || undefined}
        aria-label={`${dock === "right" ? "右侧" : "底部"}任务工作栏`}
        hidden={collapsed}
      >
        <div
          className="session-workbar__resize-handle"
          role="separator"
          aria-label={`调整${dock === "right" ? "右侧工作栏宽度" : "底部工作栏高度"}`}
          aria-orientation={dock === "right" ? "vertical" : "horizontal"}
          aria-valuemin={dock === "right" ? WORKBAR_MIN_WIDTH : WORKBAR_MIN_HEIGHT}
          aria-valuemax={dock === "right" ? WORKBAR_MAX_WIDTH : WORKBAR_MAX_HEIGHT}
          aria-valuenow={controlledSize}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
        />

        <header className="session-workbar__header">
          <div className="session-workbar__title-group">
            <span className="session-workbar__eyebrow">当前任务</span>
            <strong>{dock === "right" ? "右侧工作栏" : "底部工作栏"}</strong>
          </div>
          <div className="session-workbar__actions">
            <button
              ref={launcherButtonRef}
              type="button"
              className="session-workbar__icon-button"
              aria-label={`在${dock === "right" ? "右侧" : "底部"}打开工具启动器`}
              onClick={() => onOpenLauncher(dock)}
            >
              <Plus aria-hidden="true" size={17} />
            </button>
            <button
              type="button"
              className="session-workbar__icon-button"
              aria-label={`折叠${dock === "right" ? "右侧" : "底部"}任务工作栏`}
              aria-controls={rootId}
              aria-expanded={!collapsed}
              onClick={handleCollapse}
            >
              {dock === "right" ? (
                <PanelRightClose aria-hidden="true" size={17} />
              ) : (
                <PanelBottomClose aria-hidden="true" size={17} />
              )}
            </button>
          </div>
        </header>

        {launcher}

        <div
          className="session-workbar__tab-strip"
          role="tablist"
          aria-label={`${dock === "right" ? "右侧" : "底部"}已打开的任务面板`}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => handleDrop(event, tabs.length)}
        >
          {tabs.map((tab, index) => {
            const selected = tab.id === selectedTabId;
            return (
              <div
                key={tab.id}
                className="session-workbar__tab-item"
                data-slot="session-workbar-tab-item"
                data-state={selected ? "active" : "inactive"}
                data-preview={tab.preview || undefined}
                data-pinned={tab.pinned || undefined}
                data-drop-target={dropTargetId === tab.id || undefined}
                draggable={tabs.length > 1}
                onContextMenu={(event) => {
                  event.preventDefault();
                  setContextMenu({ tabId: tab.id, x: event.clientX, y: event.clientY });
                }}
                onDoubleClick={() => {
                  if (tab.preview) onPinPreview(tab.id);
                }}
                onDragStart={(event) => handleDragStart(event, tab.id)}
                onDragEnd={resetDrag}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetId(tab.id);
                }}
                onDragLeave={() =>
                  setDropTargetId((current) => (current === tab.id ? null : current))
                }
                onDrop={(event) => {
                  event.stopPropagation();
                  handleDrop(event, index);
                }}
              >
                <GripVertical className="session-workbar__drag-mark" aria-hidden="true" size={13} />
                <button
                  ref={(node) => {
                    if (node) tabRefs.current.set(tab.id, node);
                    else tabRefs.current.delete(tab.id);
                  }}
                  id={tabDomId(rootId, tab.id)}
                  type="button"
                  className="session-workbar__tab"
                  role="tab"
                  aria-selected={selected}
                  aria-controls={panelDomId(rootId, tab.id)}
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Alt+Shift+ArrowUp Alt+Shift+ArrowDown Shift+F10"
                  tabIndex={selected ? 0 : -1}
                  data-kind={tab.kind}
                  onClick={() => onSelect(tab.id, dock)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <span className="session-workbar__tab-label">{tab.label}</span>
                  {tab.preview && (
                    <span className="session-workbar__preview-dot" aria-label="预览" />
                  )}
                  {tab.badge !== undefined && (
                    <span className="session-workbar__badge" aria-label={`${tab.badge} 条待处理`}>
                      {tab.badge}
                    </span>
                  )}
                </button>
                {tab.closable && (
                  <button
                    type="button"
                    className="session-workbar__close"
                    aria-label={`关闭“${tab.label}”`}
                    onClick={() => handleClose(tab.id)}
                  >
                    <X aria-hidden="true" size={13} />
                  </button>
                )}
              </div>
            );
          })}
        </div>

        <div className="session-workbar__panels">
          {tabs.map((tab) => {
            const selected = tab.id === selectedTabId;
            return (
              <section
                key={tab.id}
                id={panelDomId(rootId, tab.id)}
                className="session-workbar__panel"
                data-slot="session-workbar-panel"
                data-active={selected || undefined}
                role="tabpanel"
                aria-labelledby={tabDomId(rootId, tab.id)}
                hidden={!selected}
                tabIndex={selected ? 0 : -1}
              >
                {renderPanel(tab, dock)}
              </section>
            );
          })}
          {tabs.length === 0 && (
            <div
              className="session-workbar__empty"
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => handleDrop(event, 0)}
            >
              <p>还没有打开的面板</p>
              <button
                type="button"
                className="session-workbar__launcher"
                onClick={() => onOpenLauncher(dock)}
              >
                <Plus aria-hidden="true" size={16} />
                打开工具启动器
              </button>
            </div>
          )}
        </div>
      </aside>

      {contextMenu && contextTab && (
        <div
          className="session-workbar__context-menu"
          role="menu"
          aria-label={`管理“${contextTab.label}”标签`}
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          {contextTab.preview && (
            <button
              type="button"
              role="menuitem"
              onClick={() => {
                onPinPreview(contextTab.id);
                setContextMenu(null);
              }}
            >
              <Pin aria-hidden="true" size={14} />
              固定预览
            </button>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onMoveDock(contextTab.id, targetDock);
              setContextMenu(null);
            }}
          >
            {targetDock === "bottom" ? (
              <ArrowDownToLine aria-hidden="true" size={14} />
            ) : (
              <ArrowRightToLine aria-hidden="true" size={14} />
            )}
            移到{targetDock === "right" ? "右侧" : "底部"}工作栏
          </button>
          <span className="session-workbar__menu-separator" role="separator" />
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseOthers(contextTab.id);
              setContextMenu(null);
            }}
            disabled={tabs.length < 2}
          >
            关闭其他标签
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseRight(contextTab.id);
              setContextMenu(null);
            }}
            disabled={tabs.findIndex((tab) => tab.id === contextTab.id) === tabs.length - 1}
          >
            关闭右侧标签
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              handleClose(contextTab.id);
              setContextMenu(null);
            }}
            disabled={!contextTab.closable}
          >
            关闭标签
          </button>
        </div>
      )}
    </div>
  );
}

export function SessionWorkbar({
  tabs,
  activeTabId,
  collapsed,
  width,
  showRestoreButton,
  launcher,
  renderPanel,
  onSelect,
  onClose,
  onReorder,
  onToggleCollapsed,
  onResize,
  onOpenLauncher,
}: SessionWorkbarProps) {
  return (
    <SessionWorkbarDock
      dock="right"
      tabs={tabs}
      activeTabId={activeTabId}
      collapsed={collapsed}
      size={width}
      showRestoreButton={showRestoreButton}
      launcher={launcher}
      renderPanel={(tab) => renderPanel(tab)}
      onSelect={(tabId) => onSelect(tabId)}
      onClose={onClose}
      onCloseOthers={() => undefined}
      onCloseRight={() => undefined}
      onReorder={(tabId, targetIndex) => onReorder(tabId, targetIndex)}
      onMoveDock={() => undefined}
      onPinPreview={() => undefined}
      onToggleCollapsed={() => onToggleCollapsed()}
      onResize={(nextSize) => onResize(nextSize)}
      onOpenLauncher={() => onOpenLauncher()}
    />
  );
}

export function SessionWorkbarLayout({
  state,
  children,
  enabled = true,
  launcher,
  presentTab,
  renderPanel,
  onAction,
}: SessionWorkbarLayoutProps) {
  if (!enabled) return children;

  const renderDock = (dock: WorkbarDock) => {
    const dockState = state.docks[dock];
    const tabs: readonly SessionWorkbarTab[] = dockState.tabs.map((tab) => {
      const presentation = presentTab?.(tab);
      return {
        ...tab,
        closable: presentation?.closable ?? true,
        badge: presentation?.badge,
      };
    });
    return (
      <SessionWorkbarDock
        dock={dock}
        tabs={tabs}
        activeTabId={dockState.activeTabId ?? undefined}
        collapsed={dockState.collapsed}
        size={dock === "right" ? state.rightWidth : state.bottomHeight}
        launcher={launcher?.(dock)}
        renderPanel={(tab) => {
          const source = dockState.tabs.find((candidate) => candidate.id === tab.id);
          return source ? renderPanel(source, dock) : null;
        }}
        onSelect={(tabId) => onAction({ type: "select", dock, tabId })}
        onClose={(tabId) => onAction({ type: "close", tabId })}
        onCloseOthers={(tabId) => onAction({ type: "closeOthers", tabId })}
        onCloseRight={(tabId) => onAction({ type: "closeRight", tabId })}
        onReorder={(tabId, targetIndex) =>
          onAction({ type: "reorder", dock, tabId, toIndex: targetIndex })
        }
        onMoveDock={(tabId, toDock, toIndex) =>
          onAction({
            type: "moveDock",
            tabId,
            toDock,
            ...(toIndex === undefined ? {} : { toIndex }),
          })
        }
        onPinPreview={(tabId) => onAction({ type: "pinPreview", tabId })}
        onToggleCollapsed={() =>
          onAction({ type: "setCollapsed", dock, collapsed: !dockState.collapsed })
        }
        onResize={(nextSize) =>
          onAction(
            dock === "right"
              ? { type: "setWidth", width: nextSize }
              : { type: "setHeight", height: nextSize },
          )
        }
        onOpenLauncher={() =>
          onAction({ type: "setLauncherOpen", dock, open: !dockState.launcherOpen })
        }
      />
    );
  };

  return (
    <div className="session-workbar-layout" data-slot="session-workbar-layout">
      <div className="session-workbar-layout__content-row">
        <div className="session-workbar-layout__main">{children}</div>
        {renderDock("right")}
      </div>
      {renderDock("bottom")}
    </div>
  );
}

function parseTabTransfer(value: string): { tabId: string; dock: WorkbarDock } | undefined {
  try {
    const candidate: unknown = JSON.parse(value);
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "tabId" in candidate &&
      typeof candidate.tabId === "string" &&
      "dock" in candidate &&
      (candidate.dock === "right" || candidate.dock === "bottom")
    ) {
      return { tabId: candidate.tabId, dock: candidate.dock };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
