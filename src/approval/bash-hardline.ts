import { homedir } from "node:os";
import { posix } from "node:path";

interface ShellWord {
  readonly value: string;
  readonly dynamic: boolean;
  readonly quotedOrEscaped: boolean;
  readonly unquotedExpansion: boolean;
}

interface ParsedShell {
  readonly commands: readonly (readonly ShellWord[])[];
  readonly nestedCommands: readonly string[];
  readonly ambiguous: boolean;
}

/**
 * Bash hardline 纯判定。只识别不可审批绕过的系统级破坏，
 * 工作区内的普通递归删除仍交给 YOLO 正常执行。
 */
export function isHardlineBashCommand(command: string): boolean {
  return isHardlineBashCommandAtDepth(command, 0);
}

function isHardlineBashCommandAtDepth(command: string, depth: number): boolean {
  if (OTHER_HARDLINE_PATTERNS.some((pattern) => pattern.test(command))) return true;

  const parsed = parseShell(command);
  if (depth >= MAX_NESTED_COMMAND_DEPTH && parsed.nestedCommands.length > 0) {
    return true;
  }
  if (parsed.nestedCommands.some((nested) => isHardlineBashCommandAtDepth(nested, depth + 1))) {
    return true;
  }

  for (const words of parsed.commands) {
    if (isHardlineCommandWords(words, depth)) return true;
  }

  return parsed.ambiguous && hasAmbiguousDestructiveRmShape(parsed.commands);
}

function isHardlineCommandWords(words: readonly ShellWord[], depth: number): boolean {
  const executableIndex = findExecutableIndex(words);
  if (executableIndex < 0) return false;

  const executable = commandBasename(words[executableIndex]!.value);
  const args = words.slice(executableIndex + 1);
  if (executable === "rm") return isDestructiveRmInvocation(args, false);
  if (executable === "find" && isDestructiveFindInvocation(args)) return true;
  if (isMkfsExecutable(executable) && isDestructiveMkfsInvocation(args)) return true;
  if (executable === "dd" && isDestructiveDdInvocation(args)) return true;
  if (executable === "git" && isDestructiveGitInvocation(args)) return true;
  if (executable === "git-push" && isDestructiveGitPushInvocation(args)) return true;

  if (SHELL_COMMANDS.has(executable)) {
    const commandIndex = args.findIndex(
      (word) => word.value === "-c" || /^-[^-]*c/u.test(word.value),
    );
    if (commandIndex >= 0) {
      const nested = args[commandIndex + 1];
      if (!nested || nested.dynamic || depth >= MAX_NESTED_COMMAND_DEPTH) return true;
      return isHardlineBashCommandAtDepth(nested.value, depth + 1);
    }
  }

  if (executable === "eval") {
    if (args.length === 0 || args.some((word) => word.dynamic)) return true;
    return isHardlineBashCommandAtDepth(args.map((word) => word.value).join(" "), depth + 1);
  }

  if (RM_FORWARDING_COMMANDS.has(executable)) {
    const rmIndex = args.findIndex((word) => commandBasename(word.value) === "rm");
    if (rmIndex >= 0) {
      const dynamicTarget = executable === "find" || executable === "xargs";
      return isDestructiveRmInvocation(args.slice(rmIndex + 1), dynamicTarget);
    }
    const findIndex = args.findIndex((word) => commandBasename(word.value) === "find");
    if (findIndex >= 0 && isDestructiveFindInvocation(args.slice(findIndex + 1))) {
      return true;
    }
    const structuredHardlineIndex = args.findIndex((word) =>
      isStructuredHardlineExecutable(commandBasename(word.value)),
    );
    if (
      structuredHardlineIndex >= 0 &&
      isHardlineCommandWords(args.slice(structuredHardlineIndex), depth)
    ) {
      return true;
    }
    const nestedExecutableIndex = args.findIndex((word) => {
      const candidate = commandBasename(word.value);
      return candidate === "eval" || SHELL_COMMANDS.has(candidate);
    });
    if (
      nestedExecutableIndex >= 0 &&
      isHardlineCommandWords(args.slice(nestedExecutableIndex), depth)
    ) {
      return true;
    }
    const dynamicExecutableIndex = args.findIndex((word) => word.dynamic);
    if (
      dynamicExecutableIndex >= 0 &&
      isDestructiveRmInvocation(args.slice(dynamicExecutableIndex + 1), false)
    ) {
      return true;
    }
  }

  // 无法静态确认的可执行文件若携带 rm 的破坏性参数与系统目标，按 fail-closed 处理。
  return words[executableIndex]!.dynamic && isDestructiveRmInvocation(args, false);
}

