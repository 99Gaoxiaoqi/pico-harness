import { createRequire } from "node:module";
import { inspectMediaBytes, MODEL_IMAGE_MAX_BYTES } from "@pico/core/media";
import type { Canvas, Image } from "@napi-rs/canvas";

export const MODEL_IMAGE_MAX_EDGE = 2048;
export const MODEL_IMAGE_MAX_SOURCE_EDGE = 16_384;
export const MODEL_IMAGE_MAX_SOURCE_PIXELS = 32_000_000;
const MAX_ACTIVE_PREPARATIONS = 2;
const moduleRequire = createRequire(import.meta.url);
let activePreparations = 0;
const waitingPreparations = new Set<() => void>();

type ImageHeader = { width: number; height: number; animated: boolean };

async function acquirePreparation(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (activePreparations < MAX_ACTIVE_PREPARATIONS) {
    activePreparations++;
    return;
  }
  await new Promise<void>((resolve, reject) => {
    const start = () => {
      signal?.removeEventListener("abort", cancel);
      activePreparations++;
      resolve();
    };
    const cancel = () => {
      waitingPreparations.delete(start);
      reject(signal!.reason);
    };
    waitingPreparations.add(start);
    signal?.addEventListener("abort", cancel, { once: true });
  });
}

function releasePreparation(): void {
  activePreparations--;
  const next = waitingPreparations.values().next().value;
  if (next) {
    waitingPreparations.delete(next);
    next();
  }
}

function invalidImage(): Error {
  return new Error("图片文件头无效或内容已损坏。");
}

function checkDimensions(width: number, height: number): void {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width <= 0 || height <= 0)
    throw invalidImage();
  if (
    width > MODEL_IMAGE_MAX_SOURCE_EDGE ||
    height > MODEL_IMAGE_MAX_SOURCE_EDGE ||
    width * height > MODEL_IMAGE_MAX_SOURCE_PIXELS
  )
    throw new Error("图片超过解码安全上限（最大边 16384、3200 万像素），请缩小原图后重试。");
}

/** Check compressed headers before the native decoder can allocate a full bitmap. */
function readHeader(bytes: Buffer, mimeType: string): ImageHeader {
  if (mimeType === "image/png") {
    if (bytes.length < 33 || bytes.toString("ascii", 12, 16) !== "IHDR") throw invalidImage();
    const width = bytes.readUInt32BE(16);
    const height = bytes.readUInt32BE(20);
    checkDimensions(width, height);
    let animated = false;
    for (let offset = 8; offset + 12 <= bytes.length; ) {
      const size = bytes.readUInt32BE(offset);
      if (size > bytes.length - offset - 12) throw invalidImage();
      const chunk = bytes.toString("ascii", offset + 4, offset + 8);
      if (chunk === "acTL") animated = true;
      if (chunk === "IEND") return { width, height, animated };
      offset += size + 12;
    }
    throw invalidImage();
  }
  if (mimeType === "image/gif") {
    if (bytes.length < 13) throw invalidImage();
    return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8), animated: true };
  }
  if (mimeType === "image/jpeg") {
    for (let offset = 2; offset + 4 <= bytes.length; ) {
      if (bytes[offset++] !== 0xff) throw invalidImage();
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === undefined || marker === 0xda || marker === 0xd9) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) throw invalidImage();
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || size > bytes.length - offset) throw invalidImage();
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (size < 8) throw invalidImage();
        return {
          width: bytes.readUInt16BE(offset + 5),
          height: bytes.readUInt16BE(offset + 3),
          animated: false,
        };
      }
      offset += size;
    }
    throw invalidImage();
  }
  if (mimeType === "image/webp") {
    if (bytes.length < 20) throw invalidImage();
    const end = bytes.readUInt32LE(4) + 8;
    if (end > bytes.length) throw invalidImage();
    let header: ImageHeader | undefined;
    for (let offset = 12; offset + 8 <= end; ) {
      const size = bytes.readUInt32LE(offset + 4);
      if (size > end - offset - 8) throw invalidImage();
      const start = offset + 8;
      const chunk = bytes.toString("ascii", offset, start - 4);
      let current: ImageHeader | undefined;
      if (chunk === "VP8X" && size >= 10) {
        current = {
          width: bytes.readUIntLE(start + 4, 3) + 1,
          height: bytes.readUIntLE(start + 7, 3) + 1,
          animated: (bytes[start]! & 2) !== 0,
        };
      } else if (chunk === "VP8 " && size >= 10) {
        current = {
          width: bytes.readUInt16LE(start + 6) & 0x3fff,
          height: bytes.readUInt16LE(start + 8) & 0x3fff,
          animated: false,
        };
      } else if (chunk === "VP8L" && size >= 5) {
        const bits = bytes.readUInt32LE(start + 1);
        current = {
          width: (bits & 0x3fff) + 1,
          height: ((bits >>> 14) & 0x3fff) + 1,
          animated: false,
        };
      }
      if (current) {
        checkDimensions(current.width, current.height);
        header ??= current;
      }
      offset += 8 + size + (size % 2);
    }
    if (header) return header;
  }
  throw invalidImage();
}

