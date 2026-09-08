import {
  Archive,
  ArrowLeft,
  Box,
  BrainCircuit,
  ChevronDown,
  Clock3,
  Folder,
  FolderGit2,
  Gauge,
  Home,
  MoreHorizontal,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Search,
  Settings,
  ShieldCheck,
  Trash2,
  WandSparkles,
  X,
} from "lucide-react";
import { useCallback, useEffect, useState, type KeyboardEvent } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { TaskSearchDialog } from "./TaskSearchDialog.js";
import { PreviewBadge } from "./components.js";
import { removePersistentDraft } from "./conversation/index.js";
import type { ApprovalView, PromptView, RunView, SessionView, WorkspaceView } from "./model.js";
import {
  appPrimaryNavigation,
  settingsNavigationGroups,
  sortSidebarTasks,
  type SidebarTaskGrouping,
} from "./navigation.js";
import { useRuntime } from "./runtime-context.js";
import { formatRelative, isTerminalRun } from "./view-format.js";
import {
  TEMPORARY_WORKSPACE_GROUP_LABEL,
  isActiveWorkspaceSession,
  newSessionHref,
  sessionHref,
  workspaceDisplayName,
  workspaceHref,
  workspaceName,
  workspacePathFromSearch,
  workspaceSessionKey,
} from "./workspace-session.js";

const primaryNav = [{ ...appPrimaryNavigation[0], icon: Clock3 }] as const;

