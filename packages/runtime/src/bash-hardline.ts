import { homedir } from "node:os";
import { posix } from "node:path";

import {
  BashParserUnavailableError,
  createBashAnalysisBudget,
  parseBashScript as parseShell,
  type BashAnalysisBudget,
  type ShellWord,
} from "./bash-parser.js";
export { initializeBashParser, BashParserUnavailableError } from "./bash-parser.js";

/** Stable, metadata-only reason code for a Bash hardline denial. */
export type HardlineBashReasonKind =
  | "source_or_dot"
  | "opaque_shell"
  | "dynamic_executable"
  | "protected_destination"
  | "protected_redirect"
  | "destructive_git"
  | "destructive_system"
  | "unknown_hardline";

/**
 * Bash hardline 纯判定。只识别不可审批绕过的系统级破坏，
 * 工作区内的普通递归删除仍交给 `full-access` 正常执行。
 */
export function isHardlineBashCommand(command: string, initialCwd?: string): boolean {
  return classifyHardlineBashCommand(command, initialCwd) !== undefined;
}

export type BashHardlineAnalysis =
  | { readonly kind: "deny" | "unknown"; readonly reasonKind: HardlineBashReasonKind }
  | { readonly kind: "no_match" };

/** Compatibility projection: only confirmed denies are Hardline refusals. */
export function classifyHardlineBashCommand(
  command: string,
  initialCwd?: string,
): HardlineBashReasonKind | undefined {
  const result = analyzeHardlineBashCommand(command, initialCwd);
  return result.kind === "deny" ? result.reasonKind : undefined;
}

export function analyzeHardlineBashCommand(
  command: string,
  initialCwd?: string,
): BashHardlineAnalysis {
  const cwd = initialCwd ? normalizeSlashPath(initialCwd.replaceAll("\\", "/")) : UNKNOWN_SHELL_CWD;
  try {
    const reasonKind = classifyHardlineBashCommandAtDepth(
      command,
      0,
      cwd,
      EMPTY_STRING_SET,
      createBashAnalysisBudget(),
    );
    return reasonKind === undefined
      ? { kind: "no_match" }
      : { kind: isUnknownReason(reasonKind) ? "unknown" : "deny", reasonKind };
  } catch (cause) {
    if (cause instanceof BashParserUnavailableError) throw cause;
    throw new BashParserUnavailableError(
      "[shell_analysis:unavailable] Bash 分析服务失败，命令未执行。",
      { cause },
    );
  }
}

function isUnknownReason(reason: HardlineBashReasonKind): boolean {
  return (
    reason === "source_or_dot" ||
    reason === "opaque_shell" ||
    reason === "dynamic_executable" ||
    reason === "unknown_hardline"
  );
}

function mergeReason(
  current: HardlineBashReasonKind | undefined,
  next: HardlineBashReasonKind | undefined,
): HardlineBashReasonKind | undefined {
  if (next === undefined) return current;
  if (current === undefined || (isUnknownReason(current) && !isUnknownReason(next))) return next;
  return current;
}

interface ShellBinding {
  readonly value?: string;
  readonly findPathKnown: boolean;
}
interface ShellState {
  cwd: string[];
  bindings: Map<string, ShellBinding>;
  startup: Set<string>;
}
function copyShellState(state: ShellState): ShellState {
  return {
    cwd: [...state.cwd],
    bindings: new Map(state.bindings),
    startup: new Set(state.startup),
  };
}
function shellStateKey(state: ShellState): string {
  return JSON.stringify([
    [...state.cwd].sort(),
    [...state.bindings].sort(([left], [right]) => left.localeCompare(right)),
    [...state.startup].sort(),
  ]);
}
interface ShellLoop {
  readonly start: number;
  readonly variable: string | undefined;
  readonly values: readonly ShellWord[];
  readonly finite: boolean;
  iteration: number;
  readonly seen: Set<string>;
  controlUnknown: boolean;
}
function isLoopControl(words: readonly ShellWord[]): boolean {
  let index = findExecutableIndex(words);
  while (index >= 0) {
    const executable = commandBasename(words[index]!.value);
    if (executable === "break" || executable === "continue") return true;
    if (executable !== "builtin" && executable !== "command") return false;
    const args = words.slice(index + 1);
    if (isCommandLookupInvocation(args)) return false;
    const forwarded = findForwardedCommandContext(executable, args, 0);
    if (forwarded.commandIndex < 0) return false;
    words = args.slice(forwarded.commandIndex);
    index = findExecutableIndex(words);
  }
  return false;
}
function bindLoopVariable(state: ShellState, loop: ShellLoop): void {
  if (!loop.variable) return;
  const value = loop.finite ? loop.values[loop.iteration] : undefined;
  state.bindings.set(loop.variable, {
    ...(value ? { value: value.value } : {}),
    findPathKnown: value
      ? hasStaticFindPathPrefix(value.value)
      : loop.values.length > 0 &&
        loop.values.every((word) => !word.dynamic && hasStaticFindPathPrefix(word.value)),
  });
}
function joinShellStates(states: readonly ShellState[]): ShellState {
  const first = states[0]!;
  const bindings = new Map(first.bindings);
  for (const [name, value] of bindings) {
    if (
      states.some((state) => {
        const other = state.bindings.get(name);
        return !other || other.value !== value.value || other.findPathKnown !== value.findPathKnown;
      })
    )
      bindings.delete(name);
  }
  let cwd = [...new Set(states.flatMap((state) => state.cwd))];
  if (cwd.includes(UNKNOWN_SHELL_CWD) || cwd.length > MAX_SHELL_CWD_CANDIDATES)
    cwd = [UNKNOWN_SHELL_CWD];
  return { cwd, bindings, startup: new Set(states.flatMap((state) => [...state.startup])) };
}

