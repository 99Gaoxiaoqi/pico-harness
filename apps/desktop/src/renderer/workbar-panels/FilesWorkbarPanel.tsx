import { CircleAlert, Download, ExternalLink, File, FileText, RefreshCw } from "lucide-react";

export interface WorkbarArtifact {
  readonly id: string;
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly createdAt: string;
  readonly digest?: string;
}

export interface WorkbarArtifactContent {
  readonly artifactId: string;
  readonly encoding: "utf8" | "base64";
  readonly content: string;
  readonly offset: number;
  readonly nextOffset: number;
  readonly totalSize: number;
  readonly complete: boolean;
  readonly truncated?: boolean;
}

export interface ArtifactChunkProgress {
  readonly loaded: number;
  readonly total: number;
  readonly percent: number;
  readonly complete: boolean;
  readonly nextOffset: number;
}

export interface FilesWorkbarPanelProps {
  readonly artifacts: readonly WorkbarArtifact[];
  readonly selectedArtifactId?: string;
  readonly content?: WorkbarArtifactContent | null;
  readonly loading: boolean;
  readonly contentLoading?: boolean;
  readonly error?: string | null;
  readonly contentError?: string | null;
  readonly onRefresh: () => void;
  readonly onSelectArtifact: (artifactId: string) => void;
  readonly onLoadChunk: (artifactId: string, offset: number) => void;
  readonly onOpenArtifact?: (artifactId: string) => void;
  readonly onSaveArtifactAs?: (artifactId: string) => void;
}

export function artifactChunkProgress(content: WorkbarArtifactContent): ArtifactChunkProgress {
  const total = Math.max(0, content.totalSize);
  const loaded = Math.min(total, Math.max(0, content.nextOffset));
  return {
    loaded,
    total,
    percent: total === 0 ? 100 : Math.min(100, (loaded / total) * 100),
    complete: content.complete || loaded >= total,
    nextOffset: Math.max(0, content.nextOffset),
  };
}

export function FilesWorkbarPanel({
  artifacts,
  selectedArtifactId,
  content,
  loading,
  contentLoading = false,
  error,
  contentError,
  onRefresh,
  onSelectArtifact,
  onLoadChunk,
  onOpenArtifact,
  onSaveArtifactAs,
}: FilesWorkbarPanelProps) {
  const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const selectedContent = content?.artifactId === selected?.id ? content : undefined;
  const progress = selectedContent ? artifactChunkProgress(selectedContent) : undefined;

  return (
    <section className="tool-panel tool-panel--files" aria-label="生成文件">
      <header className="tool-panel__header">
        <div>
          <span className="tool-panel__eyebrow">Session Artifacts</span>
          <strong>生成文件</strong>
        </div>
        <button
          type="button"
          className="tool-panel__icon-button"
          aria-label="刷新生成文件"
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
        <div className="tool-panel__sidebar" aria-label="产物列表">
          {loading && artifacts.length === 0 ? (
            <p className="tool-panel__state" role="status">
              正在加载生成文件…
            </p>
          ) : artifacts.length === 0 ? (
            <div className="tool-panel__state">
              <File aria-hidden="true" size={20} />
              <strong>没有生成文件</strong>
              <span>当前任务生成的产物会显示在这里。</span>
            </div>
          ) : (
            <ul className="tool-panel__artifact-list">
              {artifacts.map((artifact) => (
                <li key={artifact.id}>
                  <button
                    type="button"
                    aria-pressed={artifact.id === selectedArtifactId}
                    onClick={() => onSelectArtifact(artifact.id)}
                  >
                    <FileText aria-hidden="true" size={15} />
                    <span>
                      <strong title={artifact.name}>{artifact.name}</strong>
                      <small>
                        {formatBytes(artifact.size)} · {formatArtifactTimestamp(artifact.createdAt)}
                      </small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="tool-panel__detail">
          {!selected ? (
            <p className="tool-panel__state">选择一个生成文件查看内容。</p>
          ) : (
            <section className="tool-panel__artifact" aria-label={`${selected.name} 内容`}>
              <header>
                <div>
                  <strong title={selected.name}>{selected.name}</strong>
                  <span>
                    {selected.mimeType} · {formatBytes(selected.size)}
                  </span>
                </div>
                <div>
                  {onOpenArtifact && (
                    <button
                      type="button"
                      aria-label="打开生成文件"
                      onClick={() => onOpenArtifact(selected.id)}
                    >
                      <ExternalLink aria-hidden="true" size={14} />
                    </button>
                  )}
                  {onSaveArtifactAs && (
                    <button
                      type="button"
                      aria-label="另存生成文件"
                      onClick={() => onSaveArtifactAs(selected.id)}
                    >
                      <Download aria-hidden="true" size={14} />
                    </button>
                  )}
                </div>
              </header>
              {contentError ? (
                <p className="tool-panel__error" role="alert">
                  {contentError}
                </p>
              ) : contentLoading && !selectedContent ? (
                <p className="tool-panel__state" role="status">
                  正在读取文件内容…
                </p>
              ) : !selectedContent ? (
                <p className="tool-panel__state">内容尚未加载。</p>
              ) : selectedContent.encoding !== "utf8" ? (
                <p className="tool-panel__state">二进制文件不能在此预览，请打开或另存后查看。</p>
              ) : (
                <>
                  <pre className="tool-panel__artifact-content" tabIndex={0}>
                    {selectedContent.content}
                  </pre>
                  {progress && !progress.complete && (
                    <div className="tool-panel__chunk-footer">
                      <div
                        className="tool-panel__progress"
                        role="progressbar"
                        aria-label="文件读取进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(progress.percent)}
                      >
                        <span style={{ width: `${progress.percent}%` }} />
                      </div>
                      <button
                        type="button"
                        disabled={contentLoading}
                        onClick={() => onLoadChunk(selected.id, progress.nextOffset)}
                      >
                        继续读取
                      </button>
                    </div>
                  )}
                  {(selectedContent.truncated || (progress && !progress.complete)) && (
                    <p className="tool-panel__notice">当前仅显示已读取的分块内容。</p>
                  )}
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </section>
  );
}

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "未知大小";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function formatArtifactTimestamp(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  return new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}
