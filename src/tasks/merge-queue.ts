import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
import { isAbsolute, normalize, resolve } from "node:path";

import {
  buildSafeGitEnvironment,
  createDisabledHooksPath,
  hardenGitArgs,
  UNSAFE_GIT_DRIVER_CONFIG_PATTERN,
} from "./git-safety.js";

export interface WorktreeMergeCandidate {
  taskId: string;
  sourceBranch: string;
  sourceWorktree: string;
  targetBranch: string;
  targetWorktree: string;
}

export type WorktreeMergeStatus = "queued" | "running" | "merged" | "blocked";

export interface WorktreeMergeSnapshot extends WorktreeMergeCandidate {
  status: WorktreeMergeStatus;
  queuedAt: number;
  startedAt?: number;
  finishedAt?: number;
  targetHeadBefore?: string;
  sourceHead?: string;
  mergeHead?: string;
  error?: string;
}

export interface GitExecutionOptions {
  cwd: string;
}

export interface GitExecutionResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Injectable command boundary; implementations must not invoke a shell. */
export type GitExecutor = (
  args: readonly string[],
  options: GitExecutionOptions,
) => Promise<GitExecutionResult>;

export interface WorktreeMergeQueueOptions {
  git?: GitExecutor;
  now?: () => number;
}

export type WorktreeMergeSubscriber = (snapshot: WorktreeMergeSnapshot) => void;

interface QueueEntry extends WorktreeMergeSnapshot {
  expectedTargetHead: string;
  expectedUpstreamHead?: string;
  mergeAttempted: boolean;
}

/**
 * A fail-closed, serial queue for integrating completed worktree branches.
 *
 * Conflicts are intentionally left in the target worktree. No automatic
 * reset, stash, hook bypass, or force operation is used.
 */
export class WorktreeMergeQueue {
  private readonly entries = new Map<string, QueueEntry>();
  private readonly subscribers = new Set<WorktreeMergeSubscriber>();
  private readonly git: GitExecutor;
  private readonly now: () => number;
  private drainPromise?: Promise<void>;

  constructor(options: WorktreeMergeQueueOptions = {}) {
    const rawGit = options.git ?? executeGit;
    const disabledHooksPath = createDisabledHooksPath();
    this.git = (args, gitOptions) => rawGit(hardenGitArgs(args, disabledHooksPath), gitOptions);
    this.now = options.now ?? Date.now;
  }

  async enqueue(candidate: WorktreeMergeCandidate): Promise<WorktreeMergeSnapshot> {
    const normalized = validateCandidate(candidate);
    if (this.entries.has(normalized.taskId)) {
      throw new Error(`合并任务已存在: ${normalized.taskId}`);
    }

    const expectedTargetHead = await this.resolveBranchHead(
      normalized.targetWorktree,
      normalized.targetBranch,
    );
    const expectedUpstreamHead = await this.resolveOptionalUpstreamHead(normalized.targetWorktree);
    const entry: QueueEntry = {
      ...normalized,
      status: "queued",
      queuedAt: this.now(),
      expectedTargetHead,
      expectedUpstreamHead,
      mergeAttempted: false,
    };
    this.entries.set(entry.taskId, entry);
    this.emit(entry);
    this.scheduleDrain();
    return cloneSnapshot(entry);
  }

  list(): WorktreeMergeSnapshot[] {
    return [...this.entries.values()].map(cloneSnapshot);
  }

  get(taskId: string): WorktreeMergeSnapshot | undefined {
    const entry = this.entries.get(taskId);
    return entry ? cloneSnapshot(entry) : undefined;
  }

