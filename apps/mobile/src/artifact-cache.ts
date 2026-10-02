import { Directory, File, Paths } from "expo-file-system";
import * as Crypto from "expo-crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { RemoteRuntimeClient } from "@pico/remote-client";
import type { RuntimeMediaReference, RuntimeSessionArtifact } from "@pico/protocol/mobile";
import { assertArtifactIntegrity } from "./core";
import { verifyMediaIntegrity } from "./media";

const cache = new Directory(Paths.cache, "pico-artifacts");
let cacheEpoch = 0;
const downloads = new Set<AbortController>();

export function clearArtifactCache() {
  cacheEpoch++;
  for (const controller of downloads) controller.abort();
  if (cache.exists) cache.delete();
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
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  downloads.add(controller);
  const check = () => {
    if (epoch !== cacheEpoch || signal?.aborted || controller.signal.aborted)
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
    cache.create({ idempotent: true, intermediates: true });
    const resourceCache = new Directory(cache, identity);
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
    partial = new File(cache, `${Crypto.randomUUID()}.partial`);
    onProgress?.("加载中…");
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
          if (epoch === cacheEpoch && !signal?.aborted)
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
    if (partial?.exists) partial.delete();
    downloads.delete(controller);
    signal?.removeEventListener("abort", abort);
  }
}
