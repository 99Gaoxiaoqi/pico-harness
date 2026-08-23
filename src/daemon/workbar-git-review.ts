import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, open, readFile, readlink, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export type WorkbarGitReviewStage = "staged" | "unstaged";

export type WorkbarGitChangeStatus =
  | "added"
  | "copied"
  | "deleted"
  | "modified"
  | "renamed"
  | "type_changed"
  | "unmerged"
  | "unknown"
  | "untracked";

export interface WorkbarGitChange {
  readonly path: string;
  readonly stage: WorkbarGitReviewStage;
  readonly status: WorkbarGitChangeStatus;
}

export interface WorkbarGitReviewSnapshot {
  readonly repositoryRoot: string;
  readonly branch: string | null;
  readonly head: string | null;
  readonly staged: readonly WorkbarGitChange[];
  readonly unstaged: readonly WorkbarGitChange[];
  readonly revision: string;
}

export interface WorkbarGitDiff {
  readonly path: string;
  readonly stage: WorkbarGitReviewStage;
  readonly revision: string;
  readonly patch: string;
  readonly bytes: number;
  readonly binary: boolean;
}

export interface WorkbarGitReviewLimits {
  readonly maxFiles: number;
  readonly maxSnapshotBytes: number;
  readonly maxDiffBytes: number;
  readonly maxUntrackedFileBytes: number;
  readonly timeoutMs: number;
}

export type WorkbarGitReviewErrorCode =
  | "invalid_request"
  | "not_repository"
  | "outside_workspace"
  | "not_found"
  | "revision_conflict"
  | "limit_exceeded"
  | "git_failed";

export class WorkbarGitReviewError extends Error {
  constructor(
    readonly code: WorkbarGitReviewErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "WorkbarGitReviewError";
  }
}

const DEFAULT_LIMITS: WorkbarGitReviewLimits = {
  maxFiles: 500,
  maxSnapshotBytes: 4 * 1024 * 1024,
  maxDiffBytes: 512 * 1024,
  maxUntrackedFileBytes: 1024 * 1024,
  timeoutMs: 10_000,
};

const GIT_BASE_ARGS = [
  "--no-optional-locks",
  "-c",
  "core.pager=cat",
  "-c",
  "pager.diff=false",
  "-c",
  "pager.status=false",
  "-c",
  "core.fsmonitor=false",
  "-c",
  "core.untrackedCache=false",
  "-c",
  "diff.external=",
] as const;

const GIT_ENV: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  LANG: "C",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
  GIT_PAGER: "cat",
  PAGER: "cat",
  GIT_TERMINAL_PROMPT: "0",
};

interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

export interface WorkbarGitReviewAuthorityOptions {
  readonly limits?: Partial<WorkbarGitReviewLimits>;
}

export class WorkbarGitReviewAuthority {
  readonly workspaceRoot: string;
  readonly repositoryRoot: string;
  readonly limits: WorkbarGitReviewLimits;

  private constructor(
    workspaceRoot: string,
    repositoryRoot: string,
    limits: WorkbarGitReviewLimits,
  ) {
    this.workspaceRoot = workspaceRoot;
    this.repositoryRoot = repositoryRoot;
    this.limits = limits;
  }

  static async open(
    workspacePath: string,
    options: WorkbarGitReviewAuthorityOptions = {},
  ): Promise<WorkbarGitReviewAuthority> {
    const limits = resolveLimits(options.limits);
    let workspaceRoot: string;
    try {
      workspaceRoot = await realpath(workspacePath);
    } catch {
      throw new WorkbarGitReviewError("invalid_request", "Workspace path does not exist");
    }
    const rootResult = await runGitAt(workspaceRoot, ["rev-parse", "--show-toplevel"], {
      maxBytes: 16 * 1024,
      timeoutMs: limits.timeoutMs,
      allowedExitCodes: [0, 128],
    });
    if (rootResult.exitCode !== 0 || !rootResult.stdout.trim()) {
      throw new WorkbarGitReviewError("not_repository", "Workspace is not a Git repository");
    }
    let repositoryRoot: string;
    try {
      repositoryRoot = await realpath(rootResult.stdout.trim());
    } catch {
      throw new WorkbarGitReviewError("not_repository", "Git repository root is unavailable");
    }
    if (!isWithin(workspaceRoot, repositoryRoot)) {
      throw new WorkbarGitReviewError(
        "outside_workspace",
        "Git repository root escapes the registered workspace",
      );
    }
    return new WorkbarGitReviewAuthority(workspaceRoot, repositoryRoot, limits);
  }

