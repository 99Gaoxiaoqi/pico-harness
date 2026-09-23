import type { WorkbarArtifact } from "./FilesWorkbarPanel.js";

export const ARTIFACT_TEXT_PREVIEW_BYTES = 256 * 1024;
export const ARTIFACT_IMAGE_PREVIEW_BYTES = 2 * 1024 * 1024;
export const ARTIFACT_BINARY_PREVIEW_BYTES = 16 * 1024 * 1024;
export type ArtifactPreviewKind =
  | "markdown"
  | "html"
  | "image"
  | "pdf"
  | "diff"
  | "text"
  | "unsupported";

export function artifactPreviewKind(
  artifact: Pick<WorkbarArtifact, "name" | "mimeType">,
): ArtifactPreviewKind {
  const mime = artifact.mimeType.toLowerCase().split(";", 1)[0]!.trim();
  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/pdf") return "pdf";
  if (["image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"].includes(mime))
    return "image";
  if (
    mime === "text/markdown" ||
    (mime.startsWith("text/") && /\.(md|markdown)$/i.test(artifact.name))
  )
    return "markdown";
  if (
    ["text/x-diff", "text/x-patch", "application/x-patch"].includes(mime) ||
    (mime.startsWith("text/") && /\.(diff|patch)$/i.test(artifact.name))
  )
    return "diff";
  if (
    mime.startsWith("text/") ||
    /^(application\/(json|xml|javascript)|.*\+(json|xml))$/.test(mime)
  )
    return "text";
  return "unsupported";
}

export function artifactPreviewLimit(artifact: Pick<WorkbarArtifact, "name" | "mimeType">): number {
  const kind = artifactPreviewKind(artifact);
  return kind === "image"
    ? ARTIFACT_IMAGE_PREVIEW_BYTES
    : kind === "pdf"
      ? ARTIFACT_BINARY_PREVIEW_BYTES
      : ARTIFACT_TEXT_PREVIEW_BYTES;
}

/** Only signed raster formats reach the renderer's image decoder; SVG stays inert. */
export function validateArtifactBinary(bytes: Uint8Array, mimeType: string): string | undefined {
  const mime = mimeType.toLowerCase().split(";", 1)[0]!.trim();
  const ascii = (start: number, text: string) =>
    [...text].every((c, i) => bytes[start + i] === c.charCodeAt(0));
  const valid =
    mime === "application/pdf"
      ? ascii(0, "%PDF-")
      : mime === "image/png"
        ? [137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)
        : mime === "image/jpeg"
          ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
          : mime === "image/gif"
            ? ascii(0, "GIF87a") || ascii(0, "GIF89a")
            : mime === "image/webp"
              ? ascii(0, "RIFF") && ascii(8, "WEBP")
              : mime === "image/avif"
                ? ascii(4, "ftyp") &&
                  (ascii(8, "avif") ||
                    ascii(8, "avis") ||
                    Array.from(
                      { length: Math.max(0, Math.floor(Math.min(bytes.length, 64) / 4) - 4) },
                      (_, i) => 16 + i * 4,
                    ).some((offset) => ascii(offset, "avif") || ascii(offset, "avis")))
                : false;
  return valid ? mime : undefined;
}

export function decodeArtifactBinary(base64: string): Uint8Array {
  if (
    base64.length > Math.ceil(ARTIFACT_BINARY_PREVIEW_BYTES / 3) * 4 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64)
  ) {
    throw new Error("预览内容过大或不是有效 Base64。");
  }
  const result = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  if (result.byteLength > ARTIFACT_BINARY_PREVIEW_BYTES) throw new Error("预览内容超过 16 MiB。");
  return result;
}

/** CSP precedes all artifact bytes. Electron also blocks subframe navigation/requests. */
export function artifactHtmlDocument(html: string): string {
  const policy =
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; connect-src 'none'; frame-src 'none'; object-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'";
  // WebRTC bypasses connect-src and Electron webRequest. Lock its constructors before
  // any artifact code; workers and nested realms are prohibited by the CSP above.
  const lockRtc =
    "for(const name of ['RTCPeerConnection','webkitRTCPeerConnection'])Object.defineProperty(globalThis,name,{value:undefined,writable:false,configurable:false});";
  const escapeToPreview =
    "addEventListener('keydown',event=>{if(event.key==='Escape')parent.postMessage('pico:artifact:escape','*')},true);";
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta http-equiv="x-dns-prefetch-control" content="off"><script>${lockRtc}${escapeToPreview}</script></head><body>${html}</body></html>`;
}
