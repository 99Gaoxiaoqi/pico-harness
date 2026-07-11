import { spawn } from "node:child_process";
import { dirname } from "node:path";

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
