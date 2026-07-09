import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import type { Dirent } from "node:fs";

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<string>;

export interface FileSuggestionOptions {
  cwd: string;
  query?: string;
  limit?: number;
  commandRunner?: CommandRunner;
}

const execFileAsync = promisify(execFile);
const DEFAULT_LIMIT = 50;
const IGNORED_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".claw",
  "node_modules",
  "dist",
  "build",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
]);

export async function listFileSuggestions(
  options: FileSuggestionOptions,
): Promise<string[]> {
  const query = normalizeQuery(options.query ?? "");
  const limit = options.limit ?? DEFAULT_LIMIT;
  const runner = options.commandRunner ?? runCommand;

  const files =
    (await tryCommand(runner, "git", ["ls-files"], options.cwd)) ??
    (await tryCommand(runner, "rg", ["--files"], options.cwd)) ??
    (await scanFiles(options.cwd));

  return unique(files)
    .filter((file) => query.length === 0 || file.includes(query))
    .sort()
    .slice(0, limit);
}

async function tryCommand(
  runner: CommandRunner,
  command: string,
  args: string[],
  cwd: string,
): Promise<string[] | undefined> {
  try {
    const output = await runner(command, args, cwd);
    const files = parseCommandOutput(output);
    return files.length > 0 ? files : undefined;
  } catch {
    return undefined;
  }
}

async function runCommand(
  command: string,
  args: string[],
  cwd: string,
): Promise<string> {
  const { stdout } = await execFileAsync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  return stdout;
}

function parseCommandOutput(output: string): string[] {
  return output
    .split(/\r?\n/)
    .map((line) => normalizePath(line.trim()))
    .filter((line) => line.length > 0);
}

async function scanFiles(root: string): Promise<string[]> {
  const results: string[] = [];

  async function walk(dir: string): Promise<void> {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (IGNORED_DIRS.has(entry.name)) continue;
        await walk(join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      results.push(normalizePath(relative(root, join(dir, entry.name))));
    }
  }

  await walk(root);
  return results;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

function normalizeQuery(query: string): string {
  const normalized = normalizePath(query.trim());
  if (normalized.startsWith('@"')) {
    return normalized.slice(2).replace(/"$/, "");
  }
  if (normalized.startsWith("@")) {
    return normalized.slice(1);
  }
  return normalized;
}
