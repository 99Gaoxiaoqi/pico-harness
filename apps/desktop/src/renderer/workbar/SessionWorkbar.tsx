import { IconButton, Button } from "../components.js";
import { GripVertical, PanelRightClose, PanelRightOpen, Pin, Plus, X } from "lucide-react";
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

import { WORKBAR_MAX_WIDTH, WORKBAR_MIN_WIDTH, clampWorkbarWidth } from "./state.js";
import type { WorkbarAction, WorkbarState, WorkbarTabKind, WorkbarTab } from "./types.js";

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

export interface SessionWorkbarProps {
  readonly tabs: readonly SessionWorkbarTab[];
  readonly activeTabId: string | undefined;
  readonly collapsed: boolean;
  readonly size: number;
  readonly showRestoreButton?: boolean | undefined;
  readonly launcher?: ReactNode | undefined;
  readonly renderPanel: (tab: SessionWorkbarTab) => ReactNode;
  readonly onSelect: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onCloseOthers: (tabId: string) => void;
  readonly onCloseRight: (tabId: string) => void;
  readonly onReorder: (tabId: string, targetIndex: number) => void;
  readonly onPinPreview: (tabId: string) => void;
  readonly onToggleCollapsed: () => void;
  readonly onResize: (size: number) => void;
  readonly onOpenLauncher: () => void;
}

export interface SessionWorkbarLayoutProps {
  readonly state: WorkbarState;
  readonly children: ReactNode;
  /** The conversation header can provide the restore control. */
  readonly showRestoreButton?: boolean | undefined;
  /** New tasks stay focused until a real session exists. */
  readonly enabled?: boolean | undefined;
  readonly launcher?: ReactNode | undefined;
  readonly presentTab?:
    | ((tab: WorkbarTab) => Partial<Pick<SessionWorkbarTab, "closable" | "badge">> | undefined)
    | undefined;
  readonly renderPanel: (tab: WorkbarTab) => ReactNode;
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

export function SessionWorkbar({
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
  onPinPreview,
  onToggleCollapsed,
  onResize,
  onOpenLauncher,
}: SessionWorkbarProps) {
  const generatedId = useId();
  const rootId = useMemo(() => `session-workbar-${generatedId.replaceAll(":", "")}`, [generatedId]);
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
  const controlledSize = clampWorkbarWidth(size);

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
      const coordinate = event.clientX;
      const nextSize = resize.startSize + resize.startCoordinate - coordinate;
      onResize(clampWorkbarWidth(nextSize));
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
  }, [onResize]);

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
    onSelect(tab.id);
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
    if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      const targetIndex = event.key === "ArrowLeft" ? index - 1 : index + 1;
      if (targetIndex >= 0 && targetIndex < tabs.length) {
        onReorder(currentTab.id, targetIndex);
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
    onToggleCollapsed();
  };

  const handleResizePointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    resizeRef.current = {
      pointerId: event.pointerId,
      startCoordinate: event.clientX,
      startSize: controlledSize,
    };
    setResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const decreaseKey = "ArrowRight";
    const increaseKey = "ArrowLeft";
    if (event.key !== decreaseKey && event.key !== increaseKey) return;
    event.preventDefault();
    const nextSize = controlledSize + (event.key === increaseKey ? 1 : -1) * KEYBOARD_RESIZE_STEP;
    onResize(clampWorkbarWidth(nextSize));
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, tabId: string) => {
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData(WORKBAR_DRAG_TYPE, JSON.stringify({ tabId }));
    event.dataTransfer.setData("text/plain", tabId);
  };

  const resetDrag = () => setDropTargetId(null);

  const handleDrop = (event: DragEvent<HTMLElement>, targetIndex: number) => {
    event.preventDefault();
    const transfer = parseTabTransfer(event.dataTransfer.getData(WORKBAR_DRAG_TYPE));
    const tabId = transfer?.tabId ?? event.dataTransfer.getData("text/plain");
    resetDrag();
    if (!tabId) return;
    if (tabs.some((tab) => tab.id === tabId)) onReorder(tabId, targetIndex);
  };

  const rootStyle = {
    "--session-workbar-width": `${controlledSize}px`,
  } as CSSProperties;
  const contextTab = tabs.find((tab) => tab.id === contextMenu?.tabId);

  return (
    <div
      className="session-workbar-shell"
      data-slot="session-workbar-shell"
      data-dock="right"
      data-state={collapsed ? "collapsed" : "expanded"}
      data-has-restore={showRestoreButton}
      style={rootStyle}
    >
      <IconButton
        label={"展开右侧任务工作栏"}
        ref={restoreButtonRef}
        type="button"
        className="session-workbar-restore"
        aria-label={"展开右侧任务工作栏"}
        aria-controls={rootId}
        aria-expanded={!collapsed}
        hidden={!collapsed || !showRestoreButton}
        onClick={() => onToggleCollapsed()}
      >
        <PanelRightOpen aria-hidden="true" size={18} />
      </IconButton>

      <aside
        id={rootId}
        className="session-workbar"
        data-slot="session-workbar"
        data-dock="right"
        data-resizing={resizing || undefined}
        aria-label={"右侧任务工作栏"}
        hidden={collapsed}
      >
        <div
          className="session-workbar__resize-handle"
          role="separator"
          aria-label={"调整右侧工作栏宽度"}
          aria-orientation="vertical"
          aria-valuemin={WORKBAR_MIN_WIDTH}
          aria-valuemax={WORKBAR_MAX_WIDTH}
          aria-valuenow={controlledSize}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
        />

        <header className="session-workbar__header">
          <div className="session-workbar__title-group">
            <span className="session-workbar__eyebrow">当前任务</span>
            <strong>右侧工作栏</strong>
          </div>
          <div className="session-workbar__actions">
            <IconButton
              label={"在右侧打开工具启动器"}
              ref={launcherButtonRef}
              type="button"
              className="session-workbar__icon-button"
              aria-label={"在右侧打开工具启动器"}
              onClick={() => onOpenLauncher()}
            >
              <Plus aria-hidden="true" size={17} />
            </IconButton>
            <IconButton
              label={"折叠右侧任务工作栏"}
              type="button"
              className="session-workbar__icon-button"
              aria-label={"折叠右侧任务工作栏"}
              aria-controls={rootId}
              aria-expanded={!collapsed}
              onClick={handleCollapse}
            >
              <PanelRightClose aria-hidden="true" size={17} />
            </IconButton>
          </div>
        </header>

        {launcher}

        <div
          className="session-workbar__tab-strip"
          role="tablist"
          aria-label={"右侧已打开的任务面板"}
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
                <Button
                  variant="quiet"
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
                  aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight Shift+F10"
                  tabIndex={selected ? 0 : -1}
                  data-kind={tab.kind}
                  onClick={() => onSelect(tab.id)}
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
                </Button>
                {tab.closable && (
                  <IconButton
                    label={`关闭“${tab.label}”`}
                    type="button"
                    className="session-workbar__close"
                    aria-label={`关闭“${tab.label}”`}
                    onClick={() => handleClose(tab.id)}
                  >
                    <X aria-hidden="true" size={13} />
                  </IconButton>
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
                {renderPanel(tab)}
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
              <Button
                variant="quiet"
                type="button"
                className="session-workbar__launcher"
                onClick={() => onOpenLauncher()}
              >
                <Plus aria-hidden="true" size={16} />
                打开工具启动器
              </Button>
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
            <Button
              variant="quiet"
              type="button"
              role="menuitem"
              onClick={() => {
                onPinPreview(contextTab.id);
                setContextMenu(null);
              }}
            >
              <Pin aria-hidden="true" size={14} />
              固定预览
            </Button>
          )}
          <Button
            variant="quiet"
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseOthers(contextTab.id);
              setContextMenu(null);
            }}
            disabled={tabs.length < 2}
          >
            关闭其他标签
          </Button>
          <Button
            variant="quiet"
            type="button"
            role="menuitem"
            onClick={() => {
              onCloseRight(contextTab.id);
              setContextMenu(null);
            }}
            disabled={tabs.findIndex((tab) => tab.id === contextTab.id) === tabs.length - 1}
          >
            关闭右侧标签
          </Button>
          <Button
            variant="quiet"
            type="button"
            role="menuitem"
            onClick={() => {
              handleClose(contextTab.id);
              setContextMenu(null);
            }}
            disabled={!contextTab.closable}
          >
            关闭标签
          </Button>
        </div>
      )}
    </div>
  );
}

