// 跨平台 Shell 抽象层:统一 Windows/macOS/Linux 的命令执行语义。
//
// 痛点:Node 的 child_process.exec 在 Windows 默认走 cmd.exe(Comspec),
// 不识别 POSIX 转义(`\n`)、管道语义、`$()`、`printf`/`test` 等,
// 导致模型生成的 `echo 'a\nb' | grep b` 在 Windows 下语义错乱。
//
// 策略(借鉴 kimi-code 的 kaos 层):始终优先 POSIX bash。
// - macOS/Linux:直接用 /bin/bash
// - Windows:探测 Git Bash(git.exe 推断 + 硬编码候选 + 环境变量覆盖),
//           探测不到时明确失败，绝不把 Bash 命令交给其他语法的 shell。
//
// 探测结果在进程内缓存,避免每次 exec 都走一遍文件系统。

import { exec } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";
import type { ExecOptions } from "node:child_process";

/**
 * 固定 utf8 编码的 exec 选项类型。
 * 显式 encoding:"utf8" 让 promisify(exec) 的类型重载收窄到 string 返回,
 * 否则 ExecOptions 联合会退到 Buffer 版本,破坏调用方的 stdout: string 断言。
 */
export type Utf8ExecOptions = ExecOptions & { encoding: BufferEncoding };

/** 环境变量名:用户可显式指定 bash.exe 路径覆盖自动探测。 */
export const SHELL_PATH_ENV = "PICO_SHELL_PATH";

/** Windows 平台标志(模块加载时计算一次)。 */
export const isWindows = process.platform === "win32";

/** 统一的 promisified exec,保持与原有 `promisify(exec)` 完全相同的签名。 */
export const execAsync = promisify(exec);

let cachedShell: string | undefined;

/**
 * 解析当前平台应使用的 shell 路径。
 * - POSIX:返回 /bin/bash
 * - Windows:返回探测到的 Git Bash 路径；探测失败或 override 不是 Bash 时 fail closed。
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
  // 1) 环境变量显式覆盖
  const override = process.env[SHELL_PATH_ENV]?.trim();
  if (override && existsSync(override)) {
    if (!isBashShell(override)) {
      throw new Error(
        `${SHELL_PATH_ENV} 必须指向 bash 或 bash.exe，拒绝使用不受 Bash hardline 保护的 shell: ${override}`,
      );
    }
    return override;
  }

  // 2) 遍历 PATH 找 git.exe,推断同根目录下的 bash.exe
  for (const gitExe of findExecutablesOnWindowsPath("git.exe")) {
    const inferred = bashCandidatesFromGitExe(gitExe);
    for (const candidate of inferred) {
      if (existsSync(candidate)) {
        return candidate;
      }
    }
  }

  // 3) 硬编码常见安装路径兜底
  const localAppData = process.env.LOCALAPPDATA?.trim();
  const hardCoded = [
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ...(localAppData
      ? [
          `${localAppData}\\Programs\\Git\\bin\\bash.exe`,
          `${localAppData}\\Programs\\Git\\usr\\bin\\bash.exe`,
        ]
      : []),
  ];
  for (const candidate of hardCoded) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // 4) 当前安全分类器只建模 Bash；回退到 cmd/PowerShell 会让分类语义与
  //    实际执行语义分裂，因此缺少 Git Bash 时必须在 spawn 前失败。
  throw new Error(
    `未找到 Git Bash。请安装 Git for Windows，或将 ${SHELL_PATH_ENV} 指向 bash.exe。`,
  );
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
 * 从 git.exe 路径推断同根目录下可能的 bash.exe 位置。
 * Git for Windows 通常把 git.exe 放在 <root>\cmd\ 或 <root>\bin\,
 * bash.exe 在 <root>\bin\bash.exe 或 <root>\usr\bin\bash.exe。
 */
function bashCandidatesFromGitExe(gitExe: string): string[] {
  // 统一成反斜杠再做 win32 路径运算
  const normalized = gitExe.replaceAll("/", "\\");
  const gitDir = dirname(normalized);
  const dirName = gitDir.split("\\").pop()?.toLowerCase();
  // 只在 git.exe 处于 cmd/ 或 bin/ 时推断,避免包管理器 shim 误判
  if (dirName !== "cmd" && dirName !== "bin") {
    return [];
  }
  const root = dirname(gitDir);
  return [join(root, "bin", "bash.exe"), join(root, "usr", "bin", "bash.exe")];
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
  throw new Error(`拒绝使用不受 Bash hardline 保护的 shell: ${shell}`);
}

/** 当前 hardline 分类器能够安全绑定的 host shell。 */
export function isBashShell(shell: string): boolean {
  const name = basename(shell.replaceAll("\\", "/")).toLowerCase();
  return name === "bash" || name === "bash.exe";
}

/** 安全门使用：解析失败或不是 Bash 时一律视为不可执行。 */
export function hasSupportedHostShell(): boolean {
  try {
    return isBashShell(resolveShell());
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
