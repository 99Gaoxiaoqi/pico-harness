import { homedir } from "node:os";
import { posix } from "node:path";

interface ShellWord {
  readonly value: string;
  readonly dynamic: boolean;
  readonly quotedOrEscaped: boolean;
  readonly unquotedExpansion: boolean;
  readonly outputRedirection: boolean;
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
  if (hasDestructiveOutputRedirection(words)) return true;

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
  if (executable === "env" && hasEnvSplitString(args)) return true;
  if (POWER_COMMANDS.has(executable)) return true;
  if (POWER_MANAGERS.has(executable) && isPowerManagerInvocation(executable, args)) return true;
  if (executable === "wipefs" && isDestructiveWipefsInvocation(args)) return true;
  if (PERMISSION_COMMANDS.has(executable) && isProtectedMutationInvocation(args)) return true;
  if (
    NATIVE_MUTATION_COMMANDS.has(executable) &&
    isDestructiveNativeMutationInvocation(executable, args)
  ) {
    return true;
  }

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
    if (dynamicExecutableIndex === 0) {
      return true;
    }
  }

  // 可执行文件本身来自 shell 展开时无法证明不会落到系统级破坏命令。
  return words[executableIndex]!.dynamic;
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

  const hasProtectedTarget = targets.some(
    (target) =>
      isProtectedRmTarget(target.value) || isPotentiallyProtectedAbsoluteExpansion(target),
  );
  // rm 的动态参数可能同时改写选项与目标，无法静态证明安全时直接 fail-closed。
  if (hasDynamicArgument || hasProtectedTarget) return true;
  if (!recursive || !force) return false;
  if (hasImplicitDynamicTarget && targets.length === 0) return true;
  return targets.some(
    (target) => isDynamicRmTarget(target.value) || isPotentiallyProtectedAbsoluteExpansion(target),
  );
}

function isDestructiveFindInvocation(args: readonly ShellWord[]): boolean {
  const hasDelete = args.some((word) => word.value === "-delete");
  const hasExternalRoots = args.some(
    (word) => word.value === "-files0-from" || word.value.startsWith("-files0-from="),
  );
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

  const hasProtectedRoot =
    hasExternalRoots ||
    roots.some(
      (root) =>
        root.dynamic ||
        isProtectedRmTarget(root.value) ||
        isPotentiallyProtectedAbsoluteExpansion(root),
    );
  if (!hasProtectedRoot) return false;
  return hasDelete || hasFindDestructiveExecutor(args);
}

function hasFindDestructiveExecutor(args: readonly ShellWord[]): boolean {
  for (let index = 0; index < args.length; index++) {
    if (!FIND_EXEC_ACTIONS.has(args[index]!.value)) continue;
    const endIndex = args.findIndex(
      (word, candidateIndex) =>
        candidateIndex > index && (word.value === ";" || word.value === "+"),
    );
    const command = args.slice(index + 1, endIndex < 0 ? args.length : endIndex);
    if (isFindDestructiveCommand(command)) return true;
  }
  return false;
}

function isFindDestructiveCommand(command: readonly ShellWord[]): boolean {
  let executableIndex = 0;
  while (executableIndex < command.length) {
    const executable = command[executableIndex]!;
    if (executable.dynamic) return true;
    const name = commandBasename(executable.value);
    if (FIND_DESTRUCTIVE_EXECUTABLES.has(name)) return true;
    if (!FIND_EXEC_FORWARDERS.has(name)) return false;
    executableIndex = findForwardedCommandIndex(name, command, executableIndex + 1);
    if (executableIndex < 0) return false;
  }
  return false;
}