function isDestructiveRmInvocation(
  args: readonly ShellWord[],
  hasImplicitDynamicTarget: boolean,
): boolean {
  let recursive = false;
  let force = false;
  let optionsEnded = false;
  let hasDynamicArgument = false;
  const targets: ShellWord[] = [];

  for (const word of args) {
    const value = word.value;
    if (word.dynamic) hasDynamicArgument = true;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("--")) {
      if (matchesLongOption(value, "--recursive")) recursive = true;
      if (matchesLongOption(value, "--force")) force = true;
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(value)) {
      const flags = value.slice(1);
      if (/[rR]/u.test(flags)) recursive = true;
      if (flags.includes("f")) force = true;
      continue;
    }
    targets.push(word);
  }

  const hasProtectedTarget = targets.some((target) => isProtectedRmTarget(target.value));
  // rm 的动态参数可能同时改写选项与目标，无法静态证明安全时直接 fail-closed。
  if (hasDynamicArgument || hasProtectedTarget) return true;
  if (!recursive || !force) return false;
  if (hasImplicitDynamicTarget && targets.length === 0) return true;
  return targets.some(
    (target) => isDynamicRmTarget(target.value) || isPotentiallyProtectedAbsoluteExpansion(target),
  );
}

function isDestructiveFindInvocation(args: readonly ShellWord[]): boolean {
  if (!args.some((word) => word.value === "-delete")) return false;

  const roots: ShellWord[] = [];
  let optionsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && FIND_PRE_PATH_OPTIONS.has(value)) continue;
    if (!optionsEnded && value === "-D") {
      index++;
      continue;
    }
    if (!optionsEnded && /^-O\d+$/u.test(value)) continue;
    if (!optionsEnded && isFindExpressionStart(value)) break;
    roots.push(word);
  }

  return roots.some(
    (root) =>
      root.dynamic ||
      isProtectedRmTarget(root.value) ||
      isPotentiallyProtectedAbsoluteExpansion(root),
  );
}

function isFindExpressionStart(value: string): boolean {
  return value === "!" || value === "(" || value === ")" || value.startsWith("-");
}

function isMkfsExecutable(executable: string): boolean {
  return /^mkfs(?:\.[a-z0-9_-]+)?$/iu.test(executable);
}

function isStructuredHardlineExecutable(executable: string): boolean {
  return (
    isMkfsExecutable(executable) ||
    executable === "dd" ||
    executable === "git" ||
    executable === "git-push"
  );
}

function isDestructiveMkfsInvocation(args: readonly ShellWord[]): boolean {
  return args.some(
    (word) =>
      word.dynamic || isDeviceTarget(word.value) || isPotentiallyProtectedAbsoluteExpansion(word),
  );
}

function isDestructiveDdInvocation(args: readonly ShellWord[]): boolean {
  return args.some((word) => {
    if (word.dynamic) return true;
    const output = word.value.match(/^of=(.*)$/su)?.[1];
    if (output === undefined) return false;
    return (
      isDeviceTarget(output) || isPotentiallyProtectedAbsoluteExpansion({ ...word, value: output })
    );
  });
}

function isDeviceTarget(target: string): boolean {
  const normalized = normalizeSlashPath(target.replaceAll("\\", "/"));
  return normalized === "/dev" || normalized.startsWith("/dev/");
}

function isDestructiveGitInvocation(args: readonly ShellWord[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(args);
  if (subcommandIndex < 0 || args[subcommandIndex]!.value !== "push") return false;
  return isDestructiveGitPushInvocation(args.slice(subcommandIndex + 1));
}

function findGitSubcommandIndex(args: readonly ShellWord[]): number {
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!.value;
    if (value === "--") return index + 1 < args.length ? index + 1 : -1;
    if (GIT_GLOBAL_OPTIONS_WITH_VALUE.has(value)) {
      index++;
      continue;
    }
    if (/^-(?:C|c).+/u.test(value) || /^--[^=]+=/u.test(value)) continue;
    if (value.startsWith("-")) continue;
    return index;
  }
  return -1;
}

