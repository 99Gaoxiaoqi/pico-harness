import { CheckboxField } from "../ui-controls.js";
import { useEffect, useRef, useState } from "react";
import type { RuntimeMemoryMetrics } from "@pico/protocol";
import { Link } from "react-router-dom";
import { Button, InlineNotice } from "../components.js";
import { useRuntime } from "../runtime-context.js";
import { workspaceDisplayName, workspaceHref } from "../workspace-session.js";

export function UserMemorySettingsPage() {
  const { data, actions } = useRuntime();
  const settings = data.memory.settings;
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [metrics, setMetrics] = useState<{ key: string; value: RuntimeMemoryMetrics }>();
  const [metricsError, setMetricsError] = useState("");
  const [metricsLoading, setMetricsLoading] = useState(false);
  const metricsSequence = useRef(0);
  const metricsKey = JSON.stringify([data.workspacePath, settings?.version, refresh]);
  const metricsKeyRef = useRef(metricsKey);
  metricsKeyRef.current = metricsKey;
  useEffect(() => {
    let cancelled = false;
    setError("");
    void actions.loadUserMemorySettings().catch(() => {
      if (!cancelled) setError("无法读取用户级记忆设置，请重试。");
    });
    return () => {
      cancelled = true;
    };
  }, [actions, refresh]);
  useEffect(() => {
    const sequence = ++metricsSequence.current;
    const key = metricsKey;
    setMetrics(undefined);
    setMetricsError("");
    setMetricsLoading(true);
    const to = Date.now();
    void actions.queryMemoryMetrics({ from: Math.max(0, to - 7 * 86_400_000), to }).then(
      (result) => {
        if (sequence !== metricsSequence.current || key !== metricsKeyRef.current) return;
        if (result?.metrics.scope === "user") setMetrics({ key, value: result.metrics });
        else setMetricsError("无法读取记忆提取统计，请刷新后重试。");
        setMetricsLoading(false);
      },
      () => {
        if (sequence !== metricsSequence.current || key !== metricsKeyRef.current) return;
        setMetricsError("无法读取记忆提取统计，请刷新后重试。");
        setMetricsLoading(false);
      },
    );
    return () => {
      metricsSequence.current += 1;
    };
  }, [actions, metricsKey]);
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
                ["autoExtract", "自动提取长期信息", "从对话中提取经过验证的长期信息。"],
                ["recallEnabled", "会话召回", "根据当前问题召回相关记忆，遵循项目隔离。"],
              ] as const
            ).map(([key, label, detail]) => (
              <div className="settings-field" key={key}>
                <CheckboxField
                  label={label}
                  labelHidden={false}
                  checked={settings[key]}
                  onCheckedChange={async (checked) => {
                    setSaving(true);
                    setError("");
                    try {
                      await actions.updateUserMemorySettings(settings.version, {
                        [key]: checked,
                      });
                    } catch {
                      setError("保存失败或设置已被其他窗口修改，请刷新后重试。");
                    } finally {
                      setSaving(false);
                    }
                  }}
                  disabled={saving}
                />
                <span>
                  <small>{detail}</small>
                </span>
              </div>
            ))}
          </fieldset>
        </section>
      )}
      <section className="settings-section" aria-labelledby="memory-metrics-title">
        <h3 id="memory-metrics-title">最近 7 天记忆提取</h3>
        <p>
          用户级统计，覆盖所有工作区。历史创建数是这段时间新建的条目数量，不代表当前已保存条目数。
        </p>
        {metricsLoading && <p role="status">正在读取记忆提取统计…</p>}
        {metricsError && <InlineNotice tone="warning">{metricsError}</InlineNotice>}
        {metrics?.key === metricsKey && <MemoryMetrics metrics={metrics.value} />}
      </section>
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

function MemoryMetrics({ metrics }: { metrics: RuntimeMemoryMetrics }) {
  const labels = { remember: "显式记住", extract: "自动提取", compaction: "上下文压缩" };
  return (
    <>
      <p>
        统计范围：{new Date(metrics.from).toLocaleString("zh-CN")} 至{" "}
        {new Date(metrics.to).toLocaleString("zh-CN")}
      </p>
      <div className="usage-table-scroll" role="region" aria-label="记忆提取统计" tabIndex={0}>
        <table className="usage-table">
          <thead>
            <tr>
              {[
                "触发方式",
                "已结算段",
                "已评估段",
                "历史创建数",
                "模型调用",
                "空提取段",
                "空提取率",
                "累计耗时",
              ].map((label) => (
                <th scope="col" key={label}>
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {metrics.groups.map((group) => (
              <tr key={group.trigger}>
                <th scope="row">{labels[group.trigger]}</th>
                <td>{group.settledCount}</td>
                <td>{group.evaluatedCount}</td>
                <td>{group.createdItemCount}</td>
                <td>{group.modelCallCount}</td>
                <td>{group.emptyCount}</td>
                <td>
                  {group.emptyRate === null
                    ? "未知（无有效评估）"
                    : `${(group.emptyRate * 100).toFixed(1)}%`}
                </td>
                <td>{(group.durationMs / 1000).toFixed(1)} s</td>
              </tr>
            ))}
          </tbody>
        </table>
        {metrics.groups.length === 0 && <p>所选时段暂无可统计的记忆提取记录。</p>}
      </div>
      <p>
        历史记录中有 {metrics.unknownReceiptCount}{" "}
        段未提供完整统计，无法判断是否为空提取。空提取率只使用已评估且统计完整的记录。
      </p>
    </>
  );
}
