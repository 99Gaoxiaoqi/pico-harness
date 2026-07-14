import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ImagePart } from "../schema/message.js";

const ACTION_TIMEOUT_MS = 5_000;
const MAX_CLIPBOARD_IMAGE_BYTES = 10 * 1024 * 1024;
const CLIPBOARD_IMAGE_ERROR =
  "未检测到可读取的剪贴板图片。请复制 PNG 图片后重试，或将图片文件拖到输入框。";

type Base64ImagePart = Extract<ImagePart, { type: "image_base64" }>;

class ClipboardImageError extends Error {}

export interface ImagePasteKey {
  readonly ctrl?: boolean;
  readonly alt?: boolean;
}

/** 图片粘贴绑定遵循终端可移植性：Windows 使用 Alt+V，其他平台使用 Ctrl+V。 */
export function imagePasteShortcutLabel(platform = process.platform): string {
  return platform === "win32" ? "Alt+V" : "Ctrl+V";
}

/** 供 TUI 输入层识别平台默认的图片粘贴按键。 */
export function isImagePasteShortcut(
  input: string,
  key: ImagePasteKey,
  platform = process.platform,
): boolean {
  const isV = input === "v" || input === "V" || input === "\u0016";
  return isV && (platform === "win32" ? key.alt === true : key.ctrl === true);
}

/** 用户在 Inspector 中显式按 c 后才调用；不经过 shell，避免正文被解释为命令。 */
export async function copyTextToClipboard(text: string): Promise<void> {
  const candidates =
    process.platform === "darwin"
      ? [{ command: "pbcopy", args: [] as string[] }]
      : process.platform === "win32"
        ? [{ command: "clip.exe", args: [] as string[] }]
        : [
            { command: "wl-copy", args: [] as string[] },
            { command: "xclip", args: ["-selection", "clipboard"] },
          ];

  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      await runProcess(candidate.command, candidate.args, text);
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("No supported clipboard command is available.", { cause: lastError });
}

/**
 * 终端不会把位图粘贴事件交给 Ink；通过平台剪贴板读取用户显式触发的图片粘贴。
 * 返回 base64，确保图片只作为当前请求的内存附件，不会写入项目目录。
 */
export async function readClipboardImage(): Promise<Base64ImagePart> {
  try {
    const image =
      process.platform === "darwin"
        ? await readMacClipboardImage()
        : process.platform === "win32"
          ? imagePartFromBuffer(await readWindowsClipboardImage(), "Windows 剪贴板")
          : process.platform === "linux"
            ? imagePartFromBuffer(await readLinuxClipboardImage(), "Linux 剪贴板")
            : imagePartFromBuffer(Buffer.alloc(0), "剪贴板");
    return image;
  } catch (error) {
    if (error instanceof ClipboardImageError) throw error;
    // 系统命令的 stderr 往往包含脚本实现细节；不要把它直接暴露给终端用户。
    throw new Error(CLIPBOARD_IMAGE_ERROR, { cause: error });
  }
}

/**
 * Finder 的“复制文件”同时提供 furl 和文件图标 PNGf。必须优先读取 furl 指向的
 * 原始图片，否则模型收到的是 Finder 图标。只有剪贴板没有文件引用时才读取位图。
 */