  subscribe(subscriber: WorktreeMergeSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  /** Wait until no entry is actively running. A blocked queue is considered idle. */
  async waitForIdle(): Promise<void> {
    await this.drainPromise;
  }

  /**
   * Resume after a human resolves the conflict in the preserved worktree.
   * The resolution must be committed and leave the target worktree clean.
   */
  async resumeAfterResolution(taskId?: string): Promise<WorktreeMergeSnapshot> {
    const entry = taskId
      ? this.entries.get(taskId)
      : [...this.entries.values()].find((candidate) => candidate.status === "blocked");
    if (!entry || entry.status !== "blocked") {
      throw new Error(taskId ? `任务未处于 blocked: ${taskId}` : "没有待恢复的 blocked 合并任务");
    }

    await this.assertCheckedOutBranch(entry.targetWorktree, entry.targetBranch);
    await this.assertClean(entry.targetWorktree, "目标");
    const currentHead = await this.resolveBranchHead(entry.targetWorktree, entry.targetBranch);

    if (entry.mergeAttempted && currentHead !== entry.targetHeadBefore) {
      this.markMerged(entry, currentHead);
      this.advanceExpectedTargetHeads(entry, currentHead);
    } else {
      entry.status = "queued";
      entry.error = undefined;
      entry.expectedTargetHead = currentHead;
      entry.expectedUpstreamHead = await this.resolveOptionalUpstreamHead(entry.targetWorktree);
      entry.mergeAttempted = false;
      entry.startedAt = undefined;
      entry.finishedAt = undefined;
      this.emit(entry);
    }

    this.scheduleDrain();
    return cloneSnapshot(entry);
  }

  private scheduleDrain(): void {
    if (this.drainPromise) return;
    this.drainPromise = this.drain().finally(() => {
      this.drainPromise = undefined;
      if (this.hasRunnableEntry()) this.scheduleDrain();
    });
  }

  private async drain(): Promise<void> {
    while (!this.hasBlockedEntry()) {
      const entry = [...this.entries.values()].find((candidate) => candidate.status === "queued");
      if (!entry) return;
      await this.process(entry);
      if (entry.status === "blocked") return;
    }
  }

  private async process(entry: QueueEntry): Promise<void> {
    entry.status = "running";
    entry.startedAt = this.now();
    entry.error = undefined;
    this.emit(entry);

    try {
      await this.assertCheckedOutBranch(entry.sourceWorktree, entry.sourceBranch);
      await this.assertCheckedOutBranch(entry.targetWorktree, entry.targetBranch);
      await this.assertClean(entry.sourceWorktree, "源");
      await this.assertClean(entry.targetWorktree, "目标");

      const targetHead = await this.resolveBranchHead(entry.targetWorktree, entry.targetBranch);
      if (targetHead !== entry.expectedTargetHead) {
        throw new Error(
          `目标分支已漂移: expected ${entry.expectedTargetHead}, actual ${targetHead}`,
        );
      }
      await this.assertUpstreamNotDrifted(entry);

      const sourceHead = await this.resolveBranchHead(entry.sourceWorktree, entry.sourceBranch);
      if (sourceHead === targetHead) {
        throw new Error(`源分支 ${entry.sourceBranch} 相对目标分支没有可合并提交`);
      }

      entry.targetHeadBefore = targetHead;
      entry.sourceHead = sourceHead;
      await this.assertNoExternalGitDrivers(entry.targetWorktree);
      await this.assertNoBranchMergeOptions(entry.targetWorktree, entry.targetBranch);
      entry.mergeAttempted = true;
      const merge = await this.git(
        [
          "merge",
          "--no-ff",
          "--no-edit",
          "--no-gpg-sign",
          "--no-verify-signatures",
          "--",
          entry.sourceBranch,
        ],
        {
          cwd: entry.targetWorktree,
        },
      );
      if (merge.exitCode !== 0) {
        throw new Error(commandFailure("git merge 失败，已保留现场", merge));
      }

      await this.assertClean(entry.targetWorktree, "目标");
      const mergeHead = await this.resolveBranchHead(entry.targetWorktree, entry.targetBranch);
      if (mergeHead === targetHead) {
        throw new Error(`源分支 ${entry.sourceBranch} 相对目标分支没有可合并提交`);
      }

      this.markMerged(entry, mergeHead);
      this.advanceExpectedTargetHeads(entry, mergeHead);
    } catch (error) {
      entry.status = "blocked";
      entry.finishedAt = this.now();
      entry.error = errorMessage(error);
      this.emit(entry);
    }
  }

  private markMerged(entry: QueueEntry, mergeHead: string): void {
    entry.status = "merged";
    entry.finishedAt = this.now();
    entry.mergeHead = mergeHead;
    entry.error = undefined;
    this.emit(entry);
  }

  /** Queue-owned target advancement must not look like external branch drift. */
  private advanceExpectedTargetHeads(completed: QueueEntry, mergeHead: string): void {
    for (const entry of this.entries.values()) {
      if (
        entry.status === "queued" &&
        entry.targetWorktree === completed.targetWorktree &&
        entry.targetBranch === completed.targetBranch &&
        entry.expectedTargetHead === completed.targetHeadBefore
      ) {
        entry.expectedTargetHead = mergeHead;
      }
    }
  }

  private async assertCheckedOutBranch(worktree: string, branch: string): Promise<void> {
    const result = await this.runChecked(
      ["rev-parse", "--abbrev-ref", "HEAD"],
      worktree,
      `无法读取工作树分支: ${worktree}`,
    );
    if (result.stdout.trim() !== branch) {
      throw new Error(`工作树分支不匹配: expected ${branch}, actual ${result.stdout.trim()}`);
    }
  }

  private async assertClean(worktree: string, label: string): Promise<void> {
    const result = await this.runChecked(
      ["status", "--porcelain=v1", "--untracked-files=normal"],
      worktree,
      `无法检查${label}工作树`,
    );
    if (result.stdout.trim().length > 0) {
      throw new Error(`${label}工作树不干净: ${worktree}`);
    }
  }

  private async assertUpstreamNotDrifted(entry: QueueEntry): Promise<void> {
    const upstreamHead = await this.resolveOptionalUpstreamHead(entry.targetWorktree);
    if (upstreamHead !== entry.expectedUpstreamHead) {
      throw new Error(
        `目标分支的远端上游已漂移: expected ${entry.expectedUpstreamHead ?? "none"}, actual ${upstreamHead ?? "none"}`,
      );
    }
  }

  private async resolveOptionalUpstreamHead(worktree: string): Promise<string | undefined> {
    const result = await this.git(["rev-parse", "--verify", "--quiet", "@{upstream}^{commit}"], {
      cwd: worktree,
    });
    return result.exitCode === 0 ? result.stdout.trim() : undefined;
  }

  private async resolveBranchHead(worktree: string, branch: string): Promise<string> {
    const result = await this.runChecked(
      ["rev-parse", "--verify", `refs/heads/${branch}^{commit}`],
      worktree,
      `无法解析分支: ${branch}`,
    );
    return result.stdout.trim();
  }

  private async assertNoExternalGitDrivers(worktree: string): Promise<void> {
    const result = await this.git(
      ["config", "--includes", "--get-regexp", UNSAFE_GIT_DRIVER_CONFIG_PATTERN],
      { cwd: worktree },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(commandFailure("无法检查 Git filter/merge driver", result));
    }
    if (result.stdout.trim().length > 0) {
      throw new Error(
        "仓库配置了外部 Git filter/merge driver，拒绝在宿主进程中自动合并；请人工审查后处理。",
      );
    }
  }

  private async assertNoBranchMergeOptions(worktree: string, branch: string): Promise<void> {
    const result = await this.git(
      ["config", "--includes", "--get-all", `branch.${branch}.mergeOptions`],
      { cwd: worktree },
    );
    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(commandFailure("无法检查目标分支 mergeOptions", result));
    }
    if (result.stdout.trim().length > 0) {
      throw new Error(
        `目标分支 ${branch} 配置了 mergeOptions，无法证明不会签名或替换合并策略；请人工合并。`,
      );
    }
  }