function findForwardedCommandIndex(
  wrapper: string,
  words: readonly ShellWord[],
  startIndex: number,
): number {
  let skipOperand = wrapper === "chroot" || wrapper === "timeout" ? 1 : 0;
  const optionsWithValue = FIND_WRAPPER_OPTIONS_WITH_VALUE.get(wrapper) ?? EMPTY_STRING_SET;
  for (let index = startIndex; index < words.length; index++) {
    const value = words[index]!.value;
    if (value === "--") return index + 1 < words.length ? index + 1 : -1;
    if (wrapper === "env" && isEnvironmentAssignment(value)) continue;
    if (value.startsWith("--")) {
      const optionName = value.split("=", 1)[0]!;
      if (optionsWithValue.has(optionName) && !value.includes("=")) index++;
      continue;
    }
    if (/^-[^-]/u.test(value)) {
      if (optionsWithValue.has(value)) index++;
      continue;
    }
    if (skipOperand > 0) {
      skipOperand--;
      continue;
    }
    return index;
  }
  return -1;
}

function isFindExpressionStart(value: string): boolean {
  return value === "!" || value === "(" || value === ")" || value.startsWith("-");
}

function isMkfsExecutable(executable: string): boolean {
  return (
    /^mkfs(?:\.[a-z0-9_-]+)?$/iu.test(executable) ||
    /^(?:mke2fs|mkdosfs|newfs(?:_[a-z0-9_-]+)?)$/iu.test(executable)
  );
}

function isStructuredHardlineExecutable(executable: string): boolean {
  return (
    isMkfsExecutable(executable) ||
    executable === "dd" ||
    executable === "env" ||
    executable === "git" ||
    executable === "git-push" ||
    executable === "wipefs" ||
    POWER_COMMANDS.has(executable) ||
    POWER_MANAGERS.has(executable) ||
    PERMISSION_COMMANDS.has(executable) ||
    NATIVE_MUTATION_COMMANDS.has(executable)
  );
}

function isDestructiveMkfsInvocation(args: readonly ShellWord[]): boolean {
  return args.some((word) => isProtectedMutationTarget(word));
}

function isDestructiveDdInvocation(args: readonly ShellWord[]): boolean {
  return args.some((word) => {
    if (word.dynamic) return true;
    const output = word.value.match(/^of=(.*)$/su)?.[1];
    if (output === undefined) return false;
    const outputTarget = { ...word, value: output };
    return isProtectedMutationTarget(outputTarget);
  });
}

function isDestructiveGitInvocation(args: readonly ShellWord[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(args);
  if (subcommandIndex < 0) return false;
  if (args[subcommandIndex]!.dynamic) {
    return isDestructiveGitPushInvocation(args.slice(subcommandIndex + 1));
  }
  if (args[subcommandIndex]!.value !== "push") return false;
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
      matchesLongOption(value, "--delete") ||
      matchesLongOption(value, "--mirror") ||
      matchesLongOption(value, "--prune") ||
      /^-[^-]*f/u.test(value) ||
      /^-[^-]*d/u.test(value) ||
      ((value.startsWith("+") || value.startsWith(":")) && value.length > 1)
    );
  });
}

function hasEnvSplitString(args: readonly ShellWord[]): boolean {
  for (const word of args) {
    const value = word.value;
    if (value === "--") return false;
    if (/^-[^-]*S/u.test(value)) return true;
    if (value === "--split-string" || value.startsWith("--split-string=")) return true;
  }
  return false;
}

function isPowerManagerInvocation(executable: string, args: readonly ShellWord[]): boolean {
  if (executable === "init" || executable === "telinit") {
    return args.some((word) => word.dynamic || word.value === "0" || word.value === "6");
  }
  if (args.some((word) => word.dynamic || POWER_ACTIONS.has(word.value.toLowerCase()))) {
    return true;
  }
  if (executable !== "systemctl") return false;
  const hasActivatingAction = args.some((word) =>
    POWER_TARGET_ACTIONS.has(word.value.toLowerCase()),
  );
  return hasActivatingAction && args.some((word) => POWER_TARGETS.has(word.value.toLowerCase()));
}