function resolveBoundWord(word: ShellWord, bindings: ReadonlyMap<string, ShellBinding>): ShellWord {
  if (!word.dynamic) return { ...word, findPathKnown: hasStaticFindPathPrefix(word.value) };
  let unresolved = false;
  let value = word.value;
  for (const expansion of [...(word.expansions ?? [])].reverse()) {
    const known = bindings.get(expansion.name)?.value;
    if (known === undefined || (!expansion.quoted && /[\s*?[~]/u.test(known))) {
      unresolved = true;
      continue;
    }
    value = value.slice(0, expansion.start) + known + value.slice(expansion.end);
  }
  if (word.expansions?.length && !unresolved && !value.includes("__dynamic__")) {
    return {
      ...word,
      value,
      dynamic: false,
      unquotedExpansion: !word.quotedOrEscaped && /[*?[~{]/u.test(value),
      findPathKnown: hasStaticFindPathPrefix(value),
    };
  }
  const exact =
    word.expansions?.length === 1 &&
    word.expansions[0]!.start === 0 &&
    word.expansions[0]!.end === word.value.length
      ? bindings.get(word.expansions[0]!.name)
      : undefined;
  return {
    ...word,
    findPathKnown: hasStaticFindPathPrefix(word.value) || exact?.findPathKnown === true,
  };
}

function updateShellBindings(words: readonly ShellWord[], state: ShellState): void {
  const executableIndex = findExecutableIndex(words);
  if (executableIndex < 0) {
    for (const word of words) {
      const assignment = word.value.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/su);
      if (!assignment) continue;
      const value = assignment[2]!;
      if (word.dynamic) state.bindings.delete(assignment[1]!);
      else
        state.bindings.set(assignment[1]!, {
          ...(!word.unquotedExpansion ? { value } : {}),
          findPathKnown: hasStaticFindPathPrefix(value),
        });
    }
    return;
  }
  const executable = commandBasename(words[executableIndex]!.value);
  const args = words.slice(executableIndex + 1);
  if (CWD_FORWARDERS.has(executable) && !isCommandLookupInvocation(args)) {
    const forwarded = findForwardedCommandContext(executable, args, 0);
    if (forwarded.commandIndex >= 0) updateShellBindings(args.slice(forwarded.commandIndex), state);
    return;
  }
  if (executable === "source" || executable === "." || executable === "eval") {
    state.bindings.clear();
    state.cwd = [UNKNOWN_SHELL_CWD];
    state.startup.add("*");
  } else if (executable === "read") {
    const names: string[] = [];
    for (let index = 0; index < args.length; index++) {
      const arg = args[index]!;
      if (arg.dynamic) {
        state.bindings.clear();
        return;
      }
      if (arg.value.startsWith("-")) {
        const option = arg.value.slice(1).match(/[adinNptu]/u);
        if (option?.index !== undefined) {
          const attached = arg.value.slice(option.index + 2);
          const target = attached || args[++index]?.value;
          if (option[0] === "a" && target) names.push(target);
        }
        continue;
      }
      names.push(arg.value);
    }
    for (const name of names.length ? names : ["REPLY"]) {
      const base = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/u)?.[1];
      if (base) state.bindings.delete(base);
      else state.bindings.clear();
    }
  } else if (["declare", "typeset", "export", "readonly", "unset"].includes(executable)) {
    for (const arg of args) {
      if (arg.dynamic) {
        state.bindings.clear();
        break;
      }
      const name = arg.value.split("=", 1)[0]!;
      const baseName = name.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/u)?.[1];
      if (baseName) state.bindings.delete(baseName);
    }
  } else if (executable === "let") {
    state.bindings.clear();
  } else if (executable === "printf") {
    const variableIndex = args.findIndex((arg) => arg.value.startsWith("-v"));
    if (variableIndex >= 0) {
      const option = args[variableIndex]!;
      const variable =
        option.value.length > 2
          ? { ...option, value: option.value.slice(2) }
          : args[variableIndex + 1];
      if (!variable || variable.dynamic) state.bindings.clear();
      else {
        const name = variable.value.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\[.*\])?$/u)?.[1];
        if (name) state.bindings.delete(name);
        else state.bindings.clear();
      }
    }
    const format =
      args[
        variableIndex >= 0
          ? variableIndex + (args[variableIndex]!.value.length > 2 ? 1 : 2)
          : args[0]?.value === "--"
            ? 1
            : 0
      ];
    if (format?.dynamic || /(^|[^%])(?:%%)*%[^%]*n/u.test(format?.value ?? ""))
      state.bindings.clear();
  }
}

