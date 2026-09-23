import { AlertCircle, ArrowUpRight, RefreshCw } from "lucide-react";
import * as React from "react";
import { providerFailureDescription, type ProviderRetryNotice } from "../provider-retry.js";

export function ProviderRetryBanner({ notice }: { readonly notice: ProviderRetryNotice }) {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    setNow(Date.now());
    if (notice.phase !== "scheduled") return;
    const timer = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(timer);
  }, [notice]);
  const remainingMs = Math.max(0, notice.at + notice.delayMs - now);
  const progress =
    notice.phase === "started" || notice.delayMs === 0
      ? 100
      : Math.max(0, Math.min(100, (1 - remainingMs / notice.delayMs) * 100));
  const reason =
    notice.httpStatus === 429
      ? "模型服务请求较多，已保留当前任务"
      : notice.httpStatus && notice.httpStatus >= 500
        ? "模型服务暂时不可用，已保留当前任务"
        : "模型连接暂时不稳定，已保留当前任务";
  return (
    <section className="conversation-provider-retry" role="status" aria-live="polite">
      <RefreshCw aria-hidden="true" className="conversation-provider-retry__icon" />
      <div className="conversation-provider-retry__body">
        <div className="conversation-provider-retry__topline">
          <strong>
            {notice.phase === "scheduled" ? "连接中断，正在自动重试" : "正在重新连接模型"}
          </strong>
          <span aria-hidden="true">
            第 {notice.nextAttempt}/{notice.maxAttempts} 次
            {notice.phase === "scheduled"
              ? ` · 约 ${Math.ceil(remainingMs / 1000)} 秒后重试`
              : " · 请求中"}
          </span>
          <span className="conversation-sr-only">
            第 {notice.nextAttempt} 次，共 {notice.maxAttempts} 次
          </span>
        </div>
        <p>{reason}</p>
        <div className="conversation-provider-retry__track" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
      </div>
    </section>
  );
}

export function ProviderFailureCard({
  notice,
  httpStatus,
  title,
  canRetry,
  onRetry,
  onDiagnostics,
}: {
  readonly notice?: ProviderRetryNotice;
  readonly httpStatus?: number;
  readonly title: string;
  readonly canRetry: boolean;
  readonly onRetry: () => void;
  readonly onDiagnostics: () => void;
}) {
  const detail = providerFailureDescription(notice, httpStatus);
  return (
    <section className="conversation-provider-failure" role="alert">
      <AlertCircle aria-hidden="true" className="conversation-provider-failure__icon" />
      <div className="conversation-provider-failure__body">
        <strong>{title}</strong>
        <p>{detail}</p>
        <div className="conversation-provider-failure__actions">
          {canRetry && (
            <button type="button" onClick={onRetry}>
              <RefreshCw aria-hidden="true" /> 编辑后重试
            </button>
          )}
          <button type="button" className="is-quiet" onClick={onDiagnostics}>
            查看诊断 <ArrowUpRight aria-hidden="true" />
          </button>
        </div>
      </div>
    </section>
  );
}
