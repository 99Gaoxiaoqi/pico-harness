import { Directory, File, FileMode, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RemoteRuntimeClient } from "@pico/remote-client";
import {
  isJsonObject,
  type RuntimeMediaReference,
  type RuntimeSessionArtifact,
} from "@pico/protocol/mobile";
import { assertArtifactIntegrity, decodedBase64Size } from "./core";
import { verifyMediaIntegrity } from "./media";

const legacyCache = new Directory(Paths.cache, "pico-artifacts");
const cache = new Directory(Paths.cache, "pico-artifacts-v2");
let cacheEpoch = 0;
let clearingAll = false;
let clearAllPromise: Promise<void> | undefined;
const hostEpochs = new Map<string, number>();
const clearingHosts = new Set<string>();
const downloads = new Map<AbortController, { hostId: string; done: Promise<void> }>();
const hostDirectory = (hostId: string) =>
  new Directory(cache, bytesToHex(sha256(new TextEncoder().encode(hostId))));

function decodeChunk(value: string): Uint8Array {
  const bytes = new Uint8Array(decodedBase64Size(value));
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  let position = 0;
  for (let i = 0; i < value.length; i += 4) {
    const a = alphabet.indexOf(value[i]!);
    const b = alphabet.indexOf(value[i + 1]!);
    const c = value[i + 2] === "=" ? 0 : alphabet.indexOf(value[i + 2]!);
    const d = value[i + 3] === "=" ? 0 : alphabet.indexOf(value[i + 3]!);
    if ((value[i + 2] === "=" && b & 15) || (value[i + 3] === "=" && value[i + 2] !== "=" && c & 3))
      throw new Error("文件分块编码无效");
    const bits = (a << 18) | (b << 12) | (c << 6) | d;
    if (position < bytes.length) bytes[position++] = bits >>> 16;
    if (position < bytes.length) bytes[position++] = (bits >>> 8) & 255;
    if (position < bytes.length) bytes[position++] = bits & 255;
  }
  return bytes;
}

export function hasLegacyArtifactCache() {
  return legacyCache.exists && legacyCache.list().length > 0;
}
export function clearLegacyArtifactCache() {
  if (legacyCache.exists) legacyCache.delete();
}
export async function clearHostArtifactCache(hostId: string) {
  clearingHosts.add(hostId);
  hostEpochs.set(hostId, (hostEpochs.get(hostId) ?? 0) + 1);
  try {
    const pending: Promise<void>[] = [];
    for (const [controller, download] of downloads) {
      if (download.hostId !== hostId) continue;
      controller.abort();
      pending.push(download.done);
    }
    // Delete after native downloads drain, so late writes cannot recreate a removed file.
    await Promise.all(pending);
    const directory = hostDirectory(hostId);
    if (directory.exists) directory.delete();
  } finally {
    clearingHosts.delete(hostId);
  }
}

export async function clearArtifactCache() {
  if (clearAllPromise) return clearAllPromise;
  clearingAll = true;
  cacheEpoch++;
  clearAllPromise = (async () => {
    try {
      const pending = [...downloads];
      for (const [controller] of pending) controller.abort();
      await Promise.all(pending.map(([, download]) => download.done));
      if (cache.exists) cache.delete();
      clearLegacyArtifactCache();
    } finally {
      clearingAll = false;
      clearAllPromise = undefined;
    }
  })();
  return clearAllPromise;
}