function classifyHardlineBashCommandAtDepth(
  command: string,
  depth: number,
  initialCwd: string,
  inheritedStartupTaints: ReadonlySet<string> = EMPTY_STRING_SET,
  budget: BashAnalysisBudget = createBashAnalysisBudget(),
  inheritedBindings: ReadonlyMap<string, ShellBinding> = new Map(),
): HardlineBashReasonKind | undefined {
  if (depth >= MAX_NESTED_COMMAND_DEPTH) return "dynamic_executable";
  const parsed = parseShell(command, budget);
  let result: HardlineBashReasonKind | undefined = parsed.destructiveSystemSyntax
    ? "destructive_system"
    : parsed.ambiguous
      ? "unknown_hardline"
      : undefined;
  let state: ShellState = {
    cwd: [initialCwd],
    bindings: new Map(inheritedBindings),
    startup: new Set(inheritedStartupTaints),
  };
  const frames: {
    base: ShellState;
    branches: ShellState[];
    isolated: boolean;
    loop?: ShellLoop;
  }[] = [];
  for (let commandIndex = 0; commandIndex < parsed.commands.length; commandIndex++) {
    if (performance.now() > budget.deadline) {
      budget.exceeded = true;
      return mergeReason(result, "unknown_hardline");
    }
    const context = parsed.commandContexts[commandIndex]!;
    const flow = context.flow;
    if (flow) {
      if (flow.kind === "save" || flow.kind === "isolate") {
        const base = copyShellState(state);
        frames.push({ base, branches: [base], isolated: flow.kind === "isolate" });
        state = copyShellState(base);
      } else if (flow.kind === "restore") {
        const frame = frames.at(-1)!;
        frame.branches.push(copyShellState(state));
        state = copyShellState(frame.base);
      } else if (flow.kind === "join") {
        const frame = frames.pop()!;
        state = joinShellStates([...frame.branches, state]);
      } else if (flow.kind === "loop_end") {
        const frame = frames.at(-1)!;
        const loop = frame.loop!;
        frame.branches.push(copyShellState(state));
        loop.iteration++;
        const finished = loop.finite && loop.iteration >= loop.values.length;
        if (!finished) bindLoopVariable(state, loop);
        const key = shellStateKey(state);
        if (finished || loop.controlUnknown || (!loop.finite && loop.seen.has(key))) {
          frames.pop();
          state = joinShellStates(frame.branches);
        } else {
          loop.seen.add(key);
          commandIndex = loop.start - 1;
        }
      } else if (flow.kind === "end_isolate") state = frames.pop()!.base;
      else if (flow.kind === "forget") {
        state.bindings.clear();
        state.cwd = [UNKNOWN_SHELL_CWD];
        state.startup.add("*");
      } else if (flow.kind === "loop") {
        const values = flow.values.map((value) => resolveBoundWord(value, state.bindings));
        const loop: ShellLoop = {
          start: commandIndex + 1,
          variable: flow.variable,
          values,
          finite:
            flow.form === "for" &&
            values.length > 0 &&
            values.every((value) => !value.dynamic && !value.unquotedExpansion),
          iteration: 0,
          seen: new Set(),
          controlUnknown: false,
        };
        frames.at(-1)!.loop = loop;
        bindLoopVariable(state, loop);
        loop.seen.add(shellStateKey(state));
      }
      continue;
    }
    const boundWords = parsed.commands[commandIndex]!.map((word) =>
      resolveBoundWord(word, state.bindings),
    );
    const nextCwdCandidates: string[] = [];
    for (const cwd of state.cwd) {
      for (const nested of parsed.nestedCommands) {
        if (nested.commandIndex === commandIndex)
          result = mergeReason(
            result,
            classifyHardlineBashCommandAtDepth(
              nested.content,
              depth + 1,
              cwd,
              state.startup,
              budget,
              state.bindings,
            ),
          );
      }
      const words = boundWords.map((word) => ({ ...word, cwd }));
      if (hasUncertainOutputRedirection(words)) result = mergeReason(result, "dynamic_executable");
      result = mergeReason(
        result,
        classifyHardlineCommandWords(words, depth, state.startup, budget),
      );
      const executableIndex = findExecutableIndex(words);
      const executable = executableIndex >= 0 ? commandBasename(words[executableIndex]!.value) : "";
      if (context.stdinPayload !== undefined || context.opaqueInput) {
        if (isKnownInterpreter(executable)) {
          result = mergeReason(result, "opaque_shell");
        } else if (BASH_LIKE_SHELL_COMMANDS.includes(executable)) {
          const options = scanShellInvocationOptions(words.slice(executableIndex + 1));
          if (
            !options.noExec &&
            options.commandIndex < 0 &&
            options.stdin === true &&
            context.stdinPayload !== undefined &&
            !context.opaqueInput
          ) {
            result = mergeReason(
              result,
              classifyHardlineBashCommandAtDepth(
                context.stdinPayload,
                depth + 1,
                cwd,
                state.startup,
                budget,
              ),
            );
          }
        }
      }
      const next = nextShellCwd(words, cwd);
      if (next !== undefined) nextCwdCandidates.push(next);
    }
    if (nextCwdCandidates.length > 0)
      state.cwd = mergeShellCwdCandidates(state.cwd, nextCwdCandidates);
    updateShellBindings(boundWords, state);
    state.startup = nextShellStartupTaints(boundWords, state.startup);
    if (isLoopControl(boundWords)) {
      for (let index = frames.length - 1; index >= 0; index--) {
        const frame = frames[index]!;
        if (frame.loop) {
          frame.loop.controlUnknown = true;
          break;
        }
        if (frame.isolated) break;
      }
      result = mergeReason(result, "unknown_hardline");
      // Conditional/nested break and continue need control-flow modeling.
      // Do not reuse a state from commands they may have skipped.
      state.bindings.clear();
      state.cwd = [UNKNOWN_SHELL_CWD];
      state.startup.add("*");
    }
    if (result !== undefined && !isUnknownReason(result)) return result;
  }
  return result;
}