  async snapshot(): Promise<WorkbarGitReviewSnapshot> {
    const [branchResult, headResult, stagedNames, unstagedNames, untrackedNames] =
      await Promise.all([
        this.run(["symbolic-ref", "--quiet", "--short", "HEAD"], 16 * 1024, [0, 1, 128]),
        this.run(["rev-parse", "--verify", "HEAD"], 16 * 1024, [0, 128]),
        this.run(diffNameArgs("staged"), this.limits.maxSnapshotBytes),
        this.run(diffNameArgs("unstaged"), this.limits.maxSnapshotBytes),
        this.run(
          ["ls-files", "--others", "--exclude-standard", "-z"],
          this.limits.maxSnapshotBytes,
        ),
      ]);
    const staged = parseNameStatus(stagedNames.stdout, "staged");
    const unstaged = [
      ...parseNameStatus(unstagedNames.stdout, "unstaged"),
      ...parseNulPaths(untrackedNames.stdout).map(
        (path): WorkbarGitChange => ({
          path,
          stage: "unstaged",
          status: "untracked",
        }),
      ),
    ];
    assertFileLimit(staged.length + unstaged.length, this.limits.maxFiles);

    const [stagedPatch, unstagedPatch] = await Promise.all([
      this.run(diffContentArgs("staged"), this.limits.maxSnapshotBytes),
      this.run(diffContentArgs("unstaged"), this.limits.maxSnapshotBytes),
    ]);
    const untrackedHashes: Array<{ path: string; hash: string; bytes: number }> = [];
    for (const change of unstaged) {
      if (change.status !== "untracked") continue;
      untrackedHashes.push(await this.hashUntrackedPath(change.path));
    }
    const snapshotBytes =
      Buffer.byteLength(stagedPatch.stdout) +
      Buffer.byteLength(unstagedPatch.stdout) +
      untrackedHashes.reduce((sum, item) => sum + item.bytes, 0);
    if (snapshotBytes > this.limits.maxSnapshotBytes) {
      throw new WorkbarGitReviewError(
        "limit_exceeded",
        `Git snapshot exceeds ${this.limits.maxSnapshotBytes} bytes`,
      );
    }
    const branch = branchResult.exitCode === 0 ? branchResult.stdout.trim() || null : null;
    const head = headResult.exitCode === 0 ? headResult.stdout.trim() || null : null;
    const revision = createHash("sha256")
      .update(
        JSON.stringify({
          version: 1,
          branch,
          head,
          staged,
          unstaged,
          untrackedHashes: untrackedHashes.map(({ path, hash }) => ({ path, hash })),
        }),
      )
      .update("\0staged\0")
      .update(stagedPatch.stdout)
      .update("\0unstaged\0")
      .update(unstagedPatch.stdout)
      .digest("hex");
    return {
      repositoryRoot: this.repositoryRoot,
      branch,
      head,
      staged,
      unstaged,
      revision,
    };
  }

