import { homedir } from "node:os";
import { posix } from "node:path";

interface ShellWord {
  readonly value: string;
  readonly dynamic: boolean;
  readonly quotedOrEscaped: boolean;
  readonly unquotedExpansion: boolean;
  readonly outputRedirection: boolean;
  readonly cwd?: string;
}

interface ParsedShell {
  readonly commands: readonly (readonly ShellWord[])[];
  readonly commandContexts: readonly ShellCommandContext[];
  readonly nestedCommands: readonly NestedShellCommand[];
  readonly ambiguous: boolean;
}

interface ShellCommandContext {
  readonly subshellDepth: number;
  readonly subshellPath: readonly number[];
  readonly conditionallyExecuted: boolean;
  readonly isolatedCwd: boolean;
}

interface NestedShellCommand {
  readonly content: string;
  readonly commandIndex: number;
}

/**
 * Bash hardline 纯判定。只识别不可审批绕过的系统级破坏，
 * 工作区内的普通递归删除仍交给 YOLO 正常执行。
 */
export function isHardlineBashCommand(command: string, initialCwd?: string): boolean {
  return isHardlineBashCommandAtDepth(
    command,
    0,
    initialCwd ? normalizeSlashPath(initialCwd.replaceAll("\\", "/")) : UNKNOWN_SHELL_CWD,
  );
}

function isHardlineBashCommandAtDepth(
  command: string,
  depth: number,
  initialCwd: string,
  inheritedStartupTaints: ReadonlySet<string> = EMPTY_STRING_SET,
): boolean {
  if (OTHER_HARDLINE_PATTERNS.some((pattern) => pattern.test(command))) return true;

  const parsed = parseShell(command);
  if (depth >= MAX_NESTED_COMMAND_DEPTH && parsed.nestedCommands.length > 0) {
    return true;
  }
  const cwdCandidatesBySubshellDepth: string[][] = [[initialCwd]];
  const startupTaintsBySubshellDepth: Set<string>[] = [new Set(inheritedStartupTaints)];
  let previousSubshellPath: readonly number[] = [];
  for (let commandIndex = 0; commandIndex < parsed.commands.length; commandIndex++) {
    const context = parsed.commandContexts[commandIndex]!;
    let sharedSubshellDepth = 0;
    while (
      sharedSubshellDepth < previousSubshellPath.length &&
      sharedSubshellDepth < context.subshellPath.length &&
      previousSubshellPath[sharedSubshellDepth] === context.subshellPath[sharedSubshellDepth]
    ) {
      sharedSubshellDepth++;
    }
    cwdCandidatesBySubshellDepth.length = sharedSubshellDepth + 1;
    startupTaintsBySubshellDepth.length = sharedSubshellDepth + 1;
    for (
      let depthIndex = sharedSubshellDepth + 1;
      depthIndex <= context.subshellDepth;
      depthIndex++
    ) {
      cwdCandidatesBySubshellDepth[depthIndex] = cwdCandidatesBySubshellDepth[depthIndex - 1]!;
      startupTaintsBySubshellDepth[depthIndex] = new Set(
        startupTaintsBySubshellDepth[depthIndex - 1]!,
      );
    }
    const cwdCandidates = cwdCandidatesBySubshellDepth[context.subshellDepth]!;
    const startupTaints = startupTaintsBySubshellDepth[context.subshellDepth]!;
    const words = parsed.commands[commandIndex]!;
    const nextCwdCandidates: string[] = [];
    let changesCwd = false;
    for (const cwd of cwdCandidates) {
      for (const nested of parsed.nestedCommands) {
        if (nested.commandIndex !== commandIndex) continue;
        if (isHardlineBashCommandAtDepth(nested.content, depth + 1, cwd, startupTaints))
          return true;
      }
      const contextualWords = words.map((word) => ({ ...word, cwd }));
      if (isHardlineCommandWords(contextualWords, depth, startupTaints)) return true;
      const nextCwd = nextShellCwd(contextualWords, cwd);
      if (nextCwd !== undefined) {
        changesCwd = true;
        nextCwdCandidates.push(nextCwd);
      }
    }
    if (changesCwd) {
      const contextualWords = words.map((word) => ({ ...word, cwd: cwdCandidates[0]! }));
      cwdCandidatesBySubshellDepth[context.subshellDepth] =
        context.isolatedCwd ||
        context.conditionallyExecuted ||
        hasComplexCwdControlPrefix(contextualWords)
          ? [UNKNOWN_SHELL_CWD]
          : mergeShellCwdCandidates(cwdCandidates, nextCwdCandidates);
    }
    if (!context.isolatedCwd) {
      startupTaintsBySubshellDepth[context.subshellDepth] = nextShellStartupTaints(
        words,
        startupTaints,
      );
    }
    previousSubshellPath = context.subshellPath;
  }

  return parsed.ambiguous && hasAmbiguousDestructiveRmShape(parsed.commands);
}

