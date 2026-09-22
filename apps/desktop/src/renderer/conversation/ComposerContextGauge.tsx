import { useEffect, useState } from "react";
import { invokeWorkbarRuntime } from "../workbar-panels/workbar-runtime.js";
import {
  composerContextUsage,
  contextTargetKey,
  createContextUsageTracker,
  type ContextUsageReading,
  type ContextUsageTarget,
} from "./live-context-usage.js";

export function ComposerContextGauge({ target }: { readonly target?: ContextUsageTarget }) {
  const [reading, setReading] = useState<ContextUsageReading>();
  const targetKey = target ? contextTargetKey(target) : "";
  useEffect(() => {
    const tracker = createContextUsageTracker({
      query: async (current) =>
        (
          await invokeWorkbarRuntime(window.pico.runtime, "session.context.get", {
            workspacePath: current.workspacePath,
            sessionId: current.sessionId,
          })
        ).context,
      onChange: setReading,
    });
    tracker.setTarget(target);
    const subscription = window.pico.sessionFrames.subscribe((frame) => {
      if (
        frame.type === "subscription.resource_changed" &&
        (frame.resource === "trace" || frame.resource === "context")
      )
        tracker.observe(frame.sessionId);
    });
    return () => {
      subscription.dispose();
      tracker.dispose();
    };
    // A fresh target object with the same identity must not restart the read.
  }, [targetKey]);
  if (!target) return null;
  // Render-time identity guard prevents an old route's figure flashing before effects run.
  const current = reading?.targetKey === targetKey ? reading : undefined;
  const usage = composerContextUsage(current?.snapshot, target);
  const percent = usage?.contextWindow
    ? (usage.inputTokens / usage.contextWindow) * 100
    : undefined;
  const label = usage
    ? `${usage.inputTokens.toLocaleString("zh-CN")} / ${usage.contextWindow?.toLocaleString("zh-CN") ?? "未知"} Token`
    : "上下文用量未知";
  const basis =
    usage?.basis === "turn_anchor" ? "最近请求锚点（输入＋输出）" : "最近成功请求（实际输入）";
  return (
    <span
      className="conversation-context-gauge"
      role="status"
      title={`${basis}：${label}${current?.error ? `；读取失败：${current.error}` : ""}`}
    >
      {percent !== undefined && (
        <svg width="16" height="16" viewBox="0 0 20 20" aria-hidden="true">
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeOpacity="0.2"
            strokeWidth="3"
          />
          <circle
            cx="10"
            cy="10"
            r="7"
            fill="none"
            stroke="currentColor"
            strokeWidth="3"
            pathLength="100"
            strokeDasharray={`${Math.max(0, Math.min(100, percent))} 100`}
            transform="rotate(-90 10 10)"
          />
        </svg>
      )}
      <span aria-label={`${basis}：${label}`}>
        {percent === undefined ? "上下文未知" : `${Math.round(percent)}%`}
      </span>
      {current?.error && (
        <span role="alert" aria-label={`上下文读取失败：${current.error}`}>
          {" "}
          · 读取失败
        </span>
      )}
    </span>
  );
}