function isKnownInterpreter(executable: string): boolean {
  return /^(?:python(?:(?:\d+(?:\.\d+)*)t?)?|node|nodejs|perl(?:\d+(?:\.\d+)*)?|ruby(?:\d+(?:\.\d+)*)?)$/u.test(
    executable,
  );
}

function classifyHardlineCommandWords(
  words: readonly ShellWord[],
  depth: number,
  startupTaints: ReadonlySet<string> = EMPTY_STRING_SET,
  budget: BashAnalysisBudget = createBashAnalysisBudget(),
): HardlineBashReasonKind | undefined {
  if (hasDestructiveOutputRedirection(words)) return "protected_redirect";
  words = commandArgv(words);

  const executableIndex = findExecutableIndex(words);
  if (executableIndex < 0) return undefined;

  const executableWord = words[executableIndex]!;
  if (executableWord.dynamic || executableWord.unquotedExpansion) return "dynamic_executable";
  const executable = commandBasename(executableWord.value);
  const args = words.slice(executableIndex + 1);
  const leadingEnvironmentAssignments = words
    .slice(0, executableIndex)
    .filter((word) => isPotentialEnvironmentAssignment(word.value));
  if (SHELL_SOURCE_COMMANDS.has(executable)) return "source_or_dot";
  const literalReason = classifyLegacyLiteralHardlinePayload(executable, args);
  if (literalReason !== undefined) return literalReason;
  if (executable === "rm") {
    return isDestructiveRmInvocation(args) ? "protected_destination" : uncertainArguments(args);
  }
  if (executable === "find") return classifyFindInvocation(args, depth, startupTaints, budget);
  if (executable === "xargs") return classifyXargsInvocation(args, depth, startupTaints, budget);
  if (
    (executable === "git" && isDestructiveGitInvocation(args)) ||
    (executable === "git-push" && isDestructiveGitPushInvocation(args))
  ) {
    return "destructive_git";
  }
  if (executable === "env" && hasEnvSplitString(args)) return "dynamic_executable";
  if (
    POWER_COMMANDS.has(executable) ||
    (POWER_MANAGERS.has(executable) && isPowerManagerInvocation(executable, args)) ||
    (isMkfsExecutable(executable) && isDestructiveMkfsInvocation(args)) ||
    (executable === "dd" && isDestructiveDdInvocation(args)) ||
    (executable === "wipefs" && isDestructiveWipefsInvocation(args))
  ) {
    return "destructive_system";
  }
  if (PERMISSION_COMMANDS.has(executable) && isProtectedMutationInvocation(args)) {
    return "protected_destination";
  }
  if (
    NATIVE_MUTATION_COMMANDS.has(executable) &&
    isDestructiveNativeMutationInvocation(executable, args)
  ) {
    return "protected_destination";
  }

  if (SHELL_COMMANDS.has(executable)) {
    const effectiveStartupTaints = new Set(startupTaints);
    for (const assignment of leadingEnvironmentAssignments) {
      const name = environmentAssignmentName(assignment.value);
      if (name) effectiveStartupTaints.add(name);
    }
    const shellOptions = scanShellInvocationOptions(args);
    let shellUnknown: HardlineBashReasonKind | undefined = hasShellStartupInjection(
      executable,
      shellOptions,
      effectiveStartupTaints,
    )
      ? "dynamic_executable"
      : undefined;
    if (OPAQUE_SHELL_COMMANDS.has(executable)) {
      // csh/fish/PowerShell/cmd 不遵循 Bash 语法；即使命令文本静态可见，
      // 也不能用当前解析器证明其脚本、stdin 或内联命令安全。
      return isShellDisplayOnlyInvocation(args) ? undefined : "opaque_shell";
    }
    if (shellOptions.ambiguous || (executable === "bash" && shellOptions.startupFile)) {
      shellUnknown = "dynamic_executable";
    }
    if (shellOptions.noExec) return shellUnknown;
    const commandIndex = shellOptions.commandIndex;
    if (commandIndex >= 0) {
      const nested = args[commandIndex + 1];
      if (!nested || nested.dynamic || depth >= MAX_NESTED_COMMAND_DEPTH) {
        return "dynamic_executable";
      }
      return mergeReason(
        shellUnknown,
        classifyHardlineBashCommandAtDepth(
          nested.value,
          depth + 1,
          words[executableIndex]!.cwd ?? SAFE_WORKSPACE_CWD,
          effectiveStartupTaints,
          budget,
        ),
      );
    }
    // 已建模 Shell 入口没有静态 -c 时会读取 stdin/脚本；纯文本分类器
    // 不能绑定这些字节，返回 unknown 并交回权限流程。
    return isShellDisplayOnlyInvocation(args) ? undefined : "dynamic_executable";
  }

  if (executable === "eval") {
    if (args.length === 0 || args.some((word) => word.dynamic)) return "dynamic_executable";
    return classifyHardlineBashCommandAtDepth(
      args.map((word) => word.value).join(" "),
      depth + 1,
      words[executableIndex]!.cwd ?? SAFE_WORKSPACE_CWD,
      startupTaints,
      budget,
    );
  }

  if (executable === "command" && isCommandLookupInvocation(args)) return undefined;

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
      let result: HardlineBashReasonKind | undefined;
      for (const target of forwarded.outputTargets) {
        if (isPseudoDeviceRedirectionTarget(target)) continue;
        result = mergeReason(
          result,
          isProtectedMutationTarget(target)
            ? "protected_destination"
            : uncertainArguments([target]),
        );
      }
      return mergeReason(
        result,
        classifyHardlineCommandWords(forwardedWords, depth, startupTaints, budget),
      );
    }
  }

  if (RM_FORWARDING_COMMANDS.has(executable)) {
    const rmIndex = args.findIndex((word) => commandBasename(word.value) === "rm");
    if (rmIndex >= 0) {
      return classifyHardlineCommandWords(args.slice(rmIndex), depth, startupTaints, budget);
    }
    const findIndex = args.findIndex((word) => commandBasename(word.value) === "find");
    if (findIndex >= 0) {
      const reason = classifyFindInvocation(
        args.slice(findIndex + 1),
        depth,
        startupTaints,
        budget,
      );
      if (reason !== undefined) return reason;
    }
    const structuredHardlineIndex = args.findIndex((word) =>
      isStructuredHardlineExecutable(commandBasename(word.value)),
    );
    if (structuredHardlineIndex >= 0) {
      const reason = classifyHardlineCommandWords(
        args.slice(structuredHardlineIndex),
        depth,
        startupTaints,
        budget,
      );
      if (reason !== undefined) return reason;
    }
    const nestedExecutableIndex = args.findIndex((word) => {
      const candidate = commandBasename(word.value);
      return candidate === "eval" || SHELL_COMMANDS.has(candidate);
    });
    if (nestedExecutableIndex >= 0) {
      const reason = classifyHardlineCommandWords(
        args.slice(nestedExecutableIndex),
        depth,
        startupTaints,
        budget,
      );
      if (reason !== undefined) return reason;
    }
    const dynamicExecutableIndex = args.findIndex((word) => word.dynamic);
    if (dynamicExecutableIndex === 0) {
      return "dynamic_executable";
    }
  }

  if (isKnownInterpreter(executable) && !isShellDisplayOnlyInvocation(args)) return "opaque_shell";
  return uncertainArguments(args);
}

