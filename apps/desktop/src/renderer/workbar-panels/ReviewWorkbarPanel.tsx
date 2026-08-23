import { CircleAlert, FileDiff, GitBranch, RefreshCw } from "lucide-react";

export type ReviewChangeSource = "staged" | "unstaged";
export type ReviewFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted";

export interface ReviewChangedFile {
  readonly path: string;
  readonly status: ReviewFileStatus;
  readonly additions?: number;
  readonly deletions?: number;
  readonly binary?: boolean;
}

export interface ReviewSnapshot {
  readonly revision: string;
  readonly branch: string;
  readonly head?: string;
  readonly staged: readonly ReviewChangedFile[];
  readonly unstaged: readonly ReviewChangedFile[];
}

export interface ReviewSelection {
  readonly path: string;
  readonly source: ReviewChangeSource;
}

export interface ReviewDiffView extends ReviewSelection {
  readonly revision: string;
  readonly content: string;
  readonly truncated?: boolean;
}

export interface ReviewWorkbarPanelProps {
  readonly snapshot?: ReviewSnapshot;
  readonly selection?: ReviewSelection;
  readonly diff?: ReviewDiffView | null;
  readonly loading: boolean;
  readonly diffLoading?: boolean;
  readonly error?: string | null;
  readonly diffError?: string | null;
  readonly onRefresh: () => void;
  readonly onSelectFile: (selection: ReviewSelection) => void;
}

export function reviewSelectionKey(selection: ReviewSelection): string {
  return `${selection.source}:${selection.path}`;
}

export function ReviewWorkbarPanel({
  snapshot,
  selection,
  diff,
  loading,
  diffLoading = false,
  error,
  diffError,
  onRefresh,
  onSelectFile,
}: ReviewWorkbarPanelProps) {
  const total = (snapshot?.staged.length ?? 0) + (snapshot?.unstaged.length ?? 0);

  return (
    <section className="tool-panel tool-panel--review" aria-label="变更">
      <header className="tool-panel__header">
        <div>
          <span className="tool-panel__eyebrow">实时 Git</span>
          <strong className="tool-panel__branch">
            <GitBranch aria-hidden="true" size={14} />
            {snapshot?.branch || "未识别分支"}
          </strong>
        </div>
        <button
          type="button"
          className="tool-panel__icon-button"
          aria-label="刷新 Git 变更"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" size={15} />
        </button>
      </header>

      {error && (
        <p className="tool-panel__error" role="alert">
          <CircleAlert aria-hidden="true" size={14} />
          {error}
        </p>
      )}

      <div className="tool-panel__split" aria-busy={loading}>
        <div className="tool-panel__sidebar" aria-label="变更文件">
          {loading && !snapshot ? (
            <p className="tool-panel__state" role="status">
              正在读取工作区变更…
            </p>
          ) : !snapshot || total === 0 ? (
            <div className="tool-panel__state">
              <FileDiff aria-hidden="true" size={20} />
              <strong>没有本地变更</strong>
              <span>工作区与当前 HEAD 一致。</span>
            </div>
          ) : (
            <>
              <ReviewFileGroup
                heading="已暂存"
                source="staged"
                files={snapshot.staged}
                selection={selection}
                onSelectFile={onSelectFile}
              />
              <ReviewFileGroup
                heading="未暂存"
                source="unstaged"
                files={snapshot.unstaged}
                selection={selection}
                onSelectFile={onSelectFile}
              />
            </>
          )}
        </div>

        <div className="tool-panel__detail" aria-live="polite">
          {diffError ? (
            <p className="tool-panel__error" role="alert">
              {diffError}
            </p>
          ) : diffLoading ? (
            <p className="tool-panel__state" role="status">
              正在加载差异…
            </p>
          ) : !selection ? (
            <p className="tool-panel__state">选择一个文件查看差异。</p>
          ) : !diff ? (
            <p className="tool-panel__state">当前文件没有可显示的文本差异。</p>
          ) : (
            <section className="tool-panel__diff" aria-label={`${diff.path} 差异`}>
              <header>
                <strong title={diff.path}>{diff.path}</strong>
                <span>{diff.source === "staged" ? "已暂存" : "未暂存"}</span>
              </header>
              <pre tabIndex={0}>{diff.content}</pre>
              {diff.truncated && <p className="tool-panel__notice">差异过大，当前内容已截断。</p>}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}

function ReviewFileGroup({
  heading,
  source,
  files,
  selection,
  onSelectFile,
}: {
  readonly heading: string;
  readonly source: ReviewChangeSource;
  readonly files: readonly ReviewChangedFile[];
  readonly selection?: ReviewSelection;
  readonly onSelectFile: (selection: ReviewSelection) => void;
}) {
  if (files.length === 0) return null;
  return (
    <section className="tool-panel__file-group" aria-label={heading}>
      <header>
        <strong>{heading}</strong>
        <span>{files.length}</span>
      </header>
      <ul>
        {files.map((file) => {
          const candidate = { path: file.path, source } satisfies ReviewSelection;
          const selected =
            selection && reviewSelectionKey(selection) === reviewSelectionKey(candidate);
          return (
            <li key={file.path}>
              <button
                type="button"
                aria-pressed={Boolean(selected)}
                data-status={file.status}
                onClick={() => onSelectFile(candidate)}
              >
                <span className="tool-panel__file-status" aria-label={statusLabel(file.status)}>
                  {statusGlyph(file.status)}
                </span>
                <span className="tool-panel__file-path" title={file.path}>
                  {file.path}
                </span>
                {!file.binary && (file.additions !== undefined || file.deletions !== undefined) && (
                  <small>
                    <span>+{file.additions ?? 0}</span>
                    <span>−{file.deletions ?? 0}</span>
                  </small>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function statusGlyph(status: ReviewFileStatus): string {
  if (status === "added" || status === "untracked") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  if (status === "conflicted") return "!";
  return "M";
}

function statusLabel(status: ReviewFileStatus): string {
  const labels: Record<ReviewFileStatus, string> = {
    added: "新增",
    modified: "修改",
    deleted: "删除",
    renamed: "重命名",
    untracked: "未跟踪",
    conflicted: "冲突",
  };
  return labels[status];
}