export function AppShell() {
  const { data, preview, message, actions, busy } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("pico.sidebar-collapsed") === "true",
  );
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    const onShortcut = (event: globalThis.KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.isComposing ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      } else if (event.key.toLowerCase() === "n") {
        event.preventDefault();
        setSearchOpen(false);
        navigate(newSessionHref());
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, [navigate]);
  const routeWorkspacePath = workspacePathFromSearch(location.search);
  const routeWorkspace = data.workspaces.find((workspace) => workspace.path === routeWorkspacePath);
  const pageTitle = routeTitle(location.pathname);
  const settingsRoute =
    location.pathname.startsWith("/settings") || location.pathname.startsWith("/extensions");
  const settingsReturnTo = window.sessionStorage.getItem("pico.settings-return-to") ?? "";
  const settingsReturnSearch = settingsReturnTo.includes("?")
    ? settingsReturnTo.slice(settingsReturnTo.indexOf("?"))
    : "";
  const navigationWorkspacePath =
    routeWorkspacePath ??
    data.workspacePath ??
    (settingsRoute ? workspacePathFromSearch(settingsReturnSearch) : undefined);
  const conversationRoute =
    location.pathname === "/task/new" || location.pathname.startsWith("/session/");
  const immersiveRoute = conversationRoute || settingsRoute || location.pathname === "/";
  const handleNavKeys = (event: KeyboardEvent<HTMLElement>) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const links = Array.from(
      event.currentTarget.querySelectorAll<HTMLAnchorElement>("a[data-nav-link]"),
    );
    const current = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (current < 0) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? links.length - 1
          : event.key === "ArrowDown"
            ? (current + 1) % links.length
            : (current - 1 + links.length) % links.length;
    links[next]?.focus();
  };
  useEffect(() => {
    window.localStorage.setItem("pico.sidebar-collapsed", String(sidebarCollapsed));
  }, [sidebarCollapsed]);
  const handleArchiveSession = useCallback(
    (session: SessionView) => {
      const isRunning = data.runs.some(
        (run) =>
          run.workspacePath === session.workspacePath &&
          run.sessionId === session.id &&
          !isTerminalRun(run.status),
      );
      if (isRunning && !window.confirm("该会话正在运行，归档可能导致运行结果丢失。确认归档？")) {
        return;
      }
      void actions.setSessionArchived(
        { workspacePath: session.workspacePath, sessionId: session.id },
        true,
      );
    },
    [actions, data.runs],
  );
  const handlePinSession = useCallback(
    (session: SessionView) => {
      void actions.setSessionPinned(
        { workspacePath: session.workspacePath, sessionId: session.id },
        !session.pinned,
      );
    },
    [actions],
  );
  const handleDeleteSession = useCallback(
    async (session: SessionView) => {
      const confirmed = window.confirm(
        `永久删除“${session.title}”？\n\n会话记录和运行历史将被移除，且无法恢复。`,
      );
      if (!confirmed) return;
      const deleted = await actions.deleteSession({
        workspacePath: session.workspacePath,
        sessionId: session.id,
      });
      if (deleted) {
        removePersistentDraft(
          workspaceSessionKey({ workspacePath: session.workspacePath, sessionId: session.id }),
        );
      }
      if (
        deleted &&
        isActiveWorkspaceSession(
          { workspacePath: session.workspacePath, sessionId: session.id },
          location.pathname,
          location.search,
        )
      ) {
        navigate(newSessionHref(session.workspacePath));
      }
    },
    [actions, location.pathname, location.search, navigate],
  );
  return (
    <div
      className={`app-shell ${!settingsRoute && sidebarCollapsed ? "is-sidebar-collapsed" : ""} ${settingsRoute ? "is-settings-route" : ""}`}
    >
      <TaskSearchDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        sessions={data.sessions}
        workspaces={data.workspaces}
        onSelect={(session) => {
          setSearchOpen(false);
          navigate(sessionHref({ workspacePath: session.workspacePath, sessionId: session.id }));
        }}
      />
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      {settingsRoute ? (
        <SettingsSidebar workspacePath={navigationWorkspacePath} onKeyDown={handleNavKeys} />
      ) : (
        <aside
          className={`sidebar ${sidebarCollapsed ? "sidebar--collapsed" : ""}`}
          onKeyDown={handleNavKeys}
        >
          <div className="sidebar__header">
            {preview && <span className="preview-dot" title="视觉预览模式" />}
            <button
              type="button"
              className="sidebar__collapse sidebar__search"
              aria-label="搜索任务"
              title="搜索任务 · ⌘K / Ctrl+K"
              onClick={() => setSearchOpen(true)}
            >
              <Search aria-hidden="true" />
            </button>
            {data.approvals.length + data.prompts.length > 0 ? (
              <span
                className="sidebar-pending-count"
                aria-label={`${data.approvals.length + data.prompts.length} 项待处理`}
                title="有待处理的审批或提问，请到对应会话查看"
              >
                {data.approvals.length + data.prompts.length}
              </span>
            ) : null}
            <button
              type="button"
              className="sidebar__collapse"
              aria-label={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              title={sidebarCollapsed ? "展开侧栏" : "收起侧栏"}
              onClick={() => setSidebarCollapsed((collapsed) => !collapsed)}
            >
              {sidebarCollapsed ? (
                <PanelLeftOpen aria-hidden="true" />
              ) : (
                <PanelLeftClose aria-hidden="true" />
              )}
            </button>
          </div>
          <Link
            className="sidebar-new-task"
            to={newSessionHref()}
            data-nav-link
            aria-label="新任务"
          >
            <Plus aria-hidden="true" />
            <span>新任务</span>
            <kbd className="sidebar-shortcut">⌘ N</kbd>
          </Link>
          <div className="sidebar__body">
            <Link
              className="nav-link"
              to="/extensions/skills"
              aria-label="扩展"
              data-nav-link
              onClick={() =>
                window.sessionStorage.setItem(
                  "pico.settings-return-to",
                  `${location.pathname}${location.search}`,
                )
              }
            >
              <Box aria-hidden="true" />
              <span className="sidebar__label">扩展</span>
            </Link>
            <SidebarNav
              items={primaryNav}
              label="主要导航"
              workspacePath={navigationWorkspacePath}
            />
            <SidebarTasks
              sessions={data.sessions}
              workspaces={data.workspaces}
              runs={data.runs}
              approvals={data.approvals}
              prompts={data.prompts}
              activeWorkspacePath={data.workspacePath}
              busy={busy === "session-state" || busy === "choose-workspace"}
              onArchiveSession={handleArchiveSession}
              onDeleteSession={handleDeleteSession}
              onPinSession={handlePinSession}
            />
          </div>
          <div className="sidebar__footer">
            <NavLink
              to="/settings"
              data-nav-link
              aria-label="设置"
              className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}
              onClick={() =>
                window.sessionStorage.setItem(
                  "pico.settings-return-to",
                  `${location.pathname}${location.search}`,
                )
              }
            >
              <Settings aria-hidden="true" />
              <span className="sidebar__label">设置</span>
            </NavLink>
            <div className="runtime-health">
              <span /> Runtime 已连接
            </div>
          </div>
        </aside>
      )}
      <div
        className={`workspace-frame ${immersiveRoute ? "workspace-frame--immersive" : ""} ${conversationRoute ? "workspace-frame--conversation" : ""} ${message ? "has-toast" : ""}`}
      >
        {!immersiveRoute && (
          <header className="titlebar">
            <div>
              <span className="titlebar__context">
                {routeWorkspacePath
                  ? workspaceDisplayName(routeWorkspacePath, routeWorkspace)
                  : "全部项目"}
              </span>
              <h1>{pageTitle}</h1>
            </div>
            <div className="titlebar__actions">
              {preview && <PreviewBadge />}
              <Link className="button button--primary" to={newSessionHref()}>
                <Plus aria-hidden="true" size={16} /> 新任务
              </Link>
            </div>
          </header>
        )}
        {message &&
          !message.startsWith("Legacy session-centric (JSONL) workspace storage exists:") && (
            <div className="toast" role="status">
              <span>{message}</span>
              <button
                type="button"
                className="toast__dismiss"
                aria-label="关闭提示"
                onClick={actions.dismissMessage}
              >
                <X aria-hidden="true" size={14} />
              </button>
            </div>
          )}
        <main
          className={`page ${conversationRoute ? "page--conversation" : ""}`}
          id="main-content"
          tabIndex={-1}
        >
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SettingsSidebar({
  workspacePath,
  onKeyDown,
}: {
  readonly workspacePath?: string;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const returnTo = window.sessionStorage.getItem("pico.settings-return-to");
  const returnHref =
    returnTo?.startsWith("/") && !returnTo.startsWith("/settings")
      ? returnTo
      : newSessionHref(workspacePath);
  const iconByKind = {
    general: Settings,
    workspaces: Folder,
    models: BrainCircuit,
    memory: BrainCircuit,
    skills: WandSparkles,
    mcp: Network,
    usage: Gauge,
    system: ShieldCheck,
  } as const;
  return (
    <aside className="sidebar settings-sidebar" onKeyDown={onKeyDown}>
      <Link
        className="settings-sidebar__back"
        to={returnHref}
        data-nav-link
        onClick={() => window.sessionStorage.removeItem("pico.settings-return-to")}
      >
        <ArrowLeft aria-hidden="true" />
        <span>返回 Pico</span>
      </Link>

      <div className="settings-sidebar__body">
        {settingsNavigationGroups.map((group) => (
          <nav key={group.label} className="settings-nav-group" aria-label={group.label}>
            <span>{group.label}</span>
            {group.items.map((item) => {
              const Icon = iconByKind[item.kind];
              const href =
                "scoped" in item && item.scoped && workspacePath
                  ? workspaceHref(item.to, workspacePath)
                  : item.to;
              return (
                <NavLink
                  key={item.to}
                  to={href}
                  end={"end" in item && item.end}
                  data-nav-link
                  className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}
                >
                  <Icon aria-hidden="true" />
                  <span>{item.label}</span>
                </NavLink>
              );
            })}
          </nav>
        ))}
      </div>
      <div className="runtime-health">
        <span /> Runtime 已连接
      </div>
    </aside>
  );
}

function SidebarTasks({
  sessions,
  workspaces,
  runs,
  approvals,
  prompts,
  activeWorkspacePath,
  busy,
  onArchiveSession,
  onDeleteSession,
  onPinSession,
}: {
  readonly sessions: readonly SessionView[];
  readonly workspaces: readonly WorkspaceView[];
  readonly runs: readonly RunView[];
  readonly approvals: readonly ApprovalView[];
  readonly prompts: readonly PromptView[];
  readonly activeWorkspacePath?: string;
  readonly busy: boolean;
  readonly onArchiveSession: (session: SessionView) => void;
  readonly onDeleteSession: (session: SessionView) => void;
  readonly onPinSession: (session: SessionView) => void;
}) {
  const [grouping, setGrouping] = useState<SidebarTaskGrouping>(() =>
    window.localStorage.getItem("pico.sidebar-task-grouping") === "project" ? "project" : "time",
  );
  const [collapsedProjects, setCollapsedProjects] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    window.localStorage.setItem("pico.sidebar-task-grouping", grouping);
  }, [grouping]);
  const visibleSessions = sortSidebarTasks(
    sessions.filter((session) => session.status !== "archived"),
  );
  const groups = Array.from(new Set(visibleSessions.map((session) => session.workspacePath)))
    .map((workspacePath) => ({
      workspace: workspaces.find((candidate) => candidate.path === workspacePath),
      workspacePath,
      sessions: visibleSessions.filter((session) => session.workspacePath === workspacePath),
    }))
    .filter((group) => group.sessions.length > 0);
  const renderSession = (session: SessionView, nested = false) => {
    const workspace = workspaces.find((candidate) => candidate.path === session.workspacePath);
    const sessionRuns = runs.filter(
      (run) => run.workspacePath === session.workspacePath && run.sessionId === session.id,
    );
    const sessionRunIds = new Set(sessionRuns.map((run) => run.id));
    const hasPendingInteraction =
      activeWorkspacePath === session.workspacePath &&
      (approvals.some(
        (approval) =>
          sessionRunIds.has(approval.runId) &&
          (!approval.sessionId || approval.sessionId === session.id),
      ) ||
        prompts.some((prompt) => sessionRunIds.has(prompt.runId)));
    return (
      <SidebarSessionRow
        key={workspaceSessionKey({ workspacePath: session.workspacePath, sessionId: session.id })}
        session={session}
        nested={nested}
        workspaceLabel={
          !nested && workspace?.temporary ? TEMPORARY_WORKSPACE_GROUP_LABEL : undefined
        }
        running={sessionRuns.some((run) => !isTerminalRun(run.status))}
        hasPendingInteraction={hasPendingInteraction}
        busy={busy}
        onArchive={onArchiveSession}
        onDelete={onDeleteSession}
        onPin={onPinSession}
      />
    );
  };

  return (
    <section className="sidebar-tasks" aria-labelledby="sidebar-tasks-title">
      <div className="sidebar-section-heading">
        <span id="sidebar-tasks-title">任务</span>
        <div className="sidebar-task-grouping" role="group" aria-label="任务分组方式">
          <button
            type="button"
            className={grouping === "time" ? "is-active" : ""}
            aria-pressed={grouping === "time"}
            onClick={() => setGrouping("time")}
          >
            时间
          </button>
          <button
            type="button"
            className={grouping === "project" ? "is-active" : ""}
            aria-pressed={grouping === "project"}
            onClick={() => setGrouping("project")}
          >
            项目
          </button>
        </div>
      </div>
      {visibleSessions.length === 0 ? (
        <p className="sidebar-tasks__empty">发送第一条消息后，任务会出现在这里。</p>
      ) : grouping === "time" ? (
        <div className="sidebar-recent-sessions">
          {visibleSessions.map((session) => renderSession(session))}
        </div>
      ) : (
        groups.map(({ workspace, workspacePath, sessions: workspaceSessions }) => (
          <div className="sidebar-project" key={workspacePath}>
            <button
              type="button"
              className="sidebar-project__header"
              aria-expanded={!collapsedProjects.has(workspacePath)}
              onClick={() =>
                setCollapsedProjects((current) => {
                  const next = new Set(current);
                  if (next.has(workspacePath)) next.delete(workspacePath);
                  else next.add(workspacePath);
                  return next;
                })
              }
            >
              {workspace?.mode === "git" ? (
                <FolderGit2 aria-hidden="true" />
              ) : (
                <Folder aria-hidden="true" />
              )}
              <span>
                {workspace?.temporary
                  ? TEMPORARY_WORKSPACE_GROUP_LABEL
                  : (workspace?.name ?? workspaceName(workspacePath))}
              </span>
              <small>{workspaceSessions.length}</small>
              <ChevronDown aria-hidden="true" />
            </button>
            {!collapsedProjects.has(workspacePath) && (
              <div className="sidebar-project__sessions">
                {workspaceSessions.map((session) => renderSession(session, true))}
              </div>
            )}
          </div>
        ))
      )}
    </section>
  );
}

