import { isAbsolute } from "node:path";

/**
 * 提取 shell 中可以静态确认的写目标。
 *
 * 这里只识别少量高置信语法，避免把 `cat /tmp/a`、`ls ../x` 之类只读命令
 * 误判为写入。无法可靠判断的 shell 仍由普通 Bash 权限策略处理。
 */
export function extractBashWritePaths(command: string): string[] {
  const paths = new Set<string>();

  collectMatches(command, /(?:^|[\s;|&])\d*>>?\s*(?!&)("[^"]+"|'[^']+'|[^\s;|&]+)/gu, paths, 1);
  collectMatches(command, /\btee(?:\s+-a)?\s+("[^"]+"|'[^']+'|[^\s;|&]+)/gu, paths, 1);
  collectMatches(
    command,
    /\b(?:touch|mkdir|rmdir|unlink)\s+(?:-[^\s]+\s+)*("[^"]+"|'[^']+'|[^\s;|&]+)/gu,
    paths,
    1,
  );

  for (const segment of command.split(/(?:&&|\|\||;|\n)/u)) {
    const tokens = shellWords(segment);
    const executableIndex = tokens.findIndex((token) => !isEnvironmentAssignment(token));
    if (executableIndex < 0) continue;
    const executable = basenameCommand(tokens[executableIndex]!);
    const args = tokens.slice(executableIndex + 1).filter((token) => !token.startsWith("-"));

    if (
      (executable === "cp" || executable === "mv" || executable === "install") &&
      args.length >= 2
    ) {
      paths.add(args.at(-1)!);
    }
    if (executable === "sed" && tokens.some((token) => token === "-i" || token.startsWith("-i"))) {
      for (const path of args.slice(1)) paths.add(path);
    }
    if (executable === "chmod" || executable === "chown") {
      for (const path of args.slice(1)) paths.add(path);
    }
    if (executable === "rm") {
      for (const path of args) paths.add(path);
    }
  }

  return [...paths].map(cleanShellPath).filter(isConcretePath);
}

export function bashCommandFromArgs(args: string): string | undefined {
  try {
    const input = JSON.parse(args) as { command?: unknown };
    return typeof input.command === "string" ? input.command : undefined;
  } catch {
    return undefined;
  }
}

function collectMatches(
  command: string,
  pattern: RegExp,
  paths: Set<string>,
  captureIndex: number,
): void {
  for (const match of command.matchAll(pattern)) {
    const path = match[captureIndex];
    if (path) paths.add(path);
  }
}

function shellWords(segment: string): string[] {
  return [...segment.matchAll(/"([^"]*)"|'([^']*)'|([^\s]+)/gu)].map(
    (match) => match[1] ?? match[2] ?? match[3] ?? "",
  );
}

function isEnvironmentAssignment(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/u.test(token);
}

function basenameCommand(command: string): string {
  return command.split(/[\\/]/u).at(-1) ?? command;
}

function cleanShellPath(path: string): string {
  return path.replace(/^["']/u, "").replace(/["'),}\]]+$/u, "");
}

function isConcretePath(path: string): boolean {
  if (!path || path === "/dev/null" || path === "-") return false;
  if (path.startsWith("&") || path.includes("$")) return false;
  return isAbsolute(path) || path.startsWith(".") || !path.includes("://");
}
