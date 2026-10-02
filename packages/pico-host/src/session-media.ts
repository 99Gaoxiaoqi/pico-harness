import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { lexer, walkTokens } from "marked";
import type { ImagePart, Message } from "@pico/core";
import {
  rewriteSavedAiSdkMedia,
  isSavedAiSdkProjectionCurrent,
} from "./provider/ai-sdk-messages.js";
import { projectMediaTextForModel, MODEL_IMAGE_MAX_BYTES } from "@pico/core/media";
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
    delete clean.providerData["picoMediaInputHash"];
    if (Object.keys(clean.providerData).length === 0) delete clean.providerData;
  }
  return clean;
}

export function messageMediaInputHash(message: Message): string {
  return createHash("sha256")
    .update(JSON.stringify(withoutMessageMedia(message)))
    .digest("hex");
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
  const inputHash = messageMediaInputHash(message);
  const replayWasValid = isSavedAiSdkProjectionCurrent(message);
  if (message.toolCallId !== undefined || !["assistant", "user"].includes(message.role))
    return message;
  const repository = new SqliteSessionWorkbarRepository({ storageRoot: options.storageRoot });
  const initialRevision = options.onArtifactsChanged
    ? repository.queryArtifacts({ sessionId: options.sessionId }).revision
    : undefined;
  const media: RuntimeMediaReference[] = [];
  const publish = (
    bytes: Uint8Array,
    alt: string,
    source?: string,
    declaredMime?: string,
    explicitImage = false,
  ) => {
    const inspected = inspectMediaBytes(bytes);
    if (
      !inspected ||
      bytes.length === 0 ||
      bytes.length >
        (explicitImage && inspected.kind === "image"
          ? MODEL_IMAGE_MAX_BYTES
          : mediaPreviewLimit(inspected.kind)) ||
      (declaredMime !== undefined && inspected.mimeType !== declaredMime)
    )
      return undefined;
    const digest = createHash("sha256").update(bytes).digest("hex");
    const id = `media:${createHash("sha256").update(`${options.sessionId}\0${inspected.kind}\0${digest}`).digest("hex")}`;
    const artifact = repository.publishArtifactSnapshot({
      sessionId: options.sessionId,
      artifactId: id,
      title: source ? basename(source).slice(0, 256) : "回复图片",
      mimeType: inspected.mimeType,
      content: bytes,
    });
    const existing = media.findIndex((item) => item.artifactId === artifact.artifactId);
    if (existing < 0) media.push(reference(artifact, inspected.kind, alt, source));
    else if (source && !media[existing]!.source)
      media[existing] = reference(artifact, inspected.kind, alt, source);
    return reference(artifact, inspected.kind, alt, source);
  };
  const artifactUri = (id: string) => `pico://artifact/${encodeURIComponent(id)}`;
  const toImage = (ref: RuntimeMediaReference): Extract<ImagePart, { type: "image_artifact" }> => ({
    type: "image_artifact",
    artifactId: ref.artifactId,
    mimeType: ref.mimeType,
    sizeBytes: ref.sizeBytes,
    digest: ref.digest,
  });
  const persistInline = (
    data: string,
    mimeType: string,
    source?: string,
    explicitImage = false,
  ) => {
    const kind = mimeType.startsWith("video/") ? "video" : "image";
    if (
      data.length >
        Math.ceil(
          (explicitImage && kind === "image" ? MODEL_IMAGE_MAX_BYTES : mediaPreviewLimit(kind)) / 3,
        ) *
          4 ||
      media.length >= MEDIA_MAX_REFERENCES
    )
      return undefined;
    const bytes = Buffer.from(data, "base64");
    if (bytes.toString("base64") !== data) return undefined;
    return publish(bytes, kind === "image" ? "图片" : "视频", source, mimeType, explicitImage);
  };
  const rewriteText = (text: string): string =>
    text.replace(
      /data:((?:image|video)\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)/giu,
      (uri, mime: string, data: string) => {
        try {
          const ref = persistInline(data, mime.toLowerCase());
          return ref ? artifactUri(ref.artifactId) : projectMediaTextForModel(uri);
        } catch {
          return projectMediaTextForModel(uri);
        }
      },
    );
  const images: ImagePart[] = [];
  for (const image of message.images ?? []) {
    try {
      if (image.type === "image_artifact") {
        const artifact = repository.queryArtifacts({
          sessionId: options.sessionId,
          artifactId: image.artifactId,
        }).artifacts[0]!;
        if (
          artifact.mimeType !== image.mimeType ||
          artifact.sizeBytes !== image.sizeBytes ||
          artifact.digest !== image.digest
        )
          continue;
        media.push(reference(artifact, "image", "图片"));
        images.push(image);
      } else if (image.type === "image_base64") {
        const ref = persistInline(image.data, image.mimeType, undefined, true);
        if (ref?.kind === "image") images.push(toImage(ref));
      } else if (image.url.startsWith("data:")) {
        const match = /^data:(image\/[a-z0-9.+-]+);base64,([a-z0-9+/=]+)$/iu.exec(image.url);
        const ref = match
          ? persistInline(match[2]!, match[1]!.toLowerCase(), undefined, true)
          : undefined;
        if (ref?.kind === "image") images.push(toImage(ref));
      } else images.push(image);
    } catch {
      /* Invalid or unauthorized attachments stay out of durable media. */
    }
  }
  if (options.message.images?.length && !images.length && !message.content)
    message.content = "媒体无法预览";
  const originalContent = message.content;
  message.content = rewriteText(message.content);
  message.images = images;
  if (!images.length) delete message.images;
  rewriteSavedAiSdkMedia(
    message,
    rewriteText,
    (data, mimeType) => {
      if (typeof data !== "string") return undefined;
      if (data.startsWith("pico://artifact/")) return data;
      const ref = persistInline(data, mimeType, undefined, true);
      return ref ? artifactUri(ref.artifactId) : undefined;
    },
    replayWasValid,
  );
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
    if (
      media.some(
        (item) => item.source === target.source || artifactUri(item.artifactId) === target.source,
      )
    )
      continue;
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
  if (images.length) message.images = images;
  rewriteSavedAiSdkMedia(
    message,
    (text) => text,
    (data) => (typeof data === "string" ? data : undefined),
    replayWasValid,
  );
  if (originalContent !== message.content) {
    for (let index = 0; index < media.length; index++) {
      const item = media[index]!;
      if (!item.source) media[index] = { ...item, source: artifactUri(item.artifactId) };
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
    ? {
        ...message,
        providerData: { ...message.providerData, picoMedia: media, picoMediaInputHash: inputHash },
      }
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

type ArtifactImage = Extract<ImagePart, { type: "image_artifact" }>;

/** Resolve only records owned by the requesting Session, including its validated fork clones. */
function ownedImage(
  repository: SqliteSessionWorkbarRepository,
  sessionId: string,
  image: ArtifactImage,
): SessionArtifactRecord | undefined {
  const matches = (artifact: SessionArtifactRecord) =>
    artifact.mimeType === image.mimeType &&
    artifact.sizeBytes === image.sizeBytes &&
    artifact.digest === image.digest;
  try {
    const exact = repository.queryArtifacts({ sessionId, artifactId: image.artifactId })
      .artifacts[0];
    if (exact && matches(exact)) return exact;
  } catch {
    /* A fork has its own ID for inherited bytes. */
  }
  let cursor: string | undefined;
  do {
    const page = repository.queryArtifacts({
      sessionId,
      limit: 200,
      ...(cursor ? { cursor } : {}),
    });
    const match = page.artifacts.find(matches);
    if (match) return match;
    cursor = page.nextCursor;
  } while (cursor);
  return undefined;
}

/** Request-time hydration validates the complete immutable bytes, never untrusted provider metadata. */
export function readSessionImageArtifact(
  storageRoot: string,
  sessionId: string,
  image: ArtifactImage,
): string | undefined {
  if (
    !Number.isSafeInteger(image.sizeBytes) ||
    image.sizeBytes <= 0 ||
    image.sizeBytes > MODEL_IMAGE_MAX_BYTES
  )
    return undefined;
  const repository = new SqliteSessionWorkbarRepository({ storageRoot });
  const artifact = ownedImage(repository, sessionId, image);
  if (!artifact) return undefined;
  const chunks: Buffer[] = [];
  let offset = 0;
  while (offset < image.sizeBytes) {
    const chunk = repository.readArtifactChunk({
      sessionId,
      artifactId: artifact.artifactId,
      offsetBytes: offset,
      limitBytes: Math.min(32 * 1024, image.sizeBytes - offset),
    });
    const bytes = Buffer.from(chunk.contentBase64, "base64");
    if (
      chunk.totalBytes !== image.sizeBytes ||
      chunk.artifact.digest !== image.digest ||
      chunk.offsetBytes !== offset ||
      chunk.endOffsetBytes !== offset + bytes.length ||
      bytes.length === 0 ||
      chunk.endOffsetBytes > image.sizeBytes
    )
      return undefined;
    chunks.push(bytes);
    offset = chunk.endOffsetBytes;
  }
  const bytes = Buffer.concat(chunks);
  const inspected = inspectMediaBytes(bytes);
  if (
    bytes.length !== image.sizeBytes ||
    inspected?.kind !== "image" ||
    inspected.mimeType !== image.mimeType ||
    createHash("sha256").update(bytes).digest("hex") !== image.digest
  )
    return undefined;
  return bytes.toString("base64");
}

/** Disposable model history follows current-session fork clones without rewriting canonical events. */
export function resolveSessionMediaReferences(
  storageRoot: string,
  sessionId: string,
  message: Message,
): Message {
  if (!message.images?.some((image) => image.type === "image_artifact")) return message;
  const repository = new SqliteSessionWorkbarRepository({ storageRoot });
  const replacements = new Map<string, string>();
  const images = message.images.map((image) => {
    if (image.type !== "image_artifact") return image;
    const artifact = ownedImage(repository, sessionId, image);
    if (!artifact || artifact.artifactId === image.artifactId) return image;
    replacements.set(image.artifactId, artifact.artifactId);
    return { ...image, artifactId: artifact.artifactId };
  });
  if (!replacements.size) return message;
  const replayWasValid = isSavedAiSdkProjectionCurrent(message);
  const projected = structuredClone({ ...message, images });
  const replace = (text: string) =>
    text.replace(/pico:\/\/artifact\/([^/?#\s)]+)/gu, (uri, id: string) => {
      const replacement = replacements.get(decodeURIComponent(id));
      return replacement ? `pico://artifact/${encodeURIComponent(replacement)}` : uri;
    });
  projected.content = replace(projected.content);
  rewriteSavedAiSdkMedia(
    projected,
    replace,
    (data) => (typeof data === "string" ? replace(data) : undefined),
    replayWasValid,
  );
  return projected;
}
