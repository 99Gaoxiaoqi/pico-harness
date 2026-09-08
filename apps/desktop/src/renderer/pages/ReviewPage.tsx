import { FileCode2, FileDiff, History, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { Button, CapabilityUnavailable, EmptyState } from "../components.js";
import type { ChangeView } from "../model.js";
import { useRuntime } from "../runtime-context.js";
import {
  workspacePathFromSearch,
  workspaceSessionKey,
  type WorkspaceSessionRef,
} from "../workspace-session.js";

export function ReviewPage() {
  const { data, actions, busy } = useRuntime();
  const location = useLocation();
  const searchParams = new URLSearchParams(location.search);
  const workspacePath = workspacePathFromSearch(location.search) ?? "";
  const sessionId = searchParams.get("sessionId") ?? undefined;
  const sessionRef =
    workspacePath && sessionId
      ? ({ workspacePath, sessionId } satisfies WorkspaceSessionRef)
      : undefined;
  const conversation = sessionRef ? data.conversations[workspaceSessionKey(sessionRef)] : undefined;
  const changes = conversation?.changes ?? (sessionId ? [] : data.changes);
  const fingerprint =
    conversation?.changeFingerprint ?? (sessionId ? undefined : data.changeFingerprint);
  const runId =
    conversation?.runId ??
    (sessionId ? undefined : data.runs.find((run) => run.workspacePath === workspacePath)?.id);
  const target = runId && fingerprint ? { runId, fingerprint } : undefined;
  const [selectedPath, setSelectedPath] = useState(changes[0]?.path);
  const [comment, setComment] = useState("");
  const [rewindOpen, setRewindOpen] = useState(false);
  const [rewindPreview, setRewindPreview] = useState<{
    readonly checkpointId: string;
    readonly fingerprint: string;
    readonly changeCount: number;
  }>();
  useEffect(() => {
    if (!changes.some((change) => change.path === selectedPath)) {
      setSelectedPath(changes[0]?.path);
    }
  }, [changes, selectedPath]);
  const selected = changes.find((change) => change.path === selectedPath);
  useEffect(() => {
    if (!selected || selected.patch || !runId) return;
    void actions.loadChangeDiff({
      workspacePath,
      ...(sessionId ? { sessionId } : {}),
      runId,
      path: selected.path,
    });
  }, [actions, runId, selected, sessionId, workspacePath]);
  if (data.notices.changes)
    return <CapabilityUnavailable title="无法读取更改" detail={data.notices.changes} />;
  if (!selected)
    return (
      <EmptyState
        icon={<FileDiff />}
        title="没有待审阅的更改"
        detail="任务生成文件更改后，会从 Runtime 加载到这里。"
      />
    );
  return (
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
                    : "先读取预览；执行时会重新验证指纹，冲突时不会写入。"}
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
          <code>{renderPatch(selected)}</code>
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
              disabled={Boolean(busy) || !target}
              onClick={() => void actions.reviewChanges("approve", undefined, target)}
            >
              批准更改
            </Button>
            <Button
              variant="primary"
              disabled={Boolean(busy) || !target}
              onClick={() => void actions.applyChanges(target)}
            >
              批准并应用
            </Button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function renderPatch(change: ChangeView): string {
  if (!change.patch) return "Runtime 未返回此文件的 diff 内容。";
  return change.patch;
}