function uncertainArguments(args: readonly ShellWord[]): HardlineBashReasonKind | undefined {
  return args.some(
    (word) =>
      word.dynamic ||
      word.unquotedExpansion ||
      (word.cwd === UNKNOWN_SHELL_CWD &&
        !word.value.startsWith("-") &&
        !word.value.startsWith("/")),
  )
    ? "dynamic_executable"
    : undefined;
}

function hasStaticFindPathPrefix(value: string): boolean {
  const prefix = staticShellWordPrefix(value);
  return prefix.length > 0 && !isFindExpressionStart(prefix);
}

function staticShellWordPrefix(value: string): string {
  // Command substitutions are represented by a parser placeholder, not literal text.
  return value.split(/[$~*?[{]|__dynamic__/u, 1)[0] ?? "";
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
function classifyLegacyLiteralHardlinePayload(
  executable: string,
  args: readonly ShellWord[],
): HardlineBashReasonKind | undefined {
  const entryKind = interpreterEntryKind(executable, args);
  if (entryKind !== "inline") return undefined;
  const payload = inlineInterpreterPayload(executable, args);
  if (payload === undefined) return undefined;
  return LEGACY_LITERAL_HARDLINE_PATTERNS.find(({ pattern }) => pattern.test(payload))?.reasonKind;
}

function inlineInterpreterPayload(
  executable: string,
  args: readonly ShellWord[],
): string | undefined {
  const python = executable.startsWith("python");
  const node = executable === "node" || executable === "nodejs";
  const perl = executable.startsWith("perl");
  const inline = python ? "c" : node ? "ep" : perl ? "eE" : "e";
  const valueOptions = python
    ? PYTHON_OPTIONS_WITH_VALUE
    : node
      ? NODE_OPTIONS_WITH_VALUE
      : new Set(
          (perl ? ["F", "I", "M", "m"] : ["C", "E", "F", "I", "r"]).map((option) => `-${option}`),
        );
  const payload = (index: number): string | undefined =>
    args[index]?.dynamic ? undefined : args[index]?.value;
  for (let index = 0; index < args.length; index++) {
    const argument = args[index]!;
    const value = argument.value;
    if (argument.dynamic || value === "--" || value === "-" || !value.startsWith("-"))
      return undefined;
    if (node && /^(?:--eval|--print)(?:=|$)/u.test(value))
      return value.includes("=") ? value.slice(value.indexOf("=") + 1) : payload(index + 1);
    const placement = optionValuePlacement(value, valueOptions);
    if (placement === "next") {
      index++;
      continue;
    }
    if (placement === "attached" || value.startsWith("--")) continue;
    const cluster = value.slice(1);
    for (let position = 0; position < cluster.length; position++) {
      const option = cluster[position]!;
      if (inline.includes(option)) return cluster.slice(position + 1) || payload(index + 1);
      if (valueOptions.has(`-${option}`)) {
        if (position === cluster.length - 1) index++;
        break;
      }
    }
  }
  return undefined;
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
  readonly stdin?: boolean;
}

function scanShellInvocationOptions(args: readonly ShellWord[]): ShellInvocationOptions {
  args = commandArgv(args);
  let stdin = true;
  let explicitStdin = false;
  let startupFile = false;
  let interactive = false;
  let login = false;
  let noExec = false;
  let hasCommandString = false;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (word.dynamic) {
      return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: true };
    }
    if (value === "--" || value === "-") {
      if (!hasCommandString) {
        stdin = value === "-" || explicitStdin || index + 1 === args.length;
        break;
      }
      if (index + 1 >= args.length) {
        return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: true };
      }
      return { commandIndex: index, startupFile, interactive, login, noExec, ambiguous: false };
    }
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
    if (!/^[-+][^-]/u.test(value)) {
      if (hasCommandString) {
        return {
          commandIndex: index - 1,
          startupFile,
          interactive,
          login,
          noExec,
          ambiguous: false,
        };
      }
      stdin = explicitStdin;
      break;
    }

    const enablesOption = value[0] === "-";
    const cluster = value.slice(1);
    for (let optionIndex = 0; optionIndex < cluster.length; optionIndex++) {
      const option = cluster[optionIndex]!;
      if (option === "o" || option === "O") {
        let optionName: string;
        if (optionIndex + 1 === cluster.length) {
          if (index + 1 >= args.length) {
            return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: true };
          }
          const optionValue = args[++index]!;
          if (optionValue.dynamic) {
            return {
              commandIndex: -1,
              startupFile,
              interactive,
              login,
              noExec,
              ambiguous: true,
            };
          }
          optionName = optionValue.value;
        } else {
          optionName = cluster.slice(optionIndex + 1);
        }
        if (option === "o" && optionName === "noexec") noExec = enablesOption;
        break;
      }
      if (option === "n") noExec = enablesOption;
      if (option === "i") interactive = enablesOption;
      if (option === "l") login = enablesOption;
      if (option === "s") explicitStdin = enablesOption;
      if (enablesOption && option === "c") hasCommandString = true;
    }
  }
  if (hasCommandString) {
    return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: true };
  }
  return { commandIndex: -1, startupFile, interactive, login, noExec, ambiguous: false, stdin };
}