function isDestructiveWipefsInvocation(args: readonly ShellWord[]): boolean {
  const destructive = args.some((word) => {
    const value = word.value;
    return (
      word.dynamic ||
      value === "--all" ||
      value === "--offset" ||
      value.startsWith("--offset=") ||
      (/^-[^-]/u.test(value) && /[ao]/u.test(value.slice(1)))
    );
  });
  return destructive && args.some((word) => isProtectedMutationTarget(word));
}

function isProtectedMutationInvocation(args: readonly ShellWord[]): boolean {
  return args.some((word) => isProtectedMutationTarget(word));
}

function isProtectedMutationTarget(target: ShellWord): boolean {
  return (
    target.dynamic ||
    isProtectedRmTarget(target.value) ||
    isPotentiallyProtectedAbsoluteExpansion(target)
  );
}

function isDestructiveNativeMutationInvocation(
  executable: string,
  args: readonly ShellWord[],
): boolean {
  switch (executable) {
    case "cp":
    case "install":
    case "ln":
      return isProtectedDestinationInvocation(executable, args);
    case "mv":
      return isProtectedMoveInvocation(args);
    case "sed":
      return isProtectedSedInPlaceInvocation(args);
    case "shred":
      return hasProtectedUtilityOperand(args, SHRED_OPTIONS_WITH_VALUE);
    case "tee":
      return hasProtectedUtilityOperand(args, EMPTY_STRING_SET);
    case "truncate":
      return hasProtectedUtilityOperand(args, TRUNCATE_OPTIONS_WITH_VALUE);
    case "rmdir":
    case "unlink":
      return hasProtectedUtilityOperand(args, EMPTY_STRING_SET);
    default:
      return false;
  }
}

function isProtectedDestinationInvocation(
  executable: "cp" | "install" | "ln",
  args: readonly ShellWord[],
): boolean {
  const optionsWithValue =
    executable === "install" ? INSTALL_OPTIONS_WITH_VALUE : COPY_OPTIONS_WITH_VALUE;
  const parsed = collectUtilityOperands(args, optionsWithValue, true);
  if (parsed.targetDirectory && isProtectedMutationTarget(parsed.targetDirectory)) return true;

  const directoryMode =
    executable === "install" &&
    args.some((word) => word.value === "-d" || word.value === "--directory");
  if (directoryMode) {
    return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
  }
  if (parsed.operands.length < 2) return false;
  return isProtectedMutationTarget(parsed.operands.at(-1)!);
}

function isProtectedMoveInvocation(args: readonly ShellWord[]): boolean {
  const parsed = collectUtilityOperands(args, COPY_OPTIONS_WITH_VALUE, true);
  if (parsed.targetDirectory && isProtectedMutationTarget(parsed.targetDirectory)) return true;
  return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
}

function isProtectedSedInPlaceInvocation(args: readonly ShellWord[]): boolean {
  const inPlace = args.some(
    (word) => /^-[^-]*i/u.test(word.value) || word.value.startsWith("--in-place"),
  );
  if (!inPlace) return false;

  const files: ShellWord[] = [];
  let hasExplicitScript = false;
  let consumedDefaultScript = false;
  let optionsEnded = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && SED_SCRIPT_OPTIONS.has(value)) {
      hasExplicitScript = true;
      index++;
      continue;
    }
    if (
      !optionsEnded &&
      SED_SCRIPT_OPTIONS_WITH_VALUE_PREFIX.some((prefix) => value.startsWith(prefix))
    ) {
      hasExplicitScript = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("-")) continue;
    if (!hasExplicitScript && !consumedDefaultScript) {
      consumedDefaultScript = true;
      continue;
    }
    files.push(word);
  }
  return files.some((file) => isProtectedMutationTarget(file));
}

function hasProtectedUtilityOperand(
  args: readonly ShellWord[],
  optionsWithValue: ReadonlySet<string>,
): boolean {
  return collectUtilityOperands(args, optionsWithValue, false).operands.some((operand) =>
    isProtectedMutationTarget(operand),
  );
}