  async diff(input: {
    readonly path: string;
    readonly stage: WorkbarGitReviewStage;
    readonly expectedRevision: string;
  }): Promise<WorkbarGitDiff> {
    const path = normalizeRepositoryPath(input.path);
    const snapshot = await this.snapshot();
    if (snapshot.revision !== input.expectedRevision) {
      throw new WorkbarGitReviewError(
        "revision_conflict",
        "Git review snapshot changed; refresh before reading the diff",
      );
    }
    const changes = input.stage === "staged" ? snapshot.staged : snapshot.unstaged;
    const change = changes.find((candidate) => candidate.path === path);
    if (!change) {
      throw new WorkbarGitReviewError("not_found", "File is not present in the requested snapshot");
    }
    const patch =
      change.status === "untracked"
        ? await this.untrackedPatch(path)
        : (await this.run([...diffContentArgs(input.stage), "--", path], this.limits.maxDiffBytes))
            .stdout;
    const bytes = Buffer.byteLength(patch);
    if (bytes > this.limits.maxDiffBytes) {
      throw new WorkbarGitReviewError(
        "limit_exceeded",
        `Git diff exceeds ${this.limits.maxDiffBytes} bytes`,
      );
    }
    return {
      path,
      stage: input.stage,
      revision: snapshot.revision,
      patch,
      bytes,
      binary: patch.includes("GIT binary patch") || patch.includes("Binary files "),
    };
  }

  private async run(
    args: readonly string[],
    maxBytes: number,
    allowedExitCodes: readonly number[] = [0],
  ): Promise<GitResult> {
    return runGitAt(this.repositoryRoot, args, {
      maxBytes,
      timeoutMs: this.limits.timeoutMs,
      allowedExitCodes,
    });
  }

  private async hashUntrackedPath(
    path: string,
  ): Promise<{ path: string; hash: string; bytes: number }> {
    const absolute = resolveContainedPath(this.repositoryRoot, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      return {
        path,
        hash: createHash("sha256").update(`symlink\0${target}`).digest("hex"),
        bytes: Buffer.byteLength(target),
      };
    }
    if (!stat.isFile()) {
      throw new WorkbarGitReviewError("invalid_request", "Untracked path is not a regular file");
    }
    if (stat.size > this.limits.maxUntrackedFileBytes) {
      throw new WorkbarGitReviewError(
        "limit_exceeded",
        `Untracked file exceeds ${this.limits.maxUntrackedFileBytes} bytes`,
      );
    }
    const contents = await readContainedRegularFile(absolute, this.repositoryRoot);
    return {
      path,
      hash: createHash("sha256").update(contents).digest("hex"),
      bytes: contents.byteLength,
    };
  }

  private async untrackedPatch(path: string): Promise<string> {
    const absolute = resolveContainedPath(this.repositoryRoot, path);
    const stat = await lstat(absolute);
    if (stat.isSymbolicLink()) {
      const target = await readlink(absolute);
      return `diff --git a/${path} b/${path}\nnew file mode 120000\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1 @@\n+${target}\n`;
    }
    if (!stat.isFile()) {
      throw new WorkbarGitReviewError("invalid_request", "Untracked path is not a regular file");
    }
    if (stat.size > this.limits.maxUntrackedFileBytes) {
      throw new WorkbarGitReviewError(
        "limit_exceeded",
        `Untracked file exceeds ${this.limits.maxUntrackedFileBytes} bytes`,
      );
    }
    const contents = await readContainedRegularFile(absolute, this.repositoryRoot);
    if (contents.includes(0)) {
      return `diff --git a/${path} b/${path}\nnew file mode 100644\nBinary files /dev/null and b/${path} differ\n`;
    }
    const text = contents.toString("utf8");
    const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
    const body = lines.map((line) => `+${line}`).join("\n");
    return `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n@@ -0,0 +1,${lines.length} @@\n${body}\n`;
  }
}

function resolveLimits(
  overrides: Partial<WorkbarGitReviewLimits> | undefined,
): WorkbarGitReviewLimits {
  const limits = { ...DEFAULT_LIMITS, ...overrides };
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new WorkbarGitReviewError("invalid_request", `${name} must be a positive integer`);
    }
  }
  return limits;
}

function diffNameArgs(stage: WorkbarGitReviewStage): string[] {
  return [
    "diff",
    ...(stage === "staged" ? ["--cached"] : []),
    "--name-status",
    "-z",
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
  ];
}

