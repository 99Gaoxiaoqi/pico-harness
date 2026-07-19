import {
  AlertTriangle,
  Archive,
  Bot,
  Box,
  BrainCircuit,
  CheckCircle2,
  CircleDollarSign,
  Clock3,
  Code2,
  FileCode2,
  FileDiff,
  Folder,
  FolderGit2,
  Gauge,
  GitFork,
  History,
  Home,
  Layers3,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  Pin,
  Plus,
  Pencil,
  RefreshCw,
  RotateCcw,
  Search,
  Settings,
  ShieldCheck,
  Sparkles,
  TerminalSquare,
  Trash2,
  WandSparkles,
  Workflow,
} from "lucide-react";
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  HashRouter,
  Link,
  Navigate,
  NavLink,
  Outlet,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  ApprovalDialog,
  Button,
  CapabilityList,
  EmptyState,
  InlineNotice,
  PromptDialog,
  StatusPill,
} from "./components.js";
import {
  ConversationComposer,
  ConversationInspector,
  ConversationSurface,
  ConversationTranscript,
  type ComposerBehavior,
  type ConversationInspectorView,
  type ConversationItemView,
  mergeConversationItemGroups,
} from "./conversation/index.js";
import type {
  CapabilityView,
  ChangeView,
  RunView,
  SessionView,
  TimelineItem,
  WorkspaceView,
  WorkspaceMode,
} from "./model.js";
import { ProviderPage } from "./ProviderPage.js";
import { useRuntimeStore, type RuntimeStore } from "./runtime.js";
import {
  newSessionHref,
  sessionHref,
  workspaceHref,
  workspaceName,
  workspaceParent,
  workspacePathFromSearch,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "./workspace-session.js";

const RuntimeContext = createContext<RuntimeStore | null>(null);

function useRuntime(): RuntimeStore {
  const value = useContext(RuntimeContext);
  if (!value) throw new Error("RuntimeContext is missing");
  return value;
}

export class AppErrorBoundary extends Component<
  { readonly children: ReactNode },
  { readonly error?: Error }
> {
  override state: { readonly error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    if (this.state.error) {
      return (
        <main className="fatal-state">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <h1>Pico 无法显示这个界面</h1>
          <p>{this.state.error.message}</p>
          <Button variant="primary" onClick={() => window.location.reload()}>
            重新载入
          </Button>
        </main>
      );
    }
    return this.props.children;
  }
}

export function DesktopApp() {
  const runtime = useRuntimeStore();
  return (
    <RuntimeContext.Provider value={runtime}>
      <HashRouter>
        <AppStateRouter />
      </HashRouter>
    </RuntimeContext.Provider>
  );
}

function AppStateRouter() {
  const { connection } = useRuntime();
  if (connection.kind === "loading") return <LoadingScreen />;
  if (connection.kind === "unavailable" || connection.kind === "error") {
    return <ConnectionScreen />;
  }
  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route
          path="task/new"
          element={
            <WorkspaceRoute>
              <NewTaskPage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="task/:runId"
          element={
            <WorkspaceRoute>
              <TaskPage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="session/:sessionId"
          element={
            <WorkspaceRoute>
              <ConversationPage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="review"
          element={
            <WorkspaceRoute>
              <ReviewPage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="automations"
          element={
            <WorkspaceRoute>
              <AutomationsPage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="skills"
          element={
            <WorkspaceRoute>
              <CapabilityPage kind="skills" />
            </WorkspaceRoute>
          }
        />
        <Route
          path="mcp"
          element={
            <WorkspaceRoute>
              <CapabilityPage kind="mcp" />
            </WorkspaceRoute>
          }
        />
        <Route
          path="providers"
          element={
            <WorkspaceRoute>
              <ProviderPageRoute />
            </WorkspaceRoute>
          }
        />
        <Route
          path="usage"
          element={
            <WorkspaceRoute>
              <UsagePage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="settings"
          element={
            <WorkspaceRoute>
              <SettingsPage />
            </WorkspaceRoute>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

function WorkspaceRoute({ children }: { readonly children: ReactNode }) {
  const { data, actions } = useRuntime();
  const location = useLocation();
  const workspacePath = workspacePathFromSearch(location.search);
  const workspace = data.workspaces.find((candidate) => candidate.path === workspacePath);

  useEffect(() => {
    if (workspacePath && workspace && data.workspacePath !== workspacePath) {
      void actions.selectWorkspace(workspacePath);
    }
  }, [actions, data.workspacePath, workspace, workspacePath]);

  if (!workspacePath || !workspace) return <WorkspacePicker />;
  if (data.workspacePath !== workspacePath) {
    return (
      <div className="workspace-route-loading" aria-busy="true">
        <RefreshCw aria-hidden="true" />
        <p>正在载入 {workspace.name}…</p>
      </div>
    );
  }
  if (!data.trusted) return <TrustWorkspace workspacePath={workspacePath} />;
  return children;
}

function WorkspacePicker() {
  const { data, actions, busy } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const addWorkspace = async () => {
    const workspacePath = await actions.chooseWorkspace();
    if (workspacePath) navigate(workspaceHref(location.pathname, workspacePath));
  };
  return (
    <section className="workspace-picker" aria-labelledby="workspace-picker-title">
      <span className="eyebrow">会话工作区</span>
      <h2 id="workspace-picker-title">选择这个会话要使用的项目</h2>
      <p>工作区只绑定到这个会话，不会把整个 App 锁定在一个目录。</p>
      {data.workspaces.length > 0 ? (
        <div className="workspace-picker__list">
          {data.workspaces.map((workspace) => (
            <Link
              className="workspace-picker__item"
              key={workspace.path}
              to={workspaceHref(location.pathname, workspace.path)}
            >
              <span className="workspace-picker__icon">
                {workspace.mode === "git" ? (
                  <FolderGit2 aria-hidden="true" />
                ) : (
                  <Folder aria-hidden="true" />
                )}
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>{workspaceParent(workspace.path)}</small>
              </span>
              <span className="workspace-picker__state">
                {workspace.trusted ? "已信任" : "待信任"}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        <EmptyState
          icon={<Folder />}
          title="还没有项目"
          detail="先添加一个本地文件夹，再开始会话。"
        />
      )}
      <Button variant="primary" disabled={Boolean(busy)} onClick={() => void addWorkspace()}>
        <Plus aria-hidden="true" size={16} />
        添加项目文件夹
      </Button>
    </section>
  );
}

function LoadingScreen() {
  return (
    <main className="loading-screen" aria-busy="true">
      <span className="brand-mark brand-mark--large" aria-hidden="true">
        P
      </span>
      <p>Pico 正在连接本地 Runtime…</p>
    </main>
  );
}

function ConnectionScreen() {
  const { connection, actions } = useRuntime();
  const detail =
    connection.kind === "loading" || connection.kind === "ready" ? "" : connection.detail;
  return (
    <main className="connection-screen">
      <div className="connection-card">
        <span className="brand-mark brand-mark--large" aria-hidden="true">
          P
        </span>
        <span className="eyebrow">本地 Runtime 未连接</span>
        <h1>界面已就绪，但没有可用的数据连接</h1>
        <p>{detail}</p>
        <InlineNotice tone="warning">
          Pico 不会使用演示数据代替真实任务。修复连接后，这里会显示你的本地会话。
        </InlineNotice>
        <Button variant="primary" onClick={() => void actions.reload()}>
          <RefreshCw aria-hidden="true" size={16} />
          重新连接
        </Button>
      </div>
    </main>
  );
}

function Onboarding() {
  const { data, actions, busy, preview } = useRuntime();
  const navigate = useNavigate();
  const selected = Boolean(data.workspacePath);
  const chooseWorkspace = async () => {
    const workspacePath = await actions.chooseWorkspace();
    if (workspacePath) navigate(newSessionHref(workspacePath));
  };
  return (
    <main className="onboarding">
      {preview && <PreviewBadge />}
      <header className="onboarding__header">
        <span className="brand-mark" aria-hidden="true">
          P
        </span>
        <span>Pico</span>
      </header>
      <section className="onboarding__content">
        <div className="onboarding__copy">
          <span className="eyebrow">开始之前</span>
          <h1>
            把一个项目交给 Pico，
            <br />
            从清楚的边界开始。
          </h1>
          <p>代码、会话和密钥都留在这台电脑。Pico 只会在你信任的工作区内执行操作。</p>
        </div>
        <div className="setup-card">
          <ol className="setup-steps" aria-label="设置进度">
            <li className="is-current">
              <span>1</span>选择项目
            </li>
            <li className={selected ? "is-current" : ""}>
              <span>2</span>确认信任
            </li>
            <li>
              <span>3</span>连接模型
            </li>
          </ol>
          <div className="setup-card__body">
            <div className="setup-icon">
              <Folder aria-hidden="true" />
            </div>
            <h2>{selected ? "项目已选择" : "选择一个项目文件夹"}</h2>
            <p>它会成为任务的文件边界。你可以稍后添加更多工作区。</p>
            {data.workspacePath && (
              <div className="selected-path">
                <code>{data.workspacePath}</code>
              </div>
            )}
            <Button
              variant="primary"
              disabled={Boolean(busy)}
              onClick={() => void chooseWorkspace()}
            >
              {selected ? "更换文件夹" : "选择文件夹"}
            </Button>
            {selected && (
              <Button
                disabled={Boolean(busy)}
                onClick={() => data.workspacePath && navigate(newSessionHref(data.workspacePath))}
              >
                继续并检查工作区
              </Button>
            )}
          </div>
          <footer>
            <ShieldCheck aria-hidden="true" size={15} /> Pico 不会扫描其他目录
          </footer>
        </div>
      </section>
    </main>
  );
}

function TrustWorkspace({ workspacePath }: { readonly workspacePath: string }) {
  const { data, actions, busy } = useRuntime();
  const navigate = useNavigate();
  return (
    <section className="trust-screen" aria-labelledby="trust-workspace-title">
      <section className="trust-card">
        <div className="setup-icon">
          <ShieldCheck aria-hidden="true" />
        </div>
        <span className="eyebrow">工作区信任</span>
        <h1 id="trust-workspace-title">你信任这个项目的内容吗？</h1>
        <p>Pico 可能会读取文件、运行项目命令，并根据任务修改代码。危险或越界操作仍需要单独审批。</p>
        <code className="trust-path">{workspacePath}</code>
        <WorkspaceModeCard mode={data.workspaceMode} />
        <ul className="trust-facts">
          <li>
            <CheckCircle2 aria-hidden="true" /> 访问范围限制在此文件夹
          </li>
          <li>
            <CheckCircle2 aria-hidden="true" /> 敏感操作会先说明影响
          </li>
          <li>
            <CheckCircle2 aria-hidden="true" /> 可随时在设置中撤销信任
          </li>
        </ul>
        <div className="button-row">
          <Button disabled={Boolean(busy)} onClick={() => navigate("/sessions")}>
            返回会话库
          </Button>
          <Button
            variant="primary"
            disabled={Boolean(busy)}
            onClick={() => void actions.trustWorkspace(workspacePath, true)}
          >
            信任并继续
          </Button>
        </div>
      </section>
    </section>
  );
}

const primaryNav = [{ to: "/automations", label: "自动化", icon: Workflow, scoped: true }] as const;

const resourceNav = [
  { to: "/skills", label: "Skills", icon: WandSparkles, scoped: true },
  { to: "/mcp", label: "MCP", icon: Network, scoped: true },
  { to: "/providers", label: "模型", icon: BrainCircuit, scoped: true },
  { to: "/usage", label: "用量", icon: Gauge, scoped: true },
] as const;

function AppShell() {
  const { data, preview, message, actions, busy } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("pico.sidebar-collapsed") === "true",
  );
  const routeWorkspacePath = workspacePathFromSearch(location.search);
  const pageTitle = routeTitle(location.pathname);
  const conversationRoute =
    location.pathname === "/task/new" || location.pathname.startsWith("/session/");
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
  const handleAddWorkspace = useCallback(() => {
    void actions.chooseWorkspace();
  }, [actions]);
  const handleArchiveSession = useCallback(
    (session: SessionView) => {
      void actions.setSessionArchived(
        { workspacePath: session.workspacePath, sessionId: session.id },
        true,
      );
    },
    [actions],
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
      if (deleted && location.pathname === `/session/${session.id}`) {
        navigate(newSessionHref(session.workspacePath));
      }
    },
    [actions, location.pathname, navigate],
  );
  return (
    <div className={`app-shell ${sidebarCollapsed ? "is-sidebar-collapsed" : ""}`}>
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside
        className={`sidebar ${sidebarCollapsed ? "sidebar--collapsed" : ""}`}
        onKeyDown={handleNavKeys}
      >
        <div className="sidebar__header">
          <Link className="sidebar__brand" to="/" aria-label="Pico 开始页">
            <span className="brand-mark" aria-hidden="true">
              P
            </span>
            <span className="sidebar__label">Pico</span>
            {preview && <span className="preview-dot" title="视觉预览模式" />}
          </Link>
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
        <Link className="sidebar-new-task" to={newSessionHref()} data-nav-link aria-label="新任务">
          <Plus aria-hidden="true" />
          <span>新任务</span>
        </Link>
        <div className="sidebar__body">
          <SidebarNav items={primaryNav} label="主要导航" workspacePath={routeWorkspacePath} />
          <SidebarTasks
            sessions={data.sessions}
            workspaces={data.workspaces}
            runs={data.runs}
            busy={busy === "session-state" || busy === "choose-workspace"}
            onAddWorkspace={handleAddWorkspace}
            onArchiveSession={handleArchiveSession}
            onDeleteSession={handleDeleteSession}
            onPinSession={handlePinSession}
          />
          <SidebarNav
            items={resourceNav}
            label="能力与设置"
            caption="工具"
            workspacePath={routeWorkspacePath}
          />
        </div>
        <div className="sidebar__footer">
          <NavLink
            to={routeWorkspacePath ? workspaceHref("/settings", routeWorkspacePath) : "/settings"}
            data-nav-link
            aria-label="设置"
            className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}
          >
            <Settings aria-hidden="true" />
            <span className="sidebar__label">设置</span>
          </NavLink>
          <div className="runtime-health">
            <span /> Runtime 已连接
          </div>
        </div>
      </aside>
      <div
        className={`workspace-frame ${conversationRoute ? "workspace-frame--conversation" : ""}`}
      >
        {!conversationRoute && (
          <header className="titlebar">
            <div>
              <span className="titlebar__context">
                {routeWorkspacePath ? workspaceName(routeWorkspacePath) : "全部项目"}
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
        {message && (
          <div className="toast" role="status">
            {message}
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

function SidebarTasks({
  sessions,
  workspaces,
  runs,
  busy,
  onAddWorkspace,
  onArchiveSession,
  onDeleteSession,
  onPinSession,
}: {
  readonly sessions: readonly SessionView[];
  readonly workspaces: readonly WorkspaceView[];
  readonly runs: readonly RunView[];
  readonly busy: boolean;
  readonly onAddWorkspace: () => void;
  readonly onArchiveSession: (session: SessionView) => void;
  readonly onDeleteSession: (session: SessionView) => void;
  readonly onPinSession: (session: SessionView) => void;
}) {
  const visibleSessions = sessions.filter((session) => session.status !== "archived");
  const workspacePaths = Array.from(
    new Set([
      ...workspaces.map((workspace) => workspace.path),
      ...visibleSessions.map((session) => session.workspacePath),
    ]),
  );
  const groups = workspacePaths
    .map((workspacePath) => ({
      workspace: workspaces.find((candidate) => candidate.path === workspacePath),
      workspacePath,
      sessions: visibleSessions
        .filter((session) => session.workspacePath === workspacePath)
        .sort(
          (left, right) =>
            Number(Boolean(right.pinned)) - Number(Boolean(left.pinned)) ||
            right.updatedAt - left.updatedAt,
        ),
    }))
    .filter((group) => group.sessions.length > 0 || group.workspace);

  return (
    <section className="sidebar-tasks" aria-labelledby="sidebar-tasks-title">
      <div className="sidebar-section-heading">
        <span id="sidebar-tasks-title">项目</span>
        <button
          type="button"
          aria-label="添加工作区"
          title="添加工作区"
          disabled={busy}
          onClick={onAddWorkspace}
        >
          <Plus aria-hidden="true" />
        </button>
      </div>
      {groups.length === 0 ? (
        <p className="sidebar-tasks__empty">新任务会按项目显示在这里。</p>
      ) : (
        groups.map(({ workspace, workspacePath, sessions: workspaceSessions }) => (
          <div className="sidebar-project" key={workspacePath}>
            <Link
              className="sidebar-project__header"
              to={newSessionHref(workspacePath)}
              data-nav-link
              title={`在 ${workspace?.name ?? workspaceName(workspacePath)} 中新建任务`}
            >
              {workspace?.mode === "git" ? (
                <FolderGit2 aria-hidden="true" />
              ) : (
                <Folder aria-hidden="true" />
              )}
              <span>{workspace?.name ?? workspaceName(workspacePath)}</span>
              <Plus aria-hidden="true" />
            </Link>
            <div className="sidebar-project__sessions">
              {workspaceSessions.map((session) => (
                <SidebarSessionRow
                  key={workspaceSessionKey({ workspacePath, sessionId: session.id })}
                  session={session}
                  running={runs.some(
                    (run) => run.sessionId === session.id && !isTerminalRun(run.status),
                  )}
                  busy={busy}
                  onArchive={onArchiveSession}
                  onDelete={onDeleteSession}
                  onPin={onPinSession}
                />
              ))}
            </div>
          </div>
        ))
      )}
    </section>
  );
}

function SidebarSessionRow({
  session,
  running,
  busy,
  onArchive,
  onDelete,
  onPin,
}: {
  readonly session: SessionView;
  readonly running: boolean;
  readonly busy: boolean;
  readonly onArchive: (session: SessionView) => void;
  readonly onDelete: (session: SessionView) => void;
  readonly onPin: (session: SessionView) => void;
}) {
  const archiveSession = () => onArchive(session);
  const deleteSession = () => onDelete(session);
  const pinSession = () => onPin(session);
  return (
    <div className="sidebar-session-row">
      <NavLink
        className={({ isActive }) =>
          `sidebar-task-link ${isActive ? "is-active" : ""} ${session.pinned ? "is-pinned" : ""}`
        }
        to={sessionHref({ workspacePath: session.workspacePath, sessionId: session.id })}
        data-nav-link
      >
        <span
          className={`sidebar-task-link__status ${running ? "is-running" : ""}`}
          aria-label={running ? "运行中" : session.pinned ? "已置顶" : "会话"}
        />
        <span>{session.title}</span>
        <time dateTime={new Date(session.updatedAt).toISOString()}>
          {formatRelative(session.updatedAt)}
        </time>
      </NavLink>
      <div className="sidebar-task-actions" aria-label="会话操作">
        <button
          type="button"
          aria-label={`归档 ${session.title}`}
          title="归档"
          disabled={busy}
          onClick={archiveSession}
        >
          <Archive aria-hidden="true" />
        </button>
        <button
          type="button"
          aria-label={`删除 ${session.title}`}
          title={running ? "运行中的会话不能删除" : "删除"}
          disabled={busy || running}
          onClick={deleteSession}
        >
          <Trash2 aria-hidden="true" />
        </button>
        <button
          type="button"
          className={session.pinned ? "is-active" : ""}
          aria-label={`${session.pinned ? "取消置顶" : "置顶"} ${session.title}`}
          title={session.pinned ? "取消置顶" : "置顶"}
          disabled={busy}
          onClick={pinSession}
        >
          <Pin aria-hidden="true" />
        </button>
      </div>
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

function PreviewBadge() {
  return (
    <span className="preview-badge">
      <Sparkles aria-hidden="true" size={13} /> Preview
    </span>
  );
}

function WorkspaceModeBadge({ mode }: { readonly mode: WorkspaceMode | undefined }) {
  return (
    <span className={`workspace-mode-badge workspace-mode-badge--${mode ?? "folder"}`}>
      {mode === "git" ? <ShieldCheck aria-hidden="true" /> : <Folder aria-hidden="true" />}
      {mode === "git" ? "版本保护" : "基础模式"}
    </span>
  );
}

function WorkspaceModeCard({ mode }: { readonly mode: WorkspaceMode | undefined }) {
  const protectedMode = mode === "git";
  return (
    <section className="workspace-mode-card" aria-label="工作区模式">
      <div>
        <WorkspaceModeBadge mode={mode} />
        <strong>{protectedMode ? "这个文件夹已启用版本保护" : "这个文件夹可以直接使用"}</strong>
      </div>
      <p>
        {protectedMode
          ? "Pico 可以隔离并行任务，并在确认后合并它们的更改。"
          : "Pico 可以直接读写文件并运行并行分析子代理；可写子代理的隔离、分支和独立合并目前需要 Git。"}
      </p>
      {!protectedMode && (
        <small>版本保护是一项进阶能力，由 Git 提供；不了解它也不影响现在开始。</small>
      )}
    </section>
  );
}

function HomePage() {
  const { data } = useRuntime();
  const latestRun = data.runs.find((run) => !isTerminalRun(run.status));
  return (
    <div className="page-stack home-page">
      <section className="welcome-block">
        <span className="eyebrow">本地 Agent</span>
        <h2>今天想推进什么？</h2>
        <p>每个会话都会记住自己的项目边界。新建会话时选择工作区，已有会话会回到它原来的目录。</p>
        <div className="button-row">
          <Link className="button button--primary" to={newSessionHref()}>
            <Plus aria-hidden="true" size={16} /> 新建会话
          </Link>
          {data.workspaces.length === 0 && (
            <Link className="button" to="/onboarding">
              添加第一个项目
            </Link>
          )}
        </div>
      </section>
      <div className="dashboard-grid">
        <section className="panel panel--wide">
          <PanelHeader
            title="最近会话"
            detail={`${data.sessions.length} 个本地会话`}
            action={<Link to="/sessions">查看全部</Link>}
          />
          {data.sessions.length === 0 ? (
            <EmptyState title="还没有会话" detail="创建第一项任务后，它会出现在这里。" />
          ) : (
            <div className="session-list session-list--compact">
              {data.sessions.slice(0, 4).map((session) => (
                <SessionRow
                  key={workspaceSessionKey({
                    workspacePath: session.workspacePath,
                    sessionId: session.id,
                  })}
                  session={session}
                />
              ))}
            </div>
          )}
        </section>
        <section className="panel">
          <PanelHeader title="当前运行" detail={latestRun ? "实时状态" : "没有运行中的任务"} />
          {latestRun ? (
            <Link
              className="active-run-card"
              to={
                latestRun.sessionId
                  ? sessionHref({
                      workspacePath: latestRun.workspacePath,
                      sessionId: latestRun.sessionId,
                    })
                  : workspaceHref(`/task/${latestRun.id}`, latestRun.workspacePath)
              }
            >
              <span className="active-run-card__icon">
                <Bot aria-hidden="true" />
              </span>
              <div>
                <StatusPill status={latestRun.status} />
                <h3>{latestRun.description}</h3>
                <p>{formatElapsed(latestRun.startedAt)}</p>
              </div>
            </Link>
          ) : (
            <EmptyState icon={<Bot />} title="Pico 正在待命" detail="新任务会在这里显示进度。" />
          )}
        </section>
        <section className="panel metric-panel">
          <PanelHeader title="项目" detail="已注册的本地工作区" />
          <strong>{data.workspaces.length}</strong>
          <span>个可用项目</span>
          <p>{data.workspaces.filter((workspace) => workspace.trusted).length} 个已信任</p>
        </section>
      </div>
    </div>
  );
}

function NewTaskPage() {
  return <ConversationPage />;
}

function ConversationPage() {
  const { sessionId } = useParams();
  const { data, actions, busy, preview } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const workspacePath = workspacePathFromSearch(location.search) ?? "";
  const sessionRef = useMemo<WorkspaceSessionRef | undefined>(
    () => (sessionId && workspacePath ? { workspacePath, sessionId } : undefined),
    [sessionId, workspacePath],
  );
  const conversationKey = sessionRef ? workspaceSessionKey(sessionRef) : undefined;
  const [draft, setDraft] = useState("");
  const [behavior, setBehavior] = useState<ComposerBehavior>("steer");
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [selectedApprovalId, setSelectedApprovalId] = useState<string>();
  const [selectedPromptId, setSelectedPromptId] = useState<string>();
  const [inspector, setInspector] = useState<ConversationInspectorView>();
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [activation, setActivation] = useState<
    | { readonly kind: "skill"; readonly name: string }
    | { readonly kind: "agent"; readonly name: string }
  >();
  const sendingRef = useRef(false);

  useEffect(() => {
    if (sessionRef) void actions.loadSession(sessionRef);
  }, [actions, sessionRef]);

  useEffect(() => {
    setDraft("");
    setInspector(undefined);
    setApprovalOpen(false);
    setPromptOpen(false);
    setSelectedApprovalId(undefined);
    setSelectedPromptId(undefined);
    setEditingTitle(false);
    setConfirmCompact(false);
    setActivation(undefined);
  }, [sessionId, workspacePath]);

  const session = data.sessions.find(
    (item) => item.workspacePath === workspacePath && item.id === sessionId,
  );
  const conversation = conversationKey ? data.conversations[conversationKey] : undefined;
  const sessionRuns = data.runs.filter(
    (run) => run.workspacePath === workspacePath && run.sessionId === sessionId,
  );
  const activeRun = sessionRuns.find((run) => !isTerminalRun(run.status));
  const selectedApproval = data.approvals.find((item) => item.id === selectedApprovalId);
  const selectedPrompt = data.prompts.find((item) => item.id === selectedPromptId);
  const composerStatus = activeRun
    ? ["paused", "pause_requested"].includes(activeRun.status)
      ? "paused"
      : "running"
    : "idle";

  useEffect(() => {
    if (!editingTitle) setTitleDraft(session?.title ?? "");
  }, [editingTitle, session?.title]);

  const items = useMemo<readonly ConversationItemView[]>(() => {
    const persisted = conversation?.items ?? [];
    const live = activeRun
      ? data.timeline
          .filter((item) => item.runId === activeRun.id)
          .map(timelineItemToConversationItem)
      : [];
    const runIds = new Set(sessionRuns.map((run) => run.id));
    const decisions: ConversationItemView[] = [
      ...data.approvals
        .filter((approval) => runIds.has(approval.runId))
        .map(
          (approval): ConversationItemView => ({
            id: `approval:${approval.id}`,
            kind: "approval",
            title: approval.title,
            detail: approval.detail,
            state: "pending",
          }),
        ),
      ...data.prompts
        .filter((prompt) => runIds.has(prompt.runId))
        .map(
          (prompt): ConversationItemView => ({
            id: `prompt:${prompt.id}`,
            kind: "prompt",
            question: prompt.question,
            state: "pending",
          }),
        ),
    ];
    const changes: ConversationItemView[] =
      conversation?.runId && conversation.changes && conversation.changes.length > 0
        ? [
            {
              id: `changes:${conversation.runId}`,
              kind: "changes",
              title: "本轮文件更改",
              detail: "在应用前审阅 Runtime 生成的差异。",
              files: conversation.changes.map((change) => change.path),
              state: "pending",
            },
          ]
        : [];
    const goal =
      conversation?.goalItem && !persisted.some((item) => item.kind === "goal")
        ? [conversation.goalItem]
        : [];
    return mergeConversationItemGroups(persisted, goal, live, decisions, changes);
  }, [
    activeRun,
    data.approvals,
    conversation,
    data.prompts,
    data.timeline,
    sessionId,
    sessionRuns,
  ]);

  const submit = async (text: string, nextBehavior: ComposerBehavior) => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    try {
      const result = await actions.sendMessage({
        workspacePath,
        ...(sessionId ? { sessionId } : {}),
        text,
        behavior: nextBehavior,
        ...(activeRun ? { expectedRunId: activeRun.id } : {}),
        ...(activation ? { activation } : {}),
      });
      if (!result.succeeded) return;
      setDraft("");
      setActivation(undefined);
      if (!sessionId && result.sessionId) {
        navigate(
          sessionHref({
            workspacePath: result.workspacePath ?? workspacePath,
            sessionId: result.sessionId,
          }),
          { replace: true },
        );
      }
    } finally {
      sendingRef.current = false;
    }
  };

  const openCatalog = () => {
    setInspector({
      title: "添加到会话",
      subtitle: "来自当前 Runtime 的真实目录",
      content: (
        <div className="conversation-catalog-list">
          <section>
            <h3>Skills</h3>
            {data.catalogSkills.length === 0 ? (
              <p>当前工作区没有可用 Skill。</p>
            ) : (
              data.catalogSkills.map((skill) => (
                <button
                  type="button"
                  key={`skill:${skill.name}`}
                  onClick={() => {
                    setActivation({ kind: "skill", name: skill.name });
                    setInspector(undefined);
                  }}
                >
                  <WandSparkles aria-hidden="true" />
                  <span>
                    <strong>{skill.name}</strong>
                    <small>{skill.description}</small>
                  </span>
                </button>
              ))
            )}
          </section>
          <section>
            <h3>子代理</h3>
            {data.catalogAgents.length === 0 ? (
              <p>当前 Runtime 没有发现可用 Agent。</p>
            ) : (
              data.catalogAgents.map((agent) => (
                <button
                  type="button"
                  key={`agent:${agent.name}`}
                  onClick={() => {
                    setActivation({ kind: "agent", name: agent.name });
                    setInspector(undefined);
                  }}
                >
                  <Bot aria-hidden="true" />
                  <span>
                    <strong>{agent.name}</strong>
                    <small>{agent.description}</small>
                  </span>
                </button>
              ))
            )}
          </section>
        </div>
      ),
    });
  };

  const openItem = (item: ConversationItemView) => {
    if (item.kind === "approval") {
      setSelectedApprovalId(item.id.replace(/^approval:/, ""));
      setApprovalOpen(true);
      return;
    }
    if (item.kind === "prompt") {
      setSelectedPromptId(item.id.replace(/^prompt:/, ""));
      setPromptOpen(true);
      return;
    }
    if (item.kind === "changes") {
      const params = new URLSearchParams({ workspace: workspacePath });
      if (sessionId) params.set("sessionId", sessionId);
      navigate(`/review?${params.toString()}`);
      return;
    }
    if (item.kind === "tool") {
      setInspector({
        title: item.title,
        subtitle: item.toolName,
        content: (
          <pre className="conversation-inspector-output">
            {item.output ?? item.detail ?? "没有可显示的输出。"}
          </pre>
        ),
      });
      return;
    }
    if (item.kind === "subagent") {
      setInspector({
        title: item.name,
        subtitle: "子代理会话",
        content: <p>{item.detail ?? "详细会话仍在 Runtime 中同步。"}</p>,
      });
    }
  };

  return (
    <ConversationSurface
      className="session-conversation"
      header={
        <div className="conversation-session-header">
          <div>
            {editingTitle && sessionRef ? (
              <form
                className="conversation-title-editor"
                onSubmit={(event) => {
                  event.preventDefault();
                  void actions
                    .renameSession(sessionRef, titleDraft)
                    .then(() => setEditingTitle(false));
                }}
              >
                <label className="conversation-sr-only" htmlFor="conversation-title">
                  会话标题
                </label>
                <input
                  id="conversation-title"
                  name="conversation-title"
                  autoComplete="off"
                  value={titleDraft}
                  autoFocus
                  onChange={(event) => setTitleDraft(event.target.value)}
                />
                <Button
                  type="submit"
                  variant="quiet"
                  disabled={!titleDraft.trim() || Boolean(busy)}
                >
                  保存
                </Button>
                <Button type="button" variant="quiet" onClick={() => setEditingTitle(false)}>
                  取消
                </Button>
              </form>
            ) : (
              <h1>{session?.title ?? (sessionId ? "正在载入会话…" : "今天想一起做什么？")}</h1>
            )}
          </div>
          <div className="conversation-session-header__meta">
            {preview && <PreviewBadge />}
            {conversation?.usage && (
              <span>
                {formatCompact(
                  (conversation.usage.inputTokens ?? 0) + (conversation.usage.outputTokens ?? 0),
                )}{" "}
                tokens
              </span>
            )}
            {activeRun && <StatusPill status={activeRun.status} />}
            {sessionRef && (
              <div className="conversation-session-actions" aria-label="会话操作">
                <button
                  type="button"
                  disabled={Boolean(activeRun) || Boolean(busy)}
                  onClick={() => setEditingTitle(true)}
                >
                  <Pencil aria-hidden="true" /> 重命名
                </button>
                <button
                  type="button"
                  disabled={Boolean(activeRun) || Boolean(busy)}
                  onClick={() =>
                    void actions
                      .forkSession(sessionRef)
                      .then((forked) => forked && navigate(sessionHref(forked)))
                  }
                >
                  <GitFork aria-hidden="true" /> 分叉
                </button>
                <button
                  type="button"
                  disabled={Boolean(activeRun) || Boolean(busy)}
                  onClick={() => {
                    if (!confirmCompact) {
                      setConfirmCompact(true);
                      return;
                    }
                    void actions.compactSession(sessionRef).then(() => setConfirmCompact(false));
                  }}
                >
                  <Minimize2 aria-hidden="true" /> {confirmCompact ? "确认压缩" : "压缩"}
                </button>
              </div>
            )}
          </div>
        </div>
      }
      inspector={
        inspector ? (
          <ConversationInspector
            open
            title={inspector.title}
            subtitle={inspector.subtitle}
            onClose={() => setInspector(undefined)}
          >
            {inspector.content}
          </ConversationInspector>
        ) : undefined
      }
      composer={
        <ConversationComposer
          value={draft}
          onValueChange={setDraft}
          onSubmit={(value) => void submit(value.text, value.behavior)}
          status={composerStatus}
          behavior={behavior}
          onBehaviorChange={setBehavior}
          busy={busy === "send-message"}
          disabled={Boolean(conversation?.loadError)}
          placeholder={
            activation?.kind === "skill"
              ? `输入 ${activation.name} 的参数或补充要求…`
              : activation?.kind === "agent"
                ? `描述要委派给 ${activation.name} 的任务…`
                : sessionId
                  ? "继续对话，或在运行中调整方向…"
                  : "向 Pico 发送消息…"
          }
          statusText={
            conversation?.queuedCount ? `${conversation.queuedCount} 条消息正在排队` : undefined
          }
          onPause={activeRun ? () => void actions.pauseRun(activeRun.id) : undefined}
          onResume={activeRun ? () => void actions.resumeRun(activeRun.id) : undefined}
          onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
          onAttach={composerStatus === "idle" ? openCatalog : undefined}
          trailingAccessory={
            activation ? (
              <button
                type="button"
                className="conversation-activation-chip"
                onClick={() => setActivation(undefined)}
                aria-label={`移除 ${activation.kind === "skill" ? "Skill" : "子代理"} ${activation.name}`}
              >
                {activation.kind === "skill" ? "Skill" : "Agent"}: {activation.name} ×
              </button>
            ) : undefined
          }
          leadingAccessory={
            <>
              <span className="conversation-context-label">
                {data.workspaceMode === "git" ? (
                  <FolderGit2 aria-hidden="true" />
                ) : (
                  <Folder aria-hidden="true" />
                )}
                {workspaceName(workspacePath)}
              </span>
              {sessionRef && conversation?.settings && (
                <>
                  <label className="conversation-context-option">
                    <span className="conversation-sr-only">模型</span>
                    <select
                      name="model-route"
                      aria-label="模型"
                      value={conversation.settings.modelRouteId ?? ""}
                      disabled={Boolean(activeRun) || Boolean(busy)}
                      onChange={(event) =>
                        void actions.updateSessionSettings(sessionRef, {
                          modelRouteId: event.target.value,
                        })
                      }
                    >
                      {!data.modelRoutes.some(
                        (route) => route.id === conversation.settings?.modelRouteId,
                      ) && (
                        <option value={conversation.settings.modelRouteId ?? ""}>
                          {conversation.settings.model}
                        </option>
                      )}
                      {data.modelRoutes.map((route) => (
                        <option key={route.id} value={route.id}>
                          {route.label}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="conversation-context-option">
                    <span className="conversation-sr-only">权限模式</span>
                    <select
                      name="interaction-mode"
                      aria-label="权限模式"
                      value={conversation.settings.mode}
                      disabled={Boolean(activeRun) || Boolean(busy)}
                      onChange={(event) =>
                        void actions.updateSessionSettings(sessionRef, {
                          mode: event.target.value as "default" | "plan" | "auto" | "yolo",
                        })
                      }
                    >
                      <option value="default">默认</option>
                      <option value="plan">计划</option>
                      <option value="auto">自动</option>
                      <option value="yolo">完全访问</option>
                    </select>
                  </label>
                  {conversation.settings.reasoningLevels.length > 0 && (
                    <label className="conversation-context-option">
                      <span className="conversation-sr-only">Thinking</span>
                      <select
                        name="thinking-effort"
                        aria-label="Thinking"
                        value={conversation.settings.thinkingEffort}
                        disabled={Boolean(activeRun) || Boolean(busy)}
                        onChange={(event) =>
                          void actions.updateSessionSettings(sessionRef, {
                            thinkingEffort: event.target.value,
                          })
                        }
                      >
                        {conversation.settings.reasoningLevels.map((level) => (
                          <option key={level} value={level}>
                            {level}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
            </>
          }
        />
      }
    >
      {conversation?.loadError ? (
        <div className="conversation-empty-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <h3>无法恢复这个会话</h3>
          <p>{conversation.loadError}</p>
          <Button
            disabled={Boolean(busy)}
            onClick={() => sessionRef && actions.loadSession(sessionRef)}
          >
            重新载入
          </Button>
        </div>
      ) : (
        <>
          {sessionRef && conversation?.nextBefore && (
            <div className="conversation-history-pagination">
              <Button
                variant="quiet"
                disabled={Boolean(busy)}
                onClick={() => void actions.loadEarlierSession(sessionRef)}
              >
                {busy === "load-earlier-session" ? "正在加载…" : "加载更早记录"}
              </Button>
            </div>
          )}
          <ConversationTranscript
            items={items}
            onOpenItem={openItem}
            emptyState={
              <div className="conversation-empty-state">
                <Sparkles aria-hidden="true" />
                <h3>{sessionId ? "这个会话还没有可见消息" : "从一条消息开始"}</h3>
                <p>可以像在 TUI 里一样交代目标、追问方案，或先让 Pico 阅读项目。</p>
              </div>
            }
          />
        </>
      )}
      <ApprovalDialog
        approval={selectedApproval}
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        busy={busy === "approval"}
        onDecision={(decision) =>
          void actions
            .respondApproval(selectedApproval?.id ?? "", decision)
            .then(() => setApprovalOpen(false))
        }
      />
      <PromptDialog
        prompt={selectedPrompt}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        busy={busy === "prompt"}
        onAnswer={(answer) =>
          void actions
            .respondPrompt(selectedPrompt?.id ?? "", answer)
            .then(() => setPromptOpen(false))
        }
      />
    </ConversationSurface>
  );
}

function timelineItemToConversationItem(item: TimelineItem): ConversationItemView {
  if (item.kind === "plan") {
    return {
      id: item.id,
      kind: "plan",
      title: item.title,
      steps: [
        { id: `${item.id}:step`, title: item.detail ?? item.title, state: item.state ?? "active" },
      ],
      at: item.at,
    };
  }
  if (item.kind === "tool") {
    return {
      id: item.id,
      kind: "tool",
      toolName: item.title,
      title: item.title,
      detail: item.detail,
      state: item.state ?? "active",
      at: item.at,
    };
  }
  if (item.kind === "agent") {
    return {
      id: item.id,
      kind: "subagent",
      name: item.title,
      title: item.title,
      detail: item.detail,
      state: item.state ?? "active",
      at: item.at,
    };
  }
  if (item.eventType === "assistant.message") {
    return { id: item.id, kind: "assistantMessage", text: item.detail ?? item.title, at: item.at };
  }
  return {
    id: item.id,
    kind: "status",
    title: item.title,
    detail: item.detail,
    tone: item.state === "failed" ? "error" : item.state === "done" ? "success" : "neutral",
    at: item.at,
  };
}

function isTerminalRun(status: string): boolean {
  return ["cancelled", "failed", "succeeded", "completed"].includes(status);
}

function TaskPage() {
  const { runId } = useParams();
  const { data } = useRuntime();
  const location = useLocation();
  const workspacePath = workspacePathFromSearch(location.search);
  const run = data.runs.find((item) => item.workspacePath === workspacePath && item.id === runId);
  if (!run)
    return <EmptyState title="找不到这次运行" detail="它可能已被归档，或 Runtime 尚未同步完成。" />;
  if (run.sessionId) {
    return (
      <Navigate
        replace
        to={sessionHref({ workspacePath: run.workspacePath, sessionId: run.sessionId })}
      />
    );
  }
  return (
    <EmptyState
      icon={<History />}
      title="这是旧版运行记录"
      detail="它没有可恢复的 Session 标识。Pico 不会用其他运行的时间线或更改冒充这次记录。"
      action={
        <Link className="button" to="/sessions">
          返回会话库
        </Link>
      }
    />
  );
}

function ReviewPage() {
  const { data, actions, busy } = useRuntime();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const workspacePath = workspacePathFromSearch(location.search) ?? "";
  const sessionId = searchParams.get("sessionId") ?? undefined;
  const sessionRef =
    workspacePath && sessionId
      ? ({ workspacePath, sessionId } satisfies WorkspaceSessionRef)
      : undefined;
  const conversation = sessionRef ? data.conversations[workspaceSessionKey(sessionRef)] : undefined;
  const changes = conversation?.changes ?? (sessionId ? [] : data.changes);
  const fingerprint =
    conversation?.changeFingerprint ?? (sessionId ? undefined : data.changeFingerprint);
  const runId =
    conversation?.runId ??
    (sessionId ? undefined : data.runs.find((run) => run.workspacePath === workspacePath)?.id);
  const target = runId && fingerprint ? { runId, fingerprint } : undefined;
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path);
  const [comment, setComment] = useState("");
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPreview, setRewindPreview] = useState<{
    readonly checkpointId: string;
    readonly fingerprint: string;
    readonly changeCount: number;
  }>();
  useEffect(() => {
    if (!selectedPath && changes[0]) setSelectedPath(changes[0].path);
  }, [changes, selectedPath]);
  const selected = changes.find((change) => change.path === selectedPath);
  if (data.notices.changes)
    return <CapabilityUnavailable title="无法读取更改" detail={data.notices.changes} />;
  if (!selected)
    return (
      <EmptyState
        icon={<FileDiff />}
        title="没有待审阅的更改"
        detail="任务生成文件更改后，会从 Runtime 加载到这里。"
      />
    );
  return (
    <div className="review-layout">
      <aside className="file-list" aria-label="已更改文件">
        <div className="file-list__header">
          <strong>更改</strong>
          <span>{changes.length} 个文件</span>
        </div>
        {changes.map((change) => (
          <button
            key={change.path}
            type="button"
            className={change.path === selected.path ? "is-active" : ""}
            onClick={() => setSelectedPath(change.path)}
          >
            <FileCode2 aria-hidden="true" />
            <span>
              <strong>{change.path.split("/").at(-1)}</strong>
              <small>{change.path}</small>
            </span>
            <em>
              +{change.additions} −{change.deletions}
            </em>
          </button>
        ))}
      </aside>
      <section className="diff-workspace">
        <header className="diff-header">
          <div>
            <code>{selected.path}</code>
            <span>
              <b>+{selected.additions}</b> <i>−{selected.deletions}</i>
            </span>
          </div>
          <Button onClick={() => setRewindOpen((value) => !value)}>
            <History aria-hidden="true" size={15} />
            Rewind
          </Button>
        </header>
        {rewindOpen && (
          <div className="rewind-panel">
            <div>
              <RotateCcw aria-hidden="true" />
              <span>
                <strong>
                  {rewindPreview ? `将回退 ${rewindPreview.changeCount} 项更改` : "回到最近检查点"}
                </strong>
                <small>
                  {rewindPreview
                    ? `指纹 ${rewindPreview.fingerprint}`
                    : "先读取预览；执行时会重新验证指纹，冲突时不会写入。"}
                </small>
              </span>
            </div>
            {rewindPreview ? (
              <Button
                variant="danger"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (sessionRef)
                    void actions.applyRewind(
                      sessionRef,
                      rewindPreview.checkpointId,
                      rewindPreview.fingerprint,
                    );
                }}
              >
                确认 Rewind
              </Button>
            ) : (
              <Button
                disabled={Boolean(busy) || !sessionRef}
                onClick={() => {
                  if (sessionRef) void actions.previewRewind(sessionRef).then(setRewindPreview);
                }}
              >
                预览 Rewind
              </Button>
            )}
          </div>
        )}
        <pre className="diff-view" aria-label={`${selected.path} 的差异`}>
          <code>{renderPatch(selected)}</code>
        </pre>
        <div className="review-composer">
          <label htmlFor="review-comment">要求修改</label>
          <div className="input-action">
            <input
              id="review-comment"
              value={comment}
              autoComplete="off"
              onChange={(event) => setComment(event.target.value)}
              placeholder="例如：保留现有错误类型，不要改变公开接口…"
            />
            <Button
              disabled={!comment.trim() || Boolean(busy)}
              onClick={() =>
                void actions
                  .reviewChanges("request_changes", comment, target)
                  .then(() => setComment(""))
              }
            >
              发送意见
            </Button>
          </div>
        </div>
        <footer className="review-footer">
          <span>
            指纹 <code>{fingerprint ?? "Runtime 未提供"}</code>
          </span>
          <div className="button-row">
            <Button
              disabled={Boolean(busy) || !target}
              onClick={() => void actions.reviewChanges("approve", undefined, target)}
            >
              批准更改
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(busy) || !target}
              onClick={() => void actions.applyChanges(target)}
            >
              批准并应用
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function SessionsPage() {
  const { data, actions, busy } = useRuntime();
  const [query, setQuery] = useState("");
  const [showArchived, setShowArchived] = useState(false);
  const sessions = data.sessions.filter(
    (item) =>
      (showArchived || item.status !== "archived") &&
      `${item.title} ${workspaceName(item.workspacePath)} ${item.workspacePath}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">本地记录</span>
          <h2>会话工作库</h2>
          <p>每个会话保留任务上下文、运行记录和检查点。</p>
        </div>
        <Link className="button button--primary" to={newSessionHref()}>
          <Plus aria-hidden="true" size={16} />
          新任务
        </Link>
      </section>
      <div className="toolbar">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <input
            name="session-search"
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话…"
          />
        </label>
        <label className="check-control">
          <input
            type="checkbox"
            checked={showArchived}
            onChange={(event) => setShowArchived(event.target.checked)}
          />
          显示已归档
        </label>
      </div>
      <section className="panel">
        {sessions.length === 0 ? (
          <EmptyState title="没有匹配的会话" detail="尝试其他关键词，或显示已归档会话。" />
        ) : (
          <div className="session-list">
            {sessions.map((session) => (
              <SessionRow
                key={workspaceSessionKey({
                  workspacePath: session.workspacePath,
                  sessionId: session.id,
                })}
                session={session}
                action={
                  <Button
                    variant="quiet"
                    disabled={busy === "session-state"}
                    onClick={() =>
                      void actions.setSessionArchived(
                        { workspacePath: session.workspacePath, sessionId: session.id },
                        session.status !== "archived",
                      )
                    }
                  >
                    {session.status === "archived" ? "恢复" : "归档"}
                  </Button>
                }
              />
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function SessionRow({
  session,
  action,
}: {
  readonly session: SessionView;
  readonly action?: ReactNode;
}) {
  return (
    <div className="session-row-wrap">
      <Link
        className="session-row"
        to={sessionHref({ workspacePath: session.workspacePath, sessionId: session.id })}
      >
        <span className="session-row__icon">
          {session.status === "archived" ? (
            <Archive aria-hidden="true" />
          ) : (
            <Code2 aria-hidden="true" />
          )}
        </span>
        <div>
          <div className="row-title">
            <h3>{session.title}</h3>
            <StatusPill status={session.status} />
          </div>
          {session.summary && <p>{session.summary}</p>}
          <div className="session-row__meta">
            <span>
              <Folder aria-hidden="true" /> {workspaceName(session.workspacePath)}
            </span>
            <time>{formatRelative(session.updatedAt)}</time>
          </div>
        </div>
      </Link>
      {action && <div className="session-row-action">{action}</div>}
    </div>
  );
}

function AutomationsPage() {
  const { data, actions, busy } = useRuntime();
  const [creating, setCreating] = useState(false);
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">后台任务</span>
          <h2>Automations</h2>
          <p>按计划启动真实任务；审批与信任规则不会被绕过。</p>
        </div>
        <Button variant="primary" onClick={() => setCreating((value) => !value)}>
          <Plus aria-hidden="true" size={16} />
          新建自动化
        </Button>
      </section>
      {creating && (
        <form
          className="automation-form"
          onSubmit={(event) => {
            event.preventDefault();
            const form = new FormData(event.currentTarget);
            const name = form.get("name");
            const prompt = form.get("prompt");
            const schedule = form.get("schedule");
            if (
              typeof name === "string" &&
              typeof prompt === "string" &&
              typeof schedule === "string"
            )
              void actions.createJob({ name, prompt, schedule }).then(() => setCreating(false));
          }}
        >
          <div>
            <label htmlFor="automation-name">名称</label>
            <input
              id="automation-name"
              name="name"
              required
              autoComplete="off"
              placeholder="例如：每周依赖检查…"
            />
          </div>
          <div>
            <label htmlFor="automation-schedule">计划</label>
            <input
              id="automation-schedule"
              name="schedule"
              required
              autoComplete="off"
              placeholder="例如：0 9 * * 1…"
            />
          </div>
          <div className="automation-form__prompt">
            <label htmlFor="automation-prompt">任务说明</label>
            <textarea
              id="automation-prompt"
              name="prompt"
              required
              autoComplete="off"
              rows={3}
              placeholder="告诉 Pico 每次需要完成什么…"
            />
          </div>
          <div className="button-row">
            <Button onClick={() => setCreating(false)}>取消</Button>
            <Button type="submit" variant="primary" disabled={Boolean(busy)}>
              创建
            </Button>
          </div>
        </form>
      )}
      {data.notices.jobs && <InlineNotice tone="warning">{data.notices.jobs}</InlineNotice>}
      {data.jobs.length === 0 ? (
        <EmptyState
          icon={<Workflow />}
          title="还没有自动化"
          detail="Runtime 尚未返回已配置的后台任务。"
        />
      ) : (
        <div className="automation-grid">
          {data.jobs.map((job) => (
            <article className="automation-card" key={job.id}>
              <header>
                <span className="automation-card__icon">
                  <Clock3 aria-hidden="true" />
                </span>
                <label className="switch">
                  <input
                    type="checkbox"
                    checked={job.enabled}
                    disabled={busy === "toggle-job"}
                    onChange={(event) => void actions.toggleJob(job.id, event.target.checked)}
                  />
                  <span />
                </label>
              </header>
              <h3>{job.name}</h3>
              <p>{job.prompt}</p>
              <div className="automation-card__meta">
                <span>{job.schedule}</span>
                <StatusPill status={job.status} />
              </div>
              <footer>
                <time>更新于 {formatRelative(job.updatedAt)}</time>
                <div className="button-row">
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy) || !job.enabled}
                    onClick={() => void actions.runJob(job.id)}
                  >
                    立即运行
                  </Button>
                  <Button
                    variant="quiet"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (window.confirm(`删除自动化“${job.name}”？此操作无法撤销。`))
                        void actions.deleteJob(job.id);
                    }}
                  >
                    删除
                  </Button>
                </div>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

function ProviderPageRoute() {
  return <ProviderPage runtime={useRuntime()} />;
}

function CapabilityPage({ kind }: { readonly kind: "skills" | "mcp" }) {
  const { data } = useRuntime();
  const config = {
    skills: {
      title: "Skills",
      eyebrow: "工作方式",
      detail: "Skills 告诉 Pico 如何稳定地完成特定类型的工作。",
      icon: WandSparkles,
      items: data.skills,
      notice: data.notices.skills,
      empty: "没有发现 Skills",
    },
    mcp: {
      title: "MCP 服务",
      eyebrow: "外部能力",
      detail: "明确管理 Pico 可以访问的工具和数据来源。",
      icon: Network,
      items: data.mcpServers,
      notice: data.notices.mcp,
      empty: "没有发现 MCP 服务",
    },
  }[kind];
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">{config.eyebrow}</span>
          <h2>{config.title}</h2>
          <p>{config.detail}</p>
        </div>
        <Button disabled title="配置编辑将在 Runtime 提供写入能力后开放">
          <Plus aria-hidden="true" size={16} />
          添加
        </Button>
      </section>
      {config.notice && <InlineNotice tone="warning">{config.notice}</InlineNotice>}
      <section className="panel capability-panel">
        <CapabilityList
          items={config.items as readonly CapabilityView[]}
          emptyTitle={config.empty}
          emptyDetail="当前 Runtime 没有返回任何配置；Pico 不会填充示例项。"
        />
      </section>
      {kind === "skills" && (
        <InlineNotice tone="neutral">
          公开 Plugin Runtime 尚未开放；这里只显示 Runtime 已加载的 Skills。
        </InlineNotice>
      )}
    </div>
  );
}

function UsagePage() {
  const { data } = useRuntime();
  const metrics = [
    ["输入 tokens", data.usage.inputTokens, TerminalSquare],
    ["输出 tokens", data.usage.outputTokens, Bot],
    ["缓存 tokens", data.usage.cachedTokens, Layers3],
    [
      "估算费用",
      data.usage.cost === undefined ? undefined : `$${data.usage.cost.toFixed(2)}`,
      CircleDollarSign,
    ],
  ] as const;
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">{data.usage.period || "Runtime 统计"}</span>
          <h2>用量</h2>
          <p>用同一套口径查看模型调用、缓存与费用估算。</p>
        </div>
      </section>
      {data.notices.usage ? (
        <CapabilityUnavailable title="用量暂不可用" detail={data.notices.usage} />
      ) : (
        <div className="usage-grid">
          {metrics.map(([label, value, Icon]) => (
            <article className="usage-card" key={label}>
              <Icon aria-hidden="true" />
              <span>{label}</span>
              <strong>{typeof value === "number" ? formatCompact(value) : (value ?? "—")}</strong>
            </article>
          ))}
        </div>
      )}
      <section className="panel">
        <PanelHeader title="数据边界" detail="费用仅为 Runtime 按 Provider 返回值计算的估算" />
        <div className="usage-explainer">
          <div>
            <Box aria-hidden="true" />
            <span>
              <strong>本地汇总</strong>
              <p>会话用量保存在 ~/.pico，不依赖登录同步。</p>
            </span>
          </div>
          <div>
            <ShieldCheck aria-hidden="true" />
            <span>
              <strong>不显示猜测值</strong>
              <p>Provider 未返回价格时，费用会明确显示为空。</p>
            </span>
          </div>
        </div>
      </section>
    </div>
  );
}

function SettingsPage() {
  const { data, actions, busy } = useRuntime();
  const [background, setBackground] = useState<"" | "enabled" | "disabled">("");
  const [diagnosticOutput, setDiagnosticOutput] = useState<string>();
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">Pico Desktop</span>
          <h2>设置</h2>
          <p>桌面偏好与 Runtime 配置保持清晰分离。</p>
        </div>
      </section>
      <section className="settings-section">
        <h3>桌面行为</h3>
        <div className="settings-list">
          <SettingRow
            title="登录时启动"
            detail={
              data.launchAtLogin === undefined
                ? "无法从系统读取当前状态"
                : "登录系统后在后台启动 Pico"
            }
          >
            {data.launchAtLogin === undefined ? (
              <StatusPill status="attention" />
            ) : (
              <Toggle
                checked={data.launchAtLogin}
                disabled={Boolean(busy)}
                label="登录时启动"
                onChange={(value) => void actions.setLaunchAtLogin(value)}
              />
            )}
          </SettingRow>
          <SettingRow title="关闭后行为" detail="主进程暂不提供状态读取；请选择要应用的行为">
            <select
              name="background-mode"
              className="select-control"
              value={background}
              disabled={Boolean(busy)}
              aria-label="关闭后行为"
              onChange={(event) => {
                const value = event.target.value as "enabled" | "disabled";
                setBackground(value);
                void actions.setBackgroundMode(value === "enabled");
              }}
            >
              <option value="" disabled>
                选择…
              </option>
              <option value="enabled">继续后台运行</option>
              <option value="disabled">退出 Pico</option>
            </select>
          </SettingRow>
        </div>
      </section>
      <section className="settings-section">
        <h3>项目与诊断</h3>
        <div className="settings-list">
          <SettingRow title="初始化 Pico 项目" detail="仅创建缺失的 AGENTS.md 与 .pico/config.json">
            <Button
              disabled={Boolean(busy)}
              onClick={() => {
                if (window.confirm(`在 ${data.workspacePath ?? "当前工作区"} 初始化 Pico 项目？`))
                  void actions.initializeWorkspace();
              }}
            >
              初始化
            </Button>
          </SettingRow>
          <SettingRow title="Runtime 诊断" detail="只读检查配置、存储和运行能力">
            <Button
              disabled={Boolean(busy)}
              onClick={() => void actions.runDiagnostics("runtime").then(setDiagnosticOutput)}
            >
              运行诊断
            </Button>
          </SettingRow>
          <SettingRow title="资源扫描" detail="只读列出 Pico 与兼容资源，不执行修复或清理">
            <Button
              disabled={Boolean(busy)}
              onClick={() => void actions.runDiagnostics("resources").then(setDiagnosticOutput)}
            >
              扫描资源
            </Button>
          </SettingRow>
        </div>
        {diagnosticOutput && (
          <pre className="settings-diagnostic-output" aria-label="诊断结果">
            {diagnosticOutput}
          </pre>
        )}
      </section>
      <section className="settings-section">
        <h3>安全</h3>
        <div className="settings-list">
          <SettingRow title="当前工作区" detail={data.workspacePath ?? "未选择"}>
            <Button
              variant="danger"
              disabled={Boolean(busy)}
              onClick={() =>
                data.workspacePath && void actions.trustWorkspace(data.workspacePath, false)
              }
            >
              撤销信任
            </Button>
          </SettingRow>
          <SettingRow
            title="工作区模式"
            detail={
              data.workspaceMode === "git"
                ? "已启用并行任务隔离与变更合并"
                : "对话、工具和并行分析可用；可写子代理隔离、分支与独立合并不可用"
            }
          >
            <WorkspaceModeBadge mode={data.workspaceMode} />
          </SettingRow>
          <SettingRow title="审批策略" detail="危险操作、越界写入与外部访问始终询问">
            <StatusPill status="ready" />
          </SettingRow>
        </div>
        {data.workspaceMode === "folder" && (
          <p className="settings-section__note">
            版本保护是一项面向高级工作流的可选能力，由 Git 提供。Pico 不会自行修改你的文件夹设置。
          </p>
        )}
      </section>
      <section className="settings-section">
        <h3>账户与扩展</h3>
        <div className="settings-list">
          <SettingRow title="登录与同步" detail="尚未开放">
            <StatusPill status="disabled" />
          </SettingRow>
          <SettingRow title="Plugins" detail="公开 Plugin Runtime 尚未开放">
            <StatusPill status="disabled" />
          </SettingRow>
        </div>
      </section>
    </div>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  disabled,
}: {
  readonly checked: boolean;
  readonly onChange: (value: boolean) => void;
  readonly label: string;
  readonly disabled?: boolean;
}) {
  return (
    <label className="switch">
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span />
    </label>
  );
}

function SettingRow({
  title,
  detail,
  children,
}: {
  readonly title: string;
  readonly detail: string;
  readonly children: ReactNode;
}) {
  return (
    <div className="setting-row">
      <div>
        <strong>{title}</strong>
        <span>{detail}</span>
      </div>
      {children}
    </div>
  );
}

function CapabilityUnavailable({
  title,
  detail,
}: {
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <EmptyState
      icon={<Layers3 />}
      title={title}
      detail={detail}
      action={
        <InlineNotice tone="warning">此区域不会用本地 fixture 替代 Runtime 数据。</InlineNotice>
      }
    />
  );
}

function PanelHeader({
  title,
  detail,
  action,
}: {
  readonly title: string;
  readonly detail?: string;
  readonly action?: ReactNode;
}) {
  return (
    <header className="panel-header">
      <div>
        <h3>{title}</h3>
        {detail && <p>{detail}</p>}
      </div>
      {action}
    </header>
  );
}

function NotFound() {
  return (
    <EmptyState
      title="找不到这个页面"
      detail="链接可能已失效。"
      action={
        <Link className="button button--primary" to="/">
          返回开始
        </Link>
      }
    />
  );
}

function routeTitle(pathname: string): string {
  if (pathname.startsWith("/task/")) return pathname === "/task/new" ? "新任务" : "任务运行";
  if (pathname.startsWith("/session/")) return "会话";
  return (
    (
      {
        "/": "开始",
        "/sessions": "会话",
        "/automations": "自动化",
        "/review": "更改审阅",
        "/skills": "Skills",
        "/mcp": "MCP",
        "/providers": "模型",
        "/usage": "用量",
        "/settings": "设置",
      } as Readonly<Record<string, string>>
    )[pathname] ?? "Pico"
  );
}

function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatRelative(value: number): string {
  const delta = Math.max(0, Date.now() - value);
  if (delta < 60_000) return "刚刚";
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} 分钟前`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} 小时前`;
  return `${Math.floor(delta / 86_400_000)} 天前`;
}

function formatElapsed(value: number): string {
  const minutes = Math.max(1, Math.floor((Date.now() - value) / 60_000));
  return `已运行 ${minutes} 分钟`;
}

function renderPatch(change: ChangeView): string {
  if (!change.patch) return "Runtime 未返回此文件的 diff 内容。";
  return change.patch;
}
