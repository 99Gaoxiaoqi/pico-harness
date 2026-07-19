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
  private readonly releases = new Map<string, Promise<void>>();
  private lifecycleState: "open" | "closing" | "closed" = "open";
  private closePromise?: Promise<void>;
  private readonly pendingOwnershipReleases = new Set<Promise<void>>();

  constructor(private readonly factory: WorkspaceRuntimeFactory<T>) {}

  async get(workspacePath: string): Promise<T> {
    this.assertOpen();
    const canonicalPath = await canonicalizeWorkspacePath(workspacePath);
    const activeRelease = this.releases.get(canonicalPath);
    if (activeRelease) await activeRelease;
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

  /** Release one workspace without closing the process-wide registry. */
  async release(workspacePath: string): Promise<void> {
    this.assertOpen();
    let canonicalPath: string;
    try {
      canonicalPath = await canonicalizeWorkspacePath(workspacePath);
    } catch (error) {
      if (!isNodeCode(error, "ENOENT")) throw error;
      // Registrations store canonical absolute paths. A workspace may be deleted
      // before unregister, so release the previously indexed key without realpath.
      canonicalPath = resolve(workspacePath);
    }
    const activeRelease = this.releases.get(canonicalPath);
    if (activeRelease) return activeRelease;
    const runtime = this.runtimes.get(canonicalPath);
    if (!runtime) return;
    if (this.runtimes.get(canonicalPath) === runtime) this.runtimes.delete(canonicalPath);
    const release = this.closeRuntimes([runtime], true);
    this.releases.set(canonicalPath, release);
    // On rejection the line below is not reached, intentionally keeping a failed
    // fence: ownership was not proven released, so replacement must fail closed.
    await release;
    if (this.releases.get(canonicalPath) === release) this.releases.delete(canonicalPath);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.lifecycleState = "closing";
    const runtimes = [...this.runtimes.values()];
    this.runtimes.clear();
    this.closePromise = Promise.allSettled([...this.releases.values()])
      .then(async (releases) => {
        const releaseFailure = releases.find((result) => result.status === "rejected");
        await this.closeRuntimes(runtimes);
        if (releaseFailure?.status === "rejected") throw releaseFailure.reason;
      })
      .finally(() => {
        this.lifecycleState = "closed";
      });
    return this.closePromise;
  }

  private async closeRuntimes(
    runtimes: readonly Promise<T>[],
    waitForOwnership = false,
  ): Promise<void> {
    const resolutions = await Promise.allSettled(runtimes);
    const resolved = resolutions.flatMap((result) =>
      result.status === "fulfilled" ? [result.value] : [],
    );
    const closes = await Promise.allSettled(resolved.map(async (runtime) => runtime.close?.()));
    const closeFailure = closes.find((result) => result.status === "rejected");
    const ownershipRelease = Promise.all(
      resolved.map(async (runtime) => runtime.waitForOwnershipRelease?.()),
    ).then(() => {
      if (closeFailure?.status === "rejected") throw closeFailure.reason;
    });
    this.pendingOwnershipReleases.add(ownershipRelease);
    void ownershipRelease
      .finally(() => this.pendingOwnershipReleases.delete(ownershipRelease))
      .catch(() => undefined);
    void ownershipRelease.catch(() => undefined);

    const resolutionFailure = resolutions.find((result) => result.status === "rejected");
    if (resolutionFailure?.status === "rejected") throw resolutionFailure.reason;
    if (waitForOwnership) {
      await ownershipRelease;
      return;
    }
    if (closeFailure?.status === "rejected") throw closeFailure.reason;
  }

  hasPendingOwnership(): boolean {
    return this.pendingOwnershipReleases.size > 0;
  }

  async waitForOwnershipRelease(): Promise<void> {
    while (this.pendingOwnershipReleases.size > 0) {
      await Promise.all([...this.pendingOwnershipReleases]);
    }
  }

  private assertOpen(): void {
    if (this.lifecycleState !== "open") {
      throw new Error("Workspace Runtime registry 正在关闭");
    }
  }
}

function isNodeCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}

export async function canonicalizeWorkspacePath(workspacePath: string): Promise<string> {
  const physicalPath = await realpath(resolve(workspacePath));
  const gitTopLevel = await resolveGitTopLevel(physicalPath);
  return gitTopLevel ? realpath(resolve(gitTopLevel)) : physicalPath;
}

export function resolveGitBranch(workspacePath: string): Promise<string | undefined> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      ["branch", "--show-current"],
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
            resolveResult(undefined);
            return;
          }
          reject(new Error(`Pico 无法解析 Git 分支 ${workspacePath}：${detail}`, { cause: error }));
          return;
        }
        resolveResult(stdout.trim() || undefined);
      },
    );
  });
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