function diffContentArgs(stage: WorkbarGitReviewStage): string[] {
  return [
    "diff",
    ...(stage === "staged" ? ["--cached"] : []),
    "--no-ext-diff",
    "--no-textconv",
    "--no-renames",
    "--binary",
  ];
}

function parseNameStatus(output: string, stage: WorkbarGitReviewStage): WorkbarGitChange[] {
  const fields = output.split("\0");
  const changes: WorkbarGitChange[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const rawStatus = fields[index];
    const path = fields[index + 1];
    if (!rawStatus || !path) continue;
    changes.push({ path, stage, status: decodeStatus(rawStatus[0] ?? "?") });
  }
  return changes;
}

function parseNulPaths(output: string): string[] {
  return output.split("\0").filter((path) => path.length > 0);
}

function decodeStatus(status: string): WorkbarGitChangeStatus {
  switch (status) {
    case "A":
      return "added";
    case "C":
      return "copied";
    case "D":
      return "deleted";
    case "M":
      return "modified";
    case "R":
      return "renamed";
    case "T":
      return "type_changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function normalizeRepositoryPath(path: string): string {
  if (!path || path.includes("\0") || isAbsolute(path)) {
    throw new WorkbarGitReviewError("invalid_request", "Git review path must be relative");
  }
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").some((segment) => segment === ".." || segment === "")) {
    throw new WorkbarGitReviewError("invalid_request", "Git review path escapes the repository");
  }
  return normalized;
}

function resolveContainedPath(root: string, path: string): string {
  const normalized = normalizeRepositoryPath(path);
  const absolute = resolve(root, normalized);
  if (!isWithin(root, absolute)) {
    throw new WorkbarGitReviewError("outside_workspace", "Git review path escapes the repository");
  }
  return absolute;
}

function isWithin(parent: string, child: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function readContainedRegularFile(absolute: string, root: string): Promise<Buffer> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(absolute, "r");
    const [canonical, stat] = await Promise.all([realpath(absolute), handle.stat()]);
    if (!isWithin(root, canonical) || !stat.isFile()) {
      throw new WorkbarGitReviewError("outside_workspace", "File escapes the repository");
    }
    return await readFile(handle);
  } finally {
    await handle?.close();
  }
}

function assertFileLimit(actual: number, maximum: number): void {
  if (actual > maximum) {
    throw new WorkbarGitReviewError(
      "limit_exceeded",
      `Git snapshot contains ${actual} files; maximum is ${maximum}`,
    );
  }
}

async function runGitAt(
  cwd: string,
  args: readonly string[],
  options: {
    readonly maxBytes: number;
    readonly timeoutMs: number;
    readonly allowedExitCodes: readonly number[];
  },
): Promise<GitResult> {
  return new Promise((resolveResult, reject) => {
    execFile(
      "git",
      [...GIT_BASE_ARGS, "-C", cwd, ...args],
      {
        env: GIT_ENV,
        encoding: "utf8",
        maxBuffer: options.maxBytes + 1,
        timeout: options.timeoutMs,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = typeof error?.code === "number" ? error.code : 0;
        if (error && typeof error.code !== "number") {
          if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            reject(
              new WorkbarGitReviewError(
                "limit_exceeded",
                `Git command output exceeds ${options.maxBytes} bytes`,
              ),
            );
            return;
          }
          reject(new WorkbarGitReviewError("git_failed", "Git command could not be executed"));
          return;
        }
        if (Buffer.byteLength(stdout) > options.maxBytes) {
          reject(
            new WorkbarGitReviewError(
              "limit_exceeded",
              `Git command output exceeds ${options.maxBytes} bytes`,
            ),
          );
          return;
        }
        if (!options.allowedExitCodes.includes(exitCode)) {
          reject(
            new WorkbarGitReviewError(
              "git_failed",
              stderr.trim() || `Git command failed with exit code ${exitCode}`,
            ),
          );
          return;
        }
        resolveResult({ stdout, stderr, exitCode });
      },
    );
  });
}