function SidebarSessionRow({
  session,
  nested = false,
  workspaceLabel,
  running,
  hasPendingInteraction,
  busy,
  onArchive,
  onDelete,
  onPin,
}: {
  readonly session: SessionView;
  readonly nested?: boolean;
  readonly workspaceLabel?: string | undefined;
  readonly running: boolean;
  readonly hasPendingInteraction: boolean;
  readonly busy: boolean;
  readonly onArchive: (session: SessionView) => void;
  readonly onDelete: (session: SessionView) => void;
  readonly onPin: (session: SessionView) => void;
}) {
  const location = useLocation();
  const sessionRef = { workspacePath: session.workspacePath, sessionId: session.id };
  const active = isActiveWorkspaceSession(sessionRef, location.pathname, location.search);
  const archiveSession = () => onArchive(session);
  const deleteSession = () => onDelete(session);
  const pinSession = () => onPin(session);
  return (
    <div className={`sidebar-session-row ${nested ? "is-nested" : ""}`}>
      <NavLink
        className={() =>
          `sidebar-task-link ${active ? "is-active" : ""} ${session.pinned ? "is-pinned" : ""}`
        }
        to={sessionHref(sessionRef)}
        data-nav-link
      >
        <span
          className={`sidebar-task-link__status ${running && !hasPendingInteraction ? "is-running" : ""}`}
          style={hasPendingInteraction ? { background: "#d97706" } : undefined}
          aria-label={
            hasPendingInteraction
              ? "等待审批或回答"
              : running
                ? "运行中"
                : session.pinned
                  ? "已置顶"
                  : "会话"
          }
        />
        <span title={workspaceLabel ? `${workspaceLabel} · ${session.title}` : session.title}>
          {workspaceLabel ? `${workspaceLabel} · ${session.title}` : session.title}
        </span>
        <time dateTime={new Date(session.updatedAt).toISOString()}>
          {formatRelative(session.updatedAt)}
        </time>
      </NavLink>
      <details
        className="sidebar-task-menu"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget)) event.currentTarget.open = false;
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.open = false;
            event.currentTarget.querySelector("summary")?.focus();
          }
        }}
      >
        <summary aria-label={`更多操作 ${session.title}`} title="更多操作">
          <MoreHorizontal aria-hidden="true" />
        </summary>
        <div
          className="sidebar-task-actions"
          aria-label="会话操作"
          onClick={(event) => {
            const details = event.currentTarget.closest("details");
            if (details && (event.target as HTMLElement).closest("button")) {
              details.open = false;
              details.querySelector("summary")?.focus();
            }
          }}
        >
          <button
            type="button"
            aria-label={`归档 ${session.title}`}
            title="归档"
            disabled={busy}
            onClick={archiveSession}
          >
            <Archive aria-hidden="true" /> 归档
          </button>
          <button
            type="button"
            aria-label={`删除 ${session.title}`}
            title={running ? "运行中的会话不能删除" : "删除"}
            disabled={busy || running}
            onClick={deleteSession}
          >
            <Trash2 aria-hidden="true" /> 删除
          </button>
          <button
            type="button"
            className={session.pinned ? "is-active" : ""}
            aria-label={`${session.pinned ? "取消置顶" : "置顶"} ${session.title}`}
            title={session.pinned ? "取消置顶" : "置顶"}
            disabled={busy}
            onClick={pinSession}
          >
            <Pin aria-hidden="true" /> {session.pinned ? "取消置顶" : "置顶"}
          </button>
        </div>
      </details>
    </div>
  );
}