function isDestructiveGitPushInvocation(args: readonly ShellWord[]): boolean {
  return args.some((word) => {
    const value = word.value;
    return (
      word.dynamic ||
      matchesLongOption(value, "--force") ||
      matchesLongOption(value, "--force-with-lease") ||
      /^-[^-]*f/u.test(value) ||
      (value.startsWith("+") && value.length > 1)
    );
  });
}

function isProtectedRmTarget(target: string): boolean {
  if (!target) return false;
  if (target === ".." || target.startsWith("../")) return true;
  if (isHomeExpression(target)) return true;

  const slashPath = target.replaceAll("\\", "/");
  const normalizedTarget = normalizeSlashPath(slashPath);
  if (normalizedTarget === ".." || normalizedTarget.startsWith("../")) return true;
  if (/^[A-Za-z]:\/$/u.test(normalizedTarget)) return true;
  if (/^[A-Za-z]:\/(?:[*.?{[]|$)/u.test(normalizedTarget)) return true;
  if (
    /^[A-Za-z]:\/(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:\/|$)/iu.test(
      normalizedTarget,
    )
  ) {
    return true;
  }

  const normalizedHome = normalizeSlashPath(homedir().replaceAll("\\", "/"));
  const caseInsensitiveHome = /^[A-Za-z]:\//u.test(normalizedTarget);
  const comparableTarget = caseInsensitiveHome ? normalizedTarget.toLowerCase() : normalizedTarget;
  const comparableHome = caseInsensitiveHome ? normalizedHome.toLowerCase() : normalizedHome;
  if (
    comparableTarget === comparableHome ||
    isWholeDirectoryContents(comparableTarget, comparableHome)
  ) {
    return true;
  }
  if (isAbsoluteUserRoot(normalizedTarget)) return true;
  if (isAbsoluteUserProfileTarget(normalizedTarget)) return true;

  if (!slashPath.startsWith("/")) return false;
  const normalized = normalizedTarget;
  if (normalized === "/" || /^\/(?:[*.?{[])/u.test(normalized)) return true;
  if (
    /^\/[a-z](?:\/?$|\/(?:windows|program files(?: \(x86\))?|programdata)(?:\/|$))/iu.test(
      normalized,
    )
  ) {
    return true;
  }

  const lower = normalized.toLowerCase();
  return CRITICAL_POSIX_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`));
}

function normalizeSlashPath(target: string): string {
  const drive = target.match(/^([A-Za-z]):(\/.*)$/u);
  if (!drive) return posix.normalize(target);
  return `${drive[1]!.toUpperCase()}:${posix.normalize(drive[2]!)}`;
}

function isAbsoluteUserRoot(target: string): boolean {
  return (
    /^\/(?:home|Users)$/iu.test(target) ||
    /^[A-Za-z]:\/Users$/iu.test(target) ||
    /^\/[A-Za-z]\/Users$/iu.test(target)
  );
}

function isPotentiallyProtectedAbsoluteExpansion(target: ShellWord): boolean {
  if (!target.unquotedExpansion) return false;

  const slashPath = target.value.replaceAll("\\", "/");
  const normalized = normalizeSlashPath(slashPath);
  const expansionIndex = normalized.search(/[?*[{~$]/u);
  if (expansionIndex >= 0 && expansionTouchesAbsoluteRootComponent(normalized, expansionIndex)) {
    return true;
  }
  return braceMayProduceAbsoluteTarget(slashPath);
}

function expansionTouchesAbsoluteRootComponent(target: string, expansionIndex: number): boolean {
  if (target.startsWith("/")) {
    const componentEnd = target.indexOf("/", 1);
    return componentEnd < 0 || expansionIndex < componentEnd;
  }
  if (/^[A-Za-z]:\//u.test(target)) {
    const componentEnd = target.indexOf("/", 3);
    return componentEnd < 0 || expansionIndex < componentEnd;
  }
  return false;
}

function braceMayProduceAbsoluteTarget(target: string): boolean {
  if (!target.includes("{")) return false;
  if (/(?:^|[,{])\/(?:[^}]*)/u.test(target)) return true;
  if (/(?:^|[,{])[A-Za-z]:\//u.test(target)) return true;

  const closingBrace = target.indexOf("}");
  if (!target.startsWith("{") || closingBrace < 0 || target[closingBrace + 1] !== "/") {
    return false;
  }
  return target
    .slice(1, closingBrace)
    .split(",")
    .some((alternative) => alternative.length === 0);
}

function isDynamicRmTarget(target: string): boolean {
  return target === "{}" || target === "{+}";
}

function isHomeExpression(target: string): boolean {
  const slashPath = target.replaceAll("\\", "/");
  if (/^~[^/]*(?:\/.*)?$/u.test(slashPath)) return true;
  return /^(?:\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|%USERPROFILE%)(?:\/.*)?$/iu.test(
    slashPath,
  );
}

function isWholeDirectoryContents(target: string, directory: string): boolean {
  if (directory === "/") return false;
  const suffix = target.slice(directory.length);
  return target.startsWith(`${directory}/`) && /^\/(?:[*.?{[])/u.test(suffix);
}

function isAbsoluteUserProfileTarget(target: string): boolean {
  const match = target.match(/^(?:\/(?:home|Users)|[A-Za-z]:\/Users|\/[A-Za-z]\/Users)\/[^/]+/iu);
  if (!match) return false;
  const profileRoot = match[0];
  return target === profileRoot || isWholeDirectoryContents(target, profileRoot);
}

function hasAmbiguousDestructiveRmShape(commands: readonly (readonly ShellWord[])[]): boolean {
  return commands.some((words) => {
    const rmIndex = words.findIndex((word) => commandBasename(word.value) === "rm");
    return rmIndex >= 0 && hasRecursiveAndForceFlags(words.slice(rmIndex + 1));
  });
}

function hasRecursiveAndForceFlags(words: readonly ShellWord[]): boolean {
  let recursive = false;
  let force = false;
  for (const word of words) {
    if (matchesLongOption(word.value, "--recursive")) recursive = true;
    if (matchesLongOption(word.value, "--force")) force = true;
    if (/^-[^-]/u.test(word.value)) {
      const flags = word.value.slice(1);
      if (/[rR]/u.test(flags)) recursive = true;
      if (flags.includes("f")) force = true;
    }
  }
  return recursive && force;
}

function matchesLongOption(
  value: string,
  canonical: "--recursive" | "--force" | "--force-with-lease",
): boolean {
  const optionName = value.split("=", 1)[0]!;
  return optionName.length > 2 && canonical.startsWith(optionName);
}

function parseShell(command: string): ParsedShell {
  const commands: ShellWord[][] = [];
  const nestedCommands: string[] = [];
  let words: ShellWord[] = [];
  let value = "";
  let dynamic = false;
  let quotedOrEscaped = false;
  let unquotedExpansion = false;
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let ambiguous = false;

  const finishWord = (): void => {
    if (!tokenStarted) return;
    words.push({ value, dynamic, quotedOrEscaped, unquotedExpansion });
    value = "";
    dynamic = false;
    quotedOrEscaped = false;
    unquotedExpansion = false;
    tokenStarted = false;
  };
  const finishCommand = (): void => {
    finishWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else value += char;
      tokenStarted = true;
      continue;
    }

    if (char === "`") {
      const substitution = readBacktickSubstitution(command, index + 1);
      nestedCommands.push(substitution.content);
      value += "__dynamic__";
      dynamic = true;
      if (quote !== "double") unquotedExpansion = true;
      tokenStarted = true;
      index = substitution.endIndex;
      if (!substitution.closed) ambiguous = true;
      continue;
    }

    if (char === "$" && next === "(") {
      const substitution = readDollarSubstitution(command, index + 2);
      nestedCommands.push(substitution.content);
      value += "__dynamic__";
      dynamic = true;
      if (quote !== "double") unquotedExpansion = true;
      tokenStarted = true;
      index = substitution.endIndex;
      if (!substitution.closed) ambiguous = true;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (char === "\\") {
        if (next === undefined) {
          ambiguous = true;
          continue;
        }
        if (next === "$" || next === "`" || next === '"' || next === "\\") {
          value += next;
          index++;
        } else if (next === "\n") {
          index++;
        } else {
          value += char;
        }
        tokenStarted = true;
        continue;
      }
      if (char === "$") dynamic = true;
      value += char;
      tokenStarted = true;
      continue;
    }

    if (char === "'") {
      quote = "single";
      quotedOrEscaped = true;
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      quotedOrEscaped = true;
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) {
        ambiguous = true;
        continue;
      }
      if (next !== "\n") value += next;
      quotedOrEscaped = true;
      tokenStarted = true;
      index++;
      continue;
    }
    if (char === "$" || char === "~") {
      if (char === "$") dynamic = true;
      unquotedExpansion = true;
      value += char;
      tokenStarted = true;
      continue;
    }
    if (char === "#" && !tokenStarted) {
      finishCommand();
      while (index + 1 < command.length && command[index + 1] !== "\n") index++;
      continue;
    }
    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      finishCommand();
      continue;
    }
    if (char === "(" || char === ")") {
      if (tokenStarted) ambiguous = true;
      finishCommand();
      continue;
    }
    if (
      (char === "{" || char === "}") &&
      !tokenStarted &&
      isStandaloneGroupingBrace(command, index)
    ) {
      finishCommand();
      continue;
    }
    if (/\s/u.test(char)) {
      finishWord();
      continue;
    }
    if (char === "*" || char === "?" || char === "[" || char === "{" || char === "}") {
      unquotedExpansion = true;
    }
    value += char;
    tokenStarted = true;
  }

  if (quote !== undefined) ambiguous = true;
  finishCommand();
  return { commands, nestedCommands, ambiguous };
}

