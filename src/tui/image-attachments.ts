import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, isAbsolute } from "node:path";
import type { ImagePart } from "../schema/message.js";
import { readClipboardImage } from "./system-actions.js";

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

export interface InputImageAttachment {
  readonly id: string;
  readonly name: string;
  readonly image: ImagePart;
}

export function imageAttachmentFromPath(filePath: string): InputImageAttachment {
  const resolved = realpathSync(filePath);
  const stat = statSync(resolved);
  if (!stat.isFile()) throw new Error(`图片不是普通文件: ${filePath}`);
  if (stat.size > MAX_IMAGE_BYTES) {
    throw new Error(
      `图片过大（${formatBytes(stat.size)}），最大允许 ${formatBytes(MAX_IMAGE_BYTES)}。`,
    );
  }

  const data = readFileSync(resolved);
  return imageAttachment(basename(resolved), imagePartFromBuffer(data, resolved));
}

export async function imageAttachmentFromClipboard(): Promise<InputImageAttachment> {
  const image = await readClipboardImage();
  const bytes = Buffer.from(image.data, "base64").byteLength;
  if (bytes > MAX_IMAGE_BYTES) {
    throw new Error(
      `剪贴板图片过大（${formatBytes(bytes)}），最大允许 ${formatBytes(MAX_IMAGE_BYTES)}。`,
    );
  }
  return imageAttachment("clipboard-image.png", image);
}

/** 终端拖拽文件通常只会向 stdin 写入绝对路径；仅识别整段输入就是一个图片路径的情况。 */
export function droppedImagePath(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes("\n")) return undefined;
  const unquoted = unwrapShellPath(trimmed);
  return isAbsolute(unquoted) && /\.(?:png|jpe?g|gif|webp)$/iu.test(unquoted)
    ? unquoted
    : undefined;
}

function imageAttachment(name: string, image: ImagePart): InputImageAttachment {
  return { id: randomUUID(), name, image };
}

function imagePartFromBuffer(
  data: Buffer,
  path: string,
): Extract<ImagePart, { type: "image_base64" }> {
  return {
    type: "image_base64",
    mimeType: inferImageMimeType(data, path),
    data: data.toString("base64"),
  };
}

function inferImageMimeType(data: Buffer, path: string): string {
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return "image/png";
  if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) return "image/jpeg";
  if (
    data.subarray(0, 6).toString("ascii") === "GIF87a" ||
    data.subarray(0, 6).toString("ascii") === "GIF89a"
  )
    return "image/gif";
  if (data.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  throw new Error(`不支持的图片格式: ${path}`);
}

function unwrapShellPath(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value.replaceAll("\\ ", " ");
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024 / 1024)} MB`;
}
