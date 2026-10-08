/**
 * PowerShell 命令权限的保守分类(Windows 宿主方言)。
 *
 * 与 bash-safety.ts 同构:Shell 文本无法被静态分析器完整证明安全,只识别
 * 一个很小的、无写入能力的 cmdlet 子集;任何不确定语法都必须进入审批。
 *
 * PowerShell 的对象管道/子表达式/变量展开比 bash 更难静态约束,因此更保守:
 * 变量($)、子表达式(())、scriptblock({})、调用运算符(&)、splat(@)、
 * 反引号转义、重定向、注释符一律 requires-approval——宁可多审批,不可错判。
 */
import { classifyGitCommand } from "./bash-safety.js";
import type { BashHardlineAnalysis, HardlineBashReasonKind } from "./bash-hardline.js";

/** Windows `full-access` 仍保留不可审批绕过的确定性红线；这里只拦截高置信破坏语义。 */
export function classifyPowerShellHardlineCommand(
  command: string,
): HardlineBashReasonKind | undefined {
  const analysis = analyzePowerShellHardlineCommand(command);
  return analysis.kind === "deny" ? analysis.reasonKind : undefined;
}

export function analyzePowerShellHardlineCommand(command: string): BashHardlineAnalysis {
  const reasonKind = powerShellHardlineReason(command);
  return reasonKind === undefined
    ? { kind: "no_match" }
    : {
        kind:
          reasonKind === "opaque_shell" || reasonKind === "unknown_hardline" ? "unknown" : "deny",
        reasonKind,
      };
}

function powerShellHardlineReason(command: string): HardlineBashReasonKind | undefined {
  const normalized = command.trim();
  if (!normalized) return "unknown_hardline";
  const statements = parseConservativeStatements(normalized, true);
  let unknownReason: HardlineBashReasonKind | undefined =
    statements.kind === "unsupported" ? "unknown_hardline" : undefined;
  for (const segment of statements.pipelines) {
    // PowerShell 的 quoted head 是字符串表达式；调用运算符仍属于 unsupported。
    if (segment.quotedExecutable) {
      unknownReason ??= "unknown_hardline";
      continue;
    }
    const reason = powerShellSegmentHardlineReason(segment);
    if (reason === "opaque_shell") unknownReason = reason;
    else if (reason !== undefined) return reason;
  }
  return unknownReason;
}

function normalizePowerShellExecutable(token: string | undefined): string | undefined {
  return token
    ?.split(/[\\/]/u)
    .at(-1)
    ?.toLowerCase()
    .replace(/\.exe$/u, "");
}

function powerShellSegmentHardlineReason(
  segment: ParsedPowerShellSegment,
): HardlineBashReasonKind | undefined {
  const { tokens, literalTokens } = segment;
  const executable = normalizePowerShellExecutable(tokens[0]);
  const args = tokens.slice(1);
  const literalArgs = literalTokens.slice(1);
  if (
    executable === "git" &&
    args[0]?.toLowerCase() === "push" &&
    args.slice(1).some((arg) => /^(?:--force(?:-with-lease(?:=.*)?)?|-f)$/iu.test(arg))
  ) {
    return "destructive_git";
  }
  if (
    executable !== undefined &&
    /^(?:format-volume|clear-disk|initialize-disk|remove-partition|stop-computer|restart-computer|remove-localuser|disable-localuser|bcdedit|diskpart)$/u.test(
      executable,
    )
  ) {
    return "destructive_system";
  }
  if (
    executable === "stop-process" &&
    literalArgs.some((values, index) => {
      const arg = values[0] ?? "";
      const inlineName = /^-name:(.*)$/iu.exec(arg)?.[1];
      const names =
        inlineName !== undefined
          ? [inlineName, ...values.slice(1)]
          : arg.toLowerCase() === "-name"
            ? literalArgs[index + 1]
            : undefined;
      return names?.some((name) => /^(?:wininit|csrss|lsass|services)(?:\.exe)?$/iu.test(name));
    })
  ) {
    return "destructive_system";
  }
  if (
    executable !== undefined &&
    /^(?:remove-item|del|erase|rd|rmdir|rm)$/u.test(executable) &&
    literalArgs.flat().some((arg) => {
      const target = arg.replace(/^-(?:literalpath|path):/iu, "").replaceAll("/", "\\");
      return (
        arg === "/" ||
        /^(?:[a-z]:)?\\(?:windows|program files|users)(?:\\|$|[?*])|^[a-z]:\\$/iu.test(target)
      );
    })
  ) {
    return "protected_destination";
  }
  if (
    executable === "invoke-expression" ||
    executable === "iex" ||
    executable === "add-type" ||
    ((executable === "powershell" || executable === "pwsh") &&
      args.some((arg) => /^-(?:encodedcommand|enc)(?::|$)/iu.test(arg)))
  ) {
    return "opaque_shell";
  }
  return undefined;
}

