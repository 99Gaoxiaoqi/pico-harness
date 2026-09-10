import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { RuntimeMemorySettings } from "@pico/protocol";
import { Button, InlineNotice } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import { workspaceDisplayName, workspaceHref } from "../workspace-session.js";

export function UserMemorySettingsPage() {
  const { data, actions } = useRuntime();
  const [settings, setSettings] = useState<RuntimeMemorySettings>();
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSettings(undefined);
    setError("");
    void actions.loadUserMemorySettings().then(
      (value) => {
        if (!cancelled) setSettings(value);
      },
      () => {
        if (!cancelled) setError("无法读取用户级记忆设置，请重试。");
      },
    );
    return () => {
      cancelled = true;
    };
  }, [actions, refresh]);
  const scopes = data.workspaces.filter(
    (workspace) => !workspace.temporary || workspace.path === data.workspacePath,
  );
  return (
    <div className="page-stack settings-page">
      <section className="page-intro">
        <div>
          <span className="eyebrow">能力</span>
          <h2>记忆</h2>
          <p>记忆策略对所有项目生效。项目记忆内容仍按工作区隔离。</p>
        </div>
        <Button disabled={saving} onClick={() => setRefresh((value) => value + 1)}>
          刷新
        </Button>
      </section>
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      {!settings && !error && <p role="status">正在读取记忆设置…</p>}
      {settings && (
        <section className="memory-settings">
          <fieldset disabled={saving}>
            <legend>用户级记忆策略</legend>
            {(
              [
                ["enabled", "启用记忆", "关闭后，所有项目停止提取和召回；已保存的内容保留。"],
                ["autoPropose", "自动提取长期信息", "从对话中提取经过验证的长期信息。"],
                ["injectionEnabled", "会话召回", "根据当前问题召回相关记忆，遵循项目隔离。"],
              ] as const
            ).map(([key, label, detail]) => (
              <label key={key}>
                <input
                  type="checkbox"
                  checked={settings[key]}
                  onChange={async (event) => {
                    setSaving(true);
                    setError("");
                    try {
                      setSettings(
                        await actions.updateUserMemorySettings(settings.version, {
                          [key]: event.target.checked,
                        }),
                      );
                    } catch {
                      setError("保存失败或设置已被其他窗口修改，请刷新后重试。");
                    } finally {
                      setSaving(false);
                    }
                  }}
                />
                <span>
                  <strong>{label}</strong>
                  <small>{detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </section>
      )}
      <details className="settings-section health-report__raw">
        <summary>管理已保存的记忆</summary>
        <p>选择工作区查看内容；这里的选择不会改变用户级策略。</p>
        <div className="settings-list">
          {scopes.map((workspace) => (
            <p key={workspace.path}>
              <Link to={workspaceHref("/memory", workspace.path)}>
                {workspace.temporary
                  ? "当前无项目任务"
                  : workspaceDisplayName(workspace.path, workspace)}
              </Link>
            </p>
          ))}
        </div>
        {scopes.length === 0 && <p>暂无工作区记忆。</p>}
      </details>
    </div>
  );
}