function commandArgv(words: readonly ShellWord[]): readonly ShellWord[] {
  const result: ShellWord[] = [];
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!;
    if (word.outputRedirection) {
      if (!outputRedirectionHasTarget(word.value)) index++;
    } else result.push(word);
  }
  return result;
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

function isDestructiveRmInvocation(args: readonly ShellWord[]): boolean {
  const parsed = collectUtilityOperands(args, EMPTY_STRING_SET, false);
  return parsed.operands.some((target) => isProtectedMutationTarget(target));
}

function classifyFindInvocation(
  args: readonly ShellWord[],
  depth: number,
  startupTaints: ReadonlySet<string>,
  budget: BashAnalysisBudget,
): HardlineBashReasonKind | undefined {
  const hasExternalRoots = args.some(
    (word) => word.value === "-files0-from" || word.value.startsWith("-files0-from="),
  );
  const roots: ShellWord[] = [];
  let optionsEnded = false;
  let expressionIndex = args.length;
  for (let index = 0; index < args.length; index++) {
    const word = args[index]!;
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      continue;
    }
    if (!optionsEnded && FIND_PRE_PATH_OPTIONS.has(value)) continue;
    if (!optionsEnded && value === "-D") {
      const debugFlags = args[++index];
      if (debugFlags?.dynamic && debugFlags.unquotedExpansion) return "dynamic_executable";
      continue;
    }
    if (!optionsEnded && /^-O\d+$/u.test(value)) continue;
    if (isFindExpressionStart(value)) {
      expressionIndex = index;
      break;
    }
    roots.push(word);
  }

  if (roots.length === 0) {
    roots.push({
      value: ".",
      dynamic: false,
      quotedOrEscaped: false,
      unquotedExpansion: false,
      outputRedirection: false,
      cwd: args[0]?.cwd ?? UNKNOWN_SHELL_CWD,
    });
  }
  const unknownRoots =
    hasExternalRoots ||
    roots.some((root) => root.dynamic || root.unquotedExpansion || root.cwd === UNKNOWN_SHELL_CWD);
  let result: HardlineBashReasonKind | undefined =
    roots.some((root) => root.dynamic && !root.findPathKnown) || hasExternalRoots
      ? "dynamic_executable"
      : undefined;
  const hasProtectedRoot = roots.some((root) => isProtectedMutationTarget(root));
  for (let index = expressionIndex; index < args.length; index++) {
    const word = args[index]!;
    const action = word.value;
    if (word.dynamic) {
      result = mergeReason(result, "dynamic_executable");
      continue;
    }
    if (action === "-delete" && unknownRoots) result = mergeReason(result, "dynamic_executable");
    if (action === "-delete" && hasProtectedRoot) return "protected_destination";
    if (FIND_OUTPUT_ACTIONS.has(action)) {
      const target = args[++index];
      if (!target) {
        result = mergeReason(result, "dynamic_executable");
        continue;
      }
      if (target.dynamic || target.cwd === UNKNOWN_SHELL_CWD)
        result = mergeReason(result, "dynamic_executable");
      if (!isPseudoDeviceRedirectionTarget(target) && isProtectedMutationTarget(target)) {
        return "protected_destination";
      }
      if (action === "-fprintf") {
        const format = args[++index];
        if (format?.dynamic && format.unquotedExpansion)
          result = mergeReason(result, "dynamic_executable");
      }
      continue;
    }
    if (FIND_EXEC_ACTIONS.has(action)) {
      const endIndex = args.findIndex(
        (candidate, candidateIndex) =>
          candidateIndex > index &&
          (candidate.value === ";" ||
            (candidate.value === "+" &&
              args[candidateIndex - 1]?.value === "{}" &&
              (action === "-exec" || action === "-execdir"))),
      );
      const command = args.slice(index + 1, endIndex < 0 ? args.length : endIndex);
      if (
        command.some((argument) => {
          if (!argument.dynamic) return false;
          const prefix = staticShellWordPrefix(argument.value);
          return argument.unquotedExpansion || prefix === "" || prefix === ";" || prefix === "+";
        })
      ) {
        // Expanded argv can introduce an executor terminator and expose later find actions.
        result = mergeReason(result, "dynamic_executable");
      }
      const executesInMatchDirectory = action === "-execdir" || action === "-okdir";
      const reason = classifyFindCommand(
        command,
        hasProtectedRoot,
        executesInMatchDirectory,
        depth,
        startupTaints,
        budget,
      );
      result = mergeReason(result, reason);
      index = endIndex < 0 ? args.length : endIndex;
      continue;
    }
    if (FIND_EXPRESSION_OPTIONS_WITH_VALUE.has(action) || /^-newer[acmBt][acmBt]$/u.test(action)) {
      const operand = args[++index];
      if (operand?.dynamic && operand.unquotedExpansion)
        result = mergeReason(result, "dynamic_executable");
    }
  }
  return result;
}

