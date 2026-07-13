import { spawn, type ChildProcess } from "node:child_process";
import { isWindows } from "./shell.js";

const TASKKILL_TIMEOUT_MS = 1_000;

/**
 * 向 child 所在的整个进程树发送终止信号。
 * POSIX 前台/后台 shell 均以 detached 进程组启动，因此负 pid 可覆盖孙进程；
 * Windows 使用 taskkill /T，避免只杀掉 bash.exe/cmd.exe 外壳。
 */
export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: { requireWindowsTreeProof?: boolean } = {},
): Promise<boolean> {
  const pid = child.pid;
  const childExited = child.exitCode !== null || child.signalCode !== null;

  if (pid === undefined) return options.requireWindowsTreeProof !== true;

  if (isWindows) {
    // tools/call 可能留下孙进程；根进程已退出不能单独证明整树已消失。
    // 也不能对已退出的旧 PID 运行 taskkill，避免 PID 复用时误杀无关进程。
    if (childExited) return options.requireWindowsTreeProof !== true;
    if (await runTaskkill(pid)) return true;
    if (options.requireWindowsTreeProof === true) return false;
  } else {
    if (childExited) return true;
    try {
      process.kill(-pid, signal);
      return true;
    } catch {
      // 进程组可能已经退出，或调用方未以 detached 方式启动。
    }
  }

  return signalChild(child, signal);
}

function runTaskkill(pid: number): Promise<boolean> {
  let killer: ChildProcess;
  try {
    killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
  } catch {
    return Promise.resolve(false);
  }

  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (succeeded: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(succeeded);
    };
    const timer = setTimeout(() => {
      try {
        killer.kill();
      } catch {
        // taskkill 可能恰好在超时边界退出。
      }
      finish(false);
    }, TASKKILL_TIMEOUT_MS);

    killer.once("error", () => finish(false));
    killer.once("close", (code) => finish(code === 0));
  });
}

function signalChild(child: ChildProcess, signal: NodeJS.Signals): boolean {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  try {
    return child.kill(signal);
  } catch {
    // 进程可能在发信号前已经退出。
    return child.exitCode !== null || child.signalCode !== null;
  }
}