function SidebarNav({
  items,
  label,
  caption,
  workspacePath,
}: {
  readonly items: readonly {
    readonly to: string;
    readonly label: string;
    readonly icon: typeof Home;
    readonly end?: boolean;
    readonly scoped?: boolean;
  }[];
  readonly label: string;
  readonly caption?: string;
  readonly workspacePath?: string;
}) {
  return (
    <nav className="sidebar-nav" aria-label={label}>
      {caption && <span className="sidebar-nav__caption">{caption}</span>}
      {items.map(({ to, label: itemLabel, icon: Icon, end, scoped }) => (
        <NavLink
          key={to}
          to={scoped && workspacePath ? workspaceHref(to, workspacePath) : to}
          {...(end === undefined ? {} : { end })}
          data-nav-link
          aria-label={itemLabel}
          className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}
        >
          <Icon aria-hidden="true" />
          <span>{itemLabel}</span>
        </NavLink>
      ))}
    </nav>
  );
}

function routeTitle(pathname: string): string {
  if (pathname.startsWith("/task/")) return pathname === "/task/new" ? "新任务" : "任务运行";
  if (pathname.startsWith("/session/")) return "会话";
  if (pathname.startsWith("/extensions")) return "扩展";
  if (pathname.startsWith("/settings")) return "设置";
  return (
    (
      {
        "/": "开始",
        "/sessions": "会话",
        "/automations": "定时任务",
        "/review": "更改审阅",
      } as Readonly<Record<string, string>>
    )[pathname] ?? "Pico"
  );
}