function isStandaloneGroupingBrace(command: string, index: number): boolean {
  const previous = command[index - 1];
  const next = command[index + 1];
  const isBoundary = (char: string | undefined): boolean =>
    char === undefined || /[\s;&|()]/u.test(char);
  return isBoundary(previous) && isBoundary(next);
}

function readDollarSubstitution(
  command: string,
  startIndex: number,
): { content: string; endIndex: number; closed: boolean } {
  let depth = 1;
  let quote: "single" | "double" | undefined;
  for (let index = startIndex; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];
    if (char === "\\") {
      index++;
      continue;
    }
    if (quote === "single") {
      if (char === "'") quote = undefined;
      continue;
    }
    if (char === "'") {
      quote = "single";
      continue;
    }
    if (char === '"') {
      quote = quote === "double" ? undefined : "double";
      continue;
    }
    if (char === "$" && next === "(") {
      depth++;
      index++;
      continue;
    }
    if (char === ")" && quote !== "double" && --depth === 0) {
      return { content: command.slice(startIndex, index), endIndex: index, closed: true };
    }
  }
  return {
    content: command.slice(startIndex),
    endIndex: command.length - 1,
    closed: false,
  };
}

function readBacktickSubstitution(
  command: string,
  startIndex: number,
): { content: string; endIndex: number; closed: boolean } {
  for (let index = startIndex; index < command.length; index++) {
    if (command[index] === "\\") {
      index++;
      continue;
    }
    if (command[index] === "`") {
      return { content: command.slice(startIndex, index), endIndex: index, closed: true };
    }
  }
  return {
    content: command.slice(startIndex),
    endIndex: command.length - 1,
    closed: false,
  };
}

