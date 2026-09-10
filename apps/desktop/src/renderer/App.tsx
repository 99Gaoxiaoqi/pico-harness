// Preserve the stylesheet cascade independently of page import order.
import "./conversation/graph-board.css";
import "./usage/usage.css";
import "./conversation/conversation.css";
import "./workbar/SessionWorkbar.css";
import "./workbar-panels/ToolPanels.css";
import "./workbar-panels/workbar-panels.css";

import { Folder, RefreshCw, ShieldCheck } from "lucide-react";
import { Component, useEffect, useState, type ReactNode } from "react";
import {
  HashRouter,
  Link,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from "react-router-dom";
import { AppShell } from "./AppShell.js";
import { MemoryPage } from "./MemoryPage.js";
import { UserMemorySettingsPage } from "./pages/UserMemorySettingsPage.js";
import { ProviderPage } from "./ProviderPage.js";
import { Button, EmptyState, InlineNotice, PreviewBadge } from "./components.js";
import { legacySurfaceHref } from "./navigation.js";
import { AutomationsPage } from "./pages/AutomationsPage.js";
import { ConversationPage, NewTaskPage } from "./pages/ConversationPage.js";
import { ExtensionsIndex, ExtensionsPage } from "./pages/ExtensionsPage.js";
import { HomePage } from "./pages/HomePage.js";
import { ReviewPage } from "./pages/ReviewPage.js";
import { SessionsPage } from "./pages/SessionsPage.js";
import { SettingsPage, SystemSettingsPage, WorkspaceSettingsPage } from "./pages/SettingsPage.js";
import "./pages/subagent-settings.css";
import { SubagentSettingsPage } from "./pages/SubagentSettingsPage.js";
import { TaskPage } from "./pages/TaskPage.js";
import { RuntimeContext, useRuntime } from "./runtime-context.js";
import { useRuntimeStore } from "./runtime.js";
import { UsagePage } from "./usage/UsagePage.js";
import { WorkspaceRoute } from "./workspace-access.js";
import { newSessionHref } from "./workspace-session.js";

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
        <Route path="settings/workspaces" element={<WorkspaceSettingsPage />} />
        <Route path="settings/models" element={<ProviderPageRoute />} />
        <Route path="settings/subagents" element={<SubagentSettingsRoute />} />
        <Route path="settings/memory" element={<UserMemorySettingsPage />} />
        <Route path="settings/usage" element={<UsagePage />} />
        <Route path="settings/system" element={<SystemSettingsPage />} />
        <Route
          path="memory"
          element={
            <WorkspaceRoute>
              <MemoryPageRoute />
            </WorkspaceRoute>
          }
        />
        <Route path="skills" element={<LegacySurfaceRedirect to="/extensions/skills" />} />
        <Route path="mcp" element={<LegacySurfaceRedirect to="/extensions/mcp" />} />
        <Route path="providers" element={<LegacySurfaceRedirect to="/settings/models" />} />
        <Route path="usage" element={<LegacySurfaceRedirect to="/settings/usage" />} />
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

function SubagentSettingsRoute() {
  const { data, actions } = useRuntime();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let active = true;
    const refresh = () =>
      void actions.loadSubagentSettings().catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause.message : "读取子 Agent 配置失败");
      });
    refresh();
    window.addEventListener("focus", refresh);
    return () => {
      active = false;
      window.removeEventListener("focus", refresh);
    };
  }, [actions]);
  if (!data.subagentSettings)
    return (
      <InlineNotice tone={error ? "warning" : "neutral"}>
        {error ?? "正在读取子 Agent 配置…"}
      </InlineNotice>
    );
  return (
    <SubagentSettingsPage
      snapshot={data.subagentSettings}
      onUpdate={actions.updateSubagentSettings}
    />
  );
}