function isHardlineCommandWords(
  words: readonly ShellWord[],
  depth: number,
  startupTaints: ReadonlySet<string> = EMPTY_STRING_SET,
): boolean {
  if (hasDestructiveOutputRedirection(words)) return true;

  const executableIndex = findExecutableIndex(words);
  if (executableIndex < 0) return false;

  const executableWord = words[executableIndex]!;
  if (executableWord.dynamic || executableWord.unquotedExpansion) return true;
  const executable = commandBasename(executableWord.value);
  const args = words.slice(executableIndex + 1);
  const leadingEnvironmentAssignments = words
    .slice(0, executableIndex)
    .filter((word) => isPotentialEnvironmentAssignment(word.value));
  if (SHELL_SOURCE_COMMANDS.has(executable)) return true;
  if (hasLegacyLiteralHardlinePayload(executable, args)) return true;
  if (executable === "rm") return isDestructiveRmInvocation(args, false);
  if (executable === "find" && isDestructiveFindInvocation(args)) return true;
  if (isMkfsExecutable(executable) && isDestructiveMkfsInvocation(args)) return true;
  if (executable === "dd" && isDestructiveDdInvocation(args)) return true;
  if (executable === "git" && isDestructiveGitInvocation(args)) return true;
  if (executable === "git-push" && isDestructiveGitPushInvocation(args)) return true;
  if (executable === "env" && hasEnvSplitString(args)) return true;
  if (executable === "xargs" && isDestructiveXargsInvocation(args, depth)) return true;
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
    const effectiveStartupTaints = new Set(startupTaints);
    for (const assignment of leadingEnvironmentAssignments) {
      const name = environmentAssignmentName(assignment.value);
      if (name) effectiveStartupTaints.add(name);
    }
    const shellOptions = scanShellInvocationOptions(args);
    if (hasShellStartupInjection(executable, shellOptions, effectiveStartupTaints)) return true;
    if (OPAQUE_SHELL_COMMANDS.has(executable)) {
      // csh/fish/PowerShell/cmd 不遵循 Bash 语法；即使命令文本静态可见，
      // 也不能用当前解析器证明其脚本、stdin 或内联命令安全。
      return !isShellDisplayOnlyInvocation(args);
    }
    if (shellOptions.ambiguous || (executable === "bash" && shellOptions.startupFile)) return true;
    if (shellOptions.noExec) return false;
    const commandIndex = shellOptions.commandIndex;
    if (commandIndex >= 0) {
      const nested = args[commandIndex + 1];
      if (!nested || nested.dynamic || depth >= MAX_NESTED_COMMAND_DEPTH) return true;
      return isHardlineBashCommandAtDepth(
        nested.value,
        depth + 1,
        words[executableIndex]!.cwd ?? SAFE_WORKSPACE_CWD,
        effectiveStartupTaints,
      );
    }
    // 已建模 Shell 入口没有静态 -c 时会读取 stdin/脚本；纯文本分类器
    // 不能绑定这些字节，因此对该可见调用 fail-closed。
    return !isShellDisplayOnlyInvocation(args);
  }

  if (executable === "eval") {
    if (args.length === 0 || args.some((word) => word.dynamic)) return true;
    return isHardlineBashCommandAtDepth(
      args.map((word) => word.value).join(" "),
      depth + 1,
      words[executableIndex]!.cwd ?? SAFE_WORKSPACE_CWD,
      startupTaints,
    );
  }

  if (executable === "command" && isCommandLookupInvocation(args)) return false;

  if (FIND_EXEC_FORWARDERS.has(executable)) {
    const forwarded = findForwardedCommandContext(executable, args, 0);
    if (forwarded.commandIndex >= 0) {
      const inheritedCwd = words[executableIndex]!.cwd ?? SAFE_WORKSPACE_CWD;
      const forwardedCwd = forwarded.cwd
        ? resolveForwardedCwd(forwarded.cwd, inheritedCwd)
        : inheritedCwd;
      const forwardedWords = [
        ...leadingEnvironmentAssignments,
        ...forwarded.environmentAssignments,
        ...args.slice(forwarded.commandIndex),
      ].map((word) => ({ ...word, cwd: forwardedCwd }));
      if (isHardlineCommandWords(forwardedWords, depth, startupTaints)) return true;
    }
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
      isHardlineCommandWords(args.slice(structuredHardlineIndex), depth, startupTaints)
    ) {
      return true;
    }
    const nestedExecutableIndex = args.findIndex((word) => {
      const candidate = commandBasename(word.value);
      return candidate === "eval" || SHELL_COMMANDS.has(candidate);
    });
    if (
      nestedExecutableIndex >= 0 &&
      isHardlineCommandWords(args.slice(nestedExecutableIndex), depth, startupTaints)
    ) {
      return true;
    }
    const dynamicExecutableIndex = args.findIndex((word) => word.dynamic);
    if (dynamicExecutableIndex === 0) {
      return true;
    }
  }

  // 可执行文件本身来自 shell 展开时无法证明不会落到系统级破坏命令。
  return false;
}

function isCommandLookupInvocation(args: readonly ShellWord[]): boolean {
  for (const word of args) {
    if (word.dynamic) return false;
    if (word.value === "--") return false;
    if (!word.value.startsWith("-")) return false;
    if (/^-[^-]*[vV]/u.test(word.value)) return true;
  }
  return false;
}

/** Preserve the legacy literal deny floor for known inline-code interpreter modes. */
function hasLegacyLiteralHardlinePayload(executable: string, args: readonly ShellWord[]): boolean {
  const entryKind = interpreterEntryKind(executable, args);
  if (entryKind !== "inline" && entryKind !== "ambiguous") return false;
  const payload = args.map((word) => word.value).join(" ");
  return LEGACY_LITERAL_HARDLINE_PATTERNS.some((pattern) => pattern.test(payload));
}

type InterpreterEntryKind = "inline" | "script" | "other" | "ambiguous";

function interpreterEntryKind(
  executable: string,
  args: readonly ShellWord[],
): InterpreterEntryKind {
  if (/^python(?:(?:\d+(?:\.\d+)*)t?)?$/u.test(executable)) {
    return pythonEntryKind(args);
  }
  if (executable === "node" || executable === "nodejs") {
    return nodeEntryKind(args);
  }
  if (/^perl(?:\d+(?:\.\d+)*)?$/u.test(executable)) {
    return clusteredInterpreterEntryKind(args, new Set(["e", "E"]), new Set(["F", "I", "M", "m"]));
  }
  if (/^ruby(?:\d+(?:\.\d+)*)?$/u.test(executable)) {
    return clusteredInterpreterEntryKind(
      args,
      new Set(["e"]),
      new Set(["C", "E", "F", "I", "r"]),
      new Set(["W", "x"]),
    );
  }
  return "other";
}

function pythonEntryKind(args: readonly ShellWord[]): InterpreterEntryKind {
  let ambiguousLongOptionValue = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (word.dynamic) return "ambiguous";
    if (value === "--" || value === "-") return "other";
    if (!value.startsWith("-")) {
      return ambiguousLongOptionValue && args.slice(index + 1).some(isPythonInlineOption)
        ? "ambiguous"
        : "script";
    }
    const optionValue = optionValuePlacement(value, PYTHON_OPTIONS_WITH_VALUE);
    if (optionValue === "next") {
      if (index + 1 >= args.length) return "ambiguous";
      index++;
      continue;
    }
    if (optionValue === "attached") continue;
    if (value.startsWith("--")) {
      if (!value.includes("=")) ambiguousLongOptionValue = true;
      continue;
    }
    const cluster = value.slice(1);
    for (let optionIndex = 0; optionIndex < cluster.length; optionIndex++) {
      const option = cluster[optionIndex]!;
      if (option === "c") return "inline";
      if (option === "m") return "other";
      if (option === "W" || option === "X") {
        if (optionIndex + 1 === cluster.length) {
          if (index + 1 >= args.length) return "ambiguous";
          index++;
        }
        break;
      }
    }
  }
  return "other";
}

