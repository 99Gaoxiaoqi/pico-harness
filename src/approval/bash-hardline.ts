import { homedir } from "node:os";
import { posix } from "node:path";

interface ShellWord {
  readonly value: string;
  readonly dynamic: boolean;
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
  const executableIndex = words.findIndex((word) => !isEnvironmentAssignment(word.value));
  if (executableIndex < 0) return false;

  const executable = commandBasename(words[executableIndex]!.value);
  const args = words.slice(executableIndex + 1);
  if (executable === "rm") return isDestructiveRmInvocation(args, false);

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
      if (value === "--recursive") recursive = true;
      if (value === "--force") force = true;
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
  if (!recursive || !force) return hasDynamicArgument && hasProtectedTarget;
  if (hasImplicitDynamicTarget && targets.length === 0) return true;
  return targets.some(
    (target) =>
      target.dynamic || isDynamicRmTarget(target.value) || isProtectedRmTarget(target.value),
  );
}

function isProtectedRmTarget(target: string): boolean {
  if (!target) return false;
  if (target === ".." || target.startsWith("../")) return true;
  if (isHomeExpression(target)) return true;

  const slashPath = target.replaceAll("\\", "/");
  if (/^[A-Za-z]:\/(?:[*.?{[]|$)/u.test(slashPath)) return true;
  if (/^[A-Za-z]:\/(?:Windows|Program Files(?: \(x86\))?|ProgramData)(?:\/|$)/iu.test(slashPath)) {
    return true;
  }

  const normalizedTarget = posix.normalize(slashPath);
  const normalizedHome = posix.normalize(homedir().replaceAll("\\", "/"));
  const caseInsensitiveHome = /^[A-Za-z]:\//u.test(normalizedTarget);
  const comparableTarget = caseInsensitiveHome ? normalizedTarget.toLowerCase() : normalizedTarget;
  const comparableHome = caseInsensitiveHome ? normalizedHome.toLowerCase() : normalizedHome;
  if (
    comparableTarget === comparableHome ||
    isWholeDirectoryContents(comparableTarget, comparableHome)
  ) {
    return true;
  }

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

  if (/^\/(?:home|Users)\/[^/]+\/?$/u.test(normalized)) return true;

  const lower = normalized.toLowerCase();
  return CRITICAL_POSIX_ROOTS.some((root) => lower === root || lower.startsWith(`${root}/`));
}

function isDynamicRmTarget(target: string): boolean {
  return target === "{}" || target === "{+}";
}

function isHomeExpression(target: string): boolean {
  if (/^~(?:[^/]*)(?:\/?|\/(?:[*.?{[]).*)$/u.test(target)) return true;
  return /^(?:\$HOME|\$\{HOME\}|\$USERPROFILE|\$\{USERPROFILE\}|%USERPROFILE%)(?:\/?|\/(?:[*.?{[]).*)$/iu.test(
    target,
  );
}

function isWholeDirectoryContents(target: string, directory: string): boolean {
  if (directory === "/") return false;
  const suffix = target.slice(directory.length);
  return target.startsWith(`${directory}/`) && /^\/(?:[*.?{[])/u.test(suffix);
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
    if (word.value === "--recursive") recursive = true;
    if (word.value === "--force") force = true;
    if (/^-[^-]/u.test(word.value)) {
      const flags = word.value.slice(1);
      if (/[rR]/u.test(flags)) recursive = true;
      if (flags.includes("f")) force = true;
    }
  }
  return recursive && force;
}

function parseShell(command: string): ParsedShell {
  const commands: ShellWord[][] = [];
  const nestedCommands: string[] = [];
  let words: ShellWord[] = [];
  let value = "";
  let dynamic = false;
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let ambiguous = false;

  const finishWord = (): void => {
    if (!tokenStarted) return;
    words.push({ value, dynamic });
    value = "";
    dynamic = false;
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
      tokenStarted = true;
      continue;
    }
    if (char === '"') {
      quote = "double";
      tokenStarted = true;
      continue;
    }
    if (char === "\\") {
      if (next === undefined) {
        ambiguous = true;
        continue;
      }
      if (next !== "\n") value += next;
      tokenStarted = true;
      index++;
      continue;
    }
    if (char === "$" || char === "~") {
      if (char === "$") dynamic = true;
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
    if ((char === "(" || char === ")") && !tokenStarted) {
      finishCommand();
      continue;
    }
    if (/\s/u.test(char)) {
      finishWord();
      continue;
    }
    value += char;
    tokenStarted = true;
  }

  if (quote !== undefined) ambiguous = true;
  finishCommand();
  return { commands, nestedCommands, ambiguous };
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

function commandBasename(command: string): string {
  return command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? command;
}

const MAX_NESTED_COMMAND_DEPTH = 8;

const SHELL_COMMANDS: ReadonlySet<string> = new Set(["bash", "dash", "ksh", "sh", "zsh"]);

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
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//iu,
  /\bdd\s+if=.*\bof=\/dev\//iu,
  /:\(\)\s*\{/u,
  /\bshutdown\b/iu,
  /\breboot\b/iu,
  /\bgit\s+push\s+(?:-f|--force)\s+.*\b(?:main|master)\b/iu,
];