function isEnvironmentAssignment(value: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(value);
}

function findExecutableIndex(words: readonly ShellWord[]): number {
  return words.findIndex(
    (word) =>
      !isEnvironmentAssignment(word.value) &&
      (word.quotedOrEscaped || !SHELL_CONTROL_PREFIXES.has(word.value.toLowerCase())),
  );
}

function commandBasename(command: string): string {
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? command;
}

const MAX_NESTED_COMMAND_DEPTH = 8;

const SHELL_COMMANDS: ReadonlySet<string> = new Set(["bash", "dash", "ksh", "sh", "zsh"]);

const SHELL_CONTROL_PREFIXES: ReadonlySet<string> = new Set([
  "!",
  "coproc",
  "do",
  "elif",
  "else",
  "if",
  "then",
  "until",
  "while",
]);

const RM_FORWARDING_COMMANDS: ReadonlySet<string> = new Set([
  "builtin",
  "busybox",
  "chroot",
  "command",
  "doas",
  "env",
  "exec",
  "find",
  "nice",
  "nohup",
  "sudo",
  "time",
  "timeout",
  "toybox",
  "xargs",
]);

const FIND_PRE_PATH_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P"]);

const GIT_GLOBAL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-c",
  "--config-env",
  "--exec-path",
  "--git-dir",
  "--namespace",
  "--super-prefix",
  "--work-tree",
]);

const CRITICAL_POSIX_ROOTS: readonly string[] = [
  "/applications",
  "/bin",
  "/boot",
  "/dev",
  "/etc",
  "/lib",
  "/lib64",
  "/library",
  "/opt",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/system",
  "/usr",
  "/var",
];

const OTHER_HARDLINE_PATTERNS: readonly RegExp[] = [
  /:\(\)\s*\{/u,
  /\bshutdown\b/iu,
  /\breboot\b/iu,
];
