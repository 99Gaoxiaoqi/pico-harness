// 跨平台 Shell 抽象层:统一 Windows/macOS/Linux 的命令执行语义。
//
// 策略:POSIX 用 /bin/bash;Windows 用 PowerShell(pwsh 优先,回退 Windows
// PowerShell),不再探测 Git Bash——对齐 maka 的宿主选择(企业安全软件常删
// bash.exe 造成残缺安装,而 PowerShell 是 Windows 必装组件)。
// shell 方言(hostShellDialect)作为安全分派的依据:bash 宿主沿用 bash-hardline
// 静态红线;PowerShell 宿主没有静态红线,由审批层把关(maka 立场:进程内命令
// 文本分析不是安全边界,承重边界是 OS 沙箱,沙箱落地后再复评)。
//
// 探测结果在进程内缓存,避免每次 exec 都走一遍文件系统。

import { exec, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, join } from "node:path";
import { promisify } from "node:util";
import type { ExecOptions } from "node:child_process";

/**
 * 固定 utf8 编码的 exec 选项类型。
 * 显式 encoding:"utf8" 让 promisify(exec) 的类型重载收窄到 string 返回,
 * 否则 ExecOptions 联合会退到 Buffer 版本,破坏调用方的 stdout: string 断言。
 */
export type Utf8ExecOptions = ExecOptions & { encoding: BufferEncoding };

/** 当前宿主 shell 的方言,安全分类与模型提示按此分派。 */
export type HostShellDialect = "bash" | "powershell";

/** 环境变量名:用户可显式指定 shell 可执行文件路径覆盖自动探测。 */
export const SHELL_PATH_ENV = "PICO_SHELL_PATH";

/** Windows 平台标志(模块加载时计算一次)。 */
export const isWindows = process.platform === "win32";

/** 统一的 promisified exec,保持与原有 `promisify(exec)` 完全相同的签名。 */
export const execAsync = promisify(exec);

let cachedShell: string | undefined;

/**
 * 解析当前平台应使用的 shell 路径。
 * - POSIX:返回 /bin/bash
 * - Windows:返回探测到的 PowerShell 路径；探测失败或 override 不可用时 fail closed。
 */
export function resolveShell(): string {
  if (cachedShell !== undefined) {
    return cachedShell;
  }
  cachedShell = isWindows ? resolveWindowsShell() : "/bin/bash";
  return cachedShell;
}

/** 重置缓存(仅测试用,允许重新探测)。 */
export function resetShellCache(): void {
  cachedShell = undefined;
}

function resolveWindowsShell(): string {
  // 1) 环境变量显式覆盖(接受 bash 系与 PowerShell;须真跑可用)
  const override = process.env[SHELL_PATH_ENV]?.trim();
  if (override && existsSync(override)) {
    if (!isBashShell(override) && !isPowerShell(override)) {
      throw new Error(
        `${SHELL_PATH_ENV} 必须指向 bash/sh 或 pwsh/powershell 可执行文件: ${override}`,
      );
    }
    if (!isUsableShellCandidate(override)) {
      throw new Error(`${SHELL_PATH_ENV} 指向的 shell 无法执行: ${override}`);
    }
    return override;
  }

  // 2) pwsh(PowerShell 7+)优先:PATH → 固定安装位置
  const pwsh = findFirstExisting([
    ...findExecutablesOnWindowsPath("pwsh.exe"),
    join(process.env.ProgramFiles ?? "", "PowerShell", "7", "pwsh.exe"),
  ]);
  if (pwsh) return pwsh;

  // 3) Windows PowerShell 5.1 回退:PATH → System32 固定位置
  const powershell = findFirstExisting([
    ...findExecutablesOnWindowsPath("powershell.exe"),
    join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    ),
  ]);
  if (powershell) return powershell;

  // PowerShell 是 Windows 必装组件,到这里说明系统本身残缺,fail closed。
  throw new Error(
    `未找到可用的 PowerShell(pwsh/powershell.exe)。或将 ${SHELL_PATH_ENV} 指向 pwsh.exe/powershell.exe。`,
  );
}

