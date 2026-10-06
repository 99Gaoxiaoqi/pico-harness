import "./PendingSendNotice.css";
import { useNavigate } from "react-router-dom";
import type { PendingSendEntry } from "./pending-send.js";
import type { RuntimeStore } from "./runtime.js";
import { sessionHref } from "./workspace-session.js";

export function PendingSendNotice({
  runtime,
  entry,
}: {
  readonly runtime: RuntimeStore;
  readonly entry: PendingSendEntry;
}) {
  const navigate = useNavigate();
  const sending = runtime.pendingSendBusy?.includes(entry.scope.sourceKey) ?? false;
  const recover = async () => {
    const result = await runtime.actions.recoverPendingSend?.(entry.scope.sourceKey);
    if (result?.succeeded && result.workspacePath && result.sessionId) {
      navigate(sessionHref({ workspacePath: result.workspacePath, sessionId: result.sessionId }));
    }
  };
  const abandon = () => {
    if (
      window.confirm(
        "原请求可能已经执行。放弃恢复会删除待确认记录并保留文字草稿，不会取消 Host 上的执行。仍要放弃恢复吗？",
      )
    ) {
      runtime.actions.abandonPendingSend?.(entry.scope.sourceKey);
    }
  };
  return (
    <div className="pending-send-notice" role="status">
      <span>
        {entry.kind === "blocked"
          ? `待确认发送记录无法恢复：${entry.reason}`
          : "有一条发送待确认，原请求可能已经执行。"}
      </span>
      {runtime.sendRecoverySupported === false && (
        <span>请更新 Pico 后恢复发送结果，待确认记录已保留。</span>
      )}
      <button
        type="button"
        disabled={sending || entry.kind === "blocked" || runtime.sendRecoverySupported === false}
        onClick={() => void recover()}
      >
        {sending ? "正在确认…" : "恢复发送结果"}
      </button>
      <button type="button" disabled={sending} onClick={abandon}>
        放弃恢复
      </button>
    </div>
  );
}

export function PendingSendList({ runtime }: { readonly runtime: RuntimeStore }) {
  const entries =
    runtime.pendingSends?.filter((entry) => entry.scope.picoHome === runtime.data.picoHome) ?? [];
  if (!entries.length) return null;
  return (
    <details className="pending-send-list" open>
      <summary>待确认发送（{entries.length}）</summary>
      {entries.map((entry) => (
        <div key={entry.scope.sourceKey} data-pending-source={entry.scope.sourceKey}>
          <span>
            {entry.scope.sourceKey.startsWith("side:")
              ? "侧聊"
              : entry.scope.sourceKey.startsWith("research-implement:")
                ? "研究转实施"
                : "对话"}
          </span>
          {entry.kind === "pending" && <span> · {entry.record.draftSnapshot.slice(0, 100)}</span>}
          <PendingSendNotice runtime={runtime} entry={entry} />
        </div>
      ))}
    </details>
  );
}
