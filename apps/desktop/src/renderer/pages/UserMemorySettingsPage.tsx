import { useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { ShieldCheck } from "lucide-react";
import { MemoryPage } from "../MemoryPage.js";
import { useRuntime } from "../runtime-context.js";
import { SelectField } from "../ui-controls.js";
import { InlineNotice } from "../components.js";
import { WorkspaceRoute } from "../workspace-access.js";
import { workspaceDisplayName, workspacePathFromSearch } from "../workspace-session.js";
import { MemoryPolicySection } from "./MemoryPolicySection.js";
import { MemoryScopeOverview } from "../MemoryScopeOverview.js";
import "./memory-settings.css";

export function UserMemorySettingsPage() {
  const runtime = useRuntime();
  const { data } = runtime;
  const location = useLocation();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const params = new URLSearchParams(location.search);
  const requested = workspacePathFromSearch(location.search);
  const explicitScope = params.get("scope");
  const scopes = data.workspaces;
  const current = scopes.find((workspace) => workspace.path === data.workspacePath);
  const scope =
    explicitScope === "global" || explicitScope === "all" || explicitScope === "unassigned"
      ? explicitScope
      : requested
        ? `workspace:${requested}`
        : current
          ? `workspace:${current.path}`
          : "all";
  const workspacePath = scope.startsWith("workspace:") ? scope.slice(10) : undefined;
  const changeScope = (value: string) => {
    if (editing) return;
    const next = new URLSearchParams(location.search);
    for (const key of [
      "scope",
      "workspace",
      "item",
      "candidate",
      "referenceItemVersion",
      "referenceContentVersion",
    ])
      next.delete(key);
    if (value.startsWith("workspace:")) next.set("workspace", value.slice(10));
    else next.set("scope", value);
    navigate({ pathname: "/settings/memory", search: next.toString(), hash: "" });
  };
  const settings = data.memory.settings;
  return (
    <div className="page-stack settings-page unified-memory-settings">
      <header className="page-intro">
        <div>
          <span className="eyebrow">设置</span>
          <h2>记忆</h2>
          <p>管理 Pico 记住的偏好、事实与任务经验。</p>
        </div>
      </header>
      <details className="unified-memory-policy">
        <summary>
          <span>
            <ShieldCheck size={16} aria-hidden="true" />
            记忆策略
          </span>
          <small>
            {settings
              ? `${settings.enabled ? "记忆已开启" : "记忆已关闭"} · ${settings.autoExtract ? "自动提取开启" : "自动提取关闭"} · ${settings.recallEnabled ? "会话召回开启" : "会话召回关闭"}`
              : "正在读取策略…"}
          </small>
          <span className="unified-memory-policy__hint">调整</span>
        </summary>
        <MemoryPolicySection />
      </details>
      <div className="unified-memory-scope">
        <SelectField
          label="管理范围"
          value={scope}
          disabled={editing}
          onValueChange={changeScope}
          options={[
            { value: "all", label: "全部范围" },
            { value: "global", label: "全局" },
            ...scopes
              .filter((workspace) => !workspace.temporary)
              .map((workspace) => ({
                value: `workspace:${workspace.path}`,
                label: workspaceDisplayName(workspace.path, workspace),
              })),
            { value: "unassigned", label: "无项目任务" },
            ...(current?.temporary
              ? [{ value: `workspace:${current.path}`, label: "当前无项目任务" }]
              : []),
            ...(requested && !scopes.some((workspace) => workspace.path === requested)
              ? [{ value: `workspace:${requested}`, label: "工作区不可用" }]
              : []),
          ]}
        />
        <p>
          {editing
            ? "有正在编辑的内容，请先保存或结束编辑再切换范围。"
            : "集中管理不会扩大引用范围；项目内容仍按工作区隔离。"}
        </p>
      </div>
      {workspacePath ? (
        requested ? (
          <WorkspaceRoute>
            <MemoryPage runtime={runtime} embedded onDraftStateChange={setEditing} />
          </WorkspaceRoute>
        ) : data.trusted ? (
          <MemoryPage runtime={runtime} embedded onDraftStateChange={setEditing} />
        ) : (
          <InlineNotice tone="warning">
            当前工作区尚未信任。请在项目设置中确认信任后管理内容。
          </InlineNotice>
        )
      ) : (
        <MemoryScopeOverview runtime={runtime} scope={scope as "all" | "global" | "unassigned"} />
      )}
    </div>
  );
}
