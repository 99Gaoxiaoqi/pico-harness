import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, dirname, isAbsolute, join } from "node:path";
import type { CommandHookHandler, HookHandler } from "../types.js";

/**
 * Command Hook 威胁模型（2026-08-17 对齐 Claude Code 哲学重构）。
 *
 * 旧模型把环境（PATH）当不可信输入：绑定时逐条校验 PATH、钉死可执行文件
 * canonical 身份 + 引用文件哈希，任何静态不可解释的条目即 fail-closed 拒绝
 * 绑定。代价是公司标配的脏环境（PATH 里的未展开字面量等）让 hook 静默死亡。
 *
 * 新模型的信任判断：
 * 1. hook 命令来自用户配置（user/project/local hooks.json）= 用户意图，
 *    命令本身不是攻击面；信任锚 = 配置字节指纹审批（trusted-hooks.json）
 *    + workspace trust（撤销信任后 dispatch 边界失效）。
 * 2. 命令是任意 shell 字符串，运行时交给 shell 解释（对齐 Claude Code：
 *    spawn 显式 shell 二进制 + `-c`，不用 node 的 shell:true 选项）。
 *    审计粒度从"文件字节钉死"降为"配置字节审批"——已确认的取舍。
 * 3. 环境消毒保留：剥离 base env 的 loader 注入变量（LD_PRELOAD 等）防第三
 *    方篡改被批准命令的行为；handler.env 覆盖（含 PATH）放行——配置即意图。
 */

export interface ReferencedScriptResolution {
  readonly paths: readonly string[];
  readonly watchPaths: readonly string[];
  readonly executablePaths: readonly string[];
}

export interface CommandHookInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

export type HookShellKind = "bash" | "sh" | "pwsh" | "powershell";

export interface HookShell {
  readonly kind: HookShellKind;
  readonly path: string;
  /** argv 前缀；完整 spawn argv = [path, ...argsPrefix, commandString]。 */
  readonly argsPrefix: readonly string[];
}

/** shell 化后的命令执行绑定；executor 直接 spawn，不经过 PATH 解析。 */
export interface ResolvedCommandHookInvocation extends CommandHookInvocation {
  readonly shell: HookShell;
  /** command + args（按 shell 方言 quote 后）拼成的完整命令行。 */
  readonly commandString: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

/**
 * 剥离 base 环境里的 loader 注入变量，防止第三方通过 ambient 环境改变被批准
 * 命令的行为。handler.env 不再限制覆盖任何变量（含 PATH）——配置是用户意图，
 * 与 Claude Code 语义一致；消毒只针对继承环境。
 */
export function sanitizeCommandHookEnvironment(
  handler: CommandHookHandler,
  baseEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (!isBlockedEnvironmentName(name)) sanitized[name] = value;
  }
  const result = { ...sanitized, ...handler.env };
  // 解释器不得回退到可变的用户启动配置位置（与旧模型一致的确定性要求）。
  result.PYTHONNOUSERSITE = "1";
  result.PYTHONDONTWRITEBYTECODE = "1";
  if (process.platform !== "win32") {
    result.ZDOTDIR = "/dev/null";
    result.XDG_CONFIG_HOME = "/dev/null";
    result.XDG_DATA_HOME = "/dev/null";
    result.XDG_DATA_DIRS = "/dev/null";
  }
  return result;
}

/** Backward-compatible export for the executor import used before the boundary was generalized. */
export const sanitizePackageInvocationEnvironment = sanitizeCommandHookEnvironment;

/**
 * 解析 hook 命令的执行绑定：shell 选择 + 环境消毒 + 命令行拼装。
 * 不做任何 PATH/可执行文件解析——那是 shell 运行时的职责。
 */
export async function resolveCommandHookExecution(
  handler: CommandHookHandler,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  shell?: HookShell,
): Promise<ResolvedCommandHookInvocation> {
  void workspace;
  const command = handler.command.trim();
  if (!command) throw new Error("该 command Hook 无法执行: 命令为空");
  const args = handler.args ?? [];
  const selectedShell = shell ?? resolveHookShell(environment);
  const commandString = buildCommandString(selectedShell.kind, command, args);
  return {
    command,
    args,
    shell: selectedShell,
    commandString,
    env: sanitizeCommandHookEnvironment(handler, environment),
  };
}

/**
 * command + args 拼成完整命令行。无 args 时命令原样保留（任意 shell 语法，
 * shell 全权解释）；有 args 时逐词 quote 拼接。PowerShell 的 quoted string
 * 在命令位不会被执行，需要调用运算符 `&` 前缀（POSIX shell 不需要）。
 */
function buildCommandString(kind: HookShellKind, command: string, args: readonly string[]): string {
  if (args.length === 0) return command;
  const quoted = [command, ...args].map((word) => quoteShellWord(kind, word)).join(" ");
  return kind === "pwsh" || kind === "powershell" ? `& ${quoted}` : quoted;
}

/**
 * shell 化后 command handler 没有可钉死的脚本文件；保留接口形状供 reloader
 * 与信任库消费（watch 路径只剩配置文件与信任库本身，由上游负责）。
 */