function nodeEntryKind(args: readonly ShellWord[]): InterpreterEntryKind {
  let ambiguousLongOptionValue = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (word.dynamic) return "ambiguous";
    if (value === "--" || value === "-") return "other";
    if (!value.startsWith("-")) {
      return ambiguousLongOptionValue && args.slice(index + 1).some(isNodeInlineOption)
        ? "ambiguous"
        : "script";
    }
    if (isNodeInlineOption(word)) return "inline";
    const optionValue = optionValuePlacement(value, NODE_OPTIONS_WITH_VALUE);
    if (optionValue === "next") {
      if (index + 1 >= args.length) return "ambiguous";
      index++;
    } else if (value.startsWith("--") && !value.includes("=")) {
      ambiguousLongOptionValue = true;
    }
  }
  return "other";
}

function isPythonInlineOption(word: ShellWord): boolean {
  return !word.dynamic && (word.value === "-c" || /^-[^-]*c/u.test(word.value));
}

function isNodeInlineOption(word: ShellWord): boolean {
  const value = word.value;
  return (
    !word.dynamic &&
    (value === "-e" ||
      value === "-p" ||
      value === "--eval" ||
      value === "--print" ||
      /^-[ep].+/su.test(value) ||
      value.startsWith("--eval=") ||
      value.startsWith("--print="))
  );
}

function clusteredInterpreterEntryKind(
  args: readonly ShellWord[],
  inlineOptions: ReadonlySet<string>,
  valueOptions: ReadonlySet<string>,
  optionalAttachedValueOptions: ReadonlySet<string> = EMPTY_STRING_SET,
): InterpreterEntryKind {
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (word.dynamic) return "ambiguous";
    if (value === "--" || value === "-") return "other";
    if (!value.startsWith("-")) return "script";
    if (value.startsWith("--")) continue;
    const cluster = value.slice(1);
    for (let optionIndex = 0; optionIndex < cluster.length; optionIndex++) {
      const option = cluster[optionIndex]!;
      if (inlineOptions.has(option)) return "inline";
      if (valueOptions.has(option)) {
        if (optionIndex + 1 === cluster.length) {
          if (index + 1 >= args.length) return "ambiguous";
          index++;
        }
        break;
      }
      if (optionalAttachedValueOptions.has(option) && optionIndex + 1 < cluster.length) break;
    }
  }
  return "other";
}

function optionValuePlacement(
  value: string,
  optionsWithValue: ReadonlySet<string>,
): "attached" | "next" | undefined {
  for (const option of optionsWithValue) {
    if (value === option) return "next";
    if (option.startsWith("--")) {
      if (value.startsWith(`${option}=`)) return "attached";
    } else if (value.startsWith(option)) {
      return "attached";
    }
  }
  return undefined;
}

interface ShellInvocationOptions {
  readonly commandIndex: number;
  readonly startupFile: boolean;
  readonly interactive: boolean;
  readonly login: boolean;
  readonly noExec: boolean;
  readonly ambiguous: boolean;
}

function scanShellInvocationOptions(args: readonly ShellWord[]): ShellInvocationOptions {
  let startupFile = false;
  let interactive = false;
  let login = false;
  let noExec = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (word.dynamic) {
      return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: true };
    }
    if (value === "--" || value === "-") break;
    if (isBashStartupFileOption(value)) {
      startupFile = true;
      if (!value.includes("=")) index++;
      continue;
    }
    if (value === "--login") {
      login = true;
      continue;
    }
    if (value.startsWith("--")) continue;
    if (!/^[-+][^-]/u.test(value)) break;

    const enablesOption = value[0] === "-";
    const cluster = value.slice(1);
    let hasCommandString = false;
    for (let optionIndex = 0; optionIndex < cluster.length; optionIndex++) {
      const option = cluster[optionIndex]!;
      if (option === "o" || option === "O") {
        let optionName: string;
        if (optionIndex + 1 === cluster.length) {
          if (index + 1 >= args.length) {
            return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: true };
          }
          optionName = args[++index]!.value;
        } else {
          optionName = cluster.slice(optionIndex + 1);
        }
        if (option === "o" && optionName === "noexec") noExec = enablesOption;
        break;
      }
      if (option === "n") noExec = enablesOption;
      if (option === "i") interactive = enablesOption;
      if (option === "l") login = enablesOption;
      if (enablesOption && option === "c") hasCommandString = true;
    }
    if (hasCommandString) {
      return { commandIndex: index, startupFile, interactive, login, noExec, ambiguous: false };
    }
  }
  return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: false };
}

function isBashStartupFileOption(value: string): boolean {
  for (const option of BASH_STARTUP_FILE_OPTIONS) {
    if (value === option || value.startsWith(`${option}=`)) return true;
  }
  return false;
}

function isShellDisplayOnlyInvocation(args: readonly ShellWord[]): boolean {
  return (
    args.length === 1 &&
    !args[0]!.dynamic &&
    (args[0]!.value === "--help" || args[0]!.value === "--version")
  );
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

  const hasProtectedTarget = targets.some((target) => isProtectedMutationTarget(target));
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
    hasExternalRoots || roots.some((root) => root.dynamic || isProtectedMutationTarget(root));
  return (hasProtectedRoot && hasDelete) || hasFindDestructiveExecutor(args, hasProtectedRoot);
}

function hasFindDestructiveExecutor(
  args: readonly ShellWord[],
  hasProtectedRoot: boolean,
): boolean {
  for (let index = 0; index < args.length; index++) {
    const action = args[index]!.value;
    if (!FIND_EXEC_ACTIONS.has(action)) continue;
    const endIndex = args.findIndex(
      (word, candidateIndex) =>
        candidateIndex > index && (word.value === ";" || word.value === "+"),
    );
    const command = args.slice(index + 1, endIndex < 0 ? args.length : endIndex);
    const executesInMatchDirectory = action === "-execdir" || action === "-okdir";
    if (isFindDestructiveCommand(command, hasProtectedRoot, executesInMatchDirectory)) {
      return true;
    }
  }
  return false;
}

