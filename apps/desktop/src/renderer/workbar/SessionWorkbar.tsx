import { GripVertical, PanelRightClose, PanelRightOpen, Plus, X } from "lucide-react";
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
import "./SessionWorkbar.css";

const MIN_WORKBAR_WIDTH = 320;
const MAX_WORKBAR_WIDTH = 600;
const KEYBOARD_RESIZE_STEP = 16;

export interface SessionWorkbarTab {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  readonly closable: boolean;
  readonly badge?: string | number | undefined;
}

export interface SessionWorkbarProps {
  readonly tabs: readonly SessionWorkbarTab[];
  readonly activeTabId: string | undefined;
  readonly collapsed: boolean;
  readonly width: number;
  readonly renderPanel: (tab: SessionWorkbarTab) => ReactNode;
  readonly onSelect: (tabId: string) => void;
  readonly onClose: (tabId: string) => void;
  readonly onReorder: (tabId: string, targetIndex: number) => void;
  readonly onToggleCollapsed: () => void;
  readonly onResize: (width: number) => void;
  readonly onOpenLauncher: () => void;
}

function clampWidth(width: number): number {
  return Math.min(MAX_WORKBAR_WIDTH, Math.max(MIN_WORKBAR_WIDTH, Math.round(width)));
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
  width,
  renderPanel,
  onSelect,
  onClose,
  onReorder,
  onToggleCollapsed,
  onResize,
  onOpenLauncher,
}: SessionWorkbarProps) {
  const generatedId = useId();
  const rootId = useMemo(() => `session-workbar-${generatedId.replaceAll(":", "")}`, [generatedId]);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const collapseButtonRef = useRef<HTMLButtonElement>(null);
  const launcherButtonRef = useRef<HTMLButtonElement>(null);
  const restoreButtonRef = useRef<HTMLButtonElement>(null);
  const expandedFocusRef = useRef<HTMLElement | null>(null);
  const closeFocusPendingRef = useRef(false);
  const previousCollapsedRef = useRef(collapsed);
  const draggedTabIdRef = useRef<string | null>(null);
  const resizeRef = useRef<{ pointerId: number; startX: number; startWidth: number } | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [resizing, setResizing] = useState(false);

  const selectedTabId = tabs.some((tab) => tab.id === activeTabId) ? activeTabId : tabs[0]?.id;
  const controlledWidth = clampWidth(width);

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
      restoreButtonRef.current?.focus();
      return;
    }
    const target = expandedFocusRef.current;
    if (target?.isConnected) target.focus();
    else if (selectedTabId) tabRefs.current.get(selectedTabId)?.focus();
  }, [collapsed, selectedTabId]);

  useEffect(() => {
    const handlePointerMove = (event: globalThis.PointerEvent) => {
      const resize = resizeRef.current;
      if (!resize || event.pointerId !== resize.pointerId) return;
      onResize(clampWidth(resize.startWidth + resize.startX - event.clientX));
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

  const focusTab = (index: number) => {
    const tab = tabs[index];
    if (!tab) return;
    onSelect(tab.id);
    tabRefs.current.get(tab.id)?.focus();
  };

  const handleTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (tabs.length === 0) return;
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
      startX: event.clientX,
      startWidth: controlledWidth,
    };
    setResizing(true);
  };

  const handleResizeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? 1 : -1;
    onResize(clampWidth(controlledWidth + direction * KEYBOARD_RESIZE_STEP));
  };

  const handleDragStart = (event: DragEvent<HTMLDivElement>, tabId: string) => {
    draggedTabIdRef.current = tabId;
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", tabId);
  };

  const resetDrag = () => {
    draggedTabIdRef.current = null;
    setDropTargetId(null);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>, targetIndex: number) => {
    event.preventDefault();
    const tabId = draggedTabIdRef.current ?? event.dataTransfer.getData("text/plain");
    resetDrag();
    if (!tabs.some((tab) => tab.id === tabId)) return;
    onReorder(tabId, targetIndex);
  };

  const rootStyle = { "--session-workbar-width": `${controlledWidth}px` } as CSSProperties;

  return (
    <div
      className="session-workbar-shell"
      data-slot="session-workbar-shell"
      data-state={collapsed ? "collapsed" : "expanded"}
      style={rootStyle}
    >
      <button
        ref={restoreButtonRef}
        type="button"
        className="session-workbar-restore"
        aria-label="展开任务工作栏"
        aria-controls={rootId}
        aria-expanded={!collapsed}
        hidden={!collapsed}
        onClick={onToggleCollapsed}
      >
        <PanelRightOpen aria-hidden="true" size={18} />
      </button>

      <aside
        id={rootId}
        className="session-workbar"
        data-slot="session-workbar"
        data-resizing={resizing || undefined}
        aria-label="任务工作栏"
        hidden={collapsed}
      >
        <div
          className="session-workbar__resize-handle"
          role="separator"
          aria-label="调整任务工作栏宽度"
          aria-orientation="vertical"
          aria-valuemin={MIN_WORKBAR_WIDTH}
          aria-valuemax={MAX_WORKBAR_WIDTH}
          aria-valuenow={controlledWidth}
          tabIndex={0}
          onPointerDown={handleResizePointerDown}
          onKeyDown={handleResizeKeyDown}
        />

        <header className="session-workbar__header">
          <div className="session-workbar__title-group">
            <span className="session-workbar__eyebrow">当前任务</span>
            <strong>工作栏</strong>
          </div>
          <div className="session-workbar__actions">
            <button
              ref={launcherButtonRef}
              type="button"
              className="session-workbar__icon-button"
              aria-label="打开工具启动器"
              onClick={onOpenLauncher}
            >
              <Plus aria-hidden="true" size={17} />
            </button>
            <button
              ref={collapseButtonRef}
              type="button"
              className="session-workbar__icon-button"
              aria-label="折叠任务工作栏"
              aria-controls={rootId}
              aria-expanded={!collapsed}
              onClick={handleCollapse}
            >
              <PanelRightClose aria-hidden="true" size={17} />
            </button>
          </div>
        </header>

        <div className="session-workbar__tab-strip" role="tablist" aria-label="已打开的任务面板">
          {tabs.map((tab, index) => {
            const selected = tab.id === selectedTabId;
            return (
              <div
                key={tab.id}
                className="session-workbar__tab-item"
                data-slot="session-workbar-tab-item"
                data-selected={selected || undefined}
                data-drop-target={dropTargetId === tab.id || undefined}
                draggable={tabs.length > 1}
                onDragStart={(event) => handleDragStart(event, tab.id)}
                onDragEnd={resetDrag}
                onDragOver={(event) => {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                  setDropTargetId(tab.id);
                }}
                onDragLeave={() =>
                  setDropTargetId((current) => (current === tab.id ? null : current))
                }
                onDrop={(event) => handleDrop(event, index)}
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
                  tabIndex={selected ? 0 : -1}
                  data-kind={tab.kind}
                  onClick={() => onSelect(tab.id)}
                  onKeyDown={(event) => handleTabKeyDown(event, index)}
                >
                  <span className="session-workbar__tab-label">{tab.label}</span>
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
            <div className="session-workbar__empty">
              <p>还没有打开的面板</p>
              <button type="button" className="session-workbar__launcher" onClick={onOpenLauncher}>
                <Plus aria-hidden="true" size={16} />
                打开工具启动器
              </button>
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
