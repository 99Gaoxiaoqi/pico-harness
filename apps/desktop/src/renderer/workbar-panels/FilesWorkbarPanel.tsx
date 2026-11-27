import { DropdownMenu, DropdownMenuItem } from "@astryxdesign/core/DropdownMenu";
import { IconButton, Button } from "../components.js";
import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  CircleAlert,
  Download,
  ExternalLink,
  File,
  FileText,
  MoreHorizontal,
  RefreshCw,
} from "lucide-react";
import { ArtifactPreview } from "./ArtifactPreview.js";
import { artifactPreviewKind, artifactPreviewLimit } from "./artifact-preview-model.js";
import { copyDiagnostic } from "../diagnostic-copy.js";
import { isMacPlatform, isWindowsPlatform } from "../platform.js";

/**
 * Failure row for the files panel: user copy, a visible retry action, and the
 * raw details only behind an explicit diagnostic copy (UX-09 / UX-20).
 */
function PanelErrorRow({
  message,
  diagnostic,
  onRetry,
}: {
  readonly message: string;
  readonly diagnostic?: string | null;
  readonly onRetry?: (() => void) | undefined;
}) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  return (
    <div className="tool-panel__error" role="alert">
      <CircleAlert aria-hidden="true" size={14} />
      <span className="tool-panel__error-message">{message}</span>
      {(onRetry || diagnostic) && (
        <span className="tool-panel__error-actions">
          {onRetry && (
            <Button variant="quiet" type="button" onClick={onRetry}>
              重试
            </Button>
          )}
          {diagnostic && (
            <Button
              variant="quiet"
              type="button"
              onClick={() => {
                void copyDiagnostic(diagnostic).then(
                  () => setCopyState("copied"),
                  () => setCopyState("failed"),
                );
              }}
            >
              {copyState === "copied"
                ? "已复制诊断"
                : copyState === "failed"
                  ? "复制失败 · 重试"
                  : "复制诊断"}
            </Button>
          )}
        </span>
      )}
    </div>
  );
}