export async function downloadArtifact(options: {
  client: RemoteRuntimeClient;
  scopeId: string;
  workspaceId: string;
  sessionId: string;
  artifact: RuntimeSessionArtifact;
  media?: RuntimeMediaReference;
  signal?: AbortSignal;
  assertCurrent: () => void;
  onProgress?: (message: string) => void;
}): Promise<File> {
  const { artifact, signal, media, assertCurrent, onProgress } = options;
  const epoch = cacheEpoch;
  const hostEpoch = hostEpochs.get(options.scopeId) ?? 0;
  if (clearingAll) throw new Error("手机成果缓存正在清理");
  if (clearingHosts.has(options.scopeId)) throw new Error("这台电脑的成果缓存正在清理");
  let finishDownload!: () => void;
  const done = new Promise<void>((resolve) => {
    finishDownload = resolve;
  });
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  downloads.set(controller, { hostId: options.scopeId, done });
  const check = () => {
    if (
      epoch !== cacheEpoch ||
      hostEpoch !== (hostEpochs.get(options.scopeId) ?? 0) ||
      signal?.aborted ||
      controller.signal.aborted
    )
      throw new Error("媒体读取已取消");
    assertCurrent();
  };
  let partial: File | undefined;
  try {
    check();
    const identity = await Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      JSON.stringify([
        options.scopeId,
        options.workspaceId,
        options.sessionId,
        artifact.artifactId,
        artifact.digest,
        artifact.mimeType,
        artifact.sizeBytes,
      ]),
    );
    check();
    const hostCache = hostDirectory(options.scopeId);
    hostCache.create({ idempotent: true, intermediates: true });
    const resourceCache = new Directory(hostCache, identity);
    resourceCache.create({ idempotent: true });
    const title = artifact.title.replace(/[^\p{L}\p{N}._-]/gu, "_").slice(-100) || "media";
    const extension = {
      "image/png": ".png",
      "image/jpeg": ".jpg",
      "image/gif": ".gif",
      "image/webp": ".webp",
      "image/avif": ".avif",
      "video/mp4": ".mp4",
      "video/webm": ".webm",
    }[artifact.mimeType];
    // iOS sharing infers the content type from the filename; artifact titles may
    // have no suffix even when the verified payload is a valid image or video.
    const name = extension && !title.toLowerCase().endsWith(extension) ? title + extension : title;
    const target = new File(resourceCache, name);
    const validate = async (file: File) => {
      check();
      if (file.size !== artifact.sizeBytes) throw new Error("文件大小校验失败");
      const hash = sha256.create();
      const handle = file.open();
      let size = 0;
      let prefix = new Uint8Array();
      try {
        while (size < artifact.sizeBytes) {
          check();
          const bytes = handle.readBytes(Math.min(64 * 1024, artifact.sizeBytes - size));
          if (!bytes.length) throw new Error("文件读取提前结束");
          if (size === 0) prefix = bytes.slice(0, 4096);
          hash.update(bytes);
          size += bytes.length;
          // Yield a native frame while hashing larger media so input remains responsive.
          if (size % (1024 * 1024) === 0)
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      } finally {
        handle.close();
      }
      check();
      const digest = bytesToHex(hash.digest());
      if (media) verifyMediaIntegrity(media, size, digest, prefix);
      else assertArtifactIntegrity(artifact, size, digest);
    };
    if (target.exists) {
      try {
        await validate(target);
        return target;
      } catch (_error) {
        check();
        target.delete();
      }
    }
    partial = new File(hostCache, `${Crypto.randomUUID()}.partial`);
    onProgress?.("加载中…");
    if (options.client.isRelay) {
      partial.create();
      const handle = partial.open(FileMode.WriteOnly);
      try {
        let offset = 0;
        while (offset < artifact.sizeBytes) {
          check();
          const chunk = await options.client.request(
            "session.artifacts.query",
            {
              sessionId: options.sessionId,
              artifactId: artifact.artifactId,
              action: "read_chunk",
              offsetBytes: offset,
              limitBytes: 32 * 1024,
            },
            { workspaceId: options.workspaceId },
          );
          check();
          const metadata = chunk.artifact;
          if (
            !isJsonObject(metadata) ||
            metadata.artifactId !== artifact.artifactId ||
            metadata.digest !== artifact.digest ||
            metadata.sizeBytes !== artifact.sizeBytes ||
            metadata.mimeType !== artifact.mimeType ||
            chunk.totalBytes !== artifact.sizeBytes ||
            typeof chunk.contentBase64 !== "string" ||
            chunk.contentBase64.length > 44 * 1024
          )
            throw new Error("文件分块身份或大小无效");
          const bytes = decodeChunk(chunk.contentBase64);
          const end = offset + bytes.length;
          if (
            chunk.offsetBytes !== offset ||
            !bytes.length ||
            bytes.length > 32 * 1024 ||
            end > artifact.sizeBytes ||
            chunk.endOffsetBytes !== end ||
            chunk.truncated !== end < artifact.sizeBytes ||
            (end < artifact.sizeBytes
              ? chunk.nextOffsetBytes !== end
              : chunk.nextOffsetBytes !== undefined)
          )
            throw new Error("文件分块偏移无效");
          handle.writeBytes(bytes);
          offset = end;
          onProgress?.(
            `${Math.round(offset / 1024)} / ${Math.round(artifact.sizeBytes / 1024)} KiB`,
          );
        }
      } finally {
        handle.close();
      }
    } else
      await File.downloadFileAsync(
        options.client.artifactUrl(options.workspaceId, options.sessionId, artifact.artifactId),
        partial,
        {
          headers: options.client.authorizationHeaders(),
          signal: controller.signal,
          onProgress: ({ bytesWritten, totalBytes }) => {
            if (bytesWritten > artifact.sizeBytes || totalBytes > artifact.sizeBytes) {
              controller.abort();
              return;
            }
            if (
              epoch === cacheEpoch &&
              hostEpoch === (hostEpochs.get(options.scopeId) ?? 0) &&
              !signal?.aborted &&
              !controller.signal.aborted
            )
              onProgress?.(
                `${Math.round(bytesWritten / 1024)} / ${Math.round(artifact.sizeBytes / 1024)} KiB`,
              );
          },
        },
      );
    check();
    onProgress?.("校验中…");
    await validate(partial);
    check();
    if (target.exists) {
      // Another card may have finished the same immutable resource while we downloaded.
      await validate(target);
    } else {
      // Keep the existence check and rename in one JS turn so duplicate cards cannot
      // overwrite a file already in use. Only the bounded rename is synchronous.
      partial.moveSync(target);
      // Expo updates the moved File's URI; it is no longer a partial to clean up.
      partial = undefined;
    }
    check();
    onProgress?.("校验通过");
    return target;
  } finally {
    try {
      if (partial?.exists) partial.delete();
    } finally {
      downloads.delete(controller);
      signal?.removeEventListener("abort", abort);
      finishDownload();
    }
  }
}