function classifyFindCommand(
  command: readonly ShellWord[],
  hasProtectedRoot: boolean,
  executesInMatchDirectory: boolean,
  depth: number,
  startupTaints: ReadonlySet<string>,
  budget: BashAnalysisBudget,
): HardlineBashReasonKind | undefined {
  if (depth >= MAX_NESTED_COMMAND_DEPTH) return "dynamic_executable";
  const effectiveCwd =
    hasProtectedRoot && executesInMatchDirectory
      ? FIND_PROTECTED_TARGET_SENTINEL
      : (command[0]?.cwd ?? SAFE_WORKSPACE_CWD);
  return classifyHardlineCommandWords(
    command
      .map((word) => ({ ...word, cwd: effectiveCwd }))
      .map((word) => (hasProtectedRoot ? taintFindProtectedTarget(word) : word)),
    depth + 1,
    startupTaints,
    budget,
  );
}

function taintFindProtectedTarget(word: ShellWord): ShellWord {
  if (!word.value.includes("{}")) return word;
  return {
    ...word,
    value: word.value.replaceAll("{}", FIND_PROTECTED_TARGET_SENTINEL),
  };
}

function classifyXargsInvocation(
  args: readonly ShellWord[],
  depth: number,
  startupTaints: ReadonlySet<string>,
  budget: BashAnalysisBudget,
): HardlineBashReasonKind | undefined {
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

  if (commandIndex < 0) return undefined;
  const unknownInput: ShellWord = {
    value: "__pico_unknown_stdin__",
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
            value: word.value.replaceAll(replacement, "__pico_unknown_stdin__"),
            dynamic: true,
          }
        : word,
    );
  } else {
    command = [...command, unknownInput];
  }
  return classifyHardlineCommandWords(command, depth, startupTaints, budget);
}

function findForwardedCommandContext(
  wrapper: string,
  words: readonly ShellWord[],
  startIndex: number,
): {
  commandIndex: number;
  cwd?: ShellWord;
  environmentAssignments: readonly ShellWord[];
  outputTargets: readonly ShellWord[];
} {
  let skipOperand = wrapper === "timeout" ? 1 : 0;
  let optionsEnded = false;
  let cwd: ShellWord | undefined;
  const environmentAssignments: ShellWord[] = [];
  const outputTargets: ShellWord[] = [];
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
        if (wrapper === "time" && matchedOption === "--output" && optionValue)
          outputTargets.push(optionValue);
      }
      continue;
    }
    if (!optionsEnded && /^-[^-]/u.test(value)) {
      const match = findShortWrapperValueOption(word, words[index + 1], optionsWithValue);
      if (match) {
        if (match.consumesNext) index++;
        if (isWrapperCwdOption(wrapper, match.option)) cwd = match.value;
        if (wrapper === "time" && match.option === "-o" && match.value)
          outputTargets.push(match.value);
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
    return { commandIndex: index, ...(cwd ? { cwd } : {}), environmentAssignments, outputTargets };
  }
  return { commandIndex: -1, ...(cwd ? { cwd } : {}), environmentAssignments, outputTargets };
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
    if (attached) {
      return { option, value: { ...word, value: attached }, consumesNext: false };
    }
    return nextWord
      ? { option, value: nextWord, consumesNext: true }
      : { option, consumesNext: true };
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
    const output = word.value.match(/^of=(.*)$/su)?.[1];
    if (output === undefined) return false;
    const outputTarget = { ...word, value: output };
    return isProtectedMutationTarget(outputTarget);
  });
}

