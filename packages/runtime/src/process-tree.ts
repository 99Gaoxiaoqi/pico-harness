import { spawn, type ChildProcess } from "node:child_process";
import { raceWithDeadline } from "./deadline.js";
import { isWindows } from "./host-shell.js";

const TASKKILL_TIMEOUT_MS = 1_000;
const MAX_TASKKILL_DIAGNOSTIC_CHARS = 4_096;

export interface WindowsProcessTreeFailure {
  readonly reason: "missing_pid" | "root_exited" | "spawn_error" | "nonzero_exit" | "timeout";
  readonly rootPid: number | undefined;
  readonly rootExitCode: number | null;
  readonly rootSignalCode: NodeJS.Signals | null;
  readonly taskkillPid?: number | undefined;
  readonly elapsedMs?: number;
  readonly exitCode?: number | null;
  readonly signalCode?: NodeJS.Signals | null;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly stdoutTruncated?: boolean;
  readonly stderrTruncated?: boolean;
  readonly error?: string;
}

type TaskkillResult =
  | { readonly terminated: true }
  | {
      readonly terminated: false;
      readonly diagnostic: Omit<
        WindowsProcessTreeFailure,
        "rootPid" | "rootExitCode" | "rootSignalCode"
      >;
    };

/**
 * 向 child 所在的整个进程树发送终止信号。
 * POSIX 前台/后台 shell 均以 detached 进程组启动，因此负 pid 可覆盖孙进程；
 * Windows 使用 taskkill /T，避免只杀掉 bash.exe/cmd.exe 外壳。
 */
export async function signalProcessTree(
  child: ChildProcess,
  signal: NodeJS.Signals,
  options: {
    requireWindowsTreeProof?: boolean;
    onWindowsTreeProofFailure?: (diagnostic: WindowsProcessTreeFailure) => void;
  } = {},
): Promise<boolean> {
  const pid = child.pid;
  const childExited = child.exitCode !== null || child.signalCode !== null;

  const reportFailure = (diagnostic: TaskkillResult & { terminated: false }) => {
    try {
      options.onWindowsTreeProofFailure?.({
        ...diagnostic.diagnostic,
        rootPid: pid,
        rootExitCode: child.exitCode,
        rootSignalCode: child.signalCode,
      });
    } catch {
      // Diagnostics cannot change whether the owned process tree was proven terminated.
    }
  };

  if (pid === undefined) {
    if (isWindows) reportFailure({ terminated: false, diagnostic: { reason: "missing_pid" } });
    return options.requireWindowsTreeProof !== true;
  }

  if (isWindows) {
    // tools/call 可能留下孙进程；根进程已退出不能单独证明整树已消失。
    // 也不能对已退出的旧 PID 运行 taskkill，避免 PID 复用时误杀无关进程。
    if (childExited) {
      reportFailure({ terminated: false, diagnostic: { reason: "root_exited" } });
      return options.requireWindowsTreeProof !== true;
    }
    const taskkill = await runTaskkill(pid);
    if (taskkill.terminated) return true;
    reportFailure(taskkill);
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

async function runTaskkill(pid: number): Promise<TaskkillResult> {
  const startedAt = performance.now();
  let stdout = "";
  let stderr = "";
  let stdoutTruncated = false;
  let stderrTruncated = false;
  let killer: ChildProcess;
  try {
    killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    return {
      terminated: false,
      diagnostic: {
        reason: "spawn_error",
        elapsedMs: Math.round(performance.now() - startedAt),
        error: String(error).slice(0, MAX_TASKKILL_DIAGNOSTIC_CHARS),
      },
    };
  }

  killer.stdout?.on("data", (chunk: Buffer) => {
    const next = stdout + chunk.toString("utf8");
    stdoutTruncated ||= next.length > MAX_TASKKILL_DIAGNOSTIC_CHARS;
    stdout = next.slice(0, MAX_TASKKILL_DIAGNOSTIC_CHARS);
  });
  killer.stderr?.on("data", (chunk: Buffer) => {
    const next = stderr + chunk.toString("utf8");
    stderrTruncated ||= next.length > MAX_TASKKILL_DIAGNOSTIC_CHARS;
    stderr = next.slice(0, MAX_TASKKILL_DIAGNOSTIC_CHARS);
  });
  const failure = (
    reason: "spawn_error" | "nonzero_exit" | "timeout",
    error?: unknown,
  ): TaskkillResult => ({
    terminated: false,
    diagnostic: {
      reason,
      taskkillPid: killer.pid,
      elapsedMs: Math.round(performance.now() - startedAt),
      exitCode: killer.exitCode,
      signalCode: killer.signalCode,
      stdout,
      stderr,
      stdoutTruncated,
      stderrTruncated,
      ...(error === undefined
        ? {}
        : { error: String(error).slice(0, MAX_TASKKILL_DIAGNOSTIC_CHARS) }),
    },
  });
  const completed = new Promise<TaskkillResult>((resolve) => {
    killer.once("error", (error) => resolve(failure("spawn_error", error)));
    killer.once("close", (code) =>
      resolve(code === 0 ? { terminated: true } : failure("nonzero_exit")),
    );
  });
  if (await raceWithDeadline(completed, TASKKILL_TIMEOUT_MS)) return await completed;
  try {
    killer.kill();
  } catch {
    // taskkill 可能恰好在超时边界退出。
  }
  return failure("timeout");
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
