import {
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
  FolderGit2,
  Gauge,
  History,
  Home,
  Layers3,
  ListChecks,
  MessageSquareMore,
  Network,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Send,
  Settings,
  ShieldCheck,
  Sparkles,
  Square,
  TerminalSquare,
  UserRoundCheck,
  WandSparkles,
  Workflow,
} from "lucide-react";
import {
  Component,
  createContext,
  useContext,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import {
  HashRouter,
  Link,
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
  PathButton,
  PromptDialog,
  StatusPill,
  StepState,
} from "./components.js";
import type { CapabilityView, ChangeView, SessionView } from "./model.js";
import { useRuntimeStore, type RuntimeStore } from "./runtime.js";

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
  state: { readonly error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  render() {
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
  const runtime = useRuntime();
  const { connection, data } = runtime;
  if (connection.kind === "loading") return <LoadingScreen />;
  if (connection.kind === "unavailable" || connection.kind === "error") {
    return <ConnectionScreen />;
  }
  if (!data.workspacePath) return <Onboarding />;
  if (!data.trusted) return <TrustWorkspace />;
  return (
    <Routes>
      <Route path="/onboarding" element={<Onboarding />} />
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="task/new" element={<NewTaskPage />} />
        <Route path="task/:runId" element={<TaskPage />} />
        <Route path="review" element={<ReviewPage />} />
        <Route path="sessions" element={<SessionsPage />} />
        <Route path="automations" element={<AutomationsPage />} />
        <Route path="skills" element={<CapabilityPage kind="skills" />} />
        <Route path="mcp" element={<CapabilityPage kind="mcp" />} />
        <Route path="providers" element={<CapabilityPage kind="providers" />} />
        <Route path="usage" element={<UsagePage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
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
  const selected = Boolean(data.workspacePath);
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
              <FolderGit2 aria-hidden="true" />
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
              onClick={() => void actions.chooseWorkspace()}
            >
              {selected ? "更换文件夹" : "选择文件夹"}
            </Button>
            {selected && (
              <Button disabled={Boolean(busy)} onClick={() => void actions.trustWorkspace(true)}>
                查看并信任此工作区
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

function TrustWorkspace() {
  const { data, actions, busy } = useRuntime();
  return (
    <main className="trust-screen">
      <section className="trust-card">
        <div className="setup-icon">
          <ShieldCheck aria-hidden="true" />
        </div>
        <span className="eyebrow">工作区信任</span>
        <h1>你信任这个项目的内容吗？</h1>
        <p>Pico 可能会读取文件、运行项目命令，并根据任务修改代码。危险或越界操作仍需要单独审批。</p>
        <code className="trust-path">{data.workspacePath}</code>
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
          <Button disabled={Boolean(busy)} onClick={() => void actions.chooseWorkspace()}>
            返回选择
          </Button>
          <Button
            variant="primary"
            disabled={Boolean(busy)}
            onClick={() => void actions.trustWorkspace(true)}
          >
            信任并继续
          </Button>
        </div>
      </section>
    </main>
  );
}

const primaryNav = [
  { to: "/", label: "开始", icon: Home, end: true },
  { to: "/sessions", label: "会话", icon: MessageSquareMore },
  { to: "/automations", label: "自动化", icon: Workflow },
  { to: "/review", label: "更改", icon: FileDiff },
] as const;

const resourceNav = [
  { to: "/skills", label: "Skills", icon: WandSparkles },
  { to: "/mcp", label: "MCP", icon: Network },
  { to: "/providers", label: "模型", icon: BrainCircuit },
  { to: "/usage", label: "用量", icon: Gauge },
] as const;

function AppShell() {
  const { data, preview, message, actions } = useRuntime();
  const location = useLocation();
  const pageTitle = routeTitle(location.pathname);
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
  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        跳到主要内容
      </a>
      <aside className="sidebar" onKeyDown={handleNavKeys}>
        <div className="sidebar__brand">
          <span className="brand-mark" aria-hidden="true">
            P
          </span>
          <span>Pico</span>
          {preview && <span className="preview-dot" title="视觉预览模式" />}
        </div>
        {data.workspacePath && (
          <PathButton path={data.workspacePath} onClick={() => void actions.openWorkspace()} />
        )}
        <SidebarNav items={primaryNav} label="主要导航" />
        <SidebarNav items={resourceNav} label="能力与设置" caption="配置" />
        <div className="sidebar__footer">
          <NavLink
            to="/settings"
            data-nav-link
            className={({ isActive }) => `nav-link ${isActive ? "is-active" : ""}`}
          >
            <Settings aria-hidden="true" />
            <span>设置</span>
          </NavLink>
          <div className="runtime-health">
            <span /> Runtime 已连接
          </div>
        </div>
      </aside>
      <div className="workspace-frame">
        <header className="titlebar">
          <div>
            <span className="titlebar__context">{data.workspacePath?.split(/[\\/]/).at(-1)}</span>
            <h1>{pageTitle}</h1>
          </div>
          <div className="titlebar__actions">
            {preview && <PreviewBadge />}
            <Link className="button button--primary" to="/task/new">
              <Plus aria-hidden="true" size={16} /> 新任务
            </Link>
          </div>
        </header>
        {message && (
          <div className="toast" role="status">
            {message}
          </div>
        )}
        <main className="page" id="main-content" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
    </div>
  );
}

function SidebarNav({
  items,
  label,
  caption,
}: {
  readonly items: readonly {
    readonly to: string;
    readonly label: string;
    readonly icon: typeof Home;
    readonly end?: boolean;
  }[];
  readonly label: string;
  readonly caption?: string;
}) {
  return (
    <nav className="sidebar-nav" aria-label={label}>
      {caption && <span className="sidebar-nav__caption">{caption}</span>}
      {items.map(({ to, label: itemLabel, icon: Icon, end }) => (
        <NavLink
          key={to}
          to={to}
          {...(end === undefined ? {} : { end })}
          data-nav-link
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

function HomePage() {
  const { data } = useRuntime();
  const latestRun = data.runs[0];
  return (
    <div className="page-stack home-page">
      <section className="welcome-block">
        <span className="eyebrow">本地 Agent 工作区</span>
        <h2>今天想推进什么？</h2>
        <p>描述结果，Pico 会先理解项目、给出计划，再在需要时请求你的决定。</p>
        <TaskComposer compact />
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
                <SessionRow key={session.id} session={session} />
              ))}
            </div>
          )}
        </section>
        <section className="panel">
          <PanelHeader title="当前运行" detail={latestRun ? "实时状态" : "没有运行中的任务"} />
          {latestRun ? (
            <Link className="active-run-card" to={`/task/${latestRun.id}`}>
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
          <PanelHeader
            title="本月用量"
            detail="仅来自 Runtime"
            action={<Link to="/usage">详情</Link>}
          />
          <strong>{formatCompact(data.usage.inputTokens ?? 0)}</strong>
          <span>输入 tokens</span>
          <div className="metric-bar">
            <span
              style={{
                width: `${Math.min(100, ((data.usage.inputTokens ?? 0) / 200_000) * 100)}%`,
              }}
            />
          </div>
          <p>缓存命中 {formatCompact(data.usage.cachedTokens ?? 0)}</p>
        </section>
      </div>
    </div>
  );
}

function NewTaskPage() {
  return (
    <div className="new-task-page">
      <div className="new-task-page__copy">
        <span className="eyebrow">新任务</span>
        <h2>
          把结果说清楚，
          <br />
          其余交给 Pico。
        </h2>
        <p>可以附上限制、验收标准或不希望改动的部分。任务开始后仍可随时 Steer。</p>
      </div>
      <TaskComposer />
    </div>
  );
}

function TaskComposer({ compact = false }: { readonly compact?: boolean }) {
  const { actions, busy, data } = useRuntime();
  const navigate = useNavigate();
  const [prompt, setPrompt] = useState("");
  const submit = async () => {
    const id = await actions.createTask(prompt);
    if (id) navigate(`/task/${id}`);
  };
  return (
    <form
      className={`task-composer ${compact ? "task-composer--compact" : ""}`}
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <label htmlFor={compact ? "quick-task" : "new-task"}>任务描述</label>
      <textarea
        id={compact ? "quick-task" : "new-task"}
        value={prompt}
        autoComplete="off"
        onChange={(event) => setPrompt(event.target.value)}
        placeholder="例如：修复离线同步冲突，并补一条关键失败路径测试…"
        rows={compact ? 3 : 8}
      />
      <div className="task-composer__footer">
        <div className="composer-context">
          <FolderGit2 aria-hidden="true" size={15} />
          <span>{data.workspacePath?.split(/[\\/]/).at(-1)}</span>
          <span>自动规划</span>
        </div>
        <Button type="submit" variant="primary" disabled={!prompt.trim() || busy === "create-task"}>
          {busy === "create-task" ? "正在创建…" : "开始任务"}
          <Send aria-hidden="true" size={15} />
        </Button>
      </div>
    </form>
  );
}

function TaskPage() {
  const { runId } = useParams();
  const { data, actions, busy } = useRuntime();
  const run = data.runs.find((item) => item.id === runId) ?? data.runs[0];
  const approval = data.approvals.find((item) => !run || item.runId === run.id);
  const prompt = data.prompts.find((item) => !run || item.runId === run.id);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const [promptOpen, setPromptOpen] = useState(false);
  const [steer, setSteer] = useState("");
  const planItems = data.timeline.filter((item) => item.kind === "plan");
  const agentItems = data.timeline.filter((item) => item.kind === "agent");
  if (!run)
    return <EmptyState title="找不到这次运行" detail="它可能已被归档，或 Runtime 尚未同步完成。" />;
  const paused = ["paused", "pause_requested"].includes(run.status);
  return (
    <div className="task-layout">
      <div className="task-main page-stack">
        <section className="task-heading">
          <div>
            <div className="task-heading__meta">
              <StatusPill status={run.status} />
              <span>{formatElapsed(run.startedAt)}</span>
            </div>
            <h2>{run.description}</h2>
          </div>
          <div className="task-controls" aria-label="运行控制">
            <Button
              onClick={() => void (paused ? actions.resumeRun(run.id) : actions.pauseRun(run.id))}
              disabled={Boolean(busy)}
            >
              {paused ? (
                <Play aria-hidden="true" size={15} />
              ) : (
                <Pause aria-hidden="true" size={15} />
              )}
              {paused ? "继续" : "暂停"}
            </Button>
            <Button
              variant="danger"
              onClick={() => void actions.stopRun(run.id)}
              disabled={Boolean(busy)}
            >
              <Square aria-hidden="true" size={14} />
              停止
            </Button>
          </div>
        </section>
        {(approval || prompt) && (
          <section className="attention-banner">
            <div>
              <UserRoundCheck aria-hidden="true" />
              <div>
                <strong>Pico 正在等待你</strong>
                <span>{[approval, prompt].filter(Boolean).length} 项决定会影响接下来的执行</span>
              </div>
            </div>
            <div className="button-row">
              {approval && (
                <Button variant="primary" onClick={() => setApprovalOpen(true)}>
                  查看审批
                </Button>
              )}
              {prompt && <Button onClick={() => setPromptOpen(true)}>回答问题</Button>}
            </div>
          </section>
        )}
        <section className="panel plan-panel">
          <PanelHeader title="执行计划" detail="Runtime 会随着发现更新步骤" />
          {planItems.length === 0 ? (
            <EmptyState
              icon={<ListChecks />}
              title="Runtime 尚未给出计划"
              detail="计划事件到达后会显示在这里；Pico 不会用预设步骤代替。"
            />
          ) : (
            <div className="plan-steps">
              {planItems.map((item, index) => (
                <div
                  className={`plan-step ${item.state === "done" ? "is-done" : item.state === "active" ? "is-active" : ""}`}
                  key={item.id}
                >
                  <StepState state={item.state ?? "waiting"} />
                  <span>{index + 1}</span>
                  <div>
                    <strong>{item.title}</strong>
                    {item.detail && <p>{item.detail}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
        <section className="panel timeline-panel">
          <PanelHeader title="运行时间线" detail="思考内容不会暴露，仅显示可验证的行动" />
          {data.timeline.length === 0 ? (
            <EmptyState title="等待第一条进度" detail="Runtime 事件到达后会实时显示。" />
          ) : (
            <ol className="timeline">
              {data.timeline.map((item) => (
                <li key={item.id}>
                  <StepState state={item.state ?? "waiting"} />
                  <div>
                    <div className="row-title">
                      <strong>{item.title}</strong>
                      <time>{formatTime(item.at)}</time>
                    </div>
                    {item.detail && <p>{item.detail}</p>}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </section>
        <form
          className="steer-box"
          onSubmit={(event) => {
            event.preventDefault();
            void actions.steerRun(run.id, steer).then(() => setSteer(""));
          }}
        >
          <label htmlFor="steer-input">调整方向</label>
          <div className="input-action">
            <input
              id="steer-input"
              value={steer}
              autoComplete="off"
              onChange={(event) => setSteer(event.target.value)}
              placeholder="补充限制，或告诉 Pico 下一步优先做什么…"
            />
            <Button type="submit" disabled={!steer.trim() || Boolean(busy)}>
              <Send aria-hidden="true" size={15} />
              Steer
            </Button>
          </div>
        </form>
      </div>
      <aside className="task-aside">
        {agentItems.length === 0 ? (
          <section className="side-card">
            <span className="side-card__icon">
              <Bot aria-hidden="true" />
            </span>
            <span className="eyebrow">子代理</span>
            <h3>没有活跃子代理</h3>
            <p>Runtime 创建子代理后，职责与状态会显示在这里。</p>
          </section>
        ) : (
          agentItems.slice(-2).map((item) => (
            <section className="side-card" key={item.id}>
              <span className="side-card__icon">
                <Bot aria-hidden="true" />
              </span>
              <span className="eyebrow">子代理</span>
              <h3>{item.title}</h3>
              {item.detail && <p>{item.detail}</p>}
              <StatusPill status={item.state ?? "active"} />
            </section>
          ))
        )}
        <section className="side-card usage-mini">
          <div className="row-title">
            <span>本次用量</span>
            <CircleDollarSign aria-hidden="true" size={16} />
          </div>
          <strong>
            {formatCompact((data.usage.inputTokens ?? 0) + (data.usage.outputTokens ?? 0))}
          </strong>
          <span>tokens</span>
          <Link to="/usage">查看用量明细</Link>
        </section>
        <Link className="review-link" to="/review">
          <FileDiff aria-hidden="true" />
          <span>
            <strong>审阅更改</strong>
            <small>{data.changes.length} 个文件</small>
          </span>
        </Link>
      </aside>
      <ApprovalDialog
        approval={approval}
        open={approvalOpen}
        onOpenChange={setApprovalOpen}
        busy={busy === "approval"}
        onDecision={(decision) =>
          void actions
            .respondApproval(approval?.id ?? "", decision)
            .then(() => setApprovalOpen(false))
        }
      />
      <PromptDialog
        prompt={prompt}
        open={promptOpen}
        onOpenChange={setPromptOpen}
        busy={busy === "prompt"}
        onAnswer={(answer) =>
          void actions.respondPrompt(prompt?.id ?? "", answer).then(() => setPromptOpen(false))
        }
      />
    </div>
  );
}

function ReviewPage() {
  const { data, actions, busy } = useRuntime();
  const [selectedPath, setSelectedPath] = useState(data.changes[0]?.path);
  const [comment, setComment] = useState("");
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPreview, setRewindPreview] = useState<{
    readonly checkpointId: string;
    readonly fingerprint: string;
    readonly changeCount: number;
  }>();
  const selected = data.changes.find((change) => change.path === selectedPath);
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
          <span>{data.changes.length} 个文件</span>
        </div>
        {data.changes.map((change) => (
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
                  const sessionId = data.runs[0]?.sessionId;
                  if (sessionId)
                    void actions.applyRewind(
                      sessionId,
                      rewindPreview.checkpointId,
                      rewindPreview.fingerprint,
                    );
                }}
              >
                确认 Rewind
              </Button>
            ) : (
              <Button
                disabled={Boolean(busy) || !data.runs[0]?.sessionId}
                onClick={() => {
                  const sessionId = data.runs[0]?.sessionId;
                  if (sessionId) void actions.previewRewind(sessionId).then(setRewindPreview);
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
                void actions.reviewChanges("request_changes", comment).then(() => setComment(""))
              }
            >
              发送意见
            </Button>
          </div>
        </div>
        <footer className="review-footer">
          <span>
            指纹 <code>{data.changeFingerprint ?? "Runtime 未提供"}</code>
          </span>
          <div className="button-row">
            <Button disabled={Boolean(busy)} onClick={() => void actions.reviewChanges("approve")}>
              批准更改
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(busy) || !data.changeFingerprint}
              onClick={() => void actions.applyChanges()}
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
      item.title.toLowerCase().includes(query.toLowerCase()),
  );
  return (
    <div className="page-stack">
      <section className="page-intro">
        <div>
          <span className="eyebrow">本地记录</span>
          <h2>会话工作库</h2>
          <p>每个会话保留任务上下文、运行记录和检查点。</p>
        </div>
        <Link className="button button--primary" to="/task/new">
          <Plus aria-hidden="true" size={16} />
          新任务
        </Link>
      </section>
      <div className="toolbar">
        <label className="search-field">
          <Search aria-hidden="true" />
          <span className="sr-only">搜索会话</span>
          <input
            value={query}
            autoComplete="off"
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索会话"
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
                key={session.id}
                session={session}
                action={
                  <Button
                    variant="quiet"
                    disabled={busy === "session-state"}
                    onClick={() =>
                      void actions.setSessionArchived(session.id, session.status !== "archived")
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
      <Link className="session-row" to={session.status === "active" ? "/" : "/sessions"}>
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
          <time>{formatRelative(session.updatedAt)}</time>
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
              placeholder="例如：每周依赖检查"
            />
          </div>
          <div>
            <label htmlFor="automation-schedule">计划</label>
            <input
              id="automation-schedule"
              name="schedule"
              required
              autoComplete="off"
              placeholder="例如：0 9 * * 1"
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

function CapabilityPage({ kind }: { readonly kind: "skills" | "mcp" | "providers" }) {
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
    providers: {
      title: "模型 Providers",
      eyebrow: "推理能力",
      detail: "选择任务使用的模型。密钥只保存在系统安全存储中。",
      icon: BrainCircuit,
      items: data.providers,
      notice: data.notices.providers,
      empty: "没有可用的 Provider",
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
      {kind === "providers" && (
        <InlineNotice tone="neutral">
          登录同步尚未开放。Provider 配置仅存放在当前设备。
        </InlineNotice>
      )}
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
        <h3>安全</h3>
        <div className="settings-list">
          <SettingRow title="当前工作区" detail={data.workspacePath ?? "未选择"}>
            <Button
              variant="danger"
              disabled={Boolean(busy)}
              onClick={() => void actions.trustWorkspace(false)}
            >
              撤销信任
            </Button>
          </SettingRow>
          <SettingRow title="审批策略" detail="危险操作、越界写入与外部访问始终询问">
            <StatusPill status="ready" />
          </SettingRow>
        </div>
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

function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(value);
}

function renderPatch(change: ChangeView): string {
  if (!change.patch) return "Runtime 未返回此文件的 diff 内容。";
  return change.patch;
}