  private async runChecked(
    args: readonly string[],
    cwd: string,
    failureMessage: string,
  ): Promise<GitExecutionResult> {
    const result = await this.git(args, { cwd });
    if (result.exitCode !== 0) throw new Error(commandFailure(failureMessage, result));
    return result;
  }

  private hasBlockedEntry(): boolean {
    return [...this.entries.values()].some((entry) => entry.status === "blocked");
  }

  private hasRunnableEntry(): boolean {
    return (
      !this.hasBlockedEntry() &&
      [...this.entries.values()].some((entry) => entry.status === "queued")
    );
  }

  private emit(entry: QueueEntry): void {
    const snapshot = cloneSnapshot(entry);
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }
}

/** Default non-shell git executor. */
export const executeGit: GitExecutor = async (args, options) =>
  await new Promise<GitExecutionResult>((resolveResult) => {
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: buildSafeGitEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        const exitCode = error && typeof error.code === "number" ? error.code : error ? 1 : 0;
        resolveResult({ exitCode, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });

function validateCandidate(candidate: WorktreeMergeCandidate): WorktreeMergeCandidate {
  if (!candidate.taskId.trim() || /[\0\r\n]/u.test(candidate.taskId)) {
    throw new Error("合并 taskId 无效");
  }
  validateBranch(candidate.sourceBranch, "源");
  validateBranch(candidate.targetBranch, "目标");
  const sourceWorktree = validateWorktree(candidate.sourceWorktree, "源");
  const targetWorktree = validateWorktree(candidate.targetWorktree, "目标");
  if (sourceWorktree === targetWorktree) throw new Error("源和目标工作树不能相同");
  if (candidate.sourceBranch === candidate.targetBranch) throw new Error("源和目标分支不能相同");

  return { ...candidate, sourceWorktree, targetWorktree };
}

function validateWorktree(path: string, label: string): string {
  if (!isAbsolute(path) || /\0/u.test(path)) throw new Error(`${label}工作树路径必须是绝对路径`);
  const normalized = normalize(resolve(path));
  if (normalized !== path) throw new Error(`${label}工作树路径必须已规范化: ${path}`);
  try {
    if (!lstatSync(normalized).isDirectory()) throw new Error("不是目录");
  } catch (error) {
    throw new Error(`${label}工作树不可用: ${normalized} (${errorMessage(error)})`, {
      cause: error,
    });
  }
  return normalized;
}

function validateBranch(branch: string, label: string): void {
  const invalid =
    branch.length === 0 ||
    branch.startsWith("-") ||
    branch.startsWith(".") ||
    branch.endsWith(".") ||
    branch.endsWith("/") ||
    branch.endsWith(".lock") ||
    branch.includes("..") ||
    branch.includes("//") ||
    branch.includes("@{") ||
    /[\0-\x20\x7f~^:?*[\\]/u.test(branch);
  if (invalid) throw new Error(`${label}分支名无效: ${branch}`);
}

function cloneSnapshot(entry: QueueEntry): WorktreeMergeSnapshot {
  const {
    expectedTargetHead: _expected,
    expectedUpstreamHead: _upstream,
    mergeAttempted: _attempted,
    ...snapshot
  } = entry;
  return { ...snapshot };
}

function commandFailure(message: string, result: GitExecutionResult): string {
  const detail = result.stderr.trim() || result.stdout.trim() || `exit ${result.exitCode}`;
  return `${message}: ${detail}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
