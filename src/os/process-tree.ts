import { spawn, type ChildProcess } from "node:child_process";
import { isWindows } from "./shell.js";

/**
 * 向 child 所在的整个进程树发送终止信号。
 * POSIX 前台/后台 shell 均以 detached 进程组启动，因此负 pid 可覆盖孙进程；
 * Windows 使用 taskkill /T，避免只杀掉 bash.exe/cmd.exe 外壳。
 */
export function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid === undefined) return;

  if (isWindows) {
    try {
      const killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      killer.once("error", () => {
        try {
          child.kill(signal);
        } catch {
          // 目标进程可能已经退出。
        }
      });
      killer.unref();
      return;
    } catch {
      // taskkill 不可用时退回 Node 的直接 child.kill。
    }
  } else {
    try {
      process.kill(-pid, signal);
      return;
    } catch {
      // 进程组可能已经退出，或调用方未以 detached 方式启动。
    }
  }

  try {
    child.kill(signal);
  } catch {
    // 进程可能在发信号前已经退出。
  }
}