function isFindDestructiveCommand(
  command: readonly ShellWord[],
  hasProtectedRoot: boolean,
  executesInMatchDirectory: boolean,
): boolean {
  let executableIndex = 0;
  let effectiveCwd =
    hasProtectedRoot && executesInMatchDirectory
      ? FIND_PROTECTED_TARGET_SENTINEL
      : (command[0]?.cwd ?? SAFE_WORKSPACE_CWD);
  while (executableIndex < command.length) {
    const executable = command[executableIndex]!;
    if (executable.dynamic) return true;
    const name = commandBasename(executable.value);
    if (!FIND_EXEC_FORWARDERS.has(name)) {
      return isHardlineCommandWords(
        command
          .slice(executableIndex)
          .map((word) => ({ ...word, cwd: effectiveCwd }))
          .map((word) => (hasProtectedRoot ? taintFindProtectedTarget(word) : word)),
        0,
      );
    }
    const forwarded = findForwardedCommandContext(name, command, executableIndex + 1);
    if (forwarded.cwd) effectiveCwd = resolveForwardedCwd(forwarded.cwd, effectiveCwd);
    executableIndex = forwarded.commandIndex;
    if (executableIndex < 0) return false;
  }
  return false;
}

function taintFindProtectedTarget(word: ShellWord): ShellWord {
  if (!word.value.includes("{}")) return word;
  return {
    ...word,
    value: word.value.replaceAll("{}", FIND_PROTECTED_TARGET_SENTINEL),
  };
}

function isDestructiveXargsInvocation(args: readonly ShellWord[], depth: number): boolean {
  let commandIndex = -1;
  let replacement: string | undefined;
  let optionsEnded = false;

  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && value.startsWith("--")) {
      const matchedOption = findMatchingLongOption(value, XARGS_OPTIONS_WITH_VALUE);
      if (matchedOption) {
        const hasAttachedValue = value.includes("=");
        const optionValue = hasAttachedValue
          ? value.slice(value.indexOf("=") + 1)
          : XARGS_OPTIONS_WITH_OPTIONAL_VALUE.has(matchedOption)
            ? undefined
            : args[++index]?.value;
        if (matchedOption === "--replace") replacement = optionValue ?? "{}";
      }
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(value)) {
      const matchedOption = [...XARGS_OPTIONS_WITH_VALUE].find(
        (candidate) => candidate.length === 2 && value.startsWith(candidate),
      );
      if (matchedOption) {
        const optionValue = value === matchedOption ? args[++index]?.value : value.slice(2);
        if (matchedOption === "-I" || matchedOption === "-J") {
          replacement = optionValue ?? "{}";
        }
      }
      continue;
    }
    commandIndex = index;
    break;
  }

  if (commandIndex < 0) return false;
  const unknownInput: ShellWord = {
    value: XARGS_PROTECTED_TARGET_SENTINEL,
    dynamic: true,
    quotedOrEscaped: false,
    unquotedExpansion: false,
    outputRedirection: false,
    ...(args[commandIndex]?.cwd ? { cwd: args[commandIndex]!.cwd } : {}),
  };
  let command = args.slice(commandIndex);
  if (replacement !== undefined) {
    command = command.map((word) =>
      replacement && word.value.includes(replacement)
        ? {
            ...word,
            value: word.value.replaceAll(replacement, XARGS_PROTECTED_TARGET_SENTINEL),
            dynamic: true,
          }
        : word,
    );
  } else {
    command = [...command, unknownInput];
  }
  return isHardlineCommandWords(command, depth);
}

function findForwardedCommandContext(
  wrapper: string,
  words: readonly ShellWord[],
  startIndex: number,
): { commandIndex: number; cwd?: ShellWord; environmentAssignments: readonly ShellWord[] } {
  let skipOperand = wrapper === "timeout" ? 1 : 0;
  let optionsEnded = false;
  let cwd: ShellWord | undefined;
  const environmentAssignments: ShellWord[] = [];
  const optionsWithValue = FIND_WRAPPER_OPTIONS_WITH_VALUE.get(wrapper) ?? EMPTY_STRING_SET;
  for (let index = startIndex; index < words.length; index++) {
    const word = words[index]!;
    const value = words[index]!.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (
      (wrapper === "env" && isPotentialEnvironmentAssignment(value)) ||
      ((wrapper === "sudo" || wrapper === "doas") && isEnvironmentAssignment(value))
    ) {
      environmentAssignments.push(word);
      continue;
    }
    if (!optionsEnded && value.startsWith("--")) {
      const matchedOption = findMatchingLongOption(value, optionsWithValue);
      if (matchedOption) {
        let optionValue: ShellWord | undefined;
        if (value.includes("=")) {
          optionValue = { ...word, value: value.slice(value.indexOf("=") + 1) };
        } else {
          optionValue = words[index + 1];
          index++;
        }
        if (isWrapperCwdOption(wrapper, matchedOption)) cwd = optionValue;
      }
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(value)) {
      const match = findShortWrapperValueOption(word, words[index + 1], optionsWithValue);
      if (match) {
        if (match.consumesNext) index++;
        if (isWrapperCwdOption(wrapper, match.option)) cwd = match.value;
      }
      continue;
    }
    if (skipOperand > 0) {
      skipOperand--;
      continue;
    }
    if (wrapper === "chroot" && !cwd) {
      cwd = word;
      continue;
    }
    return { commandIndex: index, ...(cwd ? { cwd } : {}), environmentAssignments };
  }
  return { commandIndex: -1, ...(cwd ? { cwd } : {}), environmentAssignments };
}

function findShortWrapperValueOption(
  word: ShellWord,
  nextWord: ShellWord | undefined,
  optionsWithValue: ReadonlySet<string>,
): { option: string; value?: ShellWord; consumesNext: boolean } | undefined {
  const cluster = word.value;
  for (let index = 1; index < cluster.length; index++) {
    const option = `-${cluster[index]!}`;
    if (!optionsWithValue.has(option)) continue;
    const attached = cluster.slice(index + 1);
    return {
      option,
      value: attached ? { ...word, value: attached } : nextWord,
      consumesNext: attached.length === 0,
    };
  }
  return undefined;
}

function isWrapperCwdOption(wrapper: string, option: string): boolean {
  return (
    (wrapper === "env" && (option === "-C" || option === "--chdir")) ||
    (wrapper === "sudo" &&
      (option === "-D" || option === "-R" || option === "--chdir" || option === "--chroot"))
  );
}

