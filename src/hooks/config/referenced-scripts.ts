import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import { basename, delimiter, isAbsolute, relative, resolve, sep } from "node:path";
import type { CommandHookHandler, HookHandler } from "../types.js";

export interface ReferencedScriptResolution {
  readonly paths: readonly string[];
  readonly watchPaths: readonly string[];
  readonly executablePaths: readonly string[];
}

export interface CommandHookInvocation {
  readonly command: string;
  readonly args: readonly string[];
}

const PACKAGE_EXECUTABLES = new Set([
  "npm",
  "npm-cli",
  "npx",
  "pnpm",
  "pnpx",
  "yarn",
  "yarnpkg",
  "bun",
  "bunx",
  "corepack",
]);
const COMMAND_FORWARDERS = new Set([
  "command",
  "exec",
  "env",
  "sudo",
  "doas",
  "chroot",
  "timeout",
  "stdbuf",
  "nice",
  "nohup",
  "ionice",
]);
const NODE_EXECUTABLES = new Set(["node", "nodejs"]);
const FILE_INTERPRETERS = new Set([
  "sh",
  "bash",
  "dash",
  "zsh",
  "fish",
  "python",
  "python3",
  "ruby",
  "perl",
]);
const NODE_LOADER_OPTIONS = new Set(["--require", "--import", "--loader", "--experimental-loader"]);
const NODE_SAFE_FLAGS = new Set([
  "--enable-source-maps",
  "--no-warnings",
  "--trace-warnings",
  "--trace-deprecation",
  "--throw-deprecation",
  "--pending-deprecation",
  "--preserve-symlinks",
  "--preserve-symlinks-main",
  "--experimental-strip-types",
  "--no-experimental-strip-types",
  "--experimental-transform-types",
  "--use-strict",
]);
const NODE_SAFE_VALUE_OPTIONS = [
  "--unhandled-rejections=",
  "--stack-trace-limit=",
  "--max-old-space-size=",
  "--max-semi-space-size=",
  "--dns-result-order=",
] as const;
const NODE_DISPLAY_FLAGS = new Set(["--version", "-v", "--help", "-h"]);
const BLOCKED_ENVIRONMENT_NAMES = new Set([
  "BASH_ENV",
  "ENV",
  "ZDOTDIR",
  "SHELL",
  "COMSPEC",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_REPL_EXTERNAL_MODULE",
  "LD_PRELOAD",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
  "JAVA_TOOL_OPTIONS",
  "_JAVA_OPTIONS",
  "JDK_JAVA_OPTIONS",
]);
const BLOCKED_HANDLER_ENVIRONMENT_NAMES = new Set(["PATH", "PATHEXT"]);

/**
 * Command Hooks use a deliberately small exec-form grammar. Shell composition and expansion are
 * rejected instead of being interpreted differently by trust resolution and process spawning.
 */
export function resolveCommandHookInvocation(handler: CommandHookHandler): CommandHookInvocation {
  const command = handler.command.trim();
  if (!command) throw unsupportedCommand("命令为空");
  const words =
    handler.args === undefined ? parseStaticCommandLine(command) : [command, ...handler.args];
  const executable = words[0];
  if (!executable) throw unsupportedCommand("命令为空");
  const invocation = { command: executable, args: words.slice(1) };
  assertSupportedInvocation(invocation);
  return invocation;
}

/** Strip ambient loader hooks and reject handler-owned execution-path or loader injection. */
export function sanitizeCommandHookEnvironment(
  handler: CommandHookHandler,
  baseEnvironment: Readonly<NodeJS.ProcessEnv>,
): NodeJS.ProcessEnv {
  for (const name of Object.keys(handler.env ?? {})) {
    if (
      isBlockedEnvironmentName(name) ||
      BLOCKED_HANDLER_ENVIRONMENT_NAMES.has(name.toUpperCase())
    ) {
      throw unsupportedCommand(`handler.env 不允许覆盖 ${name}`);
    }
  }
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(baseEnvironment)) {
    if (!isBlockedEnvironmentName(name)) sanitized[name] = value;
  }
  return { ...sanitized, ...handler.env };
}