function collectUtilityOperands(
  args: readonly ShellWord[],
  optionsWithValue: ReadonlySet<string>,
  supportsTargetDirectory: boolean,
): { operands: ShellWord[]; targetDirectory?: ShellWord } {
  const operands: ShellWord[] = [];
  let targetDirectory: ShellWord | undefined;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && supportsTargetDirectory) {
      if (value === "-t" || value === "--target-directory") {
        targetDirectory = args[index + 1];
        index++;
        continue;
      }
      if (value.startsWith("--target-directory=")) {
        targetDirectory = {
          ...word,
          value: value.slice("--target-directory=".length),
        };
        continue;
      }
      if (value.startsWith("-t") && value.length > 2) {
        targetDirectory = { ...word, value: value.slice(2) };
        continue;
      }
    }
    if (!optionsEnded && value.startsWith("--")) {
      const optionName = value.split("=", 1)[0]!;
      if (optionsWithValue.has(optionName) && !value.includes("=")) index++;
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(value)) {
      const option = [...optionsWithValue].find(
        (candidate) => candidate.length === 2 && value.startsWith(candidate),
      );
      if (option && value === option) index++;
      continue;
    }
    operands.push(word);
  }

  return {
    operands,
    ...(targetDirectory ? { targetDirectory } : {}),
  };
}