/** Cross-platform wording: macOS says Finder, Windows says File Explorer. */
export function revealArtifactLabel(): string {
  if (isWindowsPlatform()) return "在文件资源管理器中显示";
  if (isMacPlatform()) return "在访达中显示";
  return "打开所在文件夹";
}

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
  readonly errorDiagnostic?: string | null;
  readonly contentError?: string | null;
  readonly contentDiagnostic?: string | null;
  readonly notice?: string | null;
  readonly onRefresh: () => void;
  readonly onRetryError?: () => void;
  readonly onRetryContent?: () => void;
  readonly onSelectArtifact: (artifactId: string) => void;
  readonly onBack: () => void;
  readonly onLoadChunk: (artifactId: string, offset: number) => void;
  readonly onOpenArtifact?: (artifactId: string) => void;
  readonly onOpenDefaultApp?: (artifactId: string) => void;
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
  errorDiagnostic,
  contentError,
  contentDiagnostic,
  notice,
  onRefresh,
  onRetryError,
  onRetryContent,
  onSelectArtifact,
  onBack,
  onLoadChunk,
  onOpenArtifact,
  onOpenDefaultApp,
  onSaveArtifactAs,
}: FilesWorkbarPanelProps) {
  const selected = artifacts.find((artifact) => artifact.id === selectedArtifactId);
  const selectedContent = content?.artifactId === selected?.id ? content : undefined;
  const progress = selectedContent ? artifactChunkProgress(selectedContent) : undefined;
  const backRef = useRef<HTMLButtonElement>(null);
  const refreshRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const previousSelectionRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (selected) {
      backRef.current?.focus();
    } else if (previousSelectionRef.current) {
      const previous = previousSelectionRef.current;
      (
        Array.from(listRef.current?.querySelectorAll<HTMLButtonElement>("li > button") ?? []).find(
          (button) => button.dataset.artifactId === previous,
        ) ??
        listRef.current?.querySelector<HTMLButtonElement>("li > button") ??
        refreshRef.current
      )?.focus();
    }
    previousSelectionRef.current = selected?.id;
  }, [selected?.id]);

  return (
    <section className="tool-panel tool-panel--files" aria-label="生成文件">
      <header className="tool-panel__header">
        <div>
          <span className="tool-panel__eyebrow">Session Artifacts</span>
          <strong>生成文件</strong>
        </div>
        <IconButton
          label="刷新生成文件"
          ref={refreshRef}
          type="button"
          className="tool-panel__icon-button"
          aria-label="刷新生成文件"
          disabled={loading}
          onClick={onRefresh}
        >
          <RefreshCw aria-hidden="true" size={15} />
        </IconButton>
      </header>

      {error && (
        <PanelErrorRow
          key={`list:${errorDiagnostic ?? error}`}
          message={error}
          diagnostic={errorDiagnostic}
          onRetry={onRetryError}
        />
      )}

      {selected ? (
        <div
          className="tool-panel__preview-page"
          aria-busy={contentLoading}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              onBack();
            }
          }}
        >
          <section className="tool-panel__artifact" aria-label={`${selected.name} 内容`}>
            <header>
              <Button
                variant="quiet"
                ref={backRef}
                type="button"
                className="tool-panel__back"
                onClick={onBack}
                aria-label="返回生成文件列表"
              >
                <ArrowLeft aria-hidden="true" size={16} />
                返回
              </Button>
              <div className="tool-panel__artifact-title">
                <strong title={selected.name}>{selected.name}</strong>
                <span>
                  {selected.mimeType} · {formatBytes(selected.size)}
                </span>
              </div>
              {(onOpenArtifact ||
                onSaveArtifactAs ||
                (artifactPreviewKind(selected) === "html" && onOpenDefaultApp)) && (
                <div className="pico-artifact-menu">
                  <DropdownMenu
                    className="pico-artifact-actions-menu"
                    button={{
                      label: "生成文件操作",
                      isIconOnly: true,
                      icon: <MoreHorizontal aria-hidden="true" size={16} />,
                      variant: "ghost",
                      size: "sm",
                    }}
                    hasChevron={false}
                    alignment="end"
                  >
                    {artifactPreviewKind(selected) === "html" && onOpenDefaultApp && (
                      <DropdownMenuItem
                        label="用默认应用打开"
                        onClick={() => onOpenDefaultApp(selected.id)}
                      />
                    )}
                    {onOpenArtifact && (
                      <DropdownMenuItem
                        label={revealArtifactLabel()}
                        icon={<ExternalLink aria-hidden="true" size={14} />}
                        onClick={() => onOpenArtifact(selected.id)}
                      />
                    )}
                    {onSaveArtifactAs && (
                      <DropdownMenuItem
                        label="另存生成文件"
                        icon={<Download aria-hidden="true" size={14} />}
                        onClick={() => onSaveArtifactAs(selected.id)}
                      />
                    )}
                  </DropdownMenu>
                </div>
              )}
            </header>
            {contentError ? (
              <PanelErrorRow
                key={`content:${contentDiagnostic ?? contentError}`}
                message={contentError}
                diagnostic={contentDiagnostic}
                onRetry={onRetryContent}
              />
            ) : contentLoading && !selectedContent ? (
              <p className="tool-panel__state" role="status">
                正在读取文件内容…
              </p>
            ) : !selectedContent ? (
              <p className="tool-panel__state">内容尚未加载。</p>
            ) : (
              <>
                <ArtifactPreview
                  key={selected.id}
                  artifact={selected}
                  content={selectedContent}
                  onEscape={onBack}
                  onSave={onSaveArtifactAs ? () => onSaveArtifactAs(selected.id) : undefined}
                />
                {progress &&
                  !progress.complete &&
                  progress.nextOffset < artifactPreviewLimit(selected) && (
                    <div className="tool-panel__chunk-footer">
                      <div
                        className="tool-panel__progress"
                        role="progressbar"
                        aria-label="文件读取进度"
                        aria-valuemin={0}
                        aria-valuemax={100}
                        aria-valuenow={Math.round(progress.percent)}
                      >
                        <span style={{ transform: `scaleX(${progress.percent / 100})` }} />
                      </div>
                      <Button
                        variant="quiet"
                        type="button"
                        disabled={contentLoading}
                        onClick={() => onLoadChunk(selected.id, progress.nextOffset)}
                      >
                        继续读取
                      </Button>
                    </div>
                  )}
                {(selectedContent.truncated || (progress && !progress.complete)) && (
                  <p className="tool-panel__notice">
                    {selectedContent.nextOffset >= artifactPreviewLimit(selected)
                      ? "已达到内嵌预览上限，请另存后查看完整文件。"
                      : "当前仅显示已读取的分块内容。"}
                  </p>
                )}
              </>
            )}
          </section>
        </div>
      ) : (
        <div
          ref={listRef}
          className="tool-panel__files-list-page"
          aria-label="产物列表"
          aria-busy={loading}
        >
          {notice && (
            <p className="tool-panel__notice" role="status">
              {notice}
            </p>
          )}
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
                  <Button
                    variant="quiet"
                    type="button"
                    data-artifact-id={artifact.id}
                    onClick={() => onSelectArtifact(artifact.id)}
                  >
                    <FileText aria-hidden="true" size={15} />
                    <span>
                      <strong title={artifact.name}>{artifact.name}</strong>
                      <small>
                        {formatBytes(artifact.size)} · {formatArtifactTimestamp(artifact.createdAt)}
                      </small>
                      {artifactPreviewKind(artifact) === "html" && (
                        <small className="tool-panel__artifact-hint">在 Pico 中查看</small>
                      )}
                    </span>
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
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