function resolveForwardedCwd(cwd: ShellWord, inheritedCwd: string): string {
  if (cwd.dynamic || cwd.unquotedExpansion || isHomeExpression(cwd.value)) {
    return UNKNOWN_SHELL_CWD;
  }
  const slashPath = cwd.value.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//u.test(slashPath)) {
    return normalizeSlashPath(slashPath);
  }
  return resolveAgainstCwd(inheritedCwd, slashPath);
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
      matchesLongOption(value, "--all") ||
      matchesLongOption(value, "--offset") ||
      (/^-[^-]/u.test(value) && /[ao]/u.test(value.slice(1)))
    );
  });
  return destructive && args.some((word) => isProtectedMutationTarget(word));
}

function isProtectedMutationInvocation(args: readonly ShellWord[]): boolean {
  return args.some((word) => isProtectedMutationTarget(word));
}

function isProtectedMutationTarget(target: ShellWord): boolean {
  if (
    target.dynamic ||
    isProtectedRmTarget(target.value) ||
    isPotentiallyProtectedAbsoluteExpansion(target)
  ) {
    return true;
  }
  const contextualValue = resolveTargetFromCwd(target);
  if (!contextualValue) return false;
  const contextualTarget = { ...target, value: contextualValue };
  return (
    isProtectedRmTarget(contextualValue) ||
    isPotentiallyProtectedAbsoluteExpansion(contextualTarget, false)
  );
}

function resolveTargetFromCwd(target: ShellWord): string | undefined {
  if (!target.cwd || !target.value || target.value === "-") return undefined;
  const slashPath = target.value.replaceAll("\\", "/");
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//u.test(slashPath)) return undefined;
  if (isHomeExpression(slashPath)) return undefined;
  return resolveAgainstCwd(target.cwd, slashPath);
}

function nextShellCwd(words: readonly ShellWord[], currentCwd: string): string | undefined {
  let effectiveWords = words;
  let executableIndex = findExecutableIndex(effectiveWords);
  if (executableIndex < 0) return undefined;
  let executable = commandBasename(effectiveWords[executableIndex]!.value);
  while (CWD_FORWARDERS.has(executable)) {
    const args = effectiveWords.slice(executableIndex + 1);
    const forwarded = findForwardedCommandContext(executable, args, 0);
    if (forwarded.commandIndex < 0) return undefined;
    effectiveWords = args.slice(forwarded.commandIndex);
    executableIndex = findExecutableIndex(effectiveWords);
    if (executableIndex < 0) return undefined;
    executable = commandBasename(effectiveWords[executableIndex]!.value);
  }
  if (executable === "eval") {
    const args = effectiveWords.slice(executableIndex + 1);
    if (args.length === 0 || args.some((word) => word.dynamic)) return UNKNOWN_SHELL_CWD;
    return staticShellMayChangeCwd(args.map((word) => word.value).join(" "), currentCwd)
      ? UNKNOWN_SHELL_CWD
      : undefined;
  }
  if (executable === "popd") return UNKNOWN_SHELL_CWD;
  if (executable !== "cd" && executable !== "pushd") return undefined;

  let optionsEnded = false;
  let target: ShellWord | undefined;
  const args = effectiveWords.slice(executableIndex + 1);
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    if (word.outputRedirection) {
      if (!outputRedirectionHasTarget(word.value)) index++;
      continue;
    }
    if (!optionsEnded && word.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.value.startsWith("-") && word.value !== "-") continue;
    target = word;
    break;
  }

  if (
    !target ||
    target.dynamic ||
    target.unquotedExpansion ||
    target.value === "-" ||
    (executable === "pushd" && /^[+-]\d+$/u.test(target.value))
  ) {
    return UNKNOWN_SHELL_CWD;
  }
  const slashPath = target.value.replaceAll("\\", "/");
  if (isHomeExpression(slashPath)) return UNKNOWN_SHELL_CWD;
  if (
    !slashPath.startsWith("/") &&
    effectiveWords
      .slice(0, executableIndex)
      .some((word) => word.value.toUpperCase().startsWith("CDPATH="))
  ) {
    return UNKNOWN_SHELL_CWD;
  }
  if (slashPath.startsWith("/") || /^[A-Za-z]:\//u.test(slashPath)) {
    return normalizeSlashPath(slashPath);
  }
  return resolveAgainstCwd(currentCwd, slashPath);
}

function hasComplexCwdControlPrefix(words: readonly ShellWord[]): boolean {
  const executableIndex = findExecutableIndex(words);
  if (executableIndex <= 0) return false;
  return words
    .slice(0, executableIndex)
    .some((word) => SHELL_CONTROL_PREFIXES.has(word.value.toLowerCase()));
}

function mergeShellCwdCandidates(current: readonly string[], next: readonly string[]): string[] {
  // cd/pushd 可能失败并保留原目录，两条路径都必须继续检查。
  const merged = new Set<string>();
  for (const candidate of [...current, ...next]) {
    if (candidate === UNKNOWN_SHELL_CWD) return [UNKNOWN_SHELL_CWD];
    merged.add(candidate);
    if (merged.size > MAX_SHELL_CWD_CANDIDATES) return [UNKNOWN_SHELL_CWD];
  }
  return [...merged];
}

function staticShellMayChangeCwd(command: string, initialCwd: string): boolean {
  const parsed = parseShell(command);
  if (parsed.ambiguous || parsed.nestedCommands.length > 0) return true;
  for (const words of parsed.commands) {
    const contextualWords = words.map((word) => ({ ...word, cwd: initialCwd }));
    if (nextShellCwd(contextualWords, initialCwd) !== undefined) return true;
  }
  return false;
}

function resolveAgainstCwd(cwd: string, target: string): string {
  const drive = cwd.match(/^([A-Za-z]):(\/.*)$/u);
  if (!drive) return posix.resolve(cwd, target);
  return `${drive[1]!.toUpperCase()}:${posix.resolve(drive[2]!, target)}`;
}