export type PowerShellSafetyClassification =
  | { readonly kind: "read-only" }
  | { readonly kind: "requires-approval"; readonly reason: string };
export function classifyPowerShellCommand(command: string): PowerShellSafetyClassification {
  const statements = parseConservativeStatements(command);
  if (statements.kind === "unsupported") {
    return { kind: "requires-approval", reason: statements.reason };
  }
  if (statements.pipelines.length === 0) {
    return { kind: "requires-approval", reason: "命令为空或无法确认执行内容" };
  }
  for (const segment of statements.pipelines) {
    const decision = classifyPipelineSegment(segment.tokens);
    if (decision.kind === "requires-approval") return decision;
  }
  return { kind: "read-only" };
}

interface ParsedPowerShellSegment {
  readonly tokens: readonly string[];
  /** 仅引号外的逗号分隔字面量；native argv 仍使用 tokens。 */
  readonly literalTokens: readonly (readonly string[])[];
  readonly quotedExecutable: boolean;
}

type ParsedStatements =
  | { readonly kind: "parsed"; readonly pipelines: readonly ParsedPowerShellSegment[] }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
      readonly pipelines: readonly ParsedPowerShellSegment[];
    };

/**
 * 语句按 `;`/换行切分,语句内再按 `|` 切分管段(引号感知)。
 * 双引号内含 `$`(变量展开)同样拒绝——静态无法确认展开结果。
 * Hardline 可保留已确认 argv 并在明确边界恢复；嵌套内容只跳过，不判定执行语义。
 */