export function SessionWorkbarLayout({
  state,
  children,
  enabled = true,
  showRestoreButton = true,
  launcher,
  presentTab,
  renderPanel,
  onAction,
}: SessionWorkbarLayoutProps) {
  if (!enabled) return children;

  const tabs: readonly SessionWorkbarTab[] = state.tabs.map((tab) => {
    const presentation = presentTab?.(tab);
    return {
      ...tab,
      closable: presentation?.closable ?? true,
      badge: presentation?.badge,
    };
  });

  return (
    <div className="session-workbar-layout" data-slot="session-workbar-layout">
      <div className="session-workbar-layout__content-row">
        <div className="session-workbar-layout__main">{children}</div>
        <SessionWorkbar
          tabs={tabs}
          activeTabId={state.activeTabId ?? undefined}
          collapsed={state.collapsed}
          showRestoreButton={showRestoreButton}
          size={state.width}
          launcher={launcher}
          renderPanel={(tab) => {
            const source = state.tabs.find((candidate) => candidate.id === tab.id);
            return source ? renderPanel(source) : null;
          }}
          onSelect={(tabId) => onAction({ type: "select", tabId })}
          onClose={(tabId) => onAction({ type: "close", tabId })}
          onCloseOthers={(tabId) => onAction({ type: "closeOthers", tabId })}
          onCloseRight={(tabId) => onAction({ type: "closeRight", tabId })}
          onReorder={(tabId, toIndex) => onAction({ type: "reorder", tabId, toIndex })}
          onPinPreview={(tabId) => onAction({ type: "pinPreview", tabId })}
          onToggleCollapsed={() => onAction({ type: "setCollapsed", collapsed: !state.collapsed })}
          onResize={(width) => onAction({ type: "setWidth", width })}
          onOpenLauncher={() => onAction({ type: "setLauncherOpen", open: !state.launcherOpen })}
        />
      </div>
    </div>
  );
}

function parseTabTransfer(value: string): { tabId: string } | undefined {
  try {
    const candidate: unknown = JSON.parse(value);
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "tabId" in candidate &&
      typeof candidate.tabId === "string"
    ) {
      return { tabId: candidate.tabId };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
