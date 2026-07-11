/**
 * Bash 权限的保守分类结果。
 *
 * Shell 文本无法被静态分析器完整证明安全，因此这里只识别一个很小的、
 * 无写入能力的命令子集。任何不确定语法都必须进入审批或由 Plan Mode 拒绝。
 */
export type BashSafetyClassification =
  | { readonly kind: "read-only" }
  | { readonly kind: "requires-approval"; readonly reason: string };

export function classifyBashCommand(command: string): BashSafetyClassification {
  const parsed = parseConservativePipeline(command);
  if (parsed.kind === "unsupported") {
    return { kind: "requires-approval", reason: parsed.reason };
  }
  if (parsed.commands.length === 0) {
    return { kind: "requires-approval", reason: "命令为空或无法确认执行内容" };
  }

  for (const tokens of parsed.commands) {
    const decision = classifySimpleCommand(tokens);
    if (decision.kind === "requires-approval") return decision;
  }
  return { kind: "read-only" };
}

type ParsedPipeline =
  | { readonly kind: "parsed"; readonly commands: readonly (readonly string[])[] }
  | { readonly kind: "unsupported"; readonly reason: string };

function parseConservativePipeline(command: string): ParsedPipeline {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let token = "";
  let quote: "single" | "double" | undefined;
  let tokenStarted = false;

  const finishToken = (): void => {
    if (!tokenStarted) return;
    tokens.push(token);
    token = "";
    tokenStarted = false;
  };
  const finishCommand = (): ParsedPipeline | undefined => {
    finishToken();
    if (tokens.length === 0) {
      return { kind: "unsupported", reason: "包含空命令或无法确认的 shell 运算符" };
    }
    commands.push(tokens);
    tokens = [];
    return undefined;
  };

  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    const next = command[index + 1];

    if (quote === "single") {
      if (char === "'") quote = undefined;
      else token += char;
      tokenStarted = true;
      continue;
    }
    if (quote === "double") {
      if (char === '"') {
        quote = undefined;
        tokenStarted = true;
        continue;
      }
      if (char === "`" || (char === "$" && (next === "(" || next === "{"))) {
        return { kind: "unsupported", reason: "包含命令替换或动态 shell 展开" };
      }
      if (char === "\\") {
        if (next === undefined) {
          return { kind: "unsupported", reason: "包含未完成的转义" };
        }
        token += next;
        tokenStarted = true;
        index++;
        continue;
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
    if (char === "`" || (char === "$" && (next === "(" || next === "{"))) {
      return { kind: "unsupported", reason: "包含命令替换或动态 shell 展开" };
    }
    if (char === "\\") {
      return { kind: "unsupported", reason: "包含无法静态确认的 shell 转义" };
    }
    if (char === ">" || char === "<") {
      return { kind: "unsupported", reason: "包含重定向" };
    }
    if (char === "(" || char === ")" || char === "{" || char === "}" || char === "#") {
      return { kind: "unsupported", reason: "包含无法静态确认的 shell 控制语法" };
    }
    if (char === "&" && next !== "&") {
      return { kind: "unsupported", reason: "包含后台执行或无法静态确认的 & 运算符" };
    }
    if (char === ";" || char === "\n" || char === "|") {
      const rejection = finishCommand();
      if (rejection) return rejection;
      if (char === "|" && next === "|") index++;
      continue;
    }
    if (char === "&" && next === "&") {
      const rejection = finishCommand();
      if (rejection) return rejection;
      index++;
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
  if (tokens.length > 0) commands.push(tokens);
  return { kind: "parsed", commands };
}

function classifySimpleCommand(tokens: readonly string[]): BashSafetyClassification {
  const executable = tokens[0];
  if (!executable || executable.includes("/") || executable.includes("$")) {
    return { kind: "requires-approval", reason: "无法确认实际执行程序" };
  }
  if (/^[A-Za-z_][A-Za-z0-9_]*=/u.test(executable)) {
    return { kind: "requires-approval", reason: "包含环境赋值或动态命令" };
  }

  const args = tokens.slice(1);
  if (ALWAYS_READ_ONLY_COMMANDS.has(executable)) return { kind: "read-only" };
  if (executable === "rg") {
    return args.some((arg) => arg === "--pre" || arg.startsWith("--pre="))
      ? { kind: "requires-approval", reason: "rg --pre 可以执行外部程序" }
      : { kind: "read-only" };
  }
  if (executable === "command") {
    return args.length === 2 && (args[0] === "-v" || args[0] === "-V")
      ? { kind: "read-only" }
      : { kind: "requires-approval", reason: "command 可能执行任意程序" };
  }
  if (executable === "env") {
    return args.every((arg) => SAFE_ENV_READ_OPTIONS.has(arg))
      ? { kind: "read-only" }
      : {
          kind: "requires-approval",
          reason: "env 参数可能通过 -S/--split-string 执行任意程序",
        };
  }
  if (executable === "git") return classifyGitCommand(args);

  return { kind: "requires-approval", reason: `命令 ${executable} 不在只读白名单中` };
}

function classifyGitCommand(args: readonly string[]): BashSafetyClassification {
  let subcommandIndex = 0;
  while (args[subcommandIndex] === "--no-pager" || args[subcommandIndex] === "--paginate") {
    subcommandIndex++;
  }
  const subcommand = args[subcommandIndex];
  if (!subcommand) {
    return { kind: "requires-approval", reason: "无法确认 git 子命令" };
  }
  const subcommandArgs = args.slice(subcommandIndex + 1);
  if (subcommandArgs.some(isGitWriteCapableOption)) {
    return { kind: "requires-approval", reason: "git 参数可能写文件或执行外部程序" };
  }
  if (GIT_READ_ONLY_SUBCOMMANDS.has(subcommand)) return { kind: "read-only" };
  if (subcommand === "branch") {
    return subcommandArgs.length === 0 ||
      subcommandArgs.every(
        (arg) => arg === "--list" || arg === "--show-current" || arg.startsWith("--format="),
      )
      ? { kind: "read-only" }
      : { kind: "requires-approval", reason: "git branch 参数可能修改分支" };
  }
  if (subcommand === "remote") {
    return subcommandArgs.length === 0 ||
      subcommandArgs.every((arg) => arg === "-v" || arg === "--verbose") ||
      subcommandArgs[0] === "get-url"
      ? { kind: "read-only" }
      : { kind: "requires-approval", reason: "git remote 参数可能修改远端配置" };
  }
  return { kind: "requires-approval", reason: `git ${subcommand} 不是只读子命令` };
}

function isGitWriteCapableOption(arg: string): boolean {
  return (
    arg === "--ext-diff" ||
    arg === "--filters" ||
    arg === "--textconv" ||
    arg === "--config-env" ||
    arg === "-c" ||
    arg.startsWith("-c") ||
    arg === "--output" ||
    arg.startsWith("--output=")
  );
}

const ALWAYS_READ_ONLY_COMMANDS: ReadonlySet<string> = new Set([
  "basename",
  "cat",
  "cut",
  "df",
  "dirname",
  "du",
  "echo",
  "file",
  "grep",
  "head",
  "id",
  "ls",
  "printf",
  "printenv",
  "pwd",
  "readlink",
  "realpath",
  "stat",
  "tail",
  "test",
  "tr",
  "type",
  "uname",
  "wc",
  "which",
  "whoami",
]);

const SAFE_ENV_READ_OPTIONS: ReadonlySet<string> = new Set([
  "-0",
  "--null",
  "-i",
  "--ignore-environment",
]);

const GIT_READ_ONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "cat-file",
  "describe",
  "diff",
  "grep",
  "log",
  "ls-files",
  "ls-tree",
  "name-rev",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "status",
]);
