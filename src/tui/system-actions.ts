import { spawn } from "node:child_process";
import { dirname } from "node:path";
import type { ImagePart } from "../schema/message.js";

const ACTION_TIMEOUT_MS = 5_000;

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
 * 终端不会把位图粘贴事件交给 Ink；通过平台剪贴板读取用户显式按下 Ctrl+V 的图片。
 * 返回 base64，确保图片只作为当前请求的内存附件，不会写入项目目录。
 */
export async function readClipboardImage(): Promise<Extract<ImagePart, { type: "image_base64" }>> {
  if (process.platform === "linux") {
    const data = await readLinuxClipboardImage();
    if (data.length === 0) throw new Error("剪贴板中没有可读取的 PNG 图片。");
    return { type: "image_base64", mimeType: "image/png", data: data.toString("base64") };
  }

  const output =
    process.platform === "darwin"
      ? await runProcessOutput("osascript", [
          "-l",
          "JavaScript",
          "-e",
          'ObjC.import("AppKit"); const data = $.NSPasteboard.generalPasteboard.dataForType($.NSPasteboardTypePNG); if (data === null) throw new Error("Clipboard does not contain a PNG image"); console.log(ObjC.unwrap(data.base64EncodedStringWithOptions(0)));',
        ])
      : process.platform === "win32"
        ? await runProcessOutput("powershell.exe", [
            "-NoProfile",
            "-Command",
            "Add-Type -AssemblyName System.Windows.Forms; Add-Type -AssemblyName System.Drawing; $image = [Windows.Forms.Clipboard]::GetImage(); if ($null -eq $image) { exit 2 }; $stream = New-Object IO.MemoryStream; $image.Save($stream, [Drawing.Imaging.ImageFormat]::Png); [Convert]::ToBase64String($stream.ToArray())",
          ])
        : Buffer.alloc(0);
  const data = output.toString("utf8").trim();
  if (!data) throw new Error("剪贴板中没有可读取的 PNG 图片。");
  return { type: "image_base64", mimeType: "image/png", data };
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
  throw new Error("剪贴板中没有可读取的 PNG 图片。", { cause: lastError });
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
