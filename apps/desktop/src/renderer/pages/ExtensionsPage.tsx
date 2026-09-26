import { TextField, SelectField, TextAreaField, CheckboxField } from "../ui-controls.js";
import { TabList, Tab } from "@astryxdesign/core/TabList";
import { Network, Plus, WandSparkles } from "lucide-react";
import { useEffect, useState, type FormEvent, type ComponentProps } from "react";
import { Link, Navigate, useParams, useNavigate } from "react-router-dom";
import { Button, CapabilityList, InlineNotice } from "../components.js";
import type { CapabilityView, McpServerDraft } from "../model.js";
import { useRuntime } from "../runtime-context.js";

export function ExtensionsIndex() {
  const lastKind = window.localStorage.getItem("pico.extensions-kind") === "mcp" ? "mcp" : "skills";
  return <Navigate replace to={`/extensions/${lastKind}`} />;
}

export function ExtensionsPage() {
  const navigate = useNavigate();
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
        <TabList
          className="surface-tabs"
          aria-label="扩展类型"
          value={activeKind}
          onChange={(value) => navigate(`/extensions/${value}`)}
        >
          <Tab
            as={ExtensionLink}
            href="/extensions/skills"
            value="skills"
            label="技能"
            className={activeKind === "skills" ? "is-active" : ""}
          />
          <Tab
            as={ExtensionLink}
            href="/extensions/mcp"
            value="mcp"
            label="MCP"
            className={activeKind === "mcp" ? "is-active" : ""}
          />
        </TabList>
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
  useEffect(() => {
    void actions.loadCapabilityScope(kind, undefined);
  }, [actions, kind]);
  const config = {
    skills: {
      title: "Skills",
      eyebrow: "工作方式",
      detail: "Skills 告诉 Pico 如何稳定地完成特定类型的工作。",
      icon: WandSparkles,
      items: data.skillScope.userItems,
      notice: data.notices.skills,
      empty: "没有发现 Skills",
    },
    mcp: {
      title: "MCP 服务",
      eyebrow: "外部能力",
      detail: "明确管理 Pico 可以访问的工具和数据来源。",
      icon: Network,
      items: data.mcpScope.userItems,
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
          <p>
            管理当前运行主机的用户级扩展，供所有项目使用。项目文件中的覆盖配置可通过高级诊断查看。
          </p>
        </div>
        <span>用户级</span>
      </section>
      {!scope.workspacePath && config.notice && (
        <InlineNotice tone="warning">{config.notice}</InlineNotice>
      )}
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
  const [desktopExecution, setDesktopExecution] = useState(false);
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
        desktopExecution,
      });
      return;
    }
    const endpoint = url.trim();
    if (!endpoint) return;
    void onSubmit({ name: serverName, transport, url: endpoint, enabled: true, desktopExecution });
  };
  return (
    <form className="capability-add-form" onSubmit={submit}>
      <header>
        <div>
          <strong>添加用户级 MCP 服务</strong>
          <p>只新增配置，不会连接或启动服务。如需密钥，请在安全配置源中管理。</p>
        </div>
      </header>
      <div className="settings-field">
        <span>名称</span>
        <TextField
          label="名称"
          required
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </div>
      <div className="settings-field">
        <span>传输方式</span>
        <SelectField
          label="传输方式"
          value={transport}
          onValueChange={(value) => setTransport(value as typeof transport)}
          options={[
            { value: "stdio", label: "stdio" },
            { value: "http", label: "HTTP" },
            { value: "sse", label: "SSE" },
          ]}
        />
      </div>
      {transport === "stdio" ? (
        <>
          <div className="settings-field">
            <span>命令</span>
            <TextField
              label="命令"
              required
              value={command}
              onChange={(event) => setCommand(event.target.value)}
              placeholder="npx"
            />
          </div>
          <div className="settings-field capability-add-form__wide">
            <span>参数（每行一个）</span>
            <TextAreaField
              label="参数（每行一个）"
              value={args}
              onChange={(event) => setArgs(event.target.value)}
              rows={3}
            />
          </div>
        </>
      ) : (
        <div className="settings-field capability-add-form__wide">
          <span>URL</span>
          <TextField
            label="URL"
            required
            type="url"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://example.com/mcp"
          />
        </div>
      )}
      <div className="settings-field capability-add-form__wide">
        <CheckboxField
          label="允许通过 Desktop 客户端执行（每次连接和工具调用仍需任务授权）"
          labelHidden={false}
          checked={desktopExecution}
          onCheckedChange={(checked) => setDesktopExecution(checked)}
        />
      </div>
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

function ExtensionLink({ href, ...props }: ComponentProps<"a">) {
  return <Link to={href ?? "/extensions/skills"} {...props} />;
}
