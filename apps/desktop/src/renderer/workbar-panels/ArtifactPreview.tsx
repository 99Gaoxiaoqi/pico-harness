import { useEffect, useMemo, useState } from "react";
import { MarkdownText } from "../conversation/MarkdownText.js";
import type { WorkbarArtifact, WorkbarArtifactContent } from "./FilesWorkbarPanel.js";
import {
  artifactHtmlDocument,
  artifactPreviewKind,
  artifactPreviewLimit,
  decodeArtifactBinary,
  validateArtifactBinary,
} from "./artifact-preview-model.js";

export function ArtifactPreview({
  artifact,
  content,
}: {
  artifact: WorkbarArtifact;
  content: WorkbarArtifactContent;
}) {
  const kind = artifactPreviewKind(artifact);
  const [source, setSource] = useState(false);
  const html = useMemo(
    () => (kind === "html" && content.complete ? artifactHtmlDocument(content.content) : ""),
    [kind, content.content, content.complete],
  );
  if (kind === "unsupported")
    return <p className="tool-panel__state">此文件格式不支持内嵌预览，请打开或另存后查看。</p>;
  if (kind === "image" || kind === "pdf")
    return <BinaryPreview artifact={artifact} content={content} />;
  return (
    <div className="artifact-preview">
      {(kind === "markdown" || kind === "html") && (
        <div className="artifact-preview__toolbar" role="group" aria-label="预览模式">
          <button type="button" aria-pressed={!source} onClick={() => setSource(false)}>
            预览
          </button>
          <button type="button" aria-pressed={source} onClick={() => setSource(true)}>
            源码
          </button>
        </div>
      )}
      {kind === "html" && !source ? (
        content.complete ? (
          <>
            <p className="tool-panel__notice">
              隔离预览：支持内联脚本，外链、联网和文件访问已禁用。
            </p>
            <iframe
              className="artifact-preview__frame"
              title={`${artifact.name} HTML 预览`}
              sandbox="allow-scripts"
              referrerPolicy="no-referrer"
              srcDoc={html}
            />
          </>
        ) : (
          <p className="tool-panel__notice">HTML 需要完整内容才能预览，请继续读取或另存后查看。</p>
        )
      ) : kind === "markdown" && !source ? (
        <MarkdownText text={content.content} />
      ) : kind === "diff" ? (
        <pre className="tool-panel__artifact-content artifact-preview__diff" tabIndex={0}>
          {content.content.split("\n").map((line, index) => (
            <span
              key={index}
              className={
                line.startsWith("+")
                  ? "artifact-preview__added"
                  : line.startsWith("-")
                    ? "artifact-preview__removed"
                    : line.startsWith("@@")
                      ? "artifact-preview__hunk"
                      : undefined
              }
            >
              {line}
              {"\n"}
            </span>
          ))}
        </pre>
      ) : (
        <pre className="tool-panel__artifact-content" tabIndex={0}>
          {content.content}
        </pre>
      )}
    </div>
  );
}

function BinaryPreview({
  artifact,
  content,
}: {
  artifact: WorkbarArtifact;
  content: WorkbarArtifactContent;
}) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    setError(undefined);
    if (!content.complete || content.encoding !== "base64") return;
    let objectUrl: string | undefined;
    try {
      const bytes = decodeArtifactBinary(content.content);
      if (bytes.length > artifactPreviewLimit(artifact))
        throw new Error("文件内容超过内嵌预览上限。");
      const mime = validateArtifactBinary(bytes, artifact.mimeType);
      if (!mime) throw new Error("文件内容与声明格式不符，已拒绝预览。");
      objectUrl = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: mime }));
      setUrl(objectUrl);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法预览文件。");
    }
    return () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.id, artifact.mimeType, content.content, content.complete, content.encoding]);
  if (error)
    return (
      <p className="tool-panel__error" role="alert">
        {error}
      </p>
    );
  if (!content.complete) return <p className="tool-panel__notice">正在读取预览内容…</p>;
  if (!url) return <p className="tool-panel__state">正在准备预览…</p>;
  return artifactPreviewKind(artifact) === "pdf" ? (
    <>
      <embed
        className="artifact-preview__frame"
        type="application/pdf"
        src={url}
        title={`${artifact.name} PDF 预览`}
      />
      <p className="tool-panel__notice">若 PDF 预览不可用，请另存后查看。</p>
    </>
  ) : (
    <img
      className="artifact-preview__image"
      src={url}
      alt={artifact.name}
      onError={() => setError("图片解码失败，请另存后查看。")}
    />
  );
}
