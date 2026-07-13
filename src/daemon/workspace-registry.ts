import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceRuntime {
  readonly workspacePath: string;
  close?(): Promise<void> | void;
}

export interface WorkspaceRuntimeFactory<T extends WorkspaceRuntime> {
  create(workspacePath: string): Promise<T>;
}

/**
 * Owns one runtime per canonical worktree. `realpath` makes symlinked entry points
 * share a runtime without allowing different workspaces to share mutable state.
 */
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
  return realpath(resolve(workspacePath));
}