/**
 * 探测候选 shell 真正可用:实际跑一次最小命令。
 * 仅用于用户显式 override——候选链用 existsSync 即可(PowerShell 无 Git Bash
 * 那种坏转发 stub 问题,且省一次 PowerShell 冷启动)。
 */
function isUsableShellCandidate(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  const args = isPowerShell(candidate)
    ? ["-NoProfile", "-NonInteractive", "-Command", "exit 0"]
    : ["--noprofile", "--norc", "-c", "exit 0"];
  try {
    execFileSync(candidate, args, { timeout: 3_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function findFirstExisting(candidates: readonly string[]): string | undefined {
  return candidates.find((candidate) => candidate !== "" && existsSync(candidate));
}

/**
 * 在 Windows PATH 中查找指定可执行文件的全路径。
 * Windows PATH 用 `;` 分隔,与 POSIX 的 `:` 不同。
 */
function findExecutablesOnWindowsPath(target: string): string[] {
  const pathEnv = process.env.PATH;
  if (!pathEnv) {
    return [];
  }
  const found: string[] = [];
  for (const dir of pathEnv.split(";")) {
    if (!dir) continue;
    const full = join(dir, target);
    if (existsSync(full)) {
      found.push(full);
    }
  }
  return found;
}

/**
 * 构造跨平台友好的 exec 选项。
 * 合并调用方传入的 cwd/maxBuffer/timeout 等,强制注入统一 shell 与 windowsHide,
 * 并锁定 utf8 编码使 stdout 类型收窄为 string。
 */
export function execOptions(extra?: ExecOptions): Utf8ExecOptions {
  return {
    ...extra,
    shell: resolveShell(),
    windowsHide: true,
    encoding: "utf8",
  };
}

/** 以当前平台 shell 执行一段命令文本时使用的 argv。 */
export function shellCommandArgs(shell: string, command: string): string[] {
  if (isBashShell(shell)) {
    return ["--noprofile", "--norc", "-c", command];
  }
  if (isPowerShell(shell)) {
    return ["-NoProfile", "-NonInteractive", "-Command", command];
  }
  throw new Error(`不支持的宿主 shell: ${shell}`);
}

/** bash 系宿主(bash/sh,POSIX 主体场景)。 */
export function isBashShell(shell: string): boolean {
  const name = basename(shell.replaceAll("\\", "/")).toLowerCase();
  return name === "bash" || name === "bash.exe" || name === "sh" || name === "sh.exe";
}

/** PowerShell 系宿主(Windows 默认)。 */
export function isPowerShell(shell: string): boolean {
  const name = basename(shell.replaceAll("\\", "/")).toLowerCase();
  return (
    name === "pwsh" || name === "pwsh.exe" || name === "powershell" || name === "powershell.exe"
  );
}

/**
 * 当前宿主 shell 方言。安全分类(hardline/只读判定)与模型提示按此分派。
 * shell 无法解析时 throw,调用方按 fail-closed 处理。
 */
export function hostShellDialect(): HostShellDialect {
  const shell = resolveShell();
  return isPowerShell(shell) ? "powershell" : "bash";
}

/** 安全门使用：宿主 shell 无法解析时一律视为不可执行。 */
export function hasSupportedHostShell(): boolean {
  try {
    hostShellDialect();
    return true;
  } catch {
    return false;
  }
}

/** Keep ordinary user variables while removing ambient code-loading inputs for the host shell. */
export function sanitizeShellProcessEnvironment(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    if (value === undefined || isShellStartupEnvironmentName(name)) continue;
    sanitized[name] = value;
  }
  return sanitized;
}

function isShellStartupEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return SHELL_STARTUP_ENVIRONMENT_NAMES.has(normalized) || normalized.startsWith("BASH_FUNC_");
}

const SHELL_STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "BASHOPTS",
  "BASH_ENV",
  "BASH_XTRACEFD",
  "CDPATH",
  "ENV",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "PS4",
  "SHELLOPTS",
]);
