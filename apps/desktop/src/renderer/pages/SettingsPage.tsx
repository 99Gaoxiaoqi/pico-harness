import { AlertTriangle, CheckCircle2, Folder, FolderGit2, Plus } from "lucide-react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, InlineNotice, StatusPill, WorkspaceModeBadge } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import type { DesktopDiagnosticReport } from "../runtime.js";
import { workspaceDisplayName } from "../workspace-session.js";

export function SettingsPage() {
  const { data, actions, busy } = useRuntime();
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
          <SettingRow
            title="关闭后行为"
            detail={
              data.backgroundMode === undefined
                ? "无法从系统读取当前状态"
                : "关闭主窗口时，选择继续在后台运行或完全退出"
            }
          >
            {data.backgroundMode === undefined ? (
              <StatusPill status="attention" />
            ) : (
              <select
                name="background-mode"
                className="select-control"
                value={data.backgroundMode ? "enabled" : "disabled"}
                disabled={Boolean(busy)}
                aria-label="关闭后行为"
                onChange={(event) =>
                  void actions.setBackgroundMode(event.target.value === "enabled")
                }
              >
                <option value="enabled">继续后台运行</option>
                <option value="disabled">退出 Pico</option>
              </select>
            )}
          </SettingRow>
        </div>
        {data.notices.desktopPreferences && (
          <InlineNotice tone="warning">{data.notices.desktopPreferences}</InlineNotice>
        )}
      </section>
    </div>
  );
}