/** Backward-compatible export for the executor import used before the boundary was generalized. */
export const sanitizePackageInvocationEnvironment = sanitizeCommandHookEnvironment;

export async function resolveReferencedScripts(
  handler: HookHandler,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv> = process.env,
): Promise<ReferencedScriptResolution> {
  if (handler.type !== "command") {
    return { paths: [], watchPaths: [], executablePaths: [] };
  }
  const invocation = resolveCommandHookInvocation(handler);
  const sanitizedEnvironment = sanitizeCommandHookEnvironment(handler, environment);
  const executable = await resolveExecutable(invocation.command, workspace, sanitizedEnvironment);
  const executableName = executableBasename(executable);
  if (PACKAGE_EXECUTABLES.has(executableName)) {
    throw unsupportedCommand(`解析后的可执行文件属于 package-manager/runner: ${executableName}`);
  }
  const paths: string[] = [];

  if (isWithin(workspace, executable)) paths.push(executable);
  if (NODE_EXECUTABLES.has(executableName)) {
    paths.push(...(await resolveNodeCodePaths(invocation.args, workspace)));
  } else if (FILE_INTERPRETERS.has(executableName)) {
    const script = await resolveInterpreterScript(invocation.args, workspace, executableName);
    if (script) paths.push(script);
  }

  const uniquePaths = sortedUnique(paths);
  const canonicalPaths = await canonicalExistingPaths(uniquePaths);
  return {
    paths: canonicalPaths,
    watchPaths: sortedUnique([...uniquePaths, ...canonicalPaths]),
    executablePaths: [executable],
  };
}

/** Lexical compatibility helper; trust decisions must use resolveReferencedScripts instead. */
export function resolveReferencedScriptCandidates(
  handler: HookHandler,
  workspace: string,
): readonly string[] {
  if (handler.type !== "command") return [];
  const invocation = resolveCommandHookInvocation(handler);
  return sortedUnique(
    [invocation.command, ...invocation.args]
      .filter((value) => looksExplicitPath(value))
      .map((value) => resolve(workspace, value)),
  );
}

export async function existingReferencedScripts(
  handler: HookHandler,
  workspace: string,
): Promise<readonly string[]> {
  return (await resolveReferencedScripts(handler, workspace)).paths;
}

function assertSupportedInvocation(invocation: CommandHookInvocation): void {
  const name = executableBasename(invocation.command);
  if (PACKAGE_EXECUTABLES.has(name)) {
    throw unsupportedCommand(`不支持 package-manager/runner 命令 ${name}`);
  }
  if (COMMAND_FORWARDERS.has(name)) {
    throw unsupportedCommand(`不支持可转发其他命令的包装器 ${name}`);
  }
  if (NODE_EXECUTABLES.has(name)) assertSafeNodeInvocation(invocation.args);
  if (FILE_INTERPRETERS.has(name) && invocation.args.some(isInterpreterInlineCodeOption)) {
    throw unsupportedCommand(`${name} 的内联/模块执行模式无法绑定完整代码来源`);
  }
}

function assertSafeNodeInvocation(args: readonly string[]): void {
  for (const value of args) {
    if (value === "--run" || value.startsWith("--run=")) {
      throw unsupportedCommand("node --run 会执行未绑定的 package script");
    }
    if (
      value === "--env-file" ||
      value.startsWith("--env-file=") ||
      value === "--env-file-if-exists" ||
      value.startsWith("--env-file-if-exists=")
    ) {
      throw unsupportedCommand("node env-file 可注入运行时加载配置");
    }
  }
}