function isDestructiveNativeMutationInvocation(
  executable: string,
  args: readonly ShellWord[],
): boolean {
  switch (executable) {
    case "cp":
    case "install":
      return isProtectedDestinationInvocation(executable, args);
    case "ln":
      return isProtectedLinkInvocation(args);
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
  if (parsed.ambiguousDynamicArgument) return true;
  if (parsed.targetDirectory && isProtectedMutationTarget(parsed.targetDirectory)) return true;

  if (
    executable === "cp" &&
    isCopyLinkMode(args) &&
    parsed.operands.some((operand) => isProtectedMutationTarget(operand))
  ) {
    return true;
  }

  const directoryMode =
    executable === "install" &&
    args.some(
      (word) => /^-[^-]*d/u.test(word.value) || matchesLongOption(word.value, "--directory"),
    );
  if (directoryMode) {
    return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
  }
  if (parsed.operands.length < 2) return false;
  return isProtectedMutationTarget(parsed.operands.at(-1)!);
}

function isProtectedMoveInvocation(args: readonly ShellWord[]): boolean {
  const parsed = collectUtilityOperands(args, COPY_OPTIONS_WITH_VALUE, true);
  if (parsed.ambiguousDynamicArgument) return true;
  if (parsed.targetDirectory && isProtectedMutationTarget(parsed.targetDirectory)) return true;
  return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
}

function isProtectedLinkInvocation(args: readonly ShellWord[]): boolean {
  const parsed = collectUtilityOperands(args, COPY_OPTIONS_WITH_VALUE, true);
  if (parsed.ambiguousDynamicArgument) return true;
  if (parsed.targetDirectory && isProtectedMutationTarget(parsed.targetDirectory)) return true;
  return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
}

function isCopyLinkMode(args: readonly ShellWord[]): boolean {
  return args.some(
    (word) =>
      /^-[^-]*[PRadlrs]/u.test(word.value) ||
      matchesLongOption(word.value, "--archive") ||
      matchesLongOption(word.value, "--link") ||
      matchesLongOption(word.value, "--no-dereference") ||
      matchesLongOption(word.value, "--recursive") ||
      matchesLongOption(word.value, "--symbolic-link"),
  );
}

function isProtectedSedInPlaceInvocation(args: readonly ShellWord[]): boolean {
  const inPlace = args.some(
    (word) => /^-[^-]*i/u.test(word.value) || matchesLongOption(word.value, "--in-place"),
  );

  const files: ShellWord[] = [];
  let hasExplicitScript = false;
  let consumedDefaultScript = false;
  let optionsEnded = false;
  let ambiguousDynamicArgument = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded) {
      const scriptOption = sedScriptOptionKind(value);
      if (scriptOption) {
        hasExplicitScript = true;
        if (scriptOption === "separate") index++;
        continue;
      }
      if (word.dynamic) {
        const scriptAlreadyKnown = hasExplicitScript || consumedDefaultScript;
        const requiredFollowingOperands = scriptAlreadyKnown ? 1 : 2;
        if (
          !word.quotedOrEscaped ||
          countFollowingSedOperands(args, index + 1) >= requiredFollowingOperands
        ) {
          ambiguousDynamicArgument = true;
        }
      }
    }
    if (!optionsEnded && value.startsWith("-")) continue;
    if (!hasExplicitScript && !consumedDefaultScript) {
      consumedDefaultScript = true;
      continue;
    }
    files.push(word);
  }
  if (ambiguousDynamicArgument) return true;
  if (!inPlace) return false;
  return files.some((file) => isProtectedMutationTarget(file));
}

function countFollowingSedOperands(args: readonly ShellWord[], startIndex: number): number {
  let count = 0;
  let optionsEnded = false;
  for (let index = startIndex; index < args.length; index++) {
    const word = args[index]!;
    if (!optionsEnded && word.value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded) {
      const scriptOption = sedScriptOptionKind(word.value);
      if (scriptOption) {
        if (scriptOption === "separate") index++;
        continue;
      }
      if (word.value.startsWith("-")) continue;
    }
    count++;
  }
  return count;
}

function sedScriptOptionKind(value: string): "attached" | "separate" | undefined {
  if (value.startsWith("--")) {
    if (!matchesLongOption(value, "--expression") && !matchesLongOption(value, "--file")) {
      return undefined;
    }
    return value.includes("=") ? "attached" : "separate";
  }
  if (!/^-[^-]/u.test(value)) return undefined;
  const optionIndex = value.slice(1).search(/[ef]/u);
  if (optionIndex < 0) return undefined;
  return optionIndex + 2 < value.length ? "attached" : "separate";
}

function hasProtectedUtilityOperand(
  args: readonly ShellWord[],
  optionsWithValue: ReadonlySet<string>,
): boolean {
  const parsed = collectUtilityOperands(args, optionsWithValue, false);
  return (
    parsed.ambiguousDynamicArgument ||
    parsed.operands.some((operand) => isProtectedMutationTarget(operand))
  );
}