function isDestructiveGitInvocation(args: readonly ShellWord[]): boolean {
  const subcommandIndex = findGitSubcommandIndex(args);
  if (subcommandIndex < 0) return false;
  if (args[subcommandIndex]!.dynamic) return false;
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
    return args.some((word) => !word.dynamic && (word.value === "0" || word.value === "6"));
  }
  if (args.some((word) => !word.dynamic && POWER_ACTIONS.has(word.value.toLowerCase()))) {
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
    (!target.dynamic && isProtectedRmTarget(target.value)) ||
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
  if (
    target.dynamic ||
    !target.cwd ||
    target.cwd === UNKNOWN_SHELL_CWD ||
    !target.value ||
    target.value === "-"
  )
    return undefined;
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
  if (executable === "eval") return UNKNOWN_SHELL_CWD;
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

function resolveAgainstCwd(cwd: string, target: string): string {
  if (cwd === UNKNOWN_SHELL_CWD) return UNKNOWN_SHELL_CWD;
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
  if (parsed.targetDirectory && isProtectedMutationTarget(parsed.targetDirectory)) return true;
  return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
}

function isProtectedLinkInvocation(args: readonly ShellWord[]): boolean {
  const parsed = collectUtilityOperands(args, COPY_OPTIONS_WITH_VALUE, true);
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
    }
    if (!optionsEnded && value.startsWith("-")) continue;
    if (!hasExplicitScript && !consumedDefaultScript) {
      consumedDefaultScript = true;
      continue;
    }
    files.push(word);
  }
  if (!inPlace) return false;
  return files.some((file) => isProtectedMutationTarget(file));
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
  return parsed.operands.some((operand) => isProtectedMutationTarget(operand));
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

    if (target && isFileDescriptorDuplication(redirection, target)) continue;
    if (target && isPseudoDeviceRedirectionTarget(target)) continue;
    if (target && isProtectedMutationTarget(target)) return true;
  }
  return false;
}

function hasUncertainOutputRedirection(words: readonly ShellWord[]): boolean {
  return words.some((word, index) => {
    if (!word.outputRedirection) return false;
    const target = words[index + 1];
    if (target && isFileDescriptorDuplication(word, target)) return false;
    return (
      !target ||
      target.dynamic ||
      target.unquotedExpansion ||
      (target.cwd === UNKNOWN_SHELL_CWD && !target.value.startsWith("/"))
    );
  });
}

function isFileDescriptorDuplication(operator: ShellWord, target: ShellWord): boolean {
  return (
    operator.value.endsWith(">&") &&
    !target.dynamic &&
    !target.unquotedExpansion &&
    /^(?:\d+-?|-)$/u.test(target.value)
  );
}

function isPseudoDeviceRedirectionTarget(target: ShellWord): boolean {
  if (target.dynamic || target.unquotedExpansion) return false;
  const normalized = target.value.replaceAll("\\", "/").toLowerCase();
  return normalized === "/dev/null" || normalized === "/dev/tty" || normalized === "nul";
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
  return target.startsWith(`${directory}/`) && /^\/(?:[*?{[]|\.[*?{[])/u.test(suffix);
}

function isAbsoluteUserProfileTarget(target: string): boolean {
  const match = target.match(/^(?:\/(?:home|Users)|[A-Za-z]:\/Users|\/[A-Za-z]\/Users)\/[^/]+/iu);
  if (!match) return false;
  const profileRoot = match[0];
  return target === profileRoot || isWholeDirectoryContents(target, profileRoot);
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

function outputRedirectionHasTarget(value: string): boolean {
  const target = value.match(/^(?:\d+|\{[^}]+\}|&)?(?:>\||>>?)(.*)$/su)?.[1];
  return target !== undefined && target !== "" && target !== "&";
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

const UNKNOWN_SHELL_CWD = "__pico_unknown_cwd__";

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
  "--inspect-port",
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
  "ionice",
  "nice",
  "nohup",
  "stdbuf",
  "sudo",
  "time",
  "timeout",
  "toybox",
]);

const FIND_PRE_PATH_OPTIONS: ReadonlySet<string> = new Set(["-H", "-L", "-P"]);

const FIND_EXEC_ACTIONS: ReadonlySet<string> = new Set(["-exec", "-execdir", "-ok", "-okdir"]);

const FIND_OUTPUT_ACTIONS: ReadonlySet<string> = new Set([
  "-fls",
  "-fprint",
  "-fprint0",
  "-fprintf",
]);

const FIND_EXPRESSION_OPTIONS_WITH_VALUE: ReadonlySet<string> = new Set([
  "-amin",
  "-anewer",
  "-atime",
  "-cmin",
  "-cnewer",
  "-ctime",
  "-files0-from",
  "-fstype",
  "-gid",
  "-group",
  "-ilname",
  "-iname",
  "-inum",
  "-ipath",
  "-iregex",
  "-iwholename",
  "-links",
  "-lname",
  "-maxdepth",
  "-mindepth",
  "-mmin",
  "-mtime",
  "-name",
  "-newer",
  "-path",
  "-perm",
  "-printf",
  "-regex",
  "-regextype",
  "-samefile",
  "-size",
  "-type",
  "-uid",
  "-used",
  "-user",
  "-wholename",
  "-xtype",
]);

const FIND_PROTECTED_TARGET_SENTINEL = "/etc/.pico-find-protected-target";

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

const LEGACY_LITERAL_HARDLINE_PATTERNS: readonly {
  readonly pattern: RegExp;
  readonly reasonKind: HardlineBashReasonKind;
}[] = [
  {
    pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*\s+\/(?:["'\s}]|$)/iu,
    reasonKind: "protected_destination",
  },
  {
    pattern: /\brm\s+-[a-z]*f[a-z]*r[a-z]*\s+\/(?:["'\s}]|$)/iu,
    reasonKind: "protected_destination",
  },
  { pattern: /\bmkfs(?:\.[a-z0-9]+)?\s+\/dev\//iu, reasonKind: "destructive_system" },
  { pattern: /\bdd\s+if=.*\bof=\/dev\//iu, reasonKind: "destructive_system" },
  { pattern: /:\(\)\s*\{/u, reasonKind: "destructive_system" },
  {
    pattern: /\bgit\s+push\s+(?:-f|--force)\s+.*\b(?:main|master)\b/iu,
    reasonKind: "destructive_git",
  },
];
