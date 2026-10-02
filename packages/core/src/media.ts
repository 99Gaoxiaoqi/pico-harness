/** Durable media identities. Bytes and temporary browser URLs never belong in transcript items. */
export type RuntimeMediaReference = {
  readonly artifactId: string;
  readonly kind: "image" | "video";
  readonly alt: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly digest: string;
  /** Original Markdown destination, used only to match an already registered resource. */
  readonly source?: string;
};

/** Explicit model attachments retain the existing CLI input limit; UI previews stay smaller. */
export const MODEL_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const MEDIA_IMAGE_MAX_BYTES = 2 * 1024 * 1024;
export const MEDIA_VIDEO_MAX_BYTES = 16 * 1024 * 1024;
export const MEDIA_MAX_REFERENCES = 16;

/** Sniff only passive raster/container formats; decoder support is checked by the client. */
export function inspectMediaBytes(
  bytes: Uint8Array,
): { kind: "image" | "video"; mimeType: string } | undefined {
  const ascii = (offset: number, text: string) =>
    [...text].every((c, i) => bytes[offset + i] === c.charCodeAt(0));
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b))
    return { kind: "image", mimeType: "image/png" };
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    return { kind: "image", mimeType: "image/jpeg" };
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return { kind: "image", mimeType: "image/gif" };
  if (ascii(0, "RIFF") && ascii(8, "WEBP")) return { kind: "image", mimeType: "image/webp" };
  if (ascii(4, "ftyp")) {
    const size =
      bytes.length >= 8
        ? new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0)
        : 0;
    if (size < 16 || size > bytes.length || size > 4096) return undefined;
    const brands = [
      8,
      ...Array.from({ length: Math.floor((size - 16) / 4) }, (_, i) => 16 + i * 4),
    ];
    if (brands.some((offset) => ascii(offset, "avif") || ascii(offset, "avis")))
      return { kind: "image", mimeType: "image/avif" };
    if (
      brands.some((offset) =>
        ["isom", "iso2", "mp41", "mp42", "avc1", "M4V "].some((brand) => ascii(offset, brand)),
      )
    )
      return { kind: "video", mimeType: "video/mp4" };
  }
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    // WebM DocType element (0x4282) contains a four-byte value; don't accept arbitrary EBML.
    for (let i = 4; i < Math.min(bytes.length - 6, 4096); i++)
      if (
        bytes[i] === 0x42 &&
        bytes[i + 1] === 0x82 &&
        bytes[i + 2] === 0x84 &&
        ascii(i + 3, "webm")
      )
        return { kind: "video", mimeType: "video/webm" };
  }
  return undefined;
}

export function mediaPreviewLimit(kind: "image" | "video"): number {
  return kind === "image" ? MEDIA_IMAGE_MAX_BYTES : MEDIA_VIDEO_MAX_BYTES;
}

/**
 * Binary media embedded in prose is an output resource, not a text prompt.
 * Apply only to request text: canonical messages, signed reasoning, tool inputs,
 * and explicit multimodal attachment bytes must remain unchanged.
 */
export function projectMediaTextForModel(text: string): string {
  return text.replace(
    /data:((?:image|video)\/[a-z0-9.+-]+)(?:;[^,\s"'<>()[\]`]+)?,[a-z0-9+/=%_-]+/giu,
    (_uri, mime: string) =>
      `[${mime.toLowerCase().startsWith("image/") ? "image" : "video"} data omitted: ${mime.toLowerCase()}]`,
  );
}
