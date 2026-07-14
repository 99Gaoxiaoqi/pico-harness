import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, relative, resolve, sep } from "node:path";

export type ProjectEntrypointStatus = "created" | "existing";

export interface ProjectEntrypointResult {
  readonly path: "AGENTS.md" | ".pico/config.json";
  readonly status: ProjectEntrypointStatus;
}

export interface ProjectInitializationResult {
  readonly workspacePath: string;
  readonly files: readonly ProjectEntrypointResult[];
  readonly message: string;
}

const AGENTS_TEMPLATE = [
  "# AGENTS.md",
  "",
  "## Project Guidance",
  "",
  "- Keep changes small and easy to review.",
  "- Prefer existing project conventions before adding new patterns.",
  "",
].join("\n");

const CONFIG_TEMPLATE = `${JSON.stringify(
  {
    version: 1,
    commandsDir: ".pico/commands",
    keybindings: {},
  },
  null,
  2,
)}\n`;

/**
 * Shared `/init` domain operation. Existing files are never overwritten and the
 * project config directory must resolve inside the canonical workspace.
 */
export async function initializeProjectEntrypoints(
  workDir: string,
): Promise<ProjectInitializationResult> {
  const workspacePath = await realpath(workDir);
  const picoDir = join(workspacePath, ".pico");
  await mkdir(picoDir, { recursive: true });
  const physicalPicoDir = await realpath(picoDir);
  if (!isWithin(workspacePath, physicalPicoDir)) {
    throw new Error(`拒绝初始化：${picoDir} 解析到工作区边界外`);
  }
  const agents = await createFileIfAbsent(join(workspacePath, "AGENTS.md"), AGENTS_TEMPLATE);
  const config = await createFileIfAbsent(join(physicalPicoDir, "config.json"), CONFIG_TEMPLATE);
  const files = Object.freeze([
    { path: "AGENTS.md", status: agents },
    { path: ".pico/config.json", status: config },
  ] satisfies ProjectEntrypointResult[]);
  return {
    workspacePath,
    files,
    message: renderProjectInitialization(files),
  };
}

export function renderProjectInitialization(files: readonly ProjectEntrypointResult[]): string {
  return files
    .map((file) =>
      file.status === "created" ? `Created ${file.path}` : `${file.path} already exists`,
    )
    .join("\n");
}

async function createFileIfAbsent(path: string, content: string): Promise<ProjectEntrypointStatus> {
  try {
    await writeFile(path, content, { flag: "wx", mode: 0o600 });
    return "created";
  } catch (error) {
    if (isNodeCode(error, "EEXIST") && (await lstat(path)).isFile()) return "existing";
    if (isNodeCode(error, "EEXIST")) {
      throw new Error(`拒绝初始化：${path} 已存在但不是普通文件`, { cause: error });
    }
    throw error;
  }
}

function isWithin(root: string, target: string): boolean {
  const path = relative(resolve(root), resolve(target));
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`));
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
