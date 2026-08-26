import {
  AlertTriangle,
  ArrowLeft,
  Archive,
  Bot,
  Box,
  BrainCircuit,
  CheckCircle2,
  ChevronDown,
  CircleDollarSign,
  Clock3,
  Code2,
  FileCode2,
  FileDiff,
  Folder,
  FolderGit2,
  FolderPlus,
  Gauge,
  GitBranch,
  GitFork,
  History,
  Home,
  Layers3,
  Laptop,
  Minimize2,
  Network,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
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
import type { RuntimeUserDefaults } from "@pico/protocol";
import {
  Component,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type FormEvent,
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
import { Button, CapabilityList, EmptyState, InlineNotice, StatusPill } from "./components.js";
import {
  ConversationComposer,
  ConversationContextMenu,
  ConversationInteractionSlot,
  ConversationSurface,
  ConversationTranscript,
  type ComposerBehavior,
  type ConversationInspectorView,
  type ConversationItemView,
  mergeConversationItemGroups,
  omitApprovalAuditItems,
  removeSupersededActiveTools,
  removePersistentDraft,
  usePersistentDraft,
} from "./conversation/index.js";
import type {
  ApprovalView,
  CapabilityView,
  ChangeView,
  ConversationView,
  McpServerDraft,
  PromptView,
  RunView,
  SessionView,
  TimelineItem,
  WorkspaceView,
  WorkspaceMode,
} from "./model.js";
import { ProviderPage } from "./ProviderPage.js";
import { MemoryPage } from "./MemoryPage.js";
import { useRuntimeStore, type DesktopDiagnosticReport, type RuntimeStore } from "./runtime.js";
import {
  newSessionHref,
  TEMPORARY_WORKSPACE_GROUP_LABEL,
  isActiveWorkspaceSession,
  sessionHref,
  workspaceDisplayName,
  workspaceHref,
  workspaceName,
  workspaceParent,
  workspacePathFromSearch,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "./workspace-session.js";
import {
  appPrimaryNavigation,
  legacySurfaceHref,
  settingsNavigationGroups,
  sortSidebarTasks,
  type SidebarTaskGrouping,
} from "./navigation.js";
import {
  SessionWorkbarLayout,
  WorkbarLauncher,
  createWorkbarToolTab,
  createWorkbarState,
  getWorkbarTool,
  isWorkbarPanelActive,
  loadWorkbarState,
  reduceWorkbarState,
  resolveWorkbarShortcut,
  saveWorkbarState,
  type WorkbarDock,
  type WorkbarAction,
  type WorkbarTab,
  type WorkbarToolKind,
} from "./workbar/index.js";
import "./workbar/SessionWorkbar.css";
import { BrowserWorkbarPanel } from "./workbar-panels/BrowserWorkbarPanel.js";
import { isBrowserPanelActive } from "./workbar-panels/browser-agent-lease-controller.js";
import { SideChatPanelController } from "./workbar-panels/SideChatPanelController.js";
import {
  WorkbarPanelHost,
  stopWorkbarTerminalInstance,
  type WorkbarPanelHostKind,
} from "./workbar-panels/WorkbarPanelHost.js";
import "./workbar-panels/ToolPanels.css";
import "./workbar-panels/workbar-panels.css";

const RuntimeContext = createContext<RuntimeStore | null>(null);
const CHOOSE_PROJECT_OPTION_VALUE = "__choose-project__";
const TEMPORARY_PROJECT_OPTION_VALUE = "__temporary-project__";

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
  if (connection.kind === "error") return <ConnectionScreen />;
  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route element={<AppShell />}>
        <Route index element={<Navigate replace to="/task/new" />} />
        <Route path="home" element={<HomePage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="task/new" element={<NewTaskPage />} />
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
        <Route path="extensions" element={<ExtensionsIndex />} />
        <Route path="extensions/:kind" element={<ExtensionsPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route
          path="settings/workspaces"
          element={
            <WorkspaceRoute>
              <WorkspaceSettingsPage />
            </WorkspaceRoute>
          }
        />
        <Route path="settings/models" element={<ProviderPageRoute />} />
        <Route
          path="settings/memory"
          element={
            <WorkspaceRoute>
              <MemoryPageRoute />
            </WorkspaceRoute>
          }
        />
        <Route
          path="settings/usage"
          element={
            <WorkspaceRoute>
              <UsagePage />
            </WorkspaceRoute>
          }
        />
        <Route
          path="settings/system"
          element={
            <WorkspaceRoute>
              <SystemSettingsPage />
            </WorkspaceRoute>
          }
        />
        <Route path="memory" element={<LegacySurfaceRedirect to="/settings/memory" />} />
        <Route path="skills" element={<LegacySurfaceRedirect to="/extensions/skills" />} />
        <Route path="mcp" element={<LegacySurfaceRedirect to="/extensions/mcp" />} />
        <Route path="providers" element={<LegacySurfaceRedirect to="/settings/models" />} />
        <Route path="usage" element={<LegacySurfaceRedirect to="/settings/usage" />} />
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
        <p>正在载入 {workspaceDisplayName(workspace.path, workspace)}…</p>
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
                <strong>{workspaceDisplayName(workspace.path, workspace)}</strong>
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
  const detail = connection.kind === "error" ? connection.detail : "";
  return (
    <main className="connection-screen">
      <div className="connection-card">
        <span className="brand-mark brand-mark--large" aria-hidden="true">
          P
        </span>
        <span className="eyebrow">本地 Runtime 未连接</span>
        <h1>连接已断开，正在自动恢复</h1>
        <p>{detail}</p>
        <InlineNotice tone="warning">
          Pico 不会使用演示数据代替真实任务。本地 Runtime
          服务恢复后会自动重连并回到你的会话；也可立即手动重试。
        </InlineNotice>
        <Button variant="primary" onClick={() => void actions.reload()}>
          <RefreshCw aria-hidden="true" size={16} />
          立即重试
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
            {selected && (
              <Link
                style={{ display: "inline-block", fontSize: 13, marginTop: 8 }}
                to="/settings/models"
              >
                连接模型（配置 Provider 与 API Key）→
              </Link>
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

const primaryNav = [{ ...appPrimaryNavigation[0], icon: Clock3 }] as const;

function AppShell() {
  const { data, preview, message, actions, busy } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => window.localStorage.getItem("pico.sidebar-collapsed") === "true",
  );
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
            <Link className="sidebar__brand" to="/task/new" aria-label="Pico 新任务">
              <span className="brand-mark" aria-hidden="true">
                P
              </span>
              <span className="sidebar__label">Pico</span>
              {preview && <span className="preview-dot" title="视觉预览模式" />}
            </Link>
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
          </Link>
          <div className="sidebar__body">
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
        className={`workspace-frame ${immersiveRoute ? "workspace-frame--immersive" : ""} ${conversationRoute ? "workspace-frame--conversation" : ""}`}
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
      <div className="settings-sidebar__title">
        <span className="brand-mark" aria-hidden="true">
          P
        </span>
        <strong>设置</strong>
      </div>
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
  const recentSessions = [...data.sessions]
    .filter((session) => session.status !== "archived")
    .sort((left, right) => right.updatedAt - left.updatedAt)
    .slice(0, 6);
  return (
    <div className="launch-page">
      <section className="launch-hero">
        <span className="brand-mark brand-mark--large" aria-hidden="true">
          P
        </span>
        <span className="eyebrow">LOCAL AGENT WORKBENCH</span>
        <h2>把下一件事交给 Pico</h2>
        <p>选择一个项目，描述你想完成的结果。Pico 会把分析、执行和变更留在同一条任务记录里。</p>
        <div className="launch-hero__actions">
          <Link className="button button--primary" to={newSessionHref()}>
            <Plus aria-hidden="true" size={16} /> 开始新任务
          </Link>
          {data.workspaces.length === 0 ? (
            <Link className="button" to="/onboarding">
              添加项目
            </Link>
          ) : (
            <span>{data.workspaces.length} 个本地项目已连接</span>
          )}
        </div>
      </section>

      <section className="launch-resume" aria-labelledby="launch-resume-title">
        <header>
          <div>
            <span className="eyebrow">继续工作</span>
            <h3 id="launch-resume-title">最近任务</h3>
          </div>
          <Link to="/sessions">查看全部</Link>
        </header>
        {latestRun && (
          <Link
            className="launch-active-run"
            to={
              latestRun.sessionId
                ? sessionHref({
                    workspacePath: latestRun.workspacePath,
                    sessionId: latestRun.sessionId,
                  })
                : workspaceHref(`/task/${latestRun.id}`, latestRun.workspacePath)
            }
          >
            <span className="launch-active-run__pulse" aria-hidden="true" />
            <span>
              <small>正在执行</small>
              <strong>{latestRun.description}</strong>
            </span>
            <time>{formatElapsed(latestRun.startedAt)}</time>
          </Link>
        )}
        {recentSessions.length === 0 ? (
          <EmptyState title="还没有任务" detail="第一个任务会在发送消息后出现在这里。" />
        ) : (
          <div className="session-list session-list--compact launch-session-list">
            {recentSessions.map((session) => (
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
    </div>
  );
}

function NewTaskPage() {
  const { data, actions } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const workspacePath = workspacePathFromSearch(location.search);
  const workspace = data.workspaces.find((candidate) => candidate.path === workspacePath);

  useEffect(() => {
    if (!workspacePath) {
      let cancelled = false;
      void actions.ensureTemporaryWorkspace().then((temporaryWorkspacePath) => {
        if (!cancelled && temporaryWorkspacePath) {
          navigate(newSessionHref(temporaryWorkspacePath), { replace: true });
        }
      });
      return () => {
        cancelled = true;
      };
    }
    if (workspacePath && workspace && data.workspacePath !== workspacePath) {
      void actions.selectWorkspace(workspacePath);
    }
    return undefined;
  }, [actions, data.workspacePath, navigate, workspace, workspacePath]);

  if (!workspacePath) {
    return (
      <div className="workspace-route-loading" aria-busy="true" aria-label="正在准备新任务">
        <RefreshCw aria-hidden="true" />
        <p>正在准备无项目任务…</p>
      </div>
    );
  }
  if (workspacePath && !workspace) {
    return <Navigate replace to="/task/new" />;
  }
  if (workspacePath && workspace && data.workspacePath === workspacePath && !data.trusted) {
    return <TrustWorkspace workspacePath={workspacePath} />;
  }
  return <ConversationPage />;
}

interface ConversationEnvironmentPanelProps {
  readonly view: "overview" | "review" | "context";
  readonly workspacePath: string;
  readonly workspaceLabel?: string | undefined;
  readonly mode: WorkspaceMode;
  readonly branch?: string | undefined;
  readonly changes: readonly ChangeView[];
  readonly active: boolean;
  readonly model?: string | undefined;
  readonly context?: ConversationView["context"];
  readonly collaborationMode?: "agent" | "plan" | undefined;
  readonly orchestrationMode?: "default" | "graph" | undefined;
  readonly permissionMode?: "default" | "auto" | "yolo" | undefined;
  readonly onReview: () => void;
}

export function ConversationEnvironmentPanel({
  view,
  workspacePath,
  workspaceLabel,
  mode,
  branch,
  changes,
  active,
  model,
  context,
  collaborationMode,
  orchestrationMode,
  permissionMode,
  onReview,
}: ConversationEnvironmentPanelProps) {
  const [worktreeExpanded, setWorktreeExpanded] = useState(false);
  const [branchExpanded, setBranchExpanded] = useState(false);
  const additions = changes.reduce((total, change) => total + change.additions, 0);
  const deletions = changes.reduce((total, change) => total + change.deletions, 0);
  const permissionLabels = {
    default: "默认权限",
    auto: "自动模式",
    yolo: "完全访问",
  } as const;

  return (
    <section className="conversation-environment-shell" aria-label="任务工作台">
      <section className="conversation-environment-panel">
        <div
          className="conversation-environment-panel__body"
          aria-label={view === "overview" ? "概览" : view === "review" ? "变更" : "上下文"}
        >
          {view === "overview" && (
            <div className="conversation-environment-panel__rows">
              <button
                type="button"
                className="conversation-environment-row conversation-environment-row--changes"
                disabled={changes.length === 0}
                onClick={onReview}
              >
                <FileDiff aria-hidden="true" />
                <span>文件变更</span>
                <span className="conversation-change-stats">
                  {active && changes.length === 0 ? (
                    <small>运行中</small>
                  ) : changes.length === 0 ? (
                    <small>暂无</small>
                  ) : (
                    <>
                      <b>+{additions.toLocaleString()}</b>
                      <em>-{deletions.toLocaleString()}</em>
                    </>
                  )}
                </span>
              </button>
              <button
                type="button"
                className="conversation-environment-row"
                aria-expanded={worktreeExpanded}
                onClick={() => setWorktreeExpanded((expanded) => !expanded)}
              >
                <Laptop aria-hidden="true" />
                <span>{mode === "git" ? "本地工作树" : "本地文件夹"}</span>
                <ChevronDown
                  className={worktreeExpanded ? "is-expanded" : undefined}
                  aria-hidden="true"
                />
              </button>
              {worktreeExpanded && (
                <div className="conversation-environment-detail">
                  <p title={workspacePath}>{workspacePath}</p>
                </div>
              )}
              {mode === "git" && (
                <>
                  <button
                    type="button"
                    className="conversation-environment-row"
                    aria-expanded={branchExpanded}
                    onClick={() => setBranchExpanded((expanded) => !expanded)}
                  >
                    <GitBranch aria-hidden="true" />
                    <span>{branch ?? "Detached HEAD"}</span>
                    <ChevronDown
                      className={branchExpanded ? "is-expanded" : undefined}
                      aria-hidden="true"
                    />
                  </button>
                  {branchExpanded && (
                    <div className="conversation-environment-detail conversation-environment-detail--branch">
                      当前工作树分支；切换与合并仍由项目 Git 工具负责。
                    </div>
                  )}
                </>
              )}
            </div>
          )}
          {view === "review" && (
            <div className="conversation-workbench__changes">
              {changes.length === 0 ? (
                <div className="conversation-workbench__empty">
                  <FileDiff aria-hidden="true" />
                  <strong>{active ? "等待本次运行完成" : "没有可显示的变更检查点"}</strong>
                  <p>
                    {active
                      ? "运行结束后，这里会显示固化的变更检查点。"
                      : "这里仅展示已结束运行固化的变更，不代表当前工作区是干净的。"}
                  </p>
                </div>
              ) : (
                <>
                  <div className="conversation-workbench__change-summary">
                    <span>{changes.length} 个文件</span>
                    <span className="conversation-change-stats">
                      <b>+{additions.toLocaleString()}</b>
                      <em>-{deletions.toLocaleString()}</em>
                    </span>
                  </div>
                  <ol className="conversation-workbench__file-list">
                    {changes.map((change) => (
                      <li key={`${change.status}:${change.path}`}>
                        <span data-status={change.status}>
                          {change.status.slice(0, 1).toUpperCase()}
                        </span>
                        <code title={change.path}>{change.path}</code>
                        <small>
                          +{change.additions} −{change.deletions}
                        </small>
                      </li>
                    ))}
                  </ol>
                  <Button variant="quiet" onClick={onReview}>
                    打开完整审阅
                  </Button>
                </>
              )}
            </div>
          )}
          {view === "context" && (
            <div className="conversation-workbench__context">
              <dl>
                {context && (
                  <>
                    <div>
                      <dt>上下文</dt>
                      <dd>
                        {formatCompact(context.estimatedInputTokens)} /{" "}
                        {formatCompact(context.inputBudgetTokens)}
                      </dd>
                    </div>
                    <div>
                      <dt>已用</dt>
                      <dd>
                        {context.usedPercent.toFixed(1)}%（
                        {context.estimation === "estimated" ? "估算" : context.estimation}）
                      </dd>
                    </div>
                    <div>
                      <dt>剩余</dt>
                      <dd>约 {formatCompact(context.remainingTokens)} tokens</dd>
                    </div>
                    <div>
                      <dt>窗口</dt>
                      <dd>
                        {formatCompact(context.contextWindowTokens)}，预留输出{" "}
                        {formatCompact(context.reservedOutputTokens)}
                      </dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Runtime</dt>
                  <dd>
                    <i aria-hidden="true" />
                    已连接
                  </dd>
                </div>
                <div>
                  <dt>项目</dt>
                  <dd title={workspacePath}>{workspaceLabel ?? workspaceName(workspacePath)}</dd>
                </div>
                <div>
                  <dt>模式</dt>
                  <dd>{mode === "git" ? "Git 工作树" : "本地文件夹"}</dd>
                </div>
                {model && (
                  <div>
                    <dt>模型</dt>
                    <dd>{model}</dd>
                  </div>
                )}
                {permissionMode && (
                  <div>
                    <dt>权限</dt>
                    <dd>{permissionLabels[permissionMode]}</dd>
                  </div>
                )}
                {collaborationMode && (
                  <div>
                    <dt>协作</dt>
                    <dd>{collaborationMode === "plan" ? "计划模式" : "Agent 模式"}</dd>
                  </div>
                )}
                {orchestrationMode && (
                  <div>
                    <dt>编排</dt>
                    <dd>{orchestrationMode === "graph" ? "Graph 模式" : "线性"}</dd>
                  </div>
                )}
              </dl>
            </div>
          )}
        </div>
      </section>
    </section>
  );
}

function ConversationPage() {
  const { sessionId } = useParams();
  const runtime = useRuntime();
  const { data, actions, busy, preview, message } = runtime;
  const location = useLocation();
  const navigate = useNavigate();
  const workspacePath = workspacePathFromSearch(location.search) ?? "";
  const sessionRef = useMemo<WorkspaceSessionRef | undefined>(
    () => (sessionId && workspacePath ? { workspacePath, sessionId } : undefined),
    [sessionId, workspacePath],
  );
  const conversationKey = sessionRef ? workspaceSessionKey(sessionRef) : undefined;
  const draftKey = conversationKey ?? `new:${workspacePath || "unbound"}`;
  const {
    value: draft,
    update: handleDraftChange,
    clear: clearDraft,
  } = usePersistentDraft(draftKey);
  const [behavior, setBehavior] = useState<ComposerBehavior>("steer");
  const [inspector, setInspector] = useState<ConversationInspectorView>();
  const [catalogOpen, setCatalogOpen] = useState(false);
  const [workbar, dispatchWorkbar] = useReducer(reduceWorkbarState, undefined, () => {
    const fallback = createWorkbarState({ collapsed: true });
    return typeof window === "undefined"
      ? fallback
      : loadWorkbarState(window.localStorage, fallback);
  });
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");
  const [confirmCompact, setConfirmCompact] = useState(false);
  const [activation, setActivation] = useState<
    | { readonly kind: "skill"; readonly name: string }
    | { readonly kind: "agent"; readonly name: string }
  >();
  const sendingRef = useRef(false);
  const firstSendBaselineRef = useRef<ReadonlySet<string>>(new Set());
  const [awaitingFirstSession, setAwaitingFirstSession] = useState(false);

  useEffect(() => {
    if (sessionRef) void actions.loadSession(sessionRef);
  }, [actions, sessionRef]);

  useEffect(() => {
    setInspector(undefined);
    setCatalogOpen(false);
    setEditingTitle(false);
    setConfirmCompact(false);
    setActivation(undefined);
  }, [sessionId, workspacePath]);

  useEffect(() => {
    if (typeof window !== "undefined") saveWorkbarState(window.localStorage, workbar);
  }, [workbar]);

  useEffect(() => {
    if (!inspector) {
      dispatchWorkbar({ type: "close", tabId: "inspector-preview" });
      return;
    }
    dispatchWorkbar({
      type: "openPreview",
      dock: "right",
      tab: { id: "inspector-preview", kind: "inspector", label: inspector.title },
    });
  }, [inspector]);

  const session = data.sessions.find(
    (item) => item.workspacePath === workspacePath && item.id === sessionId,
  );
  const workspace = data.workspaces.find((candidate) => candidate.path === workspacePath);
  const projectWorkspaceOptions = data.workspaces.filter(
    (candidate) => candidate.temporary !== true,
  );
  const workspaceLabel = workspaceDisplayName(workspacePath, workspace);
  const conversation = conversationKey ? data.conversations[conversationKey] : undefined;
  const sessionRuns = data.runs.filter(
    (run) => run.workspacePath === workspacePath && run.sessionId === sessionId,
  );
  const activeRun = sessionRuns.find((run) => !isTerminalRun(run.status));
  const composerStatus = activeRun
    ? ["paused", "pause_requested"].includes(activeRun.status)
      ? "paused"
      : "running"
    : "idle";
  const [newTaskSettingOverrides, setNewTaskSettingOverrides] = useState<
    Readonly<Record<string, RuntimeUserDefaults>>
  >({});
  const newTaskSettings = useMemo<RuntimeUserDefaults>(() => {
    const defaults = data.providerConfig.userDefaults;
    const legacyMode = defaults.mode;
    const modelRouteId =
      defaults.modelRouteId ?? data.providerConfig.defaultModelRouteId ?? data.modelRoutes[0]?.id;
    return {
      ...(modelRouteId ? { modelRouteId } : {}),
      collaborationMode: defaults.collaborationMode ?? (legacyMode === "plan" ? "plan" : "agent"),
      orchestrationMode: defaults.orchestrationMode ?? "default",
      permissionMode:
        defaults.permissionMode ??
        (legacyMode === "auto" || legacyMode === "yolo" ? legacyMode : "yolo"),
      ...(defaults.thinkingEffort ? { thinkingEffort: defaults.thinkingEffort } : {}),
      ...(workspacePath ? newTaskSettingOverrides[workspacePath] : {}),
    };
  }, [
    data.modelRoutes,
    data.providerConfig.defaultModelRouteId,
    data.providerConfig.userDefaults,
    newTaskSettingOverrides,
    workspacePath,
  ]);
  const updateNewTaskSettings = useCallback(
    (patch: RuntimeUserDefaults) => {
      if (!workspacePath) return;
      setNewTaskSettingOverrides((current) => ({
        ...current,
        [workspacePath]: { ...current[workspacePath], ...patch },
      }));
    },
    [workspacePath],
  );

  const runIds = useMemo(() => new Set(sessionRuns.map((run) => run.id)), [sessionRuns]);
  const persistedPendingApproval = activeRun
    ? [...(conversation?.items ?? [])]
        .reverse()
        .find(
          (item): item is Extract<ConversationItemView, { readonly kind: "approval" }> =>
            item.kind === "approval" && item.state === "pending" && item.id.startsWith("approval:"),
        )
    : undefined;
  const pendingApproval =
    data.approvals.filter((item) => runIds.has(item.runId)).at(-1) ??
    (persistedPendingApproval && activeRun
      ? {
          id: persistedPendingApproval.id.slice("approval:".length),
          runId: activeRun.id,
          sessionId,
          title: persistedPendingApproval.title,
          detail: persistedPendingApproval.detail,
          risk: "medium" as const,
          kind: "tool" as const,
        }
      : undefined);
  const pendingPrompt = data.prompts.filter((item) => runIds.has(item.runId)).at(-1);
  const legacyStorageBlocked = Boolean(
    workspacePath &&
    message?.startsWith("Legacy session-centric (JSONL) workspace storage exists:") &&
    message.includes(`/workspaces/${workspaceName(workspacePath)}-`),
  );
  const workspaceReady = Boolean(
    workspacePath && data.workspacePath === workspacePath && data.trusted && !legacyStorageBlocked,
  );

  useEffect(() => {
    if (!awaitingFirstSession || sessionId || !workspacePath) return;
    const createdSession = data.sessions
      .filter(
        (candidate) =>
          candidate.workspacePath === workspacePath &&
          !firstSendBaselineRef.current.has(candidate.id),
      )
      .sort((left, right) => right.updatedAt - left.updatedAt)[0];
    if (!createdSession) return;
    setAwaitingFirstSession(false);
    navigate(
      sessionHref({ workspacePath: createdSession.workspacePath, sessionId: createdSession.id }),
      { replace: true },
    );
  }, [awaitingFirstSession, data.sessions, navigate, sessionId, workspacePath]);

  useEffect(() => {
    if (!editingTitle) setTitleDraft(session?.title ?? "");
  }, [editingTitle, session?.title]);

  const items = useMemo<readonly ConversationItemView[]>(() => {
    const persisted = removeSupersededActiveTools(
      conversation?.items ?? [],
      Boolean(activeRun),
    ).filter(
      (item) =>
        Boolean(activeRun) ||
        !((item.kind === "approval" || item.kind === "prompt") && item.state === "pending"),
    );
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
    const goal =
      conversation?.goalItem && !persisted.some((item) => item.kind === "goal")
        ? [conversation.goalItem]
        : [];
    const discovery = conversation?.discoveryItem ? [conversation.discoveryItem] : [];
    return omitApprovalAuditItems(
      mergeConversationItemGroups(persisted, goal, discovery, live, decisions),
    );
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
    if (sendingRef.current || !workspaceReady) return;
    sendingRef.current = true;
    if (!sessionId) {
      firstSendBaselineRef.current = new Set(
        data.sessions
          .filter((candidate) => candidate.workspacePath === workspacePath)
          .map((candidate) => candidate.id),
      );
      setAwaitingFirstSession(true);
    }
    try {
      const result = await actions.sendMessage({
        workspacePath,
        ...(sessionId ? { sessionId } : {}),
        ...(!sessionId ? { initialSettings: newTaskSettings } : {}),
        text,
        behavior: nextBehavior,
        ...(activeRun ? { expectedRunId: activeRun.id } : {}),
        ...(activation ? { activation } : {}),
      });
      if (!result.succeeded) {
        setAwaitingFirstSession(false);
        return;
      }
      clearDraft();
      setActivation(undefined);
      if (!sessionId && result.sessionId) {
        setAwaitingFirstSession(false);
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

  const openCatalog = () => setCatalogOpen((open) => !open);

  const chooseProjectFolder = async () => {
    const path = await actions.chooseWorkspace();
    if (path) navigate(newSessionHref(path));
  };

  const openItem = (item: ConversationItemView) => {
    if (item.kind === "approval") {
      document.querySelector(".conversation-interaction-slot")?.scrollIntoView({ block: "end" });
      return;
    }
    if (item.kind === "prompt") {
      document.querySelector(".conversation-interaction-slot")?.scrollIntoView({ block: "end" });
      return;
    }
    if (item.kind === "changes") {
      const params = new URLSearchParams({ workspace: workspacePath });
      if (sessionId) params.set("sessionId", sessionId);
      navigate(`/review?${params.toString()}`);
      return;
    }
    if (item.kind === "discovery" && sessionId) {
      setInspector({
        title: "代码探索",
        subtitle: `${item.depth} · ${item.phase} · ${item.status}`,
        content: (
          <div>
            <p>{item.objective}</p>
            <p>
              {item.inspectedFiles} 个文件 · {item.evidenceCount} 条证据 · {item.openQuestions}{" "}
              个待确认问题
            </p>
            {item.reason && <p>{item.reason}</p>}
          </div>
        ),
      });
      return;
    }
    if (item.kind === "tool") {
      const result = item.result;
      const evidenceUri = result?.evidence?.uri;
      const inspectorContent = (content: string, pageLabel?: string) => (
        <div>
          {result && (
            <p>
              状态：{result.status} · 原始大小：{result.rawSizeBytes} bytes · SHA-256：
              <code>{result.sha256}</code>
              {result.deliveryTruncated ? " · Host 投影已截断" : ""}
            </p>
          )}
          {evidenceUri && <p>Evidence：{evidenceUri}</p>}
          {pageLabel && <p>{pageLabel}</p>}
          <pre className="conversation-inspector-output">{content}</pre>
        </div>
      );
      setInspector({
        title: item.title,
        subtitle: item.toolName,
        content: inspectorContent(item.output ?? item.detail ?? "没有可显示的输出。"),
      });
      if (evidenceUri && sessionId) {
        void actions
          .readToolEvidence({
            workspacePath,
            sessionId,
            evidenceUri,
            limitBytes: 64 * 1024,
          })
          .then((page) => {
            if (!page) return;
            setInspector({
              title: item.title,
              subtitle: item.toolName,
              content: inspectorContent(
                page.content,
                `Evidence bytes ${page.offsetBytes}-${page.endOffsetBytes} / ${page.totalBytes}${
                  page.truncated ? " · 尚有后续分页" : ""
                }`,
              ),
            });
          });
      }
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

  const respondToApproval = (
    decision:
      | "allow_once"
      | "allow_session"
      | "deny"
      | "execute"
      | "continue_editing"
      | "reject_exit"
      | "resume_execution"
      | "cancel_execution"
      | "replan_execution",
    feedback?: string,
  ) => {
    if (!pendingApproval) return;
    const operation =
      pendingApproval.kind === "plan" &&
      (decision === "execute" ||
        decision === "continue_editing" ||
        decision === "reject_exit" ||
        decision === "resume_execution" ||
        decision === "cancel_execution" ||
        decision === "replan_execution")
        ? actions.respondPlan({
            planId: pendingApproval.planId ?? "",
            sessionId: sessionId ?? "",
            action: decision,
            expectedRevision: pendingApproval.expectedRevision ?? 0,
            expectedSessionSequence: pendingApproval.expectedSessionSequence ?? 0,
            ...(pendingApproval.planOperationId
              ? { operationId: pendingApproval.planOperationId }
              : {}),
            ...(feedback || pendingApproval.planFeedback
              ? { feedback: feedback ?? pendingApproval.planFeedback }
              : {}),
          })
        : actions.respondApproval(
            pendingApproval.id,
            decision as "allow_once" | "allow_session" | "deny",
          );
    void operation;
  };

  const workbarChangeCount = conversation?.changes?.length ?? 0;
  const renderWorkbarPanel = useCallback(
    (tab: WorkbarTab, dock: WorkbarDock): ReactNode => {
      const active = isWorkbarPanelActive(workbar, dock, tab.id, {
        sessionBound: Boolean(sessionRef),
      });
      if (tab.kind === "inspector") {
        const showPreview = tab.id === "inspector-preview" && inspector;
        if (showPreview) {
          return (
            <div data-panel-active={active || undefined}>
              <section className="conversation-inspector" aria-label={inspector.title}>
                <header className="conversation-inspector__header">
                  <div>
                    <h2>{inspector.title}</h2>
                    {inspector.subtitle && <p>{inspector.subtitle}</p>}
                  </div>
                </header>
                <div className="conversation-inspector__body">{inspector.content}</div>
              </section>
            </div>
          );
        }
      }
      if (!sessionId) return null;
      if (
        tab.kind === "inspector" ||
        tab.kind === "review" ||
        tab.kind === "tasks" ||
        tab.kind === "files" ||
        tab.kind === "terminal"
      ) {
        return (
          <WorkbarPanelHost
            kind={tab.kind as WorkbarPanelHostKind}
            workspacePath={workspacePath}
            sessionId={sessionId}
            instanceId={tab.id}
            active={active}
            readOnly={session?.status === "archived"}
          />
        );
      }
      if (tab.kind === "browser" && sessionId) {
        return (
          <BrowserWorkbarPanel
            bridge={window.pico}
            sessionId={sessionId}
            active={isBrowserPanelActive(active, session?.status)}
          />
        );
      }
      if (tab.kind === "side-chat") {
        return (
          <SideChatPanelController
            key={JSON.stringify([workspacePath, sessionId, tab.id])}
            runtime={runtime}
            workspacePath={workspacePath}
            sourceSessionId={sessionId}
            panelId={tab.id}
            active={active}
            onRequestClose={() => dispatchWorkbar({ type: "close", tabId: tab.id })}
          />
        );
      }
      return null;
    },
    [inspector, runtime, session?.status, sessionId, sessionRef, workbar, workspacePath],
  );

  const handleWorkbarAction = useCallback(
    (action: WorkbarAction) => {
      if (
        !sessionId ||
        (action.type !== "close" && action.type !== "closeOthers" && action.type !== "closeRight")
      ) {
        dispatchWorkbar(action);
        return;
      }
      const dock = (Object.keys(workbar.docks) as WorkbarDock[]).find((candidate) =>
        workbar.docks[candidate].tabs.some((tab) => tab.id === action.tabId),
      );
      if (!dock) {
        dispatchWorkbar(action);
        return;
      }
      const tabs = workbar.docks[dock].tabs;
      const targetIndex = tabs.findIndex((tab) => tab.id === action.tabId);
      const closingTabs =
        action.type === "close"
          ? tabs.filter((tab) => tab.id === action.tabId)
          : action.type === "closeOthers"
            ? tabs.filter((tab) => tab.id !== action.tabId)
            : tabs.slice(targetIndex + 1);
      const terminalTabs = closingTabs.filter((tab) => tab.kind === "terminal");
      if (terminalTabs.length === 0) {
        dispatchWorkbar(action);
        return;
      }
      void Promise.allSettled(
        terminalTabs.map((tab) =>
          stopWorkbarTerminalInstance(window.pico.runtime, {
            workspacePath,
            sessionId,
            instanceId: tab.id,
          }),
        ),
      ).finally(() => dispatchWorkbar(action));
    },
    [sessionId, workbar.docks, workspacePath],
  );

  const openWorkbarTab = useCallback((kind: WorkbarToolKind, dock?: WorkbarDock) => {
    const tool = getWorkbarTool(kind);
    const tab = tool.multiple
      ? {
          id: `${kind}:${globalThis.crypto.randomUUID()}`,
          kind,
          label: tool.label,
        }
      : createWorkbarToolTab(kind);
    dispatchWorkbar({ type: "open", tab, dock: dock ?? tool.defaultDock });
  }, []);

  useEffect(() => {
    const handleShortcut = (event: globalThis.KeyboardEvent) => {
      const kind = resolveWorkbarShortcut(event);
      if (!kind || !sessionRef) return;
      event.preventDefault();
      openWorkbarTab(kind);
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, [openWorkbarTab, sessionRef]);

  const workbarLauncher = useCallback(
    (dock: WorkbarDock): ReactNode =>
      workbar.docks[dock].launcherOpen ? (
        <WorkbarLauncher
          dock={dock}
          renderIcon={(kind) =>
            kind === "review" ? (
              <FileDiff size={15} />
            ) : kind === "terminal" ? (
              <TerminalSquare size={15} />
            ) : kind === "side-chat" ? (
              <Bot size={15} />
            ) : kind === "files" ? (
              <Folder size={15} />
            ) : (
              <Code2 size={15} />
            )
          }
          onOpen={(kind, targetDock) => openWorkbarTab(kind, targetDock)}
          onClose={() => dispatchWorkbar({ type: "setLauncherOpen", dock, open: false })}
        />
      ) : undefined,
    [openWorkbarTab, workbar.docks],
  );

  return (
    <SessionWorkbarLayout
      state={workbar}
      enabled={Boolean(sessionRef)}
      launcher={workbarLauncher}
      presentTab={(tab) => ({
        closable: true,
        ...(tab.kind === "review" && workbarChangeCount > 0 ? { badge: workbarChangeCount } : {}),
      })}
      renderPanel={renderWorkbarPanel}
      onAction={handleWorkbarAction}
    >
      <ConversationSurface
        className="session-conversation"
        header={
          sessionRef ? (
            <div className="conversation-session-header">
              <div className="conversation-session-header__identity">
                {workspacePath && (
                  <span className="conversation-session-project" title={workspacePath}>
                    <Folder aria-hidden="true" /> {workspaceLabel}
                  </span>
                )}
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
                  <h1>{session?.title ?? (sessionId ? "正在载入会话…" : "新任务")}</h1>
                )}
              </div>
              <div className="conversation-session-header__meta">
                {preview && <PreviewBadge />}
                {conversation?.usage && (
                  <span>
                    {formatCompact(
                      (conversation.usage.inputTokens ?? 0) +
                        (conversation.usage.outputTokens ?? 0),
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
                        void actions
                          .compactSession(sessionRef)
                          .then(() => setConfirmCompact(false));
                      }}
                    >
                      <Minimize2 aria-hidden="true" /> {confirmCompact ? "确认压缩" : "压缩"}
                    </button>
                  </div>
                )}
                {sessionRef && (
                  <button
                    type="button"
                    className="conversation-panel-toggle"
                    aria-label={workbar.docks.right.collapsed ? "打开任务工作栏" : "收起任务工作栏"}
                    aria-expanded={!workbar.docks.right.collapsed}
                    onClick={() =>
                      dispatchWorkbar({
                        type: "setCollapsed",
                        dock: "right",
                        collapsed: !workbar.docks.right.collapsed,
                      })
                    }
                  >
                    {workbar.docks.right.collapsed ? (
                      <PanelRightOpen aria-hidden="true" />
                    ) : (
                      <PanelRightClose aria-hidden="true" />
                    )}
                  </button>
                )}
              </div>
            </div>
          ) : undefined
        }
        composer={
          pendingPrompt || pendingApproval ? (
            <ConversationInteractionSlot
              prompt={pendingPrompt}
              approval={pendingPrompt ? undefined : pendingApproval}
              busy={busy === "approval" || busy === "prompt"}
              onApprovalDecision={respondToApproval}
              onPromptAnswer={(answer) => {
                if (pendingPrompt) void actions.respondPrompt(pendingPrompt.id, answer);
              }}
              onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
            />
          ) : (
            <div className="conversation-composer-region">
              {catalogOpen && (
                <ConversationContextMenu
                  skills={data.catalogSkills}
                  agents={data.catalogAgents}
                  onClose={() => setCatalogOpen(false)}
                  onSelect={(nextActivation) => {
                    setActivation(nextActivation);
                    setCatalogOpen(false);
                    window.requestAnimationFrame(() =>
                      document
                        .querySelector<HTMLTextAreaElement>(".conversation-composer textarea")
                        ?.focus(),
                    );
                  }}
                />
              )}
              <ConversationComposer
                value={draft}
                onValueChange={handleDraftChange}
                onSubmit={(value) => void submit(value.text, value.behavior)}
                status={composerStatus}
                behavior={behavior}
                onBehaviorChange={setBehavior}
                busy={busy === "send-message"}
                disabled={Boolean(conversation?.loadError)}
                submitDisabled={!workspaceReady}
                placeholder={
                  activation?.kind === "skill"
                    ? `输入 ${activation.name} 的参数或补充要求…`
                    : activation?.kind === "agent"
                      ? `描述要委派给 ${activation.name} 的任务…`
                      : sessionId
                        ? "继续对话，或在运行中调整方向…"
                        : !workspacePath
                          ? "描述任务，并在下方选择项目…"
                          : legacyStorageBlocked
                            ? "这个项目需要先迁移旧版会话数据…"
                            : !workspaceReady
                              ? "正在准备项目…"
                              : "向 Pico 发送消息…"
                }
                statusText={
                  conversation?.queuedCount
                    ? `${conversation.queuedCount} 条消息正在排队`
                    : undefined
                }
                onPause={activeRun ? () => void actions.pauseRun(activeRun.id) : undefined}
                onResume={activeRun ? () => void actions.resumeRun(activeRun.id) : undefined}
                onStop={activeRun ? () => void actions.stopRun(activeRun.id) : undefined}
                onAttach={composerStatus === "idle" && workspaceReady ? openCatalog : undefined}
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
                    {!sessionRef ? (
                      <>
                        <label className="conversation-context-option conversation-project-option">
                          <span className="conversation-sr-only">项目</span>
                          <Folder aria-hidden="true" />
                          <select
                            name="workspace"
                            aria-label="项目"
                            value={
                              workspace?.temporary ? TEMPORARY_PROJECT_OPTION_VALUE : workspacePath
                            }
                            onChange={(event) => {
                              const nextWorkspacePath = event.target.value;
                              if (nextWorkspacePath === CHOOSE_PROJECT_OPTION_VALUE) {
                                void chooseProjectFolder();
                                return;
                              }
                              if (nextWorkspacePath === TEMPORARY_PROJECT_OPTION_VALUE) return;
                              navigate(newSessionHref(nextWorkspacePath));
                            }}
                          >
                            <option value={CHOOSE_PROJECT_OPTION_VALUE}>选择项目</option>
                            {workspace?.temporary && (
                              <option value={TEMPORARY_PROJECT_OPTION_VALUE}>
                                {workspaceLabel}
                              </option>
                            )}
                            {projectWorkspaceOptions.map((workspace) => (
                              <option key={workspace.path} value={workspace.path}>
                                {workspaceDisplayName(workspace.path, workspace)}
                              </option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className="conversation-icon-button"
                          disabled={Boolean(busy)}
                          title="打开项目文件夹"
                          aria-label="打开项目文件夹"
                          onClick={() => void chooseProjectFolder()}
                        >
                          <FolderPlus aria-hidden="true" />
                        </button>
                        {workspaceReady && (
                          <>
                            <label className="conversation-context-option">
                              <span className="conversation-sr-only">模型</span>
                              <select
                                name="initial-model-route"
                                aria-label="模型"
                                value={newTaskSettings.modelRouteId ?? ""}
                                onChange={(event) =>
                                  updateNewTaskSettings({ modelRouteId: event.target.value })
                                }
                              >
                                {data.modelRoutes.length === 0 && (
                                  <option value="">默认模型</option>
                                )}
                                {data.modelRoutes.map((route) => (
                                  <option key={route.id} value={route.id}>
                                    {route.label}
                                  </option>
                                ))}
                              </select>
                            </label>
                            <label className="conversation-context-option">
                              <span className="conversation-sr-only">协作模式</span>
                              <select
                                name="initial-collaboration-mode"
                                aria-label="协作模式"
                                value={newTaskSettings.collaborationMode ?? "agent"}
                                onChange={(event) =>
                                  updateNewTaskSettings({
                                    collaborationMode: event.target.value as "agent" | "plan",
                                  })
                                }
                              >
                                <option value="agent">Agent</option>
                                <option value="plan">计划</option>
                              </select>
                            </label>
                            <label className="conversation-context-option">
                              <span className="conversation-sr-only">权限模式</span>
                              <select
                                name="initial-permission-mode"
                                aria-label="权限模式"
                                title="权限模式"
                                value={newTaskSettings.permissionMode ?? "default"}
                                onChange={(event) =>
                                  updateNewTaskSettings({
                                    permissionMode: event.target.value as
                                      | "default"
                                      | "auto"
                                      | "yolo",
                                  })
                                }
                              >
                                <option value="default">权限：默认</option>
                                <option value="auto">权限：自动</option>
                                <option value="yolo">权限：YOLO（完全访问）</option>
                              </select>
                            </label>
                            <label className="conversation-context-option">
                              <span className="conversation-sr-only">编排模式</span>
                              <select
                                name="initial-orchestration-mode"
                                aria-label="编排模式"
                                value={newTaskSettings.orchestrationMode ?? "default"}
                                onChange={(event) =>
                                  updateNewTaskSettings({
                                    orchestrationMode: event.target.value as "default" | "graph",
                                  })
                                }
                              >
                                <option value="default">线性</option>
                                <option value="graph">Graph</option>
                              </select>
                            </label>
                          </>
                        )}
                      </>
                    ) : (
                      <span className="conversation-context-label">
                        {data.workspaceMode === "git" ? (
                          <FolderGit2 aria-hidden="true" />
                        ) : (
                          <Folder aria-hidden="true" />
                        )}
                        {workspaceLabel}
                      </span>
                    )}
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
                          <span className="conversation-sr-only">协作模式</span>
                          <select
                            name="collaboration-mode"
                            aria-label="协作模式"
                            value={conversation.settings.collaborationMode}
                            disabled={Boolean(activeRun) || Boolean(busy)}
                            onChange={(event) => {
                              const collaborationMode = event.target.value as "agent" | "plan";
                              const pendingPlan = data.approvals.find(
                                (approval) =>
                                  approval.kind === "plan" &&
                                  approval.sessionId === sessionRef.sessionId,
                              );
                              if (
                                collaborationMode === "agent" &&
                                conversation.settings?.collaborationMode === "plan" &&
                                pendingPlan
                              ) {
                                if (
                                  !window.confirm(
                                    "当前计划仍待审批。退出 Plan 将拒绝并放弃这份计划，是否继续？",
                                  )
                                ) {
                                  return;
                                }
                                void actions.respondPlan({
                                  sessionId: sessionRef.sessionId,
                                  planId: pendingPlan.planId ?? pendingPlan.id,
                                  action: "reject_exit",
                                  expectedRevision: pendingPlan.expectedRevision ?? 0,
                                  expectedSessionSequence: pendingPlan.expectedSessionSequence ?? 0,
                                  feedback: "用户从协作模式开关退出 Plan。",
                                });
                                return;
                              }
                              void actions.updateSessionSettings(sessionRef, { collaborationMode });
                            }}
                          >
                            <option value="agent">Agent</option>
                            <option value="plan">计划</option>
                          </select>
                        </label>
                        <label className="conversation-context-option">
                          <span className="conversation-sr-only">权限模式</span>
                          <select
                            name="permission-mode"
                            aria-label="权限模式"
                            title="权限模式"
                            value={conversation.settings.permissionMode}
                            disabled={Boolean(activeRun) || Boolean(busy)}
                            onChange={(event) =>
                              void actions.updateSessionSettings(sessionRef, {
                                permissionMode: event.target.value as "default" | "auto" | "yolo",
                              })
                            }
                          >
                            <option value="default">权限：默认</option>
                            <option value="auto">权限：自动</option>
                            <option value="yolo">权限：YOLO（完全访问）</option>
                          </select>
                        </label>
                        <label className="conversation-context-option">
                          <span className="conversation-sr-only">编排模式</span>
                          <select
                            name="orchestration-mode"
                            aria-label="编排模式"
                            value={conversation.settings.orchestrationMode}
                            disabled={Boolean(activeRun) || Boolean(busy)}
                            onChange={(event) =>
                              void actions.updateSessionSettings(sessionRef, {
                                orchestrationMode: event.target.value as "default" | "graph",
                              })
                            }
                          >
                            <option value="default">线性</option>
                            <option value="graph">Graph</option>
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
            </div>
          )
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
                busy === "load-session" ? (
                  <div className="conversation-empty-state">
                    <h3>正在载入对话记录…</h3>
                  </div>
                ) : sessionId ? (
                  <div className="conversation-empty-state">
                    <Sparkles aria-hidden="true" />
                    <h3>这个会话还没有可见消息</h3>
                    <p>继续输入后，消息和执行记录会显示在这里。</p>
                  </div>
                ) : (
                  <div className="conversation-empty-state conversation-empty-state--new">
                    <span className="brand-mark brand-mark--large" aria-hidden="true">
                      P
                    </span>
                    <h2>{newTaskGreeting()}</h2>
                    {legacyStorageBlocked && (
                      <InlineNotice tone="warning">
                        这个项目仍包含旧版 JSONL 会话数据。Pico
                        不会自动删除或混写这些历史；请先完成迁移，再开始新任务。
                      </InlineNotice>
                    )}
                  </div>
                )
              }
            />
          </>
        )}
      </ConversationSurface>
    </SessionWorkbarLayout>
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
    if (!changes.some((change) => change.path === selectedPath)) {
      setSelectedPath(changes[0]?.path);
    }
  }, [changes, selectedPath]);
  const selected = changes.find((change) => change.path === selectedPath);
  useEffect(() => {
    if (!selected || selected.patch || !runId) return;
    void actions.loadChangeDiff({
      workspacePath,
      ...(sessionId ? { sessionId } : {}),
      runId,
      path: selected.path,
    });
  }, [actions, runId, selected, sessionId, workspacePath]);
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
  const { data } = useRuntime();
  const workspace = data.workspaces.find((candidate) => candidate.path === session.workspacePath);
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
              <Folder aria-hidden="true" />
              {workspaceDisplayName(session.workspacePath, workspace)}
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
          <h2>定时任务</h2>
          <p>让 Pico 按计划重复执行任务；审批与信任规则始终有效。</p>
        </div>
        <Button variant="primary" onClick={() => setCreating((value) => !value)}>
          <Plus aria-hidden="true" size={16} />
          新建定时任务
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
          title="还没有定时任务"
          detail="创建后，任务会在这里显示计划、开关和最近状态。"
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

function MemoryPageRoute() {
  return <MemoryPage runtime={useRuntime()} />;
}

function LegacySurfaceRedirect({ to }: { readonly to: string }) {
  const location = useLocation();
  return <Navigate replace to={legacySurfaceHref(to, location.search)} />;
}

function ExtensionsIndex() {
  const lastKind = window.localStorage.getItem("pico.extensions-kind") === "mcp" ? "mcp" : "skills";
  return <Navigate replace to={`/extensions/${lastKind}`} />;
}

function ExtensionsPage() {
  const { kind } = useParams<{ kind: string }>();
  const activeKind = kind === "mcp" ? "mcp" : kind === "skills" ? "skills" : undefined;
  useEffect(() => {
    if (activeKind) window.localStorage.setItem("pico.extensions-kind", activeKind);
  }, [activeKind]);
  if (!activeKind) return <Navigate replace to="/extensions/skills" />;
  return (
    <div className="extensions-page">
      <header className="extensions-page__header">
        <div>
          <span className="eyebrow">可安装能力</span>
          <h2>扩展</h2>
          <p>Skills 定义工作方式，MCP 连接外部工具和数据源。</p>
        </div>
        <nav className="surface-tabs" aria-label="扩展类型">
          <NavLink
            to="/extensions/skills"
            className={({ isActive }) => (isActive ? "is-active" : "")}
          >
            技能
          </NavLink>
          <NavLink to="/extensions/mcp" className={({ isActive }) => (isActive ? "is-active" : "")}>
            MCP
          </NavLink>
        </nav>
      </header>
      <CapabilityPage kind={activeKind} embedded />
    </div>
  );
}

export function CapabilityPage({
  kind,
  embedded = false,
}: {
  readonly kind: "skills" | "mcp";
  readonly embedded?: boolean;
}) {
  const { data, actions, busy } = useRuntime();
  const [addingMcp, setAddingMcp] = useState(false);
  const scope = kind === "skills" ? data.skillScope : data.mcpScope;
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
      {!embedded && (
        <section className="page-intro">
          <div>
            <span className="eyebrow">{config.eyebrow}</span>
            <h2>{config.title}</h2>
            <p>{config.detail}</p>
          </div>
          {kind === "mcp" ? (
            <Button disabled={Boolean(busy)} onClick={() => setAddingMcp((visible) => !visible)}>
              <Plus aria-hidden="true" size={16} />
              添加用户级 MCP
            </Button>
          ) : (
            <Button disabled title="Skills v1 仅支持查看">
              Skills v1 只读
            </Button>
          )}
        </section>
      )}
      {embedded && kind === "mcp" && (
        <div className="button-row">
          <Button disabled={Boolean(busy)} onClick={() => setAddingMcp((visible) => !visible)}>
            <Plus aria-hidden="true" size={16} />
            添加用户级 MCP
          </Button>
        </div>
      )}
      <section className="panel capability-scope-picker" aria-label={`${config.title}作用域`}>
        <div>
          <strong>查看范围</strong>
          <p>默认只显示用户级配置；选择项目后才读取该项目的有效配置。</p>
        </div>
        <label>
          <span className="sr-only">选择项目</span>
          <select
            className="select-control"
            value={scope.workspacePath ?? ""}
            disabled={busy === `capability-${kind}`}
            onChange={(event) =>
              void actions.loadCapabilityScope(kind, event.target.value || undefined)
            }
          >
            <option value="">仅用户级</option>
            {data.workspaces.map((workspace) => (
              <option key={workspace.path} value={workspace.path}>
                {workspaceDisplayName(workspace.path, workspace)}
                {workspace.trusted ? "" : "（未信任）"}
              </option>
            ))}
          </select>
        </label>
      </section>
      {config.notice && <InlineNotice tone="warning">{config.notice}</InlineNotice>}
      {kind === "mcp" && addingMcp && (
        <McpAddForm
          busy={busy === "mcp-user-add"}
          onCancel={() => setAddingMcp(false)}
          onSubmit={async (server) => {
            const saved = await actions.addUserMcp(server);
            if (saved) setAddingMcp(false);
          }}
        />
      )}
      <section className="panel capability-panel">
        <CapabilityList
          items={config.items as readonly CapabilityView[]}
          emptyTitle={config.empty}
          emptyDetail="当前 Runtime 没有返回任何配置；Pico 不会填充示例项。"
          {...(kind === "mcp"
            ? {
                onDelete: (item: CapabilityView) => {
                  if (!window.confirm(`删除用户级 MCP 服务“${item.name}”？`)) return;
                  void actions.deleteUserMcp(item.name);
                },
                deleting: busy === "mcp-user-delete",
              }
            : {})}
        />
      </section>
      {kind === "skills" && (
        <InlineNotice tone="neutral">
          Skills v1 仅支持查看来源与有效状态，不在 Desktop 中修改文件。
        </InlineNotice>
      )}
    </div>
  );
}

function McpAddForm({
  busy,
  onCancel,
  onSubmit,
}: {
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (server: McpServerDraft) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [transport, setTransport] = useState<"stdio" | "http" | "sse">("stdio");
  const [command, setCommand] = useState("");
  const [args, setArgs] = useState("");
  const [url, setUrl] = useState("");
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const serverName = name.trim();
    if (!serverName) return;
    if (transport === "stdio") {
      const executable = command.trim();
      if (!executable) return;
      void onSubmit({
        name: serverName,
        transport,
        command: executable,
        ...(args.trim()
          ? {
              args: args
                .split("\n")
                .map((item) => item.trim())
                .filter(Boolean),
            }
          : {}),
        enabled: true,
      });
      return;
    }
    const endpoint = url.trim();
    if (!endpoint) return;
    void onSubmit({ name: serverName, transport, url: endpoint, enabled: true });
  };
  return (
    <form className="capability-add-form" onSubmit={submit}>
      <header>
        <div>
          <strong>添加用户级 MCP 服务</strong>
          <p>只新增配置，不会连接或启动服务。如需密钥，请在安全配置源中管理。</p>
        </div>
      </header>
      <label>
        <span>名称</span>
        <input required value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        <span>传输方式</span>
        <select
          value={transport}
          onChange={(event) => setTransport(event.target.value as typeof transport)}
        >
          <option value="stdio">stdio</option>
          <option value="http">HTTP</option>
          <option value="sse">SSE</option>
        </select>
      </label>
      {transport === "stdio" ? (
        <>
          <label>
            <span>命令</span>
            <input
              required
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npx"
            />
          </label>
          <label className="capability-add-form__wide">
            <span>参数（每行一个）</span>
            <textarea value={args} onChange={(event) => setArgs(event.target.value)} rows={3} />
          </label>
        </>
      ) : (
        <label className="capability-add-form__wide">
          <span>URL</span>
          <input
            required
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
          />
        </label>
      )}
      <div className="button-row capability-add-form__wide">
        <Button disabled={busy} onClick={onCancel}>
          取消
        </Button>
        <Button variant="primary" disabled={busy} type="submit">
          保存用户级配置
        </Button>
      </div>
    </form>
  );
}

function UsagePage() {
  const { data } = useRuntime();
  const metrics = [
    ["输入 tokens", data.usage.inputTokens, TerminalSquare],
    ["输出 tokens", data.usage.outputTokens, Bot],
    ["缓存读取 tokens", data.usage.cacheReadTokens ?? data.usage.cachedTokens, Layers3],
    ["缓存写入 tokens", data.usage.cacheWriteTokens, Layers3],
    ["未缓存输入 tokens", data.usage.uncachedInputTokens, TerminalSquare],
    [
      "缓存命中率",
      data.usage.cacheRequestHitRate === undefined
        ? undefined
        : `${(data.usage.cacheRequestHitRate * 100).toFixed(1)}%`,
      Layers3,
    ],
    [
      "缓存复用率",
      data.usage.cachePromptTokenReuseRate === undefined
        ? undefined
        : `${(data.usage.cachePromptTokenReuseRate * 100).toFixed(1)}%`,
      Layers3,
    ],
    [
      "缓存读写比",
      data.usage.cacheReadToWriteRatio === undefined
        ? undefined
        : `${data.usage.cacheReadToWriteRatio.toFixed(2)}x`,
      Layers3,
    ],
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
          <span className="eyebrow">{formatUsagePeriod(data.usage.period)}</span>
          <h2>用量</h2>
          <p>总用量可含历史 baseline；缓存读写、命中与复用指标仅使用逐调用记录。</p>
        </div>
      </section>
      {data.notices.usage ? (
        <CapabilityUnavailable title="用量暂不可用" detail={data.notices.usage} />
      ) : (
        <>
          <div className="usage-grid">
            {metrics.map(([label, value, Icon]) => (
              <article className="usage-card" key={label}>
                <Icon aria-hidden="true" />
                <span>{label}</span>
                <strong>{typeof value === "number" ? formatCompact(value) : (value ?? "—")}</strong>
              </article>
            ))}
          </div>
          {data.usage.cacheAlerts?.map((alert) => (
            <InlineNotice key={alert} tone="warning">
              {alert}
            </InlineNotice>
          ))}
        </>
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
  const [background, setBackground] = useState<"enabled" | "disabled">(() =>
    window.localStorage.getItem("pico.background-mode") === "enabled" ? "enabled" : "disabled",
  );
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">偏好</span>
          <h2>通用</h2>
          <p>设置 Pico Desktop 的启动和后台行为。</p>
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
          <SettingRow title="关闭后行为" detail="关闭主窗口时，选择继续在后台运行或完全退出">
            <select
              name="background-mode"
              className="select-control"
              value={background}
              disabled={Boolean(busy)}
              aria-label="关闭后行为"
              onChange={(event) => {
                const value = event.target.value as "enabled" | "disabled";
                setBackground(value);
                window.localStorage.setItem("pico.background-mode", value);
                void actions.setBackgroundMode(value === "enabled");
              }}
            >
              <option value="enabled">继续后台运行</option>
              <option value="disabled">退出 Pico</option>
            </select>
          </SettingRow>
        </div>
      </section>
      <section className="settings-section">
        <h3>账户</h3>
        <div className="settings-list">
          <SettingRow title="登录与同步" detail="尚未开放">
            <StatusPill status="disabled" />
          </SettingRow>
          <SettingRow title="Plugin Runtime" detail="公开 Plugin Runtime 尚未开放">
            <StatusPill status="disabled" />
          </SettingRow>
        </div>
      </section>
    </div>
  );
}

function WorkspaceSettingsPage() {
  const { data, actions, busy } = useRuntime();
  const navigate = useNavigate();
  const currentWorkspace = data.workspaces.find(
    (workspace) => workspace.path === data.workspacePath,
  );
  const temporaryWorkspace = currentWorkspace?.temporary === true;
  const chooseWorkspace = async () => {
    const workspacePath = await actions.chooseWorkspace();
    if (workspacePath) navigate(workspaceHref("/settings/workspaces", workspacePath));
  };
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">偏好</span>
          <h2>工作区</h2>
          <p>管理真实项目。选择“无项目”时，任务会使用 Pico 的私有任务空间。</p>
        </div>
        <Button disabled={Boolean(busy)} onClick={() => void chooseWorkspace()}>
          <Plus aria-hidden="true" size={16} /> 添加工作区
        </Button>
      </section>
      <section className="settings-section">
        <h3>任务位置</h3>
        <div className="settings-list">
          <SettingRow title="当前选择" detail="切换只影响本设置页的管理对象">
            <select
              className="select-control"
              value={data.workspacePath ?? ""}
              aria-label="选择要管理的工作区"
              onChange={(event) =>
                navigate(workspaceHref("/settings/workspaces", event.target.value))
              }
            >
              {data.workspaces.map((workspace) => (
                <option key={workspace.path} value={workspace.path}>
                  {workspaceDisplayName(workspace.path, workspace)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow
            title={temporaryWorkspace ? "无项目" : "工作区路径"}
            detail={temporaryWorkspace ? "Pico 私有任务空间" : (data.workspacePath ?? "未选择")}
          >
            {temporaryWorkspace ? (
              <StatusPill status="ready" />
            ) : (
              <Button
                variant="danger"
                disabled={Boolean(busy)}
                onClick={() =>
                  data.workspacePath && void actions.trustWorkspace(data.workspacePath, false)
                }
              >
                撤销信任
              </Button>
            )}
          </SettingRow>
          {!temporaryWorkspace && (
            <SettingRow
              title="初始化 Pico 项目"
              detail="仅创建缺失的 AGENTS.md 与 .pico/config.json"
            >
              <Button
                disabled={Boolean(busy)}
                onClick={() => {
                  if (window.confirm(`在 ${data.workspacePath} 初始化 Pico 项目？`))
                    void actions.initializeWorkspace();
                }}
              >
                初始化
              </Button>
            </SettingRow>
          )}
          <SettingRow
            title="工作区模式"
            detail={
              temporaryWorkspace
                ? "不关联真实项目；会话与文件仍会跨重启保留"
                : data.workspaceMode === "git"
                  ? "已启用并行任务隔离与变更合并"
                  : "对话、工具和并行分析可用；可写子代理隔离、分支与独立合并不可用"
            }
          >
            <WorkspaceModeBadge mode={data.workspaceMode} />
          </SettingRow>
        </div>
        {data.workspaceMode === "folder" && !temporaryWorkspace && (
          <p className="settings-section__note">
            版本保护是一项面向高级工作流的可选能力，由 Git 提供。Pico 不会自行修改你的文件夹设置。
          </p>
        )}
      </section>
    </div>
  );
}

function SystemSettingsPage() {
  const { data, actions, busy, connection } = useRuntime();
  const [diagnosticReport, setDiagnosticReport] = useState<DesktopDiagnosticReport>();
  const memoryHref = data.workspacePath
    ? workspaceHref("/settings/memory", data.workspacePath)
    : "/settings/memory";
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">系统</span>
          <h2>健康</h2>
          <p>查看 Pico 的运行状态、模型连接、存储与系统能力。</p>
        </div>
        <Button
          variant="primary"
          disabled={Boolean(busy) || !data.workspacePath}
          onClick={() => void actions.runDiagnostics("runtime").then(setDiagnosticReport)}
        >
          <RefreshCw aria-hidden="true" size={16} />
          重新检查
        </Button>
      </section>
      <section className="settings-section">
        <h3>当前状态</h3>
        <div className="settings-list">
          <SettingRow
            title="本地 Runtime"
            detail="任务执行、工具调用和本地数据都由 Runtime Host 承载"
          >
            <StatusPill status={connection.kind === "ready" ? "ready" : "attention"} />
          </SettingRow>
          <SettingRow
            title="文件与终端工具"
            detail={
              data.workspacePath
                ? `当前任务位置：${workspaceDisplayName(
                    data.workspacePath,
                    data.workspaces.find((workspace) => workspace.path === data.workspacePath),
                  )}`
                : "任务位置准备完成后，文件和终端工具会自动可用"
            }
          >
            <StatusPill status={data.workspacePath && data.trusted ? "ready" : "attention"} />
          </SettingRow>
          <SettingRow title="桌面控制" detail="受 macOS 辅助功能权限和当前会话权限共同保护">
            <StatusPill status="attention" />
          </SettingRow>
          <SettingRow title="操作审批" detail="越界写入、破坏性操作与外部访问由会话权限策略管理">
            <StatusPill status="ready" />
          </SettingRow>
          <SettingRow title="记忆写入" detail="记忆生成、审核与长期保留策略在能力设置中管理">
            <Link className="button" to={memoryHref}>
              打开记忆设置
            </Link>
          </SettingRow>
        </div>
      </section>
      <section className="settings-section">
        <h3>诊断</h3>
        <div className="settings-list">
          <SettingRow title="运行环境" detail="检查模型、凭证、Node、任务运行与本地存储">
            <Button
              disabled={Boolean(busy)}
              onClick={() => void actions.runDiagnostics("runtime").then(setDiagnosticReport)}
            >
              开始检查
            </Button>
          </SettingRow>
          <SettingRow title="本地资源" detail="扫描 Pico 与兼容资源，不执行修复或清理">
            <Button
              disabled={Boolean(busy)}
              onClick={() => void actions.runDiagnostics("resources").then(setDiagnosticReport)}
            >
              扫描
            </Button>
          </SettingRow>
        </div>
        {diagnosticReport && <DiagnosticReport report={diagnosticReport} />}
      </section>
    </div>
  );
}

function DiagnosticReport({ report }: { readonly report: DesktopDiagnosticReport }) {
  const visibleChecks = report.checks.filter((check) => check.id !== "provider");
  return (
    <section className="health-report" aria-label="诊断结果">
      <header>
        <div>
          {report.healthy ? (
            <CheckCircle2 aria-hidden="true" />
          ) : (
            <AlertTriangle aria-hidden="true" />
          )}
          <span>
            <strong>{report.healthy ? "Pico 运行正常" : "发现需要处理的问题"}</strong>
            <small>
              {report.kind === "runtime" ? "运行环境检查" : "本地资源扫描"} · {visibleChecks.length}{" "}
              项
            </small>
          </span>
        </div>
      </header>
      <div className="health-check-list">
        {visibleChecks.map((check) => (
          <article key={check.id} data-status={check.status}>
            {check.status === "ok" ? (
              <CheckCircle2 aria-hidden="true" />
            ) : (
              <AlertTriangle aria-hidden="true" />
            )}
            <span>
              <strong>{diagnosticLabel(check.id, check.label)}</strong>
              <small>{diagnosticSummary(check.summary)}</small>
              {check.recommendation && <p>{diagnosticSummary(check.recommendation)}</p>}
            </span>
            <em>{diagnosticStatusLabel(check.status)}</em>
          </article>
        ))}
      </div>
      <details className="health-report__raw">
        <summary>查看原始报告</summary>
        <pre>{report.output}</pre>
      </details>
    </section>
  );
}

function diagnosticLabel(id: string, fallback: string): string {
  return (
    (
      {
        cwd: "任务位置",
        "env-file": "环境文件",
        model: "默认模型",
        configuration: "模型配置",
        "base-url": "模型路由",
        "api-key": "模型凭证",
        node: "Node.js",
        "runtime-ledger": "运行记录",
        "task-runtime": "任务 Runtime",
        storage: "本地存储",
        preview: "预览模式",
      } as Readonly<Record<string, string>>
    )[id] ?? fallback
  );
}

function diagnosticSummary(value: string): string {
  return value
    .replace(/\s*\(ok\)/giu, "")
    .replace(/\bfound\b/giu, "已找到")
    .replace(/\bmissing for\b/giu, "未找到：")
    .replace(/\bmissing\b/giu, "未找到")
    .replace(/\bhealthy\b/giu, "正常")
    .replace(/\bunavailable\b/giu, "不可用")
    .replace(/\bprovided by user configuration\b/giu, "由用户配置提供")
    .replace(/\bavailable from config\b/giu, "已由配置文件提供")
    .replace(/\bavailable from environment\b/giu, "已由环境变量提供")
    .replace(/\bavailable from keychain\b/giu, "已由系统凭证提供")
    .replace(/provider\(s\)/giu, "个模型连接")
    .replace(/session\(s\)/giu, "个会话")
    .replace(/schema present/giu, "数据结构正常")
    .replace(/default source=user/giu, "默认来源=用户配置")
    .replace(/default source=built-in/giu, "默认来源=内建配置")
    .replaceAll("; ", "；");
}

function diagnosticStatusLabel(
  status: DesktopDiagnosticReport["checks"][number]["status"],
): string {
  return status === "ok"
    ? "正常"
    : status === "warning"
      ? "注意"
      : status === "error"
        ? "错误"
        : "不可用";
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
        <Link className="button button--primary" to="/task/new">
          返回新任务
        </Link>
      }
    />
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

function formatCompact(value: number): string {
  return new Intl.NumberFormat("zh-CN", { notation: "compact", maximumFractionDigits: 1 }).format(
    value,
  );
}

function formatUsagePeriod(period: string | undefined): string {
  if (!period) return "全部时间";
  if (period === "all_time_with_baselines") return "全部时间";
  return period.replaceAll("_", " ");
}

function newTaskGreeting(now = new Date()): string {
  const hour = now.getHours();
  if (hour < 6) return "夜深了，先从一件小事开始。";
  if (hour < 11) return "早上好，今天想推进什么？";
  if (hour < 14) return "中午好，今天想推进什么？";
  if (hour < 18) return "下午好，适合慢慢推进。";
  return "晚上好，想先解决什么？";
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