/** Prepare request-only bytes. The caller keeps the original attachment/artifact untouched. */
export async function prepareImageForModel(
  data: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<{ data: string; mimeType: string; sizeBytes: number }> {
  signal?.throwIfAborted();
  if (data.length > Math.ceil(MODEL_IMAGE_MAX_BYTES / 3) * 4)
    throw new Error("图片超过 10 MiB 输入上限。");
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/u.test(data))
    throw new Error("图片必须是有效的原始 Base64 数据。");
  const bytes = Buffer.from(data, "base64");
  if (bytes.byteLength > MODEL_IMAGE_MAX_BYTES) throw new Error("图片超过 10 MiB 输入上限。");
  if (
    !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(mimeType) ||
    inspectMediaBytes(bytes)?.mimeType !== mimeType
  )
    throw new Error("图片格式无效或 MIME 类型不匹配，仅支持 PNG、JPEG、WebP 和 GIF。");
  const header = readHeader(bytes, mimeType);
  checkDimensions(header.width, header.height);
  if (header.animated && Math.max(header.width, header.height) > MODEL_IMAGE_MAX_EDGE)
    throw new Error("GIF 或动画图片超过 2048 像素，无法在保留动画的同时缩放，请先导出静态图片。");
  await acquirePreparation(signal);
  let image: Image | undefined;
  let canvas: Canvas | undefined;
  try {
    signal?.throwIfAborted();
    const { createCanvas, loadImage } = moduleRequire(
      "@napi-rs/canvas",
    ) as typeof import("@napi-rs/canvas");
    image = await loadImage(bytes);
    // Native decoding cannot be interrupted; keep its slot until it settles and is cleaned up.
    signal?.throwIfAborted();
    // Skia applies EXIF orientation during decode; use decoded dimensions and do not rotate again.
    checkDimensions(image.width, image.height);
    const largestEdge = Math.max(image.width, image.height);
    if (largestEdge <= MODEL_IMAGE_MAX_EDGE) return { data, mimeType, sizeBytes: bytes.byteLength };
    if (header.animated) throw new Error("动画图片无法在保留动画的同时缩放，请先导出静态图片。");
    const scale = MODEL_IMAGE_MAX_EDGE / largestEdge;
    const width = Math.max(1, Math.floor(image.width * scale));
    const height = Math.max(1, Math.floor(image.height * scale));
    canvas = createCanvas(width, height);
    const context = canvas.getContext("2d");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    context.drawImage(image, 0, 0, width, height);
    const output =
      mimeType === "image/jpeg"
        ? await canvas.encode("jpeg", 90)
        : mimeType === "image/webp"
          ? await canvas.encode("webp", 90)
          : await canvas.encode("png");
    signal?.throwIfAborted();
    if (output.byteLength > MODEL_IMAGE_MAX_BYTES)
      throw new Error("缩放后图片超过 10 MiB 输出上限。");
    return { data: output.toString("base64"), mimeType, sizeBytes: output.byteLength };
  } catch (cause) {
    signal?.throwIfAborted();
    throw new Error(`图片准备失败：${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  } finally {
    // Release native bitmap/canvas storage promptly rather than waiting for a later GC pass.
    try {
      if (image) image.src = new Uint8Array();
    } finally {
      try {
        if (canvas) canvas.width = canvas.height = 0;
      } finally {
        releasePreparation();
      }
    }
  }
}
