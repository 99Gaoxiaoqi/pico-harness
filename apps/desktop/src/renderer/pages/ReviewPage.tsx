import { isTerminalRunStatus } from "@pico/protocol";
import { FileCode2, FileDiff, History, RefreshCw, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import { Button, EmptyState, InlineNotice } from "../components.js";
import type { ChangeView } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import {
  workspacePathFromSearch,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "../workspace-session.js";

export function ReviewPage() {
  const { data, actions, busy, preview } = useRuntime();
  const location = useLocation();
  const navigate = useNavigate();
  const searchParams = new URLSearchParams(location.search);
  const workspacePath = workspacePathFromSearch(location.search) ?? "";
  const sessions = data.sessions.filter((session) => session.workspacePath === workspacePath);
  const requestedSessionId = searchParams.get("sessionId");
  const sessionId = requestedSessionId ?? sessions[0]?.id;
  const sessionRef =
    workspacePath && sessionId
      ? ({ workspacePath, sessionId } satisfies WorkspaceSessionRef)
      : undefined;
  const conversation = sessionRef ? data.conversations[workspaceSessionKey(sessionRef)] : undefined;
  const runs = data.runs.filter((run) => run.workspacePath === workspacePath &&
    run.sessionId === sessionId && isTerminalRunStatus(run.status))
    .sort((left, right) => right.startedAt - left.startedAt);
  const requestedRunId = searchParams.get("runId");
  const runId = runs.find((run) => run.id === requestedRunId)?.id ?? runs[0]?.id;
  const reviewKey = JSON.stringify([workspacePath, sessionId, runId]);
  const [review, setReview] = useState<{ key: string; changes: readonly ChangeView[]; fingerprint: string }>();
  const changes = preview ? conversation?.changes ?? data.changes : review?.key === reviewKey ? review.changes : [];
  const fingerprint = preview ? conversation?.changeFingerprint ?? data.changeFingerprint : review?.key === reviewKey ? review.fingerprint : undefined;
  const target = runId && fingerprint ? { workspacePath, runId, fingerprint } : undefined;
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [refresh, setRefresh] = useState(0);
  const [diff, setDiff] = useState<{ key: string; path: string; patch: string }>();
  const [comment, setComment] = useState("");
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPreview, setRewindPreview] = useState<{
    readonly checkpointId: string;
    readonly fingerprint: string;
    readonly changeCount: number;
  }>();
  useEffect(() => {
    setRewindOpen(false);
    setRewindPreview(undefined);
    setComment("");
    setDiff(undefined);
    setError(undefined);
    if (preview || !runId || !sessionId) { setLoading(false); return; }
    let disposed = false;
    setLoading(true);
    void actions.queryReview(workspacePath, runId).then((value) => {
      if (!disposed) setReview({ key: reviewKey, ...value });
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (!disposed) setLoading(false); });
    return () => { disposed = true; };
  }, [actions, preview, refresh, reviewKey, runId, sessionId, workspacePath]);
  useEffect(() => {
    if (!changes.some((change) => change.path === selectedPath)) {
      setSelectedPath(changes[0]?.path);
    }
  }, [changes, selectedPath]);
  const selected = changes.find((change) => change.path === selectedPath);
  useEffect(() => {
    if (!selected || selected.patch !== undefined || !runId || !fingerprint) return;
    let disposed = false;
    void actions.queryReviewDiff(workspacePath, runId, selected.path).then((value) => {
      if (disposed) return;
      if (value.fingerprint !== fingerprint) {
        setError("工作区内容已变化，请刷新审阅后重试。");
        return;
      }
      setDiff({ key: reviewKey, path: selected.path, patch: value.patch });
    }).catch((cause: unknown) => {
      if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { disposed = true; };
  }, [actions, fingerprint, reviewKey, runId, selected, workspacePath]);
  const selectScope = (nextSession: string, nextRun?: string) => {
    const params = new URLSearchParams({ workspace: workspacePath, sessionId: nextSession });
    if (nextRun) params.set("runId", nextRun);
    navigate(`/review?${params}`);
  };
  return <div className="page-stack">
    <section className="page-intro" aria-label="审阅范围">
      <label>任务<select aria-label="审阅任务" value={sessionId ?? ""}
        onChange={(event) => selectScope(event.target.value)}>
        <option value="" disabled>选择任务</option>
        {sessions.map((session) => <option key={session.id} value={session.id}>{session.title}</option>)}
      </select></label>
      <label>运行<select aria-label="审阅运行" value={runId ?? ""}
        onChange={(event) => sessionId && selectScope(sessionId, event.target.value)}>
        <option value="" disabled>没有已结束的运行</option>
        {runs.map((run) => <option key={run.id} value={run.id}>{new Date(run.startedAt).toLocaleString()} · {run.description} · {run.id.slice(-8)}</option>)}
      </select></label>
      <Button disabled={loading || Boolean(busy)} onClick={() => setRefresh((value) => value + 1)}><RefreshCw aria-hidden="true" size={15} />刷新审阅</Button>
    </section>
    <p>文件已由工具写入工作区；这里核验本次运行的更改并记录审阅结果，不会重复写入文件。</p>
    {error && <InlineNotice tone="error">{error}</InlineNotice>}
    {loading ? <p role="status">正在读取运行更改…</p> : !selected ? (
      <EmptyState
        icon={<FileDiff />}
        title="没有待审阅的更改"
        detail="请选择发生文件修改的任务和运行；聊天或只读运行可能没有更改。"
      />
    ) : (
    <div className="review-layout">
      <aside className="file-list" aria-label="已更改文件">
        <div className="file-list__header">
          <strong>更改</strong>
          <span>{changes.length} 个文件</span>
        </div>
        {changes.map((change) => (
          <button
            key={change.path}
            type="button"
            className={change.path === selected.path ? "is-active" : ""}
            onClick={() => setSelectedPath(change.path)}
          >
            <FileCode2 aria-hidden="true" />
            <span>
              <strong>{change.path.split("/").at(-1)}</strong>
              <small>{change.path}</small>
            </span>
            <em>
              +{change.additions} −{change.deletions}
            </em>
          </button>
        ))}
      </aside>
      <section className="diff-workspace">
        <header className="diff-header">
          <div>
            <code>{selected.path}</code>
            <span>
              <b>+{selected.additions}</b> <i>−{selected.deletions}</i>
            </span>
          </div>
          <Button onClick={() => setRewindOpen((value) => !value)}>
            <History aria-hidden="true" size={15} />
            Rewind
          </Button>
        </header>
        {rewindOpen && (
          <div className="rewind-panel">
            <div>
              <RotateCcw aria-hidden="true" />
              <span>
                <strong>
                  {rewindPreview ? `将回退 ${rewindPreview.changeCount} 项更改` : "回到最近检查点"}
                </strong>
                <small>
                  {rewindPreview
                    ? `指纹 ${rewindPreview.fingerprint}`
                    : "预览此会话最近检查点；执行时会重新验证指纹，冲突时不会写入。"}
                </small>
              </span>
            </div>
            {rewindPreview ? (
              <Button
                variant="danger"
                disabled={Boolean(busy)}
                onClick={() => {
                  if (sessionRef)
                    void actions.applyRewind(
                      sessionRef,
                      rewindPreview.checkpointId,
                      rewindPreview.fingerprint,
                    );
                }}
              >
                确认 Rewind
              </Button>
            ) : (
              <Button
                disabled={Boolean(busy) || !sessionRef}
                onClick={() => {
                  if (sessionRef) void actions.previewRewind(sessionRef).then(setRewindPreview);
                }}
              >
                预览 Rewind
              </Button>
            )}
          </div>
        )}
        <pre className="diff-view" aria-label={`${selected.path} 的差异`}>
          <code>{diff?.key === reviewKey && diff.path === selected.path ? diff.patch : renderPatch(selected)}</code>
        </pre>
        <div className="review-composer">
          <label htmlFor="review-comment">要求修改</label>
          <div className="input-action">
            <input
              id="review-comment"
              value={comment}
              autoComplete="off"
              onChange={(event) => setComment(event.target.value)}
              placeholder="例如：保留现有错误类型，不要改变公开接口…"
            />
            <Button
              disabled={!comment.trim() || Boolean(busy)}
              onClick={() =>
                void actions
                  .reviewChanges("request_changes", comment, target)
                  .then(() => setComment(""))
              }
            >
              发送意见
            </Button>
          </div>
        </div>
        <footer className="review-footer">
          <span>
            指纹 <code>{fingerprint ?? "Runtime 未提供"}</code>
          </span>
          <div className="button-row">
            <Button
              disabled={Boolean(busy) || !target || Boolean(error)}
              onClick={() => void actions.reviewChanges("approve", undefined, target)}
            >
              批准更改
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(busy) || !target || Boolean(error)}
              onClick={() => void actions.applyChanges(target)}
            >
              核验并确认
            </Button>
          </div>
        </footer>
      </section>
    </div>
  )}</div>;
}

function renderPatch(change: ChangeView): string {
  if (!change.patch) return "Runtime 未返回此文件的 diff 内容。";
  return change.patch;
}