async function resolveNodeCodePaths(
  args: readonly string[],
  workspace: string,
): Promise<readonly string[]> {
  const paths: string[] = [];
  let entry: string | undefined;
  let displayOnly = args.length > 0;

  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--") {
      entry = args[index + 1];
      break;
    }
    const loader = nodeLoaderOption(value);
    if (loader) {
      const loaderValue = loader.attached ?? args[++index];
      if (!loaderValue) throw unsupportedCommand(`${loader.option} 缺少静态路径`);
      paths.push(await resolveExistingCodeFile(loaderValue, workspace, loader.option));
      displayOnly = false;
      continue;
    }
    if (NODE_DISPLAY_FLAGS.has(value)) continue;
    displayOnly = false;
    if (
      NODE_SAFE_FLAGS.has(value) ||
      NODE_SAFE_VALUE_OPTIONS.some((prefix) => value.startsWith(prefix))
    ) {
      continue;
    }
    if (value.startsWith("-")) {
      throw unsupportedCommand(`无法证明 Node 选项 ${value} 的代码来源`);
    }
    entry = value;
    break;
  }

  if (entry !== undefined) {
    const entryPath = await resolveExistingCodeFile(entry, workspace, "Node 入口", true);
    if (PACKAGE_EXECUTABLES.has(executableBasename(entryPath))) {
      throw unsupportedCommand("Node 入口属于 package-manager/runner");
    }
    paths.push(entryPath);
  } else if (!displayOnly) {
    throw unsupportedCommand("Node 命令缺少可绑定的普通文件入口");
  }
  return sortedUnique(paths);
}

function nodeLoaderOption(
  value: string,
): { readonly option: string; readonly attached?: string } | undefined {
  if (value.startsWith("-r") && value !== "-r") {
    return { option: "-r", attached: value.slice(2) };
  }
  if (value === "-r") return { option: value };
  for (const option of NODE_LOADER_OPTIONS) {
    if (value === option) return { option };
    if (value.startsWith(`${option}=`)) return { option, attached: value.slice(option.length + 1) };
  }
  return undefined;
}

async function resolveInterpreterScript(
  args: readonly string[],
  workspace: string,
  interpreter: string,
): Promise<string | undefined> {
  if (args.length === 0) {
    throw unsupportedCommand(`${interpreter} 缺少可绑定的普通文件入口`);
  }
  if (args[0]!.startsWith("-")) {
    throw unsupportedCommand(`无法证明 ${interpreter} 选项 ${args[0]} 的代码来源`);
  }
  return await resolveExistingCodeFile(args[0]!, workspace, `${interpreter} 入口`, true);
}

async function resolveExistingCodeFile(
  value: string,
  workspace: string,
  label: string,
  allowBareRelative = false,
): Promise<string> {
  if (isDynamicCodeReference(value) || (!allowBareRelative && isBareModuleReference(value))) {
    throw unsupportedCommand(`${label} 不是静态文件路径: ${value}`);
  }
  const logicalPath = isAbsolute(value) ? resolve(value) : resolve(workspace, value);
  let info;
  try {
    info = await lstat(logicalPath);
  } catch (error) {
    if (isErrno(error, "ENOENT")) throw unsupportedCommand(`${label} 不存在: ${value}`);
    throw error;
  }
  if (info.isDirectory()) throw unsupportedCommand(`${label} 不允许使用目录入口: ${value}`);
  const canonicalPath = await realpath(logicalPath);
  const canonicalInfo = await lstat(canonicalPath);
  if (!canonicalInfo.isFile()) throw unsupportedCommand(`${label} 不是普通文件: ${value}`);
  return canonicalPath;
}

async function resolveExecutable(
  command: string,
  workspace: string,
  environment: Readonly<NodeJS.ProcessEnv>,
): Promise<string> {
  if (looksExplicitPath(command)) {
    return await requireExecutable(
      isAbsolute(command) ? resolve(command) : resolve(workspace, command),
    );
  }
  const pathValue = environmentValue(environment, "PATH");
  if (!pathValue) throw unsupportedCommand(`PATH 中无法解析可执行文件 ${command}`);
  const extensions = executableExtensions(command, environment);
  for (const directory of pathValue.split(delimiter)) {
    if (!directory || !isAbsolute(directory)) {
      throw unsupportedCommand("继承 PATH 含相对目录，无法绑定可执行文件");
    }
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (await isExecutableFile(candidate)) return await realpath(candidate);
    }
  }
  throw unsupportedCommand(`PATH 中无法解析可执行文件 ${command}`);
}