function hasDestructiveOutputRedirection(words: readonly ShellWord[]): boolean {
  for (let index = 0; index < words.length; index++) {
    const redirection = words[index]!;
    if (!redirection.outputRedirection) continue;

    const match = redirection.value.match(/^(?:\d+|\{[^}]+\}|&)?(?:>\||>>?)(.*)$/su);
    if (!match) continue;
    let attachedTarget = match[1] ?? "";
    let target: ShellWord | undefined;

    if (attachedTarget === "" || attachedTarget === "&") {
      target = words[index + 1];
    } else if (/^&(?:\d+|-)$/u.test(attachedTarget)) {
      continue;
    } else {
      if (attachedTarget.startsWith("&")) attachedTarget = attachedTarget.slice(1);
      target = { ...redirection, value: attachedTarget, outputRedirection: false };
    }

    if (target && isProtectedMutationTarget(target)) return true;
  }
  return false;
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
  const expansionIndex = normalized.search(/[?*[{~$@+!]/u);
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
  canonical: "--delete" | "--force" | "--force-with-lease" | "--mirror" | "--prune" | "--recursive",
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
  let outputRedirection = false;
  let extglobDepth = 0;
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;
  let ambiguous = false;

  const finishWord = (): void => {
    if (!tokenStarted) return;
    words.push({ value, dynamic, quotedOrEscaped, unquotedExpansion, outputRedirection });
    value = "";
    dynamic = false;
    quotedOrEscaped = false;
    unquotedExpansion = false;
    outputRedirection = false;
    if (extglobDepth > 0) ambiguous = true;
    extglobDepth = 0;
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
    if (extglobDepth > 0) {
      value += char;
      if (char === "(") extglobDepth++;
      if (char === ")") extglobDepth--;
      if (/\s/u.test(char)) ambiguous = true;
      tokenStarted = true;
      continue;
    }
    if (char === "(" && /[@?!+*]$/u.test(value)) {
      value += char;
      unquotedExpansion = true;
      extglobDepth = 1;
      tokenStarted = true;
      continue;
    }
    if (char === "&" && next === ">") {
      if (tokenStarted) finishWord();
      value = "&";
      outputRedirection = true;
      tokenStarted = true;
      continue;
    }
    if (char === ">") {
      if (outputRedirection && outputRedirectionHasTarget(value)) {
        finishWord();
      } else if (!outputRedirection && tokenStarted && !canPrefixOutputRedirection(value)) {
        finishWord();
      }
      outputRedirection = true;
      value += char;
      tokenStarted = true;
      continue;
    }
    if (outputRedirection && value.endsWith(">") && (char === "&" || char === "|")) {
      value += char;
      tokenStarted = true;
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

function canPrefixOutputRedirection(value: string): boolean {
  return /^(?:\d+|\{[^}]+\})$/u.test(value);
}

function outputRedirectionHasTarget(value: string): boolean {
  const target = value.match(/^(?:\d+|\{[^}]+\}|&)?(?:>\||>>?)(.*)$/su)?.[1];
  return target !== undefined && target !== "" && target !== "&";
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
  const basename = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? command;
  return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
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

const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const FIND_DESTRUCTIVE_EXECUTABLES: ReadonlySet<string> = new Set([
  "mv",
  "rm",
  "rmdir",
  "shred",
  "truncate",
  "unlink",
]);

const FIND_EXEC_FORWARDERS: ReadonlySet<string> = new Set([
  "builtin",
  "busybox",
  "chroot",
  "command",
  "doas",
  "env",
  "exec",
  "nice",
  "nohup",
  "sudo",
  "time",
  "timeout",
  "toybox",
]);

const FIND_WRAPPER_OPTIONS_WITH_VALUE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["doas", new Set(["-C", "-u"])],
  ["env", new Set(["-a", "-C", "-u", "--argv0", "--chdir", "--unset"])],
  ["exec", new Set(["-a"])],
  ["nice", new Set(["-n", "--adjustment"])],
  [
    "sudo",
    new Set([
      "-g",
      "-h",
      "-p",
      "-R",
      "-r",
      "-t",
      "-T",
      "-U",
      "-u",
      "--chroot",
      "--close-from",
      "--group",
      "--host",
      "--other-user",
      "--prompt",
      "--role",
      "--type",
      "--user",
    ]),
  ],
  ["time", new Set(["-f", "-o", "--format", "--output"])],
  ["timeout", new Set(["-k", "-s", "--kill-after", "--signal"])],
]);

const POWER_COMMANDS: ReadonlySet<string> = new Set(["halt", "poweroff", "reboot", "shutdown"]);

const POWER_MANAGERS: ReadonlySet<string> = new Set(["init", "loginctl", "systemctl", "telinit"]);

const POWER_ACTIONS: ReadonlySet<string> = new Set(["halt", "poweroff", "reboot"]);

const POWER_TARGET_ACTIONS: ReadonlySet<string> = new Set(["isolate", "start"]);

const POWER_TARGETS: ReadonlySet<string> = new Set([
  "halt.target",
  "poweroff.target",
  "reboot.target",
]);

const PERMISSION_COMMANDS: ReadonlySet<string> = new Set(["chgrp", "chmod", "chown"]);

const NATIVE_MUTATION_COMMANDS: ReadonlySet<string> = new Set([
  "cp",
  "install",
  "ln",
  "mv",
  "rmdir",
  "sed",
  "shred",
  "tee",
  "truncate",
  "unlink",
]);

const EMPTY_STRING_SET: ReadonlySet<string> = new Set();

const COPY_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set(["-S", "--suffix"]);

const INSTALL_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  ...COPY_OPTIONS_WITH_VALUE,
  "-g",
  "-m",
  "-o",
  "--group",
  "--mode",
  "--owner",
  "--strip-program",
]);

const SHRED_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-n",
  "-s",
  "--iterations",
  "--random-source",
  "--size",
]);

const TRUNCATE_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-r",
  "-s",
  "--reference",
  "--size",
]);

const SED_SCRIPT_OPTIONS: ReadonlySet<string> = new Set(["-e", "-f", "--expression", "--file"]);

const SED_SCRIPT_OPTIONS_WITH_VALUE_PREFIX: readonly string[] = [
  "-e",
  "-f",
  "--expression=",
  "--file=",
];

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
  "/private/etc",
  "/private/tmp",
  "/private/var",
  "/proc",
  "/root",
  "/run",
  "/sbin",
  "/sys",
  "/system",
  "/usr",
  "/var",
];

const OTHER_HARDLINE_PATTERNS: readonly RegExp[] = [/:\(\)\s*\{/u];
