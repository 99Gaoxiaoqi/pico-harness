import { CheckboxField } from "../ui-controls.js";
import { useEffect, useRef, useState } from "react";
import type { RuntimeMemoryMetrics } from "@pico/protocol";
import { Button, InlineNotice } from "../components.js";
import { useRuntime } from "../runtime-context.js";

export function MemoryPolicySection() {
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
  return (
    <div className="memory-policy-content">
      <div className="memory-policy-actions">
        <Button disabled={saving} onClick={() => setRefresh((value) => value + 1)}>
          刷新策略与统计
        </Button>
      </div>
      {error && <InlineNotice tone="warning">{error}</InlineNotice>}
      {!settings && !error && <p role="status">正在读取记忆设置…</p>}
      {settings && (
        <section className="memory-settings">
          <fieldset disabled={saving}>
            <legend>用户级记忆策略</legend>
            {(
              [
                [
                  "enabled",
                  "启用记忆",
                  "关闭自动记忆读写与召回；仍可管理和明确删除记忆，普通运行日志继续记录。",
                ],
                [
                  "autoExtract",
                  "自动提取长期信息",
                  "控制自动事实提取、经验反思和派生案例。关闭后仍可使用已有记忆并记录允许的实际效果；明确记住需由你授权。",
                ],
                [
                  "recallEnabled",
                  "召回记忆",
                  "控制自动注入与主动记忆搜索。关闭后仍可学习，管理页仍可查看。",
                ],
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
      <p>
        有依据的事实自动保存；范围明确的低风险方法可作为建议；案例只留记录；需要改变长期做法或扩大范围时由你决定。
      </p>
      <details className="settings-section memory-metrics" aria-labelledby="memory-metrics-title">
        <summary id="memory-metrics-title">最近 7 天记忆提取统计</summary>
        <p>
          用户级统计，覆盖所有工作区。历史创建数是这段时间新建的条目数量，不代表当前已保存条目数。
        </p>
        {metricsLoading && <p role="status">正在读取记忆提取统计…</p>}
        {metricsError && <InlineNotice tone="warning">{metricsError}</InlineNotice>}
        {metrics?.key === metricsKey && <MemoryMetrics metrics={metrics.value} />}
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
