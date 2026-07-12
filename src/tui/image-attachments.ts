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

export interface DroppedImageExtraction {
  readonly paths: readonly string[];
  readonly remainingText: string;
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

/**
 * 终端拖拽通常将一个或多个路径作为文本写入 stdin。终端种类会分别使用
 * 换行、引号或反斜杠转义空格；这里保留路径本身，并只挑出绝对图片路径。
 */
export function droppedImagePaths(text: string): readonly string[] {
  const extracted = extractDroppedImagePaths(text);
  return extracted.paths.length > 0 && extracted.remainingText.trim().length === 0
    ? extracted.paths
    : [];
}

/**
 * 只解析本次终端粘贴/拖拽产生的文本片段，并保留其中的普通文本。
 * InputBox 不应拿整个草稿反复猜测，否则已有提示词会让拖拽永远失效，
 * 而逐字输入到一半的路径也容易被误判。
 */
export function extractDroppedImagePaths(text: string): DroppedImageExtraction {
  const tokens = splitDroppedPathTokens(text);
  const imageTokens = tokens.filter((token) => isDroppedImagePath(token.value));
  if (imageTokens.length === 0) return { paths: [], remainingText: text };

  let remainingText = "";
  let cursor = 0;
  for (const token of imageTokens) {
    remainingText += text.slice(cursor, token.start);
    cursor = token.end;
  }
  remainingText += text.slice(cursor);

  return {
    paths: imageTokens.map((token) => token.value),
    remainingText: remainingText.trim().length === 0 ? "" : remainingText,
  };
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

interface DroppedPathToken {
  readonly value: string;
  readonly start: number;
  readonly end: number;
}

function splitDroppedPathTokens(value: string): DroppedPathToken[] {
  const tokens: DroppedPathToken[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let tokenStart: number | undefined;

  const pushCurrent = (end: number): void => {
    if (current && tokenStart !== undefined) {
      tokens.push({ value: current, start: tokenStart, end });
    }
    current = "";
    tokenStart = undefined;
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    if (tokenStart === undefined && !/\s/u.test(character)) tokenStart = index;
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else if (character === "\\" && canEscape(value[index + 1])) {
        current += value[index + 1];
        index += 1;
      } else {
        current += character;
      }
      continue;
    }

    if (character === '"' || character === "'") {
      quote = character;
    } else if (/\s/u.test(character)) {
      pushCurrent(index);
    } else if (character === "\\" && canEscape(value[index + 1])) {
      current += value[index + 1];
      index += 1;
    } else {
      // Windows 路径的反斜杠不是 shell 转义，例如 C:\\Users\\pico.png。
      current += character;
    }
  }
  pushCurrent(value.length);
  return tokens;
}

function canEscape(value: string | undefined): value is string {
  return (
    value === " " ||
    value === "\t" ||
    value === "\n" ||
    value === '"' ||
    value === "'" ||
    value === "\\"
  );
}

function isPortableAbsolutePath(value: string): boolean {
  return (
    isAbsolute(value) || /^[A-Za-z]:[\\/]/u.test(value) || /^\\\\[^\\/]+[\\/][^\\/]+/u.test(value)
  );
}

function isDroppedImagePath(value: string): boolean {
  return isPortableAbsolutePath(value) && /\.(?:png|jpe?g|gif|webp)$/iu.test(value);
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024 / 1024)} MB`;
}
