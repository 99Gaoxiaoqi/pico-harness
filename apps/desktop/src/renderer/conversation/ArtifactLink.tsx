import { Download } from "lucide-react";
import { useState, type ReactNode } from "react";
import { InlineHtmlArtifactPreview } from "./InlineHtmlArtifactPreview.js";
import { useMediaScope } from "./MediaPreview.js";

export function artifactLinkId(href: string): string | undefined {
  const match = /^pico:\/\/artifact\/([A-Za-z0-9_-]{1,512})$/u.exec(href);
  return match?.[1];
}

/** Artifact operations are bound to this transcript's session and verified by the native bridge. */
export function ArtifactLink({
  artifactId,
  children,
  previewHtml = false,
}: {
  readonly artifactId: string;
  readonly children: ReactNode;
  readonly previewHtml?: boolean;
}) {
  const scope = useMediaScope();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  if (!scope) return <span>{children}</span>;
  const open = async (action: "open" | "saveAs") => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await window.pico.artifacts[action]({ ...scope, artifactId });
      if (!result.ok) setError(result.error.message);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "无法打开附件，请重试。");
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="conversation-artifact-link">
      <button type="button" disabled={busy} onClick={() => void open("open")}>
        {children}
      </button>
      <button
        type="button"
        disabled={busy}
        aria-label="另存附件"
        title="另存附件"
        onClick={() => void open("saveAs")}
      >
        <Download aria-hidden="true" />
      </button>
      {previewHtml && <InlineHtmlArtifactPreview artifactId={artifactId} scope={scope} />}
      {error && <span role="alert">{error}</span>}
    </span>
  );
}
