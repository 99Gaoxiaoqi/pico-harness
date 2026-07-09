import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { promisify } from "node:util";

export type CommandRunner = (
  command: string,
  args: string[],
  cwd: string,
) => Promise<string>;

export interface FileIndexOptions {
  cwd: string;
  commandRunner?: CommandRunner;
}

export interface FileSuggestionOptions {
  cwd: string;
  query?: string;
  limit?: number;
  commandRunner?: CommandRunner;
  fileIndex?: FileIndex;
}

interface DirectoryEntry {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

const execFileAsync = promisify(execFile);

export const DEFAULT_FILE_SUGGESTION_LIMIT = 50;
export const FILE_SUGGESTION_IGNORED_DIRS: ReadonlySet<string> = new Set([
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

export class FileIndex {
  private cachedFiles: string[] | undefined;

  private constructor(
    private readonly cwd: string,
    private readonly commandRunner: CommandRunner,
  ) {}

  static create(options: FileIndexOptions): FileIndex {
    return new FileIndex(options.cwd, options.commandRunner ?? runCommand);
  }

  async query(
    text: string,
    limit = DEFAULT_FILE_SUGGESTION_LIMIT,
  ): Promise<string[]> {
    const query = normalizeFileQuery(text);
    const files = await this.getFiles();

    return files
      .filter((file) => query.length === 0 || file.includes(query))
      .slice(0, limit);
  }

  async refresh(): Promise<void> {
    this.cachedFiles = await discoverFiles(this.cwd, this.commandRunner);
  }

  private async getFiles(): Promise<string[]> {
    if (this.cachedFiles === undefined) {
      await this.refresh();
    }
    return this.cachedFiles ?? [];
  }
}

export async function listFileSuggestions(
  options: FileSuggestionOptions,
): Promise<string[]> {
  const index =
    options.fileIndex ??
    FileIndex.create({
      cwd: options.cwd,
      commandRunner: options.commandRunner,
    });

  return index.query(options.query ?? "", options.limit ?? DEFAULT_FILE_SUGGESTION_LIMIT);
}

async function discoverFiles(
  cwd: string,
  runner: CommandRunner,
): Promise<string[]> {
  const files =
    (await tryCommand(runner, "git", ["-c", "core.quotepath=false", "ls-files"], cwd)) ??
    (await tryCommand(runner, "rg", ["--files"], cwd)) ??
    (await scanFiles(cwd));

  return unique(files)
    .filter((file) => !isIgnoredPath(file))
    .sort();
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
    let entries: DirectoryEntry[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (FILE_SUGGESTION_IGNORED_DIRS.has(entry.name)) continue;
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

function isIgnoredPath(file: string): boolean {
  return file.split("/").some((part) => FILE_SUGGESTION_IGNORED_DIRS.has(part));
}

function normalizePath(path: string): string {
  return path.replaceAll("\\", "/");
}

export function normalizeFileQuery(query: string): string {
  const normalized = normalizePath(query.trim());
  if (normalized.startsWith('@"')) {
    return normalized.slice(2).replace(/"$/, "");
  }
  if (normalized.startsWith("@")) {
    return normalized.slice(1);
  }
  return normalized;
}
