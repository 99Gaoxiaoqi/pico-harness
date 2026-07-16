import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";

export interface WorkspaceRuntime {
  readonly workspacePath: string;
  close?(): Promise<void> | void;
  /** Whether bounded close returned while this runtime still owns live execution resources. */
  hasPendingOwnership?(): boolean;
  /** Settles only when those resources are safe for a replacement daemon to own. */
  waitForOwnershipRelease?(): Promise<void>;
}

export interface WorkspaceRuntimeFactory<T extends WorkspaceRuntime> {
  create(workspacePath: string): Promise<T>;
}

/** Owns one runtime per canonical Git worktree or physical folder. */
export class WorkspaceRuntimeRegistry<T extends WorkspaceRuntime> {
  private readonly runtimes = new Map<string, Promise<T>>();
  private lifecycleState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  private ownershipReleasePending = false;
  private ownershipReleasePromise: Promise<void> = Promise.resolve();

  constructor(private readonly factory: WorkspaceRuntimeFactory<T>) {}

  async get(workspacePath: string): Promise<T> {
    this.assertOpen();
    const canonicalPath = await canonicalizeWorkspacePath(workspacePath);
    this.assertOpen();
    let runtime = this.runtimes.get(canonicalPath);
    if (!runtime) {
      runtime = Promise.resolve().then(() => {
        this.assertOpen();
        return this.factory.create(canonicalPath);
      });
      this.runtimes.set(canonicalPath, runtime);
    }
    try {
      const resolved = await runtime;
      this.assertOpen();
      return resolved;
    } catch (error) {
      if (this.runtimes.get(canonicalPath) === runtime) this.runtimes.delete(canonicalPath);
      throw error;
    }
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.closePromise = this.closeRuntimes(runtimes).finally(() => {
      this.lifecycleState = "closed";
    });
    return this.closePromise;
  }

  private async closeRuntimes(runtimes: readonly Promise<T>[]): Promise<void> {
    const resolutions = await Promise.allSettled(runtimes);
    const resolved = resolutions.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const closes = await Promise.allSettled(resolved.map(async (runtime) => runtime.close?.()));
    const closeFailure = closes.find((result) => result.status === "rejected");
    this.ownershipReleasePending =
      closeFailure !== undefined || resolved.some((runtime) => runtime.hasPendingOwnership?.());
    const ownershipRelease = Promise.all(
      resolved.map(async (runtime) => runtime.waitForOwnershipRelease?.()),
    ).then(() => {
      if (closeFailure?.status === "rejected") throw closeFailure.reason;
    });
    this.ownershipReleasePromise = ownershipRelease;
    ownershipRelease.then(
      () => {
        this.ownershipReleasePending = false;
      },
      () => undefined,
    );
    void ownershipRelease.catch(() => undefined);

    const resolutionFailure = resolutions.find((result) => result.status === "rejected");
    if (resolutionFailure?.status === "rejected") throw resolutionFailure.reason;
    if (closeFailure?.status === "rejected") throw closeFailure.reason;
  }

  hasPendingOwnership(): boolean {
    return this.ownershipReleasePending;
  }

  waitForOwnershipRelease(): Promise<void> {
    return this.ownershipReleasePromise;
  }

  private assertOpen(): void {
    if (this.lifecycleState !== "open") {
      throw new Error("Workspace Runtime registry 正在关闭");
    }
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
        env: gitDiscoveryEnvironment(process.env),
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

function gitDiscoveryEnvironment(environment: Readonly<NodeJS.ProcessEnv>): NodeJS.ProcessEnv {
  const isolated = Object.fromEntries(
    Object.entries(environment).filter(([name]) => !name.toUpperCase().startsWith("GIT_")),
  );
  return { ...isolated, LANG: "C", LC_ALL: "C" };
}
