import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { lexer, walkTokens } from "marked";
import type { Message } from "@pico/core";
import type { ExecutionBoundary } from "@pico/core/permission-profile";
import {
  inspectMediaBytes,
  mediaPreviewLimit,
  MEDIA_MAX_REFERENCES,
  type RuntimeMediaReference,
} from "@pico/protocol";
import { SqliteSessionWorkbarRepository, type SessionArtifactRecord } from "@pico/storage";
import { WorkspaceRoots } from "./workspace-roots.js";

/** Drop untrusted provider metadata. Only this host may register media identities. */
export function withoutMessageMedia(message: Message): Message {
  const clean = JSON.parse(JSON.stringify(message)) as Message;
  if (clean.providerData) {
    delete clean.providerData["picoMedia"];
    if (Object.keys(clean.providerData).length === 0) delete clean.providerData;
  }
  return clean;
}

export async function prepareSessionMedia(options: {
  message: Message;
  sessionId: string;
  workDir: string;
  storageRoot: string;
  additionalDirectories: readonly string[];
  boundary?: ExecutionBoundary;
  onArtifactsChanged?: (revision: number) => void;
}): Promise<Message> {
  const message = withoutMessageMedia(options.message);
  if (message.toolCallId !== undefined || !["assistant", "user"].includes(message.role))
    return message;
  const repository = new SqliteSessionWorkbarRepository({ storageRoot: options.storageRoot });
  const initialRevision = options.onArtifactsChanged
    ? repository.queryArtifacts({ sessionId: options.sessionId }).revision
    : undefined;
  const media: RuntimeMediaReference[] = [];
  const publish = (bytes: Uint8Array, alt: string, source?: string, declaredMime?: string) => {
    const inspected = inspectMediaBytes(bytes);
    if (
      !inspected ||
      bytes.length === 0 ||
      bytes.length > mediaPreviewLimit(inspected.kind) ||
      (declaredMime !== undefined && inspected.mimeType !== declaredMime)
    )
      return;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const id = `media:${createHash("sha256").update(`${options.sessionId}\0${inspected.kind}\0${digest}`).digest("hex")}`;
    const artifact = repository.publishArtifactSnapshot({
      sessionId: options.sessionId,
      artifactId: id,
      title: source ? basename(source).slice(0, 256) : "回复图片",
      mimeType: inspected.mimeType,
      content: bytes,
    });
    if (!media.some((item) => item.artifactId === artifact.artifactId && item.source === source))
      media.push(reference(artifact, inspected.kind, alt, source));
  };
  for (const image of message.images ?? []) {
    if (media.length >= MEDIA_MAX_REFERENCES) break;
    if (
      image.type !== "image_base64" ||
      image.data.length > Math.ceil(mediaPreviewLimit("image") / 3) * 4
    )
      continue;
    try {
      const bytes = Buffer.from(image.data, "base64");
      if (bytes.toString("base64") !== image.data) continue;
      const inspected = inspectMediaBytes(bytes);
      if (inspected?.kind === "image" && inspected.mimeType === image.mimeType)
        publish(bytes, "回复图片", undefined, image.mimeType);
    } catch {
      /* A failed media item must not discard the text reply. */
    }
  }
  const targets: { source: string; alt: string }[] = [];
  walkTokens(lexer(message.content), (token) => {
    if (
      (token.type === "image" || token.type === "link") &&
      token.href.length <= 4096 &&
      (token.type === "image" ||
        /\.(mp4|webm)$/iu.test(token.href) ||
        token.href.startsWith("pico://artifact/"))
    ) {
      targets.push({ source: token.href, alt: token.text });
    }
  });
  let roots: WorkspaceRoots | undefined;
  for (const target of targets) {
    if (media.length >= MEDIA_MAX_REFERENCES) break;
    if (media.some((item) => item.source === target.source)) continue;
    try {
      const uri = /^pico:\/\/artifact\/([^/?#]+)$/u.exec(target.source);
      if (uri) {
        const artifactId = decodeURIComponent(uri[1]!);
        if (artifactId.length > 256) continue;
        const artifact = repository.queryArtifacts({ sessionId: options.sessionId, artifactId })
          .artifacts[0]!;
        if (artifact.sizeBytes > 16 * 1024 * 1024) continue;
        const header = repository.readArtifactChunk({
          sessionId: options.sessionId,
          artifactId,
          limitBytes: 4096,
        });
        const inspected = inspectMediaBytes(Buffer.from(header.contentBase64, "base64"));
        if (
          !inspected ||
          inspected.mimeType !== artifact.mimeType ||
          artifact.sizeBytes > mediaPreviewLimit(inspected.kind)
        )
          continue;
        media.push(reference(artifact, inspected.kind, target.alt, target.source));
        continue;
      }
      // No file:, network URL or protocol-relative URL becomes a filesystem request.
      if (/^[a-z][a-z0-9+.-]*:/iu.test(target.source) || target.source.startsWith("//")) continue;
      roots ??= await WorkspaceRoots.create(options.workDir, options.additionalDirectories);
      if (options.boundary?.kind === "managed")
        roots.replaceBoundaryProfile(options.boundary.profile);
      const path = await roots.assertAllowed(target.source, {
        consumeAuthorization: false,
        access: "read",
      });
      const canonical = await realpath(path);
      const allowedRoots = roots.list();
      if (!allowedRoots.some((root) => within(root, canonical))) continue;
      const file = await open(
        canonical,
        constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
      );
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size <= 0 || before.size > mediaPreviewLimit("video"))
          continue;
        if ((await realpath(path)) !== canonical) continue;
        const current = await stat(canonical);
        if (current.dev !== before.dev || current.ino !== before.ino) continue;
        const header = Buffer.alloc(Math.min(4096, before.size));
        const headerRead = await file.read(header, 0, header.length, 0);
        const inspected = inspectMediaBytes(header.subarray(0, headerRead.bytesRead));
        if (!inspected || before.size > mediaPreviewLimit(inspected.kind)) continue;
        const bytes = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const read = await file.read(bytes, offset, bytes.length - offset, offset);
          if (read.bytesRead === 0) break;
          offset += read.bytesRead;
        }
        const after = await file.stat();
        if (
          offset !== bytes.length ||
          after.size !== before.size ||
          after.mtimeMs !== before.mtimeMs ||
          after.ctimeMs !== before.ctimeMs ||
          (await realpath(path)) !== canonical
        )
          continue;
        publish(bytes, target.alt, target.source);
      } finally {
        await file.close();
      }
    } catch {
      /* Preserve an inert Markdown placeholder for missing/unauthorized media. */
    }
  }
  if (initialRevision !== undefined) {
    const revision = repository.queryArtifacts({ sessionId: options.sessionId }).revision;
    if (revision !== initialRevision) {
      try {
        options.onArtifactsChanged?.(revision);
      } catch {
        /* Notification failure does not undo durable media. */
      }
    }
  }
  return media.length > 0
    ? { ...message, providerData: { ...message.providerData, picoMedia: media } }
    : message;
}

function within(root: string, path: string): boolean {
  const rel = relative(resolve(root), path);
  return !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
}
function reference(
  artifact: SessionArtifactRecord,
  kind: RuntimeMediaReference["kind"],
  alt: string,
  source?: string,
): RuntimeMediaReference {
  return {
    artifactId: artifact.artifactId,
    kind,
    alt: alt.slice(0, 2048),
    mimeType: artifact.mimeType,
    sizeBytes: artifact.sizeBytes,
    digest: artifact.digest,
    ...(source !== undefined ? { source } : {}),
  };
}
