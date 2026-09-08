import { Network, Plus, WandSparkles } from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { NavLink, Navigate, useParams } from "react-router-dom";
import { Button, CapabilityList, InlineNotice } from "../components.js";
import type { CapabilityView, McpServerDraft } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import { workspaceDisplayName } from "../workspace-session.js";

export function ExtensionsIndex() {
  const lastKind = window.localStorage.getItem("pico.extensions-kind") === "mcp" ? "mcp" : "skills";
  return <Navigate replace to={`/extensions/${lastKind}`} />;
}

export function ExtensionsPage() {
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