function collectUtilityOperands(
  args: readonly ShellWord[],
  optionsWithValue: ReadonlySet<string>,
  supportsTargetDirectory: boolean,
): {
  operands: ShellWord[];
  targetDirectory?: ShellWord;
  ambiguousDynamicArgument: boolean;
} {
  const operands: ShellWord[] = [];
  let targetDirectory: ShellWord | undefined;
  let optionsEnded = false;
  let ambiguousDynamicArgument = false;

  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && word.dynamic) ambiguousDynamicArgument = true;
    if (!optionsEnded && supportsTargetDirectory) {
      if (value === "-t" || matchesLongOption(value, "--target-directory")) {
        const attachedTarget = value.includes("=")
          ? value.slice(value.indexOf("=") + 1)
          : undefined;
        if (attachedTarget !== undefined) {
          targetDirectory = { ...word, value: attachedTarget };
          continue;
        }
        targetDirectory = args[index + 1];
        index++;
        continue;
      }
      if (value.startsWith("-t") && value.length > 2) {
        targetDirectory = { ...word, value: value.slice(2) };
        continue;
      }
    }
    if (!optionsEnded && value.startsWith("--")) {
      if (UTILITY_EXACT_FLAG_OPTIONS.has(value)) continue;
      if (matchesAnyLongOption(value, optionsWithValue) && !value.includes("=")) index++;
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
    ambiguousDynamicArgument,
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
  if (TEMP_ROOTS.some((root) => lower === root || isWholeDirectoryContents(lower, root))) {
    return true;
  }
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

function isPotentiallyProtectedAbsoluteExpansion(
  target: ShellWord,
  allowAbsoluteBraceAlternative = true,
): boolean {
  if (!target.unquotedExpansion) return false;

  const slashPath = target.value.replaceAll("\\", "/");
  const normalized = normalizeSlashPath(slashPath);
  const expansionIndex = normalized.search(/[?*[{~$@+!]/u);
  if (expansionIndex >= 0) {
    if (expansionTouchesAbsoluteRootComponent(normalized, expansionIndex)) return true;
    const staticPrefix = normalized.slice(0, expansionIndex).toLowerCase();
    if (
      normalized.startsWith("/") &&
      [...CRITICAL_POSIX_ROOTS, ...TEMP_ROOTS].some((root) => root.startsWith(staticPrefix))
    ) {
      return true;
    }
  }
  return allowAbsoluteBraceAlternative && braceMayProduceAbsoluteTarget(slashPath);
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

function matchesLongOption(value: string, canonical: string): boolean {
  const optionName = value.split("=", 1)[0]!;
  return optionName.length > 2 && canonical.startsWith(optionName);
}

function matchesAnyLongOption(value: string, canonicalOptions: ReadonlySet<string>): boolean {
  return findMatchingLongOption(value, canonicalOptions) !== undefined;
}

function findMatchingLongOption(
  value: string,
  canonicalOptions: ReadonlySet<string>,
): string | undefined {
  return [...canonicalOptions].find(
    (canonical) => canonical.startsWith("--") && matchesLongOption(value, canonical),
  );
}

function parseShell(command: string): ParsedShell {
  const commands: ShellWord[][] = [];
  const commandContexts: ShellCommandContext[] = [];
  const nestedCommands: NestedShellCommand[] = [];
  const conditionalScopes: boolean[] = [];
  const braceGroupStarts: number[] = [];
  const subshellPath: number[] = [];
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
  let subshellDepth = 0;
  let nextSubshellId = 1;
  let pendingConditional = false;
  let pendingPipeline = false;
  let lastClosedBraceRange: { start: number; end: number } | undefined;

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
    if (words.length > 0) {
      commands.push(words);
      commandContexts.push({
        subshellDepth,
        subshellPath: [...subshellPath],
        conditionallyExecuted: pendingConditional || conditionalScopes.some(Boolean),
        isolatedCwd: pendingPipeline,
      });
    }
    words = [];
  };
  const markIsolated = (start: number, end: number): void => {
    for (let contextIndex = start; contextIndex < end; contextIndex++) {
      commandContexts[contextIndex] = {
        ...commandContexts[contextIndex]!,
        isolatedCwd: true,
      };
    }
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
      nestedCommands.push({ content: substitution.content, commandIndex: commands.length });
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
      nestedCommands.push({ content: substitution.content, commandIndex: commands.length });
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
    if ((char === "&" && next === "&") || (char === "|" && next === "|")) {
      finishCommand();
      pendingConditional = true;
      pendingPipeline = false;
      lastClosedBraceRange = undefined;
      index++;
      continue;
    }
    if (char === "|") {
      finishCommand();
      const previousIndex = commandContexts.length - 1;
      const conditional = commandContexts[previousIndex]?.conditionallyExecuted ?? false;
      if (lastClosedBraceRange) {
        markIsolated(lastClosedBraceRange.start, lastClosedBraceRange.end);
      } else if (previousIndex >= 0) {
        markIsolated(previousIndex, previousIndex + 1);
      }
      pendingConditional = conditional;
      pendingPipeline = true;
      lastClosedBraceRange = undefined;
      if (next === "&") index++;
      continue;
    }
    if (char === "&") {
      finishCommand();
      const previousIndex = commandContexts.length - 1;
      if (lastClosedBraceRange) {
        markIsolated(lastClosedBraceRange.start, lastClosedBraceRange.end);
      } else if (previousIndex >= 0) {
        markIsolated(previousIndex, previousIndex + 1);
      }
      pendingConditional = false;
      pendingPipeline = false;
      lastClosedBraceRange = undefined;
      continue;
    }
    if (char === ";" || char === "\n") {
      finishCommand();
      pendingConditional = false;
      pendingPipeline = false;
      lastClosedBraceRange = undefined;
      continue;
    }
    if (char === "(") {
      if (tokenStarted) ambiguous = true;
      finishCommand();
      conditionalScopes.push(pendingConditional || conditionalScopes.some(Boolean));
      subshellDepth++;
      subshellPath.push(nextSubshellId++);
      lastClosedBraceRange = undefined;
      continue;
    }
    if (char === ")") {
      if (tokenStarted) ambiguous = true;
      finishCommand();
      subshellDepth = Math.max(0, subshellDepth - 1);
      subshellPath.pop();
      conditionalScopes.pop();
      lastClosedBraceRange = undefined;
      continue;
    }
    if (
      (char === "{" || char === "}") &&
      !tokenStarted &&
      isStandaloneGroupingBrace(command, index)
    ) {
      finishCommand();
      if (char === "{") {
        braceGroupStarts.push(commandContexts.length);
        conditionalScopes.push(pendingConditional || conditionalScopes.some(Boolean));
        lastClosedBraceRange = undefined;
      } else {
        const start = braceGroupStarts.pop() ?? commandContexts.length;
        conditionalScopes.pop();
        lastClosedBraceRange = { start, end: commandContexts.length };
      }
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
  return { commands, commandContexts, nestedCommands, ambiguous };
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

function isPotentialEnvironmentAssignment(value: string): boolean {
  return isEnvironmentAssignment(value) || /^BASH_FUNC_.+%%=/u.test(value);
}

function environmentAssignmentName(value: string): string | undefined {
  const equalsIndex = value.indexOf("=");
  if (equalsIndex <= 0) return undefined;
  return value.slice(0, equalsIndex);
}

function nextShellStartupTaints(
  words: readonly ShellWord[],
  current: ReadonlySet<string>,
): Set<string> {
  const next = new Set(current);
  const executableIndex = findExecutableIndex(words);
  if (executableIndex < 0) {
    for (const word of words) addStartupTaint(next, environmentAssignmentName(word.value));
    return next;
  }

  const executable = commandBasename(words[executableIndex]!.value);
  if (executable === "eval") {
    next.add("*");
    return next;
  }
  if (!SHELL_ENVIRONMENT_MUTATION_BUILTINS.has(executable)) return next;
  for (const word of words.slice(executableIndex + 1)) {
    if (word.value.startsWith("-")) continue;
    addStartupTaint(next, environmentAssignmentName(word.value) ?? word.value);
  }
  return next;
}

function addStartupTaint(taints: Set<string>, name: string | undefined): void {
  if (!name) return;
  if (SHELL_STARTUP_ENVIRONMENT_NAMES.has(name) || name.startsWith("BASH_FUNC_")) {
    taints.add(name);
  }
}

function hasShellStartupInjection(
  executable: string,
  options: ShellInvocationOptions,
  taints: ReadonlySet<string>,
): boolean {
  if (options.interactive || options.login || taints.has("*")) return true;
  if (executable === "bash") {
    if (taints.has("BASH_ENV")) return true;
    if ([...taints].some((name) => name.startsWith("BASH_FUNC_"))) return true;
  }
  if (executable === "zsh" && taints.has("ZDOTDIR")) return true;
  if (BASH_LIKE_SHELL_COMMANDS.includes(executable) && taints.has("ENV")) return true;
  return false;
}

function findExecutableIndex(words: readonly ShellWord[]): number {
  return words.findIndex(
    (word) =>
      !isPotentialEnvironmentAssignment(word.value) &&
      (word.quotedOrEscaped || !SHELL_CONTROL_PREFIXES.has(word.value.toLowerCase())),
  );
}

function commandBasename(command: string): string {
  const basename = command.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase() ?? command;
  return basename.endsWith(".exe") ? basename.slice(0, -4) : basename;
}

const MAX_NESTED_COMMAND_DEPTH = 8;

const MAX_SHELL_CWD_CANDIDATES = 16;

const SAFE_WORKSPACE_CWD = "/tmp/.pico-workspace";

const UNKNOWN_SHELL_CWD = "/etc/.pico-unknown-cwd";

const BASH_LIKE_SHELL_COMMANDS: readonly string[] = [
  "ash",
  "bash",
  "dash",
  "hush",
  "ksh",
  "mksh",
  "oksh",
  "pdksh",
  "posh",
  "sh",
  "yash",
  "zsh",
];

const OPAQUE_SHELL_COMMANDS: ReadonlySet<string> = new Set([
  "cmd",
  "csh",
  "fish",
  "powershell",
  "pwsh",
  "tcsh",
]);

const SHELL_COMMANDS: ReadonlySet<string> = new Set([
  ...BASH_LIKE_SHELL_COMMANDS,
  ...OPAQUE_SHELL_COMMANDS,
]);

const SHELL_SOURCE_COMMANDS: ReadonlySet<string> = new Set([".", "source"]);

const SHELL_ENVIRONMENT_MUTATION_BUILTINS: ReadonlySet<string> = new Set([
  "declare",
  "export",
  "readonly",
  "typeset",
]);

const SHELL_STARTUP_ENVIRONMENT_NAMES: ReadonlySet<string> = new Set([
  "BASH_ENV",
  "ENV",
  "HOME",
  "PROMPT_COMMAND",
  "ZDOTDIR",
]);

const BASH_STARTUP_FILE_OPTIONS: ReadonlySet<string> = new Set(["--init-file", "--rcfile"]);

const PYTHON_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-W",
  "-X",
  "--check-hash-based-pycs",
]);

const NODE_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-C",
  "-r",
  "--conditions",
  "--env-file",
  "--env-file-if-exists",
  "--experimental-loader",
  "--import",
  "--input-type",
  "--loader",
  "--require",
  "--title",
]);

const CWD_FORWARDERS: ReadonlySet<string> = new Set(["builtin", "command", "time"]);

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
  "ionice",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "toybox",
  "xargs",
]);

