import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceRuntime {
  readonly workspacePath: string;
  close?(): Promise<void> | void;
}

export interface WorkspaceRuntimeFactory<T extends WorkspaceRuntime> {
  create(workspacePath: string): Promise<T>;
}

/** Owns one runtime per canonical Git worktree or physical folder. */
export class WorkspaceRuntimeRegistry<T extends WorkspaceRuntime> {
  private readonly runtimes = new Map<string, Promise<T>>();

  constructor(private readonly factory: WorkspaceRuntimeFactory<T>) {}

  async get(workspacePath: string): Promise<T> {
    const canonicalPath = await canonicalizeWorkspacePath(workspacePath);
    let runtime = this.runtimes.get(canonicalPath);
    if (!runtime) {
      runtime = this.factory.create(canonicalPath);
      this.runtimes.set(canonicalPath, runtime);
      try {
        await runtime;
      } catch (error) {
        this.runtimes.delete(canonicalPath);
        throw error;
      }
    }
    return runtime;
  }

  async close(): Promise<void> {
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    await Promise.all(
      runtimes.map(async (runtime) => {
        const resolved = await runtime;
        await resolved.close?.();
      }),
    );
  }
}

export async function canonicalizeWorkspacePath(workspacePath: string): Promise<string> {
  const physicalPath = await realpath(resolve(workspacePath));
  const gitTopLevel = await resolveGitTopLevel(physicalPath);
  return gitTopLevel ? realpath(resolve(gitTopLevel)) : physicalPath;
}

function resolveGitTopLevel(workspacePath: string): Promise<string | undefined> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      ["rev-parse", "--show-toplevel"],
      {
        cwd: workspacePath,
        encoding: "utf8",
        env: { ...process.env, LANG: "C", LC_ALL: "C" },
        maxBuffer: 64 * 1024,
        timeout: 5_000,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = stderr.trim() || error.message;
          if (error.code === "ENOENT" || /not a git repository/iu.test(detail)) {
            // Folder mode remains available when Git is absent or this is not a worktree.
            resolveResult(undefined);
            return;
          }
          reject(
            new Error(`Pico 无法解析 Git 工作树 ${workspacePath}：${detail}`, { cause: error }),
          );
          return;
        }
        resolveResult(stdout.trim() || undefined);
      },
    );
  });
}