function parseConservativeStatements(
  command: string,
  recoverUnsupported = false,
): ParsedStatements {
  const pipelines: ParsedPowerShellSegment[] = [];
  let tokens: string[] = [];
  let literalTokens: string[][] = [];
  let token = "";
  let tokenCommaOffsets: number[] = [];
  let arrayContinues = false;
  let tokenStarted = false;
  let tokenQuoted = false;
  let quotedExecutable = false;
  let quote: "single" | "double" | undefined;
  let unsupportedReason: string | undefined;
  let skipSegment = false;
  let lineComment = false;
  let blockCommentDepth = 0;
  const nestedClosers: string[] = [];
  const usesLiteralArrays = (): boolean =>
    /^(?:stop-process|remove-item|del|erase|rd|rmdir|rm)$/u.test(
      normalizePowerShellExecutable(tokens[0]) ?? "",
    );
  const arrayCommaFollows = (start: number): boolean => {
    let commentDepth = 0;
    for (let index = start; index < command.length; index++) {
      const char = command[index]!;
      const next = command[index + 1];
      if (char === "<" && next === "#") {
        commentDepth++;
        index++;
        continue;
      }
      if (commentDepth > 0) {
        if (char === "#" && next === ">") {
          commentDepth--;
          index++;
        }
        continue;
      }
      if (char === "\n" || !/\s/u.test(char)) return char === ",";
    }
    return false;
  };
  const continuesLiteralArray = (index: number): boolean =>
    tokenStarted && usesLiteralArrays() && (arrayContinues || arrayCommaFollows(index));

  const unsupported = (reason: string, canRecover = true): ParsedStatements | undefined => {
    unsupportedReason ??= reason;
    if (!recoverUnsupported || !canRecover) {
      if (recoverUnsupported && tokens.length > 0)
        pipelines.push({ tokens, literalTokens, quotedExecutable });
      return { kind: "unsupported", reason: unsupportedReason, pipelines };
    }
    // 未完成的 token 可能仍会展开/转义，不能把其静态前缀当成完整 argv。
    token = "";
    tokenCommaOffsets = [];
    arrayContinues = false;
    tokenStarted = false;
    tokenQuoted = false;
    skipSegment = true;
    return undefined;
  };

  const finishToken = (): void => {
    if (!tokenStarted) return;
    if (tokens.length === 0) quotedExecutable = tokenQuoted;
    tokens.push(token);
    let start = 0;
    const values = tokenCommaOffsets.map((offset) => {
      const value = token.slice(start, offset);
      start = offset + 1;
      return value;
    });
    values.push(token.slice(start));
    literalTokens.push(values);
    token = "";
    tokenCommaOffsets = [];
    arrayContinues = false;
    tokenStarted = false;
    tokenQuoted = false;
  };
  const finishSegment = (): ParsedStatements | undefined => {
    finishToken();
    if (tokens.length === 0) {
      const rejection = unsupported("包含空命令或无法确认的 shell 运算符");
      if (rejection) return rejection;
    } else {
      pipelines.push({ tokens, literalTokens, quotedExecutable });
    }
    tokens = [];
    literalTokens = [];
    quotedExecutable = false;
    skipSegment = false;
    return undefined;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];

    if (blockCommentDepth > 0) {
      if (char === "<" && next === "#") {
        blockCommentDepth++;
        index++;
      } else if (char === "#" && next === ">") {
        blockCommentDepth--;
        index++;
      }
      continue;
    }
    if (lineComment && char !== "\n") continue;
    if (lineComment) lineComment = false;

    if (quote === "single") {
      if (char === "'") {
        // '' 是 PowerShell 单引号转义,继续留在引号内
        if (next === "'") {
          if (!skipSegment) token += "'";
          index++;
          continue;
        }
        quote = undefined;
        continue;
      }
      if (!skipSegment) token += char;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        continue;
      }
      // 双引号内 $ 展开变量、反引号转义,均无法静态确认
      if (char === "$" || char === "`") {
        // 插值子表达式可含嵌套引号，现有分词器无法确认其结束位置。
        const rejection = unsupported(
          "双引号内包含变量展开或转义",
          !(char === "$" && next === "("),
        );
        if (rejection) return rejection;
        if (char === "`") index++;
        continue;
      }
      if (!skipSegment) token += char;
      continue;
    }

    if (char === "'") {
      quote = "single";
      if (!skipSegment) {
        tokenStarted = true;
        tokenQuoted = true;
        arrayContinues = false;
      }
      continue;
    }
    if (char === '"') {
      quote = "double";
      if (!skipSegment) {
        tokenStarted = true;
        tokenQuoted = true;
        arrayContinues = false;
      }
      continue;
    }
    if (char === "#" || (char === "<" && next === "#")) {
      if (char === "#" || !continuesLiteralArray(index)) finishToken();
      unsupportedReason ??= "包含注释符";
      if (!recoverUnsupported) return { kind: "unsupported", reason: unsupportedReason, pipelines };
      // 注释是数据/空白，不吞掉同一语句中注释后的命令或参数。
      if (char === "#") lineComment = true;
      else {
        blockCommentDepth++;
        index++;
      }
      continue;
    }
    if ((char === "|" || char === "&") && next === char) {
      if (nestedClosers.length === 0) finishToken();
      const rejection = unsupported("包含管道链运算符");
      if (rejection) return rejection;
      if (nestedClosers.length === 0) finishSegment();
      index++;
      continue;
    }
    if (isUnsupportedShellCharacter(char)) {
      if ((char === ">" || char === "<") && next !== "#") finishToken();
      const rejection = unsupported(
        UNSUPPORTED_CHARACTER_REASONS[char] ?? "包含无法静态确认的 shell 语法",
        // here-string 的引号不遵循普通字符串规则，不从其内部恢复扫描。
        !(char === "@" && (next === "'" || next === '"')),
      );
      if (rejection) return rejection;
      if (char === "`") index++;
      if (char === "(" || char === "{") nestedClosers.push(char === "(" ? ")" : "}");
      if (char === nestedClosers.at(-1)) nestedClosers.pop();
      continue;
    }
    if (char === ";" || char === "\n") {
      if (nestedClosers.length > 0) continue;
      const rejection = finishSegment();
      if (rejection) return rejection;
      continue;
    }
    if (char === "|") {
      if (nestedClosers.length > 0) continue;
      const rejection = finishSegment();
      if (rejection) return rejection;
      continue;
    }
    if (/\s/u.test(char)) {
      if (continuesLiteralArray(index)) continue;
      finishToken();
      continue;
    }
    if (!skipSegment) {
      if (char === "," && usesLiteralArrays()) tokenCommaOffsets.push(token.length);
      token += char;
      tokenStarted = true;
      arrayContinues = char === ",";
    }
  }

  if (quote !== undefined) {
    const rejection = unsupported("包含未闭合的引号");
    if (rejection) return rejection;
  }
  finishToken();
  if (tokens.length > 0) pipelines.push({ tokens, literalTokens, quotedExecutable });
  if (unsupportedReason !== undefined)
    return { kind: "unsupported", reason: unsupportedReason, pipelines };
  return { kind: "parsed", pipelines };
}

