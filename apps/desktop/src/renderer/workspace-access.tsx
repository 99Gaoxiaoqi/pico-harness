import { CheckCircle2, Folder, FolderGit2, Plus, RefreshCw, ShieldCheck } from "lucide-react";
import { useEffect, type ReactNode } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { Button, EmptyState, WorkspaceModeCard } from "./components.js";
import { useRuntime } from "./runtime-context.js";
import {
  workspaceDisplayName,
  workspaceHref,
  workspaceParent,
  workspacePathFromSearch,
} from "./workspace-session.js";

export function WorkspaceRoute({ children }: { readonly children: ReactNode }) {
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

export function TrustWorkspace({ workspacePath }: { readonly workspacePath: string }) {
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