async function requireExecutable(path: string): Promise<string> {
  if (!(await isExecutableFile(path)))
    throw unsupportedCommand(`可执行文件不存在或不可执行: ${path}`);
  return await realpath(path);
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() && !info.isSymbolicLink()) return false;
    await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableExtensions(command: string, environment: Readonly<NodeJS.ProcessEnv>): string[] {
  if (process.platform !== "win32" || /\.[^./\\]+$/u.test(command)) return [""];
  const pathExt = environmentValue(environment, "PATHEXT") ?? ".COM;.EXE;.BAT;.CMD";
  return [
    "",
    ...pathExt
      .split(";")
      .filter(Boolean)
      .map((value) => value.toLowerCase()),
  ];
}

function parseStaticCommandLine(command: string): string[] {
  const words: string[] = [];
  let word = "";
  let started = false;
  let quote: "single" | "double" | undefined;

  const finish = (): void => {
    if (!started) return;
    words.push(word);
    word = "";
    started = false;
  };

  for (let index = 0; index < command.length; index++) {
    const character = command[index]!;
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else word += character;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
      } else if (character === "\\") {
        const next = command[++index];
        if (next === undefined) throw unsupportedCommand("命令以不完整转义结尾");
        word += next;
      } else {
        if (character === "$" || character === "`") {
          throw unsupportedCommand("命令不允许 Shell 动态展开");
        }
        word += character;
      }
      started = true;
      continue;
    }
    if (character === "'") {
      quote = "single";
      started = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      started = true;
      continue;
    }
    if (character === "\\") {
      const next = command[++index];
      if (next === undefined) throw unsupportedCommand("命令以不完整转义结尾");
      word += next;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      finish();
      continue;
    }
    if (/[;&|<>()$`\r\n]/u.test(character)) {
      throw unsupportedCommand("命令含 Shell 组合、重定向或动态展开；请使用 command + args 形式");
    }
    if (/[?*[\]{}~]/u.test(character)) {
      throw unsupportedCommand("命令含 Shell glob/tilde 展开；请使用静态路径");
    }
    word += character;
    started = true;
  }
  if (quote) throw unsupportedCommand("命令含未闭合引号");
  finish();
  return words;
}

function isInterpreterInlineCodeOption(value: string): boolean {
  return (
    value === "-c" ||
    value === "-e" ||
    value === "-m" ||
    value.startsWith("-c") ||
    value.startsWith("-e")
  );
}

function isBlockedEnvironmentName(name: string): boolean {
  const normalized = name.toUpperCase();
  return BLOCKED_ENVIRONMENT_NAMES.has(normalized) || normalized.startsWith("DYLD_");
}

function executableBasename(path: string): string {
  return basename(path)
    .toLowerCase()
    .replace(/\.(?:exe|cmd|bat|com|js|mjs|cjs)$/u, "");
}

function looksExplicitPath(value: string): boolean {
  return (
    isAbsolute(value) || value.startsWith("./") || value.startsWith("../") || value.includes("\\")
  );
}

function isBareModuleReference(value: string): boolean {
  return (
    !isAbsolute(value) &&
    !value.startsWith("./") &&
    !value.startsWith("../") &&
    !value.includes("/")
  );
}

function isDynamicCodeReference(value: string): boolean {
  return /[$`*?[\]{}~\r\n]/u.test(value) || /^(?:data|node|file|https?):/iu.test(value);
}

async function canonicalExistingPaths(paths: readonly string[]): Promise<readonly string[]> {
  const canonical: string[] = [];
  for (const path of paths) canonical.push(await realpath(path));
  return sortedUnique(canonical);
}

function isWithin(root: string, path: string): boolean {
  const relation = relative(resolve(root), path);
  return (
    relation === "" ||
    (relation !== ".." && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

function environmentValue(
  environment: Readonly<NodeJS.ProcessEnv>,
  expectedName: string,
): string | undefined {
  const actualName = Object.keys(environment).find(
    (name) => name.toUpperCase() === expectedName.toUpperCase(),
  );
  return actualName ? environment[actualName] : undefined;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function unsupportedCommand(reason: string): Error {
  return new Error(`该 command Hook 无法建立完整静态信任: ${reason}`);
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}