const FIND_PRE_PATH_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P"]);

const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const FIND_PROTECTED_TARGET_SENTINEL = "/etc/.pico-find-protected-target";

const XARGS_PROTECTED_TARGET_SENTINEL = "/etc/.pico-xargs-protected-target";

const XARGS_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-E",
  "-I",
  "-J",
  "-L",
  "-P",
  "-R",
  "-S",
  "-a",
  "-d",
  "-n",
  "-s",
  "--arg-file",
  "--delimiter",
  "--eof",
  "--max-args",
  "--max-chars",
  "--max-lines",
  "--max-procs",
  "--process-slot-var",
  "--replace",
]);

const XARGS_OPTIONS_WITH_OPTIONAL_VALUE: ReadonlySet<string> = new Set([
  "--eof",
  "--max-args",
  "--max-lines",
  "--max-procs",
  "--replace",
]);

const FIND_EXEC_FORWARDERS: ReadonlySet<string> = new Set([
  "builtin",
  "busybox",
  "chroot",
  "command",
  "doas",
  "env",
  "exec",
  "ionice",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "toybox",
]);

const FIND_WRAPPER_OPTIONS_WITH_VALUE: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ["chroot", new Set(["--groups", "--userspec"])],
  ["doas", new Set(["-C", "-u"])],
  [
    "env",
    new Set(["-a", "-C", "-P", "-S", "-u", "--argv0", "--chdir", "--split-string", "--unset"]),
  ],
  ["exec", new Set(["-a"])],
  [
    "ionice",
    new Set(["-P", "-c", "-n", "-p", "-u", "--class", "--classdata", "--pgid", "--pid", "--uid"]),
  ],
  ["nice", new Set(["-n", "--adjustment"])],
  ["stdbuf", new Set(["-e", "-i", "-o", "--error", "--input", "--output"])],
  [
    "sudo",
    new Set([
      "-D",
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
      "--chdir",
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

const UTILITY_EXACT_FLAG_OPTIONS: ReadonlySet<string> = new Set(["--strip"]);

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

const TEMP_ROOTS: readonly string[] = ["/private/tmp", "/tmp"];

const OTHER_HARDLINE_PATTERNS: readonly RegExp[] = [/:\(\)\s*\{/u];

const LEGACY_LITERAL_HARDLINE_PATTERNS: readonly RegExp[] = [
  /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:["'\s}]|$)/iu,
  /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:["'\s}]|$)/iu,
  /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//iu,
  /\bdd\s+if=.*\bof=\/dev\//iu,
  /:\(\)\s*\{/u,
  /\bshutdown\b/iu,
  /\breboot\b/iu,
  /\bgit\s+push\s+(?:-f|--force)\s+.*\b(?:main|master)\b/iu,
];
