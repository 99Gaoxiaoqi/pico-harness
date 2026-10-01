import type { Message } from "@pico/core";
import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { lexer, type Token } from "marked";
import { inspectMediaBytes, MEDIA_IMAGE_MAX_BYTES, MEDIA_MAX_REFERENCES } from "@pico/core/media";
import { publishArtifactSnapshotLocked } from "./sqlite-session-workbar-repository.js";

/** Recover only embedded passive images; never read paths or fetch URLs while rebuilding history. */
export function projectInlineMessageMedia(
  database: DatabaseSync,
  sessionId: string,
  message: Message,
  existing: readonly Record<string, unknown>[],
): { message: Message; media: readonly Record<string, unknown>[] } {
  if (
    message.toolCallId !== undefined ||
    !["assistant", "user"].includes(message.role) ||
    !message.content.includes("data:image/")
  )
    return { message, media: existing };
  const media = [...existing];
  const rewrite = (raw: string, tokens: readonly Token[]): string => {
    let cursor = 0;
    let result = "";
    for (const token of tokens) {
      const span = locateToken(raw, token.raw, cursor);
      if (!span) continue;
      const { start, source } = span;
      result += raw.slice(cursor, start);
      let replacement = source;
      if (
        token.type === "image" &&
        token.href.startsWith("data:image/") &&
        token.raw.includes(token.href)
      ) {
        let source = "pico://unavailable";
        if (
          media.length < MEDIA_MAX_REFERENCES &&
          token.href.length <= Math.ceil(MEDIA_IMAGE_MAX_BYTES / 3) * 4 + 64
        ) {
          const match =
            /^data:(image\/(?:png|jpeg|gif|webp|avif));base64,([A-Za-z0-9+/]+={0,2})$/u.exec(
              token.href,
            );
          if (match) {
            const bytes = Buffer.from(match[2]!, "base64");
            const inspected = inspectMediaBytes(bytes);
            if (
              bytes.length <= MEDIA_IMAGE_MAX_BYTES &&
              bytes.toString("base64") === match[2] &&
              inspected?.kind === "image" &&
              inspected.mimeType === match[1]
            ) {
              const digest = createHash("sha256").update(bytes).digest("hex");
              const artifactId = `media:${createHash("sha256").update(`${sessionId}\0image\0${digest}`).digest("hex")}`;
              source = `pico://artifact/${encodeURIComponent(artifactId)}`;
              publishArtifactSnapshotLocked(
                database,
                {
                  sessionId,
                  artifactId,
                  title: token.text.slice(0, 256) || "回复图片",
                  mimeType: inspected.mimeType,
                  content: bytes,
                },
                digest,
                Date.now(),
              );
              if (!media.some((ref) => ref.artifactId === artifactId && ref.source === source)) {
                media.push({
                  artifactId,
                  kind: "image",
                  alt: token.text.slice(0, 2048),
                  mimeType: inspected.mimeType,
                  sizeBytes: bytes.length,
                  digest,
                  source,
                });
              }
            }
          }
        }
        replacement = span.source.replace(token.href, source);
      } else if (token.type === "list") {
        replacement = rewrite(source, token.items);
      } else if (token.type === "table") {
        replacement = rewrite(
          source,
          [...token.header, ...token.rows.flat()].flatMap((cell) => cell.tokens),
        );
      } else if ("tokens" in token && Array.isArray(token.tokens)) {
        replacement = rewrite(source, token.tokens);
      }
      result += replacement;
      cursor = start + span.source.length;
    }
    return result + raw.slice(cursor);
  };
  // Project a copy: provider replay, signed reasoning and the canonical event remain unchanged.
  return {
    message: { ...message, content: rewrite(message.content, lexer(message.content)) },
    media,
  };
}

/** marked strips quote prefixes and list continuation indent from nested token raws. */
function locateToken(
  raw: string,
  tokenRaw: string,
  cursor: number,
): { start: number; source: string } | undefined {
  const exact = raw.indexOf(tokenRaw, cursor);
  const lines = tokenRaw.split("\n");
  if (lines.length < 2 || !lines[0])
    return exact >= 0 ? { start: exact, source: tokenRaw } : undefined;
  let start = raw.indexOf(lines[0], cursor);
  while (start >= 0) {
    let end = start + lines[0]!.length;
    let matched = true;
    for (let i = 1; i < lines.length; i++) {
      if (raw[end] !== "\n") {
        matched = false;
        break;
      }
      end++;
      if (i === lines.length - 1 && lines[i] === "") break;
      while (end < raw.length && !raw.startsWith(lines[i]!, end) && /[ >\t]/u.test(raw[end]!))
        end++;
      if (!raw.startsWith(lines[i]!, end)) {
        matched = false;
        break;
      }
      end += lines[i]!.length;
    }
    if (matched) return { start, source: raw.slice(start, end) };
    start = raw.indexOf(lines[0]!, start + 1);
  }
  return undefined;
}