export function WorkspaceSettingsPage() {
  const { data, actions, busy } = useRuntime();
  const temporaryWorkspace = data.workspaces.find((workspace) => workspace.temporary === true);
  const projects = data.workspaces.filter((workspace) => workspace.temporary !== true);
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">偏好</span>
          <h2>项目</h2>
          <p>管理 Pico 可以访问的项目。这里的操作不会切换当前会话或新任务项目。</p>
        </div>
        <Button disabled={Boolean(busy)} onClick={() => void actions.registerWorkspace()}>
          <Plus aria-hidden="true" size={16} /> 添加项目
        </Button>
      </section>
      <section className="settings-section">
        <h3>无项目任务</h3>
        <div className="settings-list">
          <SettingRow
            title="Pico 私有任务空间"
            detail={
              temporaryWorkspace
                ? "会话和文件跨重启保留，由 Pico 自动维护"
                : "第一次创建无项目任务时自动准备"
            }
          >
            <StatusPill status={temporaryWorkspace ? "ready" : "disabled"} />
          </SettingRow>
        </div>
      </section>
      <section className="settings-section">
        <h3>已添加项目</h3>
        {projects.length === 0 ? (
          <div className="settings-empty">
            <Folder aria-hidden="true" />
            <div>
              <strong>还没有项目</strong>
              <p>添加本地文件夹后，它会出现在新任务的项目选择中。</p>
            </div>
          </div>
        ) : (
          <div className="workspace-settings-list">
            {projects.map((workspace) => (
              <article className="workspace-setting-item" key={workspace.path}>
                <span className="workspace-setting-item__icon">
                  {workspace.mode === "git" ? (
                    <FolderGit2 aria-hidden="true" />
                  ) : (
                    <Folder aria-hidden="true" />
                  )}
                </span>
                <div className="workspace-setting-item__identity">
                  <strong>{workspaceDisplayName(workspace.path, workspace)}</strong>
                  <span title={workspace.path}>{workspace.path}</span>
                </div>
                <div className="workspace-setting-item__status">
                  <WorkspaceModeBadge mode={workspace.mode} />
                  <span>{workspace.trusted ? "已信任" : "待信任"}</span>
                </div>
                <div className="workspace-setting-item__actions">
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => void actions.openWorkspace(workspace.path)}
                  >
                    打开文件夹
                  </Button>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (window.confirm(`在 ${workspace.path} 初始化 Pico 项目？`))
                        void actions.initializeWorkspace(workspace.path);
                    }}
                  >
                    初始化
                  </Button>
                  <Button
                    disabled={Boolean(busy)}
                    onClick={() => {
                      const action = workspace.trusted ? "撤销信任" : "信任";
                      if (
                        window.confirm(
                          `${action}项目 ${workspaceDisplayName(workspace.path, workspace)}？`,
                        )
                      )
                        void actions.trustWorkspace(workspace.path, !workspace.trusted);
                    }}
                  >
                    {workspace.trusted ? "撤销信任" : "信任"}
                  </Button>
                  <Button
                    variant="danger"
                    disabled={Boolean(busy)}
                    onClick={() => {
                      if (
                        window.confirm(
                          `从 Pico 项目列表移除 ${workspaceDisplayName(workspace.path, workspace)}？磁盘文件不会被删除。`,
                        )
                      )
                        void actions.unregisterWorkspace(workspace.path);
                    }}
                  >
                    移除
                  </Button>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

export function SystemSettingsPage() {
  const { data, actions, busy, connection } = useRuntime();
  const [diagnosticReport, setDiagnosticReport] = useState<DesktopDiagnosticReport>();
  const [diagnosticWorkspacePath, setDiagnosticWorkspacePath] = useState(
    () =>
      data.workspacePath ?? data.workspaces.find((workspace) => !workspace.temporary)?.path ?? "",
  );
  const diagnosticWorkspaces = data.workspaces.filter(
    (workspace) => !workspace.temporary || workspace.path === data.workspacePath,
  );
  const credentialIssues = data.providerConfig.providers.filter(
    (provider) =>
      provider.auth !== "none" && ["missing", "unsupported"].includes(provider.credentialStatus),
  );
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">系统</span>
          <h2>健康</h2>
          <p>查看当前运行主机的用户级连接与能力状态，不随聊天项目切换。</p>
        </div>
        <Button disabled={Boolean(busy)} onClick={() => void actions.reload()}>
          刷新状态
        </Button>
      </section>
      {credentialIssues.length > 0 && (
        <InlineNotice tone="warning">
          {credentialIssues.length} 个模型连接需要处理凭证：
          {credentialIssues.map((provider) => provider.id).join("、")}。
          <Link to="/settings/models">打开模型设置</Link>
        </InlineNotice>
      )}
      <section className="settings-section">
        <h3>当前状态</h3>
        <div className="settings-list">
          <SettingRow
            title="本地 Runtime"
            detail={connection.kind === "error" ? connection.detail : "本地任务执行服务的连接状态"}
          >
            <StatusPill status={connection.kind === "ready" ? "ready" : "attention"} />
          </SettingRow>
          <SettingRow
            title="连接验证"
            detail="此页不发起模型请求；已配置或凭证已保存不代表连接测试通过。"
          >
            <span className="health-status-text">未验证</span>
          </SettingRow>
          <SettingRow title="模型连接" detail="只根据当前已加载的模型路由判断，不执行网络探测">
            {data.providerConfig.providers.length > 0 ? (
              <span className="health-status-text health-status-text--ready">已配置</span>
            ) : (
              <Link className="button" to="/settings/models">
                配置模型
              </Link>
            )}
          </SettingRow>
          <SettingRow
            title="权限与审批"
            detail="实际权限由每个会话的权限模式和 macOS 系统授权共同决定"
          >
            <span className="health-status-text">由会话控制</span>
          </SettingRow>
          <SettingRow title="记忆" detail="用户级策略对所有项目生效，项目内容保持隔离">
            <Link className="button" to="/settings/memory">
              打开记忆设置
            </Link>
          </SettingRow>
        </div>
      </section>
      <section className="settings-section">
        <h3>模型与凭证</h3>
        <p className="settings-section__note">用户级连接配置；项目覆盖配置可在高级诊断中检查。</p>
        <div className="settings-list">
          {data.providerConfig.providers.map((provider) => (
            <SettingRow
              key={provider.id}
              title={provider.id}
              detail={
                provider.auth === "none"
                  ? "此连接无需凭证"
                  : provider.credentialStatus === "missing"
                    ? "缺少凭证，此连接可能无法调用"
                    : provider.credentialStatus === "unsupported"
                      ? "当前凭证方式不受支持"
                      : "已读取凭证配置，尚未在此页验证网络连接"
              }
            >
              <Link className="button" to="/settings/models">
                {provider.auth === "none"
                  ? "无需凭证"
                  : provider.credentialStatus === "missing" ||
                      provider.credentialStatus === "unsupported"
                    ? "处理凭证"
                    : "查看配置"}
              </Link>
            </SettingRow>
          ))}
          {data.providerConfig.providers.length === 0 && (
            <SettingRow title="模型配置" detail="尚无已加载的用户级连接">
              <Link className="button" to="/settings/models">
                配置模型
              </Link>
            </SettingRow>
          )}
        </div>
        {data.notices.providers && (
          <InlineNotice tone="warning">{data.notices.providers}</InlineNotice>
        )}
      </section>
      <section className="settings-section">
        <h3>扩展能力</h3>
        <p className="settings-section__note">用户级 MCP 配置，不代表实时探测结果。</p>
        <div className="settings-list">
          {data.mcpScope.userItems.map((server) => (
            <SettingRow
              key={server.id}
              title={server.name}
              detail={server.description || server.meta || "MCP 服务"}
            >
              <span className="health-status-text">
                {server.state === "attention"
                  ? "需要处理"
                  : server.state === "disabled"
                    ? "未启用"
                    : "已配置"}
              </span>
            </SettingRow>
          ))}
          {data.mcpScope.userItems.length === 0 && (
            <SettingRow
              title="MCP"
              detail="当前范围没有已加载的 MCP 服务；未配置可选扩展不属于故障"
            >
              <span className="health-status-text">未配置</span>
            </SettingRow>
          )}
        </div>
        {!data.mcpScope.workspacePath && data.notices.mcp && (
          <InlineNotice tone="warning">{data.notices.mcp}</InlineNotice>
        )}
        <Link className="button" to="/extensions/mcp">
          管理扩展
        </Link>
      </section>
      <details className="settings-section health-report__raw">
        <summary>高级诊断</summary>
        <p className="settings-section__note">
          按需检查项目环境、本地存储和资源路径。不会发起模型请求或修复数据。
        </p>
        <div className="settings-list">
          <SettingRow title="诊断项目" detail="只决定本次检查范围，不会切换当前会话">
            <select
              className="select-control"
              value={diagnosticWorkspacePath}
              aria-label="选择诊断项目"
              onChange={(event) => {
                setDiagnosticWorkspacePath(event.target.value);
                setDiagnosticReport(undefined);
              }}
            >
              <option value="">选择项目</option>
              {diagnosticWorkspaces.map((workspace) => (
                <option key={workspace.path} value={workspace.path}>
                  {workspace.temporary
                    ? "当前无项目任务"
                    : workspaceDisplayName(workspace.path, workspace)}
                </option>
              ))}
            </select>
          </SettingRow>
          <SettingRow title="检查项目环境" detail="检查模型、凭证、Node、任务运行与本地存储">
            <div className="button-row">
              <Button
                disabled={Boolean(busy) || !diagnosticWorkspacePath}
                onClick={() =>
                  void actions
                    .runDiagnostics("runtime", diagnosticWorkspacePath)
                    .then(setDiagnosticReport)
                }
              >
                开始检查
              </Button>
              <Button
                disabled={Boolean(busy) || !diagnosticWorkspacePath}
                onClick={() =>
                  void actions
                    .runDiagnostics("resources", diagnosticWorkspacePath)
                    .then(setDiagnosticReport)
                }
              >
                扫描本地资源
              </Button>
            </div>
          </SettingRow>
        </div>
        {!diagnosticWorkspacePath && (
          <p className="settings-section__note">添加项目后可以检查目录、配置和本地资源。</p>
        )}
        {diagnosticReport && <DiagnosticReport report={diagnosticReport} />}
      </details>
    </div>
  );
}

function DiagnosticReport({ report }: { readonly report: DesktopDiagnosticReport }) {
  const visibleChecks = report.checks.filter(
    (check) => check.id !== "provider" && check.id !== "env-file",
  );
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
            <strong>{report.healthy ? "本次检查未发现阻断性错误" : "发现需要处理的问题"}</strong>
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