async function readMacClipboardImage(): Promise<Base64ImagePart> {
  const fileReference = await readMacClipboardFileReference();
  if (fileReference !== undefined) {
    return await readClipboardImageFileReference(fileReference);
  }

  const directory = await mkdtemp(join(tmpdir(), "pico-clipboard-"));
  const imagePath = join(directory, "clipboard.png");
  try {
    try {
      await runProcess("osascript", ["-e", MACOS_CLIPBOARD_TO_PNG_SCRIPT, imagePath]);
    } catch {
      const tiffPath = join(directory, "clipboard.tiff");
      await runProcess("osascript", ["-e", MACOS_CLIPBOARD_TO_TIFF_SCRIPT, tiffPath]);
      await runProcess("sips", ["-s", "format", "png", tiffPath, "--out", imagePath]);
    }
    return imagePartFromBuffer(await readFile(imagePath), "macOS 剪贴板");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function readMacClipboardFileReference(): Promise<string | undefined> {
  try {
    const output = await runProcessOutput("osascript", [
      "-e",
      "get POSIX path of (the clipboard as «class furl»)",
    ]);
    const reference = output.toString("utf8").trim();
    return reference || undefined;
  } catch {
    // 没有 furl 是正常情况，例如在预览、浏览器或截图工具中复制了图片像素。
    return undefined;
  }
}

/**
 * 从 macOS 剪贴板文件引用读取原始图片。独立导出便于覆盖真实文件系统边界，
 * 同时兼容 POSIX 路径与 file:// URL（包括空格和非 ASCII URL 编码）。
 */
export async function readClipboardImageFileReference(reference: string): Promise<Base64ImagePart> {
  let filePath: string;
  try {
    const trimmed = reference.trim();
    filePath = trimmed.startsWith("file:") ? fileURLToPath(trimmed) : trimmed;
  } catch {
    throw new ClipboardImageError("剪贴板中的图片文件引用无效，请重新复制或直接拖拽图片文件。");
  }

  if (!filePath || filePath.includes("\0")) {
    throw new ClipboardImageError("剪贴板中的图片文件引用无效，请重新复制或直接拖拽图片文件。");
  }

  let resolved: string;
  let fileStat;
  try {
    resolved = await realpath(filePath);
    fileStat = await stat(resolved);
  } catch {
    throw new ClipboardImageError(`剪贴板中的图片文件不存在或无法读取：${filePath}`);
  }
  if (!fileStat.isFile()) {
    throw new ClipboardImageError(`剪贴板引用的不是普通图片文件：${filePath}`);
  }
  if (fileStat.size > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ClipboardImageError(
      `剪贴板图片过大（${formatBytes(fileStat.size)}），最大允许 ${formatBytes(MAX_CLIPBOARD_IMAGE_BYTES)}。`,
    );
  }

  let data: Buffer;
  try {
    data = await readFile(resolved);
  } catch {
    throw new ClipboardImageError(`剪贴板中的图片文件不存在或无法读取：${filePath}`);
  }
  if (data.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ClipboardImageError(
      `剪贴板图片过大（${formatBytes(data.length)}），最大允许 ${formatBytes(MAX_CLIPBOARD_IMAGE_BYTES)}。`,
    );
  }
  return imagePartFromBuffer(data, filePath);
}

const MACOS_CLIPBOARD_TO_PNG_SCRIPT = `
on run argv
  set outputPath to item 1 of argv
  set pngData to the clipboard as «class PNGf»
  set fileRef to open for access (POSIX file outputPath) with write permission
  try
    set eof fileRef to 0
    write pngData to fileRef
    close access fileRef
  on error errorMessage number errorNumber
    try
      close access fileRef
    end try
    error errorMessage number errorNumber
  end try
end run
`;

const MACOS_CLIPBOARD_TO_TIFF_SCRIPT = `
on run argv
  set outputPath to item 1 of argv
  set imageData to the clipboard as TIFF picture
  set fileRef to open for access (POSIX file outputPath) with write permission
  try
    set eof fileRef to 0
    write imageData to fileRef
    close access fileRef
  on error errorMessage number errorNumber
    try
      close access fileRef
    end try
    error errorMessage number errorNumber
  end try
end run
`;

async function readWindowsClipboardImage(): Promise<Buffer> {
  const output = await runProcessOutput("powershell.exe", [
    "-NoProfile",
    "-Command",
    "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 2 }; $stream = New-Object IO.MemoryStream; try { $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray()) } finally { $stream.Dispose(); $image.Dispose() }",
  ]);
  const encoded = output.toString("utf8").trim();
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("Windows clipboard did not return image data.");
  }
  return Buffer.from(encoded, "base64");
}

/** 用户在 Inspector 中显式按 l 后打开系统文件管理器。 */
export async function locateFileInShell(filePath: string): Promise<void> {
  if (process.platform === "darwin") {
    await runProcess("open", ["-R", filePath]);
    return;
  }
  if (process.platform === "win32") {
    await runProcess("explorer.exe", ["/select,", filePath]);
    return;
  }
  await runProcess("xdg-open", [dirname(filePath)]);
}

function runProcess(command: string, args: readonly string[], stdin?: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: [stdin === undefined ? "ignore" : "pipe", "ignore", "pipe"],
      windowsHide: true,
    });
    let stderr = "";
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        if (child.exitCode === null) child.kill();
        reject(error);
      } else resolvePromise();
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error(`${command} timed out after ${ACTION_TIMEOUT_MS}ms`));
    }, ACTION_TIMEOUT_MS);
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      settle(error);
    });
    // 命令不存在或提前退出时，向 pipe 写正文可能触发 EPIPE；显式接管，
    // 避免 EventEmitter 的未处理 error 直接终止 TUI 进程。
    child.stdin?.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (code === 0) settle();
      else settle(new Error(`${command} exited with code ${code ?? "unknown"}: ${stderr.trim()}`));
    });
    if (stdin !== undefined) child.stdin?.end(stdin);
  });
}

async function readLinuxClipboardImage(): Promise<Buffer> {
  const candidates = [
    { command: "wl-paste", args: ["--no-newline", "--type", "image/png"] },
    { command: "xclip", args: ["-selection", "clipboard", "-t", "image/png", "-o"] },
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await runProcessOutput(candidate.command, candidate.args);
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error("Linux clipboard image command failed.", { cause: lastError });
}

function imagePartFromBuffer(data: Buffer, source: string): Base64ImagePart {
  if (data.length > MAX_CLIPBOARD_IMAGE_BYTES) {
    throw new ClipboardImageError(
      `剪贴板图片过大（${formatBytes(data.length)}），最大允许 ${formatBytes(MAX_CLIPBOARD_IMAGE_BYTES)}。`,
    );
  }
  let mimeType: string | undefined;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    mimeType = "image/png";
  } else if (data.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))) {
    mimeType = "image/jpeg";
  } else if (
    data.subarray(0, 6).toString("ascii") === "GIF87a" ||
    data.subarray(0, 6).toString("ascii") === "GIF89a"
  ) {
    mimeType = "image/gif";
  } else if (
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    mimeType = "image/webp";
  }

  if (!mimeType) {
    throw new ClipboardImageError(`${source}不是受支持的图片格式；仅支持 PNG、JPEG、GIF 和 WebP。`);
  }
  return { type: "image_base64", mimeType, data: data.toString("base64") };
}

function formatBytes(bytes: number): string {
  return `${Math.ceil(bytes / 1024 / 1024)} MB`;
}

function runProcessOutput(command: string, args: readonly string[]): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, [...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const output: Buffer[] = [];
    let stderr = "";
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        if (child.exitCode === null) child.kill();
        reject(error);
      } else resolvePromise(Buffer.concat(output));
    };
    const timer = setTimeout(() => {
      child.kill();
      settle(new Error(`${command} timed out after ${ACTION_TIMEOUT_MS}ms`));
    }, ACTION_TIMEOUT_MS);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", (error) => settle(error));
    child.once("close", (code) => {
      if (code === 0) settle();
      else settle(new Error(`${command} exited with code ${code ?? "unknown"}: ${stderr.trim()}`));
    });
  });
}