export async function resolveReferencedScripts(
  handler: HookHandler,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ReferencedScriptResolution> {
  void handler;
  void workspace;
  void environment;
  return { paths: [], watchPaths: [], executablePaths: [] };
}

/** 兼容导出：shell 化后无静态候选路径。 */
export function resolveReferencedScriptCandidates(
  handler: HookHandler,
  workspace: string,
): readonly string[] {
  void handler;
  void workspace;
  return [];
}

export async function existingReferencedScripts(
  handler: HookHandler,
  workspace: string,
): Promise<readonly string[]> {
  return (await resolveReferencedScripts(handler, workspace)).paths;
}

export interface ResolveHookShellOptions {
  /** 测试接缝：替换 bash 可用性探测（生产默认实跑 `bash -c "exit 0"`）。 */
  readonly isBashUsable?: (candidatePath: string) => boolean;
}

/**
 * 选择 hook 命令的解释 shell。
 * - win32：Git Bash 优先（POSIX hook 语义的主体场景，对齐 Claude Code）；
 *   找不到 Git 时回落 PowerShell（pwsh 优先，否则 Windows PowerShell）。
 * - POSIX：bash 优先，无 bash 退 /bin/sh。
 */
export function resolveHookShell(
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
  options: ResolveHookShellOptions = {},
): HookShell {
  const probe = options.isBashUsable ?? isUsableBash;
  if (process.platform === "win32") {
    const bashPath = findGitBashPath(environment, probe);
    if (bashPath) return { kind: "bash", path: bashPath, argsPrefix: ["-c"] };
    const pwshPath = findExecutableInPath("pwsh.exe", environment) ?? findWindowsPowerShell();
    if (pwshPath)
      return {
        kind: "pwsh",
        path: pwshPath,
        argsPrefix: ["-NoProfile", "-NonInteractive", "-Command"],
      };
    return {
      kind: "powershell",
      path: "powershell.exe",
      argsPrefix: ["-NoProfile", "-NonInteractive", "-Command"],
    };
  }
  if (probe("/bin/bash")) return { kind: "bash", path: "/bin/bash", argsPrefix: ["-c"] };
  return { kind: "sh", path: "/bin/sh", argsPrefix: ["-c"] };
}

/**
 * 探测 bash 真正可用。Git for Windows 的 `Git\bin\bash.exe` 是 47KB 转发
 * stub（转发到 usr/bin/bash.exe），残缺安装里目标缺失时 stub 会以
 * "Skipping command-line ... not found" 拒绝执行——existsSync 抓不出这种
 * 半死状态，必须实际跑一次。探测失败返回 false，调用方回落下一候选。
 */
function isUsableBash(candidate: string): boolean {
  try {
    execFileSync(candidate, ["-c", "exit 0"], { timeout: 3_000, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** POSIX 单引号包裹；PowerShell 单引号内 `'` 双写转义。 */
export function quoteShellWord(kind: HookShellKind, word: string): string {
  if (kind === "pwsh" || kind === "powershell") {
    return `'${word.replaceAll("'", "''")}'`;
  }
  return `'${word.replaceAll("'", `'\\''`)}'`;
}

function findGitBashPath(
  environment: Readonly<NodeJS.ProcessEnv>,
  probe: (candidatePath: string) => boolean,
): string | undefined {
  // PATH 推导优先（环境说什么就是什么），再查固定安装位置。
  const candidates: string[] = [];
  const fromPath = findExecutableInPath("git.exe", environment);
  if (fromPath) candidates.push(join(dirname(dirname(fromPath)), "bin", "bash.exe"));
  const fromGitCmd = findExecutableInPath("git.cmd", environment);
  if (fromGitCmd) candidates.push(join(dirname(dirname(fromGitCmd)), "bin", "bash.exe"));
  candidates.push(
    "C:\\Program Files\\Git\\bin\\bash.exe",
    "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
  );
  if (environment.ProgramFiles) {
    candidates.push(join(environment.ProgramFiles, "Git", "bin", "bash.exe"));
  }
  if (environment["ProgramFiles(x86)"]) {
    candidates.push(join(environment["ProgramFiles(x86)"], "Git", "bin", "bash.exe"));
  }
  for (const candidate of candidates) {
    if (
      candidate &&
      isAbsolute(candidate) &&
      /^[A-Za-z]:[\\/]/u.test(candidate) &&
      existsSync(candidate) &&
      probe(candidate)
    ) {
      return candidate;
    }
  }
  return undefined;
}

function findWindowsPowerShell(): string | undefined {
  const systemRoot = process.env.SystemRoot ?? "C:\\WINDOWS";
  const candidate = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return existsSync(candidate) ? candidate : undefined;
}

function findExecutableInPath(
  name: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): string | undefined {
  const pathValue = environmentValue(environment, "PATH");
  if (!pathValue) return undefined;
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) continue;
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 大小写不敏感读取 Windows 环境变量（Path/PATH/path 混写）。 */
function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  name: string,
): string | undefined {
  const lowered = name.toLowerCase();
  for (const [key, value] of Object.entries(environment)) {
    if (key.toLowerCase() === lowered && value !== undefined) return value;
  }
  return undefined;
}

const BLOCKED_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "BASHOPTS",
  "BASH_XTRACEFD",
  "SHELLOPTS",
  "PS4",
  "CDPATH",
  "GLOBIGNORE",
  "ENV",
  "ZDOTDIR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_DATA_DIRS",
  "SHELL",
  "COMSPEC",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LIBPATH",
  "SHLIB_PATH",
  "LDR_PRELOAD",
  "LDR_PRELOAD64",
  "OPENSSL_CONF",
  "OPENSSL_CONF_INCLUDE",
  "OPENSSL_MODULES",
  "OPENSSL_ENGINES",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PYTHONUSERBASE",
  "PYTHONNOUSERSITE",
  "RUBYOPT",
  "RUBYLIB",
  "RUBYGEMS_GEMDEPS",
  "GEM_HOME",
  "GEM_PATH",
  "PERL5OPT",
  "PERL5LIB",
  "PERLLIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
]);

function isBlockedEnvironmentName(name: string): boolean {
  return BLOCKED_ENVIRONMENT_NAMES.has(name.toUpperCase());
}
