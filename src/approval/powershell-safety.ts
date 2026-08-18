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
    const decision = classifyPipelineSegment(segment);
    if (decision.kind === "requires-approval") return decision;
  }
  return { kind: "read-only" };
}

type ParsedStatements =
  | { readonly kind: "parsed"; readonly pipelines: readonly (readonly string[])[] }
  | { readonly kind: "unsupported"; readonly reason: string };

/**
 * 语句按 `;`/换行切分,语句内再按 `|` 切分管段(引号感知)。
 * 双引号内含 `$`(变量展开)同样拒绝——静态无法确认展开结果。
 */
function parseConservativeStatements(command: string): ParsedStatements {
  const pipelines: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let tokenStarted = false;
  let quote: "single" | "double" | undefined;

  const finishToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  const finishSegment = (): ParsedStatements | undefined => {
    finishToken();
    if (tokens.length === 0) {
      return { kind: "unsupported", reason: "包含空命令或无法确认的 shell 运算符" };
    }
    pipelines.push(tokens);
    tokens = [];
    return undefined;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];

    if (quote === "single") {
      if (char === "'") {
        // '' 是 PowerShell 单引号转义,继续留在引号内
        if (next === "'") {
          token += "'";
          index++;
          continue;
        }
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      token += char;
      tokenStarted = true;
      continue;
    }

    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      // 双引号内 $ 展开变量、反引号转义,均无法静态确认
      if (char === "$" || char === "`") {
        return { kind: "unsupported", reason: "双引号内包含变量展开或转义" };
      }
      token += char;
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
    if (isUnsupportedShellCharacter(char)) {
      return { kind: "unsupported", reason: UNSUPPORTED_CHARACTER_REASONS[char] ?? "包含无法静态确认的 shell 语法" };
    }
    if (char === "|" && next === "|") {
      // pwsh 7 管道链 || / &&(条件执行),保守拒绝
      return { kind: "unsupported", reason: "包含管道链运算符" };
    }
    if (char === ";" || char === "\n") {
      const rejection = finishSegment();
      if (rejection) return rejection;
      continue;
    }
    if (char === "|") {
      const rejection = finishSegment();
      if (rejection) return rejection;
      continue;
    }
    if (/\s/u.test(char)) {
      finishToken();
      continue;
    }
    token += char;
    tokenStarted = true;
  }

  if (quote !== undefined) {
    return { kind: "unsupported", reason: "包含未闭合的引号" };
  }
  finishToken();
  if (tokens.length > 0) pipelines.push(tokens);
  if (pipelines.some((segment) => segment.length === 0)) {
    return { kind: "unsupported", reason: "包含空命令或无法确认的 shell 运算符" };
  }
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
  if (!head || head.includes("\\") || head.includes("/") || head.includes(":") || head.startsWith("-")) {
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