/** 引号外出现即拒绝的字符及其原因。 */
const UNSUPPORTED_CHARACTER_REASONS: Readonly<Record<string, string>> = {
  $: "包含变量或子表达式",
  "`": "包含反引号转义",
  "(": "包含子表达式",
  ")": "包含子表达式",
  "{": "包含 scriptblock",
  "}": "包含 scriptblock",
  "@": "包含 splat 或数组子表达式",
  "&": "包含调用运算符",
  ">": "包含重定向",
  "<": "包含重定向",
  "#": "包含注释符",
};

function isUnsupportedShellCharacter(char: string): boolean {
  return char in UNSUPPORTED_CHARACTER_REASONS;
}

function classifyPipelineSegment(tokens: readonly string[]): PowerShellSafetyClassification {
  const head = tokens[0];
  if (
    !head ||
    head.includes("\\") ||
    head.includes("/") ||
    head.includes(":") ||
    head.startsWith("-")
  ) {
    return { kind: "requires-approval", reason: "无法确认实际执行的命令" };
  }
  const name = head.toLowerCase();
  // 内置 alias 归一到 cmdlet 再查白名单
  const cmdlet = POWERSHELL_READ_ONLY_ALIASES[name] ?? name;
  if (READ_ONLY_POWERSHELL_COMMANDS.has(cmdlet)) return { kind: "read-only" };
  // git 子命令的只读判定与宿主方言无关,复用 bash 侧实现
  if (cmdlet === "git") return classifyGitCommand(tokens.slice(1));
  return { kind: "requires-approval", reason: `命令 ${head} 不在只读白名单中` };
}

const READ_ONLY_POWERSHELL_COMMANDS: ReadonlySet<string> = new Set([
  "get-childitem",
  "get-content",
  "get-item",
  "get-location",
  "get-date",
  "get-command",
  "get-process",
  "get-service",
  "get-filehash",
  "resolve-path",
  "select-object",
  "select-string",
  "measure-object",
  "sort-object",
  "format-table",
  "format-list",
  "test-path",
  "write-output",
]);

const POWERSHELL_READ_ONLY_ALIASES: Readonly<Record<string, string>> = {
  ls: "get-childitem",
  dir: "get-childitem",
  gci: "get-childitem",
  cat: "get-content",
  gc: "get-content",
  type: "get-content",
  pwd: "get-location",
  gl: "get-location",
  echo: "write-output",
  write: "write-output",
  select: "select-object",
};
