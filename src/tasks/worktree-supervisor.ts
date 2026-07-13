import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { TaskRegistry, type TaskSnapshot, isTerminalTaskStatus } from "./task-registry.js";
import {
  buildSafeGitEnvironment,
  createDisabledHooksPath,
  disabledGitFilterArgs,
  GIT_FILTER_DRIVER_CONFIG_PATTERN,
  hardenGitArgs,
  UNSAFE_GIT_DRIVER_CONFIG_PATTERN,
} from "./git-safety.js";

export type WorktreeTaskStatus =
  | "preparing"
  | "running"
  | "stopping"
  | "completed"
  | "failed"
  | "stopped";

export type WorktreeCompletionMode = "worktree_only" | "merge_to_host";

export type WorktreeFinalizationStatus = "merged" | "not_needed" | "blocked" | "failed";

export interface WorktreeTaskFinalization {
  status: WorktreeFinalizationStatus;
  mergeRequestId?: string;
  mergeHead?: string;
  error?: string;
}

export interface WorktreeTaskFinalizationInput {
  taskId: string;
  attempt: number;
  sourceBranch: string;
  sourceWorktree: string;
  sourceHead: string;
  baseRef: string;
}

export type WorktreeTaskFinalizer = (
  input: WorktreeTaskFinalizationInput,
) => Promise<WorktreeTaskFinalization>;

export interface WorktreeTaskRequest {
  description: string;
  /** 用来创建新分支的 Git ref，默认为调用 start/retry 时的 HEAD。 */
  baseRef?: string;
  /** 可读的分支名片段；监督器会再加任务 ID 和 attempt 确保唯一。 */
  branchSlug?: string;
  /** worker 的完成边界；默认仅产出独立 worktree，不改变历史手动 merge 语义。 */
  completionMode?: WorktreeCompletionMode;
  data?: Record<string, unknown>;
}

export interface WorktreeRunnerResult {
  summary?: string;
  data?: Record<string, unknown>;
}

export interface WorktreeRunnerContext {
  taskId: string;
  attempt: number;
  worktreePath: string;
  branch: string;
  signal: AbortSignal;
  appendOutput: (chunk: string) => void;
  /** 在 runner 的安全边界点取走主代理追加的指令。 */
  drainMessages: () => string[];
}

export type WorktreeTaskRunner = (
  context: WorktreeRunnerContext,
) => Promise<WorktreeRunnerResult | void>;

export interface WorktreeTaskSnapshot {
  taskId: string;
  parentTaskId?: string;
  attempt: number;
  status: WorktreeTaskStatus;
  description: string;
  branch: string;
  worktreePath: string;
  baseRef: string;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  outputTail: string;
  pendingMessageCount: number;
  commitHash?: string;
  dirty?: boolean;
  error?: string;
  result?: WorktreeRunnerResult;
  finalization?: WorktreeTaskFinalization;
  cleanedAt?: number;
  registry: TaskSnapshot;
}

export interface GitExecutionOptions {
  cwd: string;
  signal?: AbortSignal;
  stdin?: string;
  /** git config --get-regexp 等查询以 1 表示“无匹配”。 */
  allowExitCodes?: readonly number[];
}

export interface GitExecutionResult {
  stdout: string;
  stderr: string;
}

export type GitExecutor = (
  args: readonly string[],
  options: GitExecutionOptions,
) => Promise<GitExecutionResult>;

export interface WorktreeSupervisorOptions {
  taskRegistry: TaskRegistry;
  repoRoot: string;
  worktreeRoot?: string;
  gitExecutor?: GitExecutor;
  now?: () => number;
  /** 生成 worktree 资源的额外唯一后缀，可在集成测试中固定。 */
  generateId?: () => string;
  maxOutputChars?: number;
  maxPendingMessages?: number;
  stopTimeoutMs?: number;
  /** 由宿主实现的串行 merge 边界；监督器本身不直接修改主工作树。 */
  finalizer?: WorktreeTaskFinalizer;
}

export interface CleanupOptions {
  /** 调用方已确认该分支已合并。 */
  merged?: boolean;
  /** 显式允许移除 clean worktree；未合并分支仍只会用 branch -d 安全删除。 */
  allowUnmerged?: boolean;
}

export interface CleanupResult {
  taskId: string;
  worktreeRemoved: boolean;
  branchDeleted: boolean;
  warning?: string;
}

export type CompletionSubscriber = (snapshot: WorktreeTaskSnapshot) => void;

interface WorktreeTaskRecord {
  taskId: string;
  parentTaskId?: string;
  attempt: number;
  request: WorktreeTaskRequest;
  runner: WorktreeTaskRunner;
  status: WorktreeTaskStatus;
  branch: string;
  worktreePath: string;
  baseRef: string;
  controller: AbortController;
  startedAt: number;
  updatedAt: number;
  completedAt?: number;
  output: BoundedTextRing;
  pendingMessages: string[];
  commitHash?: string;
  dirty?: boolean;
  error?: string;
  result?: WorktreeRunnerResult;
  finalization?: WorktreeTaskFinalization;
  cleanedAt?: number;
  completionNotified: boolean;
  settled: boolean;
  promise: Promise<void>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
const DEFAULT_MAX_PENDING_MESSAGES = 100;
const DEFAULT_STOP_TIMEOUT_MS = 10_000;

/**
 * 为可写子代理提供独立 Git worktree，不负责自动合并。
 *
 * start 会同步登记 TaskRegistry 并返回 preparing 快照，Git 准备与 runner 在后台运行。
 */
export class WorktreeSupervisor {
  private readonly taskRegistry: TaskRegistry;
  private readonly repoRoot: string;
  private readonly worktreeRoot: string;
  private readonly git: GitExecutor;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly maxOutputChars: number;
  private readonly maxPendingMessages: number;
  private readonly stopTimeoutMs: number;
  private readonly finalizer?: WorktreeTaskFinalizer;
  private readonly records = new Map<string, WorktreeTaskRecord>();
  private readonly completionSubscribers = new Set<CompletionSubscriber>();

  constructor(options: WorktreeSupervisorOptions) {
    if (!isAbsolute(options.repoRoot)) {
      throw new Error("repoRoot 必须是绝对路径");
    }
    this.repoRoot = resolve(options.repoRoot);
    this.worktreeRoot = options.worktreeRoot
      ? resolve(this.repoRoot, options.worktreeRoot)
      : resolve(this.repoRoot, ".worktrees");
    assertContainedPath(this.repoRoot, this.worktreeRoot, "worktreeRoot");
    if (this.worktreeRoot === this.repoRoot) {
      throw new Error("worktreeRoot 不能是仓库根目录");
    }

    this.taskRegistry = options.taskRegistry;
    const rawGit = options.gitExecutor ?? executeGit;
    const disabledHooksPath = createDisabledHooksPath();
    this.git = (args, gitOptions) => rawGit(hardenGitArgs(args, disabledHooksPath), gitOptions);
    this.now = options.now ?? Date.now;
    this.generateId = options.generateId ?? defaultResourceId;
    this.maxOutputChars = positiveInteger(
      options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS,
      "maxOutputChars",
    );
    this.maxPendingMessages = positiveInteger(
      options.maxPendingMessages ?? DEFAULT_MAX_PENDING_MESSAGES,
      "maxPendingMessages",
    );
    this.stopTimeoutMs = positiveInteger(
      options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS,
      "stopTimeoutMs",
    );
    this.finalizer = options.finalizer;
  }

  start(request: WorktreeTaskRequest, runner: WorktreeTaskRunner): WorktreeTaskSnapshot {
    return this.startAttempt(request, runner, 1);
  }

  list(): WorktreeTaskSnapshot[] {
    return [...this.records.values()]
      .sort((left, right) => left.startedAt - right.startedAt)
      .map((record) => this.toSnapshot(record));
  }

  get(taskId: string): WorktreeTaskSnapshot | undefined {
    const record = this.records.get(taskId);
    return record ? this.toSnapshot(record) : undefined;
  }

  tail(taskId: string, maxChars = this.maxOutputChars): string {
    const record = this.requireRecord(taskId);
    return record.output.tail(positiveInteger(maxChars, "maxChars"));
  }

  async stop(taskId: string, reason = "stopped by user"): Promise<WorktreeTaskSnapshot> {
    const record = this.requireRecord(taskId);
    if (isTerminal(record.status)) return this.toSnapshot(record);

    if (record.status !== "stopping") {
      record.status = "stopping";
      record.updatedAt = this.now();
      record.controller.abort(new DOMException(reason, "AbortError"));
    }
    const settled = await waitForSettlement(record.promise, this.stopTimeoutMs);
    if (!settled) {
      throw new Error(
        `任务 ${taskId} 已收到停止信号，但 runner 在 ${this.stopTimeoutMs}ms 内未退出；状态保持 stopping`,
      );
    }
    return this.toSnapshot(record);
  }

  retry(taskId: string): WorktreeTaskSnapshot {
    const previous = this.requireRecord(taskId);
    if (!isTerminal(previous.status)) {
      throw new Error(`任务 ${taskId} 尚未结束，不能重试`);
    }
    return this.startAttempt(
      previous.request,
      previous.runner,
      previous.attempt + 1,
      previous.taskId,
    );
  }

  sendMessage(taskId: string, message: string): WorktreeTaskSnapshot {
    const record = this.requireRecord(taskId);
    if (isTerminal(record.status)) {
      throw new Error(`任务 ${taskId} 已结束，无法追加指令`);
    }
    const normalized = message.trim();
    if (!normalized) throw new Error("追加指令不能为空");

    record.pendingMessages.push(normalized);
    if (record.pendingMessages.length > this.maxPendingMessages) {
      record.pendingMessages.splice(0, record.pendingMessages.length - this.maxPendingMessages);
    }
    record.updatedAt = this.now();
    return this.toSnapshot(record);
  }

  subscribeCompletion(subscriber: CompletionSubscriber): () => void {
    this.completionSubscribers.add(subscriber);
    return () => {
      this.completionSubscribers.delete(subscriber);
    };
  }

  async wait(taskId: string): Promise<WorktreeTaskSnapshot> {
    const record = this.requireRecord(taskId);
    await record.promise;
    return this.toSnapshot(record);
  }

  async cleanup(taskId: string, options: CleanupOptions = {}): Promise<CleanupResult> {
    const record = this.requireRecord(taskId);
    if (!isTerminal(record.status)) {
      throw new Error(`任务 ${taskId} 尚未结束，不能清理 worktree`);
    }
    if (!record.settled) {
      throw new Error(`任务 ${taskId} 的 runner 尚未退出，不能清理 worktree`);
    }
    if (options.merged !== true && options.allowUnmerged !== true) {
      throw new Error("清理前必须确认分支已合并，或显式设置 allowUnmerged");
    }
    if (record.cleanedAt !== undefined) {
      return { taskId, worktreeRemoved: false, branchDeleted: false, warning: "资源已清理" };
    }

    await this.assertRepositoryRoot();
    const physicalWorktreeRoot = await this.ensureSafeWorktreeRoot();
    assertContainedPath(this.worktreeRoot, record.worktreePath, "worktreePath");
    const exists = await pathExists(record.worktreePath);
    if (exists) {
      assertContainedPath(
        physicalWorktreeRoot,
        await realpath(record.worktreePath),
        "physical worktreePath",
      );
      const filterOverrides = await this.buildDisabledFilterOverrides(record.worktreePath);
      const status = await this.git([...filterOverrides, "status", "--porcelain"], {
        cwd: record.worktreePath,
      });
      if (status.stdout.trim()) {
        throw new Error(`worktree 存在未提交修改，拒绝清理: ${record.worktreePath}`);
      }
      await this.git(["worktree", "remove", record.worktreePath], { cwd: this.repoRoot });
    }

    let branchDeleted = false;
    let warning: string | undefined;
    try {
      await this.git(["branch", "-d", record.branch], { cwd: this.repoRoot });
      branchDeleted = true;
    } catch (error) {
      warning = `worktree 已移除，分支未安全删除: ${errorMessage(error)}`;
    }

    record.cleanedAt = this.now();
    record.updatedAt = record.cleanedAt;
    return {
      taskId,
      worktreeRemoved: exists,
      branchDeleted,
      ...(warning ? { warning } : {}),
    };
  }

  private startAttempt(
    request: WorktreeTaskRequest,
    runner: WorktreeTaskRunner,
    attempt: number,
    parentTaskId?: string,
  ): WorktreeTaskSnapshot {
    const description = request.description.trim();
    if (!description) throw new Error("任务描述不能为空");
    const baseRef = validateBaseRef(request.baseRef ?? "HEAD");
    const task = this.taskRegistry.create("local_agent", {
      description,
      data: {
        ...(request.data ?? {}),
        supervisor: "worktree",
        attempt,
        ...(parentTaskId ? { parentTaskId } : {}),
      },
    });
    const resourceId = sanitizeSlug(this.generateId(), "resource");
    const slug = sanitizeSlug(request.branchSlug ?? description, "task");
    const taskSlug = sanitizeSlug(task.taskId, "agent");
    const branch = validateBranchName(`pico/${slug}-${taskSlug}-a${attempt}-${resourceId}`);
    const worktreePath = resolve(
      this.worktreeRoot,
      `${slug}-${taskSlug}-a${attempt}-${resourceId}`,
    );
    assertContainedPath(this.worktreeRoot, worktreePath, "worktreePath");

    const startedAt = this.now();
    const record: WorktreeTaskRecord = {
      taskId: task.taskId,
      ...(parentTaskId ? { parentTaskId } : {}),
      attempt,
      request: {
        ...request,
        description,
        ...(request.data ? { data: { ...request.data } } : {}),
      },
      runner,
      status: "preparing",
      branch,
      worktreePath,
      baseRef,
      controller: new AbortController(),
      startedAt,
      updatedAt: startedAt,
      output: new BoundedTextRing(this.maxOutputChars),
      pendingMessages: [],
      completionNotified: false,
      settled: false,
      promise: Promise.resolve(),
    };
    this.records.set(record.taskId, record);
    record.promise = Promise.resolve().then(() => this.run(record));
    return this.toSnapshot(record);
  }

  private async run(record: WorktreeTaskRecord): Promise<void> {
    try {
      await this.prepareWorktree(record);
      record.controller.signal.throwIfAborted();
      record.status = "running";
      record.updatedAt = this.now();
      this.taskRegistry.start(record.taskId, {
        data: this.registryData(record),
      });

      const result = await record.runner({
        taskId: record.taskId,
        attempt: record.attempt,
        worktreePath: record.worktreePath,
        branch: record.branch,
        signal: record.controller.signal,
        appendOutput: (chunk) => this.appendOutput(record, chunk),
        drainMessages: () => this.drainMessages(record),
      });
      record.result = result ? cloneResult(result) : undefined;
      if (!record.controller.signal.aborted) {
        await this.commitPendingChanges(record);
      }
      await this.captureRepositoryState(record, true);
      if (record.controller.signal.aborted) {
        this.finish(record, "stopped", { error: abortReason(record.controller.signal) });
      } else {
        await this.finalizeCompletion(record);
        if (record.controller.signal.aborted) {
          this.finish(record, "stopped", { error: abortReason(record.controller.signal) });
        } else {
          this.finish(record, "completed");
        }
      }
    } catch (error) {
      await this.captureRepositoryState(record, false);
      record.settled = true;
      if (record.controller.signal.aborted) {
        this.finish(record, "stopped", { error: abortReason(record.controller.signal) });
      } else {
        this.finish(record, "failed", { error: errorMessage(error) });
      }
    } finally {
      record.settled = true;
      record.updatedAt = this.now();
    }
  }

  private async prepareWorktree(record: WorktreeTaskRecord): Promise<void> {
    await this.assertRepositoryRoot();
    await this.ensureSafeWorktreeRoot();
    if (await pathExists(record.worktreePath)) {
      throw new Error(`worktree 目标已存在: ${record.worktreePath}`);
    }
    await this.assertNoExternalGitMergeDrivers(this.repoRoot, record.controller.signal);
    await this.git(["check-ref-format", "--branch", record.branch], { cwd: this.repoRoot });
    const base = await this.git(["rev-parse", "--verify", `${record.baseRef}^{commit}`], {
      cwd: this.repoRoot,
      signal: record.controller.signal,
    });
    const commit = base.stdout.trim();
    if (!/^[0-9a-fA-F]{40,64}$/.test(commit)) {
      throw new Error(`无法解析基准提交: ${record.baseRef}`);
    }
    const filterOverrides = await this.buildDisabledFilterOverrides(
      this.repoRoot,
      record.controller.signal,
    );
    await this.assertNoActiveFilterAttributes(this.repoRoot, record.controller.signal, commit);
    await this.git(
      [...filterOverrides, "worktree", "add", "-b", record.branch, record.worktreePath, commit],
      {
        cwd: this.repoRoot,
        signal: record.controller.signal,
      },
    );
  }

  private async assertRepositoryRoot(): Promise<void> {
    const [configuredRoot, result] = await Promise.all([
      realpath(this.repoRoot),
      this.git(["rev-parse", "--show-toplevel"], { cwd: this.repoRoot }),
    ]);
    const actualRoot = await realpath(result.stdout.trim());
    if (configuredRoot !== actualRoot) {
      throw new Error(`repoRoot 不是 Git 工作树根目录: ${this.repoRoot}`);
    }
  }

  private async ensureSafeWorktreeRoot(): Promise<string> {
    await mkdir(this.worktreeRoot, { recursive: true });
    const [physicalRepoRoot, physicalWorktreeRoot] = await Promise.all([
      realpath(this.repoRoot),
      realpath(this.worktreeRoot),
    ]);
    assertContainedPath(physicalRepoRoot, physicalWorktreeRoot, "physical worktreeRoot");
    return physicalWorktreeRoot;
  }

  private async captureRepositoryState(
    record: WorktreeTaskRecord,
    required: boolean,
  ): Promise<void> {
    try {
      if (!(await pathExists(record.worktreePath))) return;
      const filterOverrides = await this.buildDisabledFilterOverrides(record.worktreePath);
      const [commit, status, branch] = await Promise.all([
        this.git(["rev-parse", "HEAD"], { cwd: record.worktreePath }),
        this.git([...filterOverrides, "status", "--porcelain"], { cwd: record.worktreePath }),
        this.git(["branch", "--show-current"], { cwd: record.worktreePath }),
      ]);
      const actualBranch = branch.stdout.trim();
      if (actualBranch !== record.branch) {
        throw new Error(`worktree 分支异常: 期望 ${record.branch}，实际 ${actualBranch}`);
      }
      record.commitHash = commit.stdout.trim();
      record.dirty = status.stdout.trim().length > 0;
      if (required && record.dirty) {
        throw new Error(`worker 完成后 worktree 仍有未提交修改: ${record.worktreePath}`);
      }
    } catch (error) {
      if (required) throw error;
      this.appendOutput(record, `\n[supervisor] 无法读取 worktree 状态: ${errorMessage(error)}\n`);
    }
  }

  private async finalizeCompletion(record: WorktreeTaskRecord): Promise<void> {
    if ((record.request.completionMode ?? "worktree_only") !== "merge_to_host") return;
    if (!this.finalizer) {
      record.finalization = {
        status: "failed",
        error: "worker 要求 merge_to_host，但宿主未配置 finalizer",
      };
      throw new Error(record.finalization.error);
    }
    if (!record.commitHash) throw new Error(`无法确认 worker ${record.taskId} 的源提交`);
    try {
      record.finalization = await this.finalizer({
        taskId: record.taskId,
        attempt: record.attempt,
        sourceBranch: record.branch,
        sourceWorktree: record.worktreePath,
        sourceHead: record.commitHash,
        baseRef: record.baseRef,
      });
    } catch (error) {
      record.finalization = { status: "failed", error: errorMessage(error) };
    }
    if (record.finalization.status === "merged" || record.finalization.status === "not_needed") {
      return;
    }
    throw new Error(record.finalization.error ?? `worker 收口为 ${record.finalization.status}`);
  }

  /** 由宿主在沙箱外把 worker 的已隔离变更打包成原子提交。 */
  private async commitPendingChanges(record: WorktreeTaskRecord): Promise<void> {
    const filterOverrides = await this.buildDisabledFilterOverrides(
      record.worktreePath,
      record.controller.signal,
    );
    const status = await this.git([...filterOverrides, "status", "--porcelain"], {
      cwd: record.worktreePath,
      signal: record.controller.signal,
    });
    if (status.stdout.trim().length === 0) return;

    await this.assertNoExternalGitMergeDrivers(record.worktreePath, record.controller.signal);

    await this.git([...filterOverrides, "add", "--all"], {
      cwd: record.worktreePath,
      signal: record.controller.signal,
    });
    await this.assertNoActiveFilterAttributes(
      record.worktreePath,
      record.controller.signal,
      undefined,
      true,
    );
    record.controller.signal.throwIfAborted();
    await this.git(
      [
        ...filterOverrides,
        "-c",
        "user.name=Pico Worker",
        "-c",
        "user.email=pico-worker@localhost",
        "commit",
        "--no-gpg-sign",
        "-m",
        workerCommitMessage(record.request.description),
      ],
      { cwd: record.worktreePath, signal: record.controller.signal },
    );
  }

  private async assertNoExternalGitMergeDrivers(cwd: string, signal?: AbortSignal): Promise<void> {
    const result = await this.git(
      ["config", "--includes", "--get-regexp", UNSAFE_GIT_DRIVER_CONFIG_PATTERN],
      { cwd, ...(signal ? { signal } : {}), allowExitCodes: [1] },
    );
    if (result.stdout.trim().length > 0) {
      throw new Error(
        "仓库配置了外部 Git merge driver，拒绝在 worker 沙箱外自动 checkout 或提交；请人工审查后提交。",
      );
    }
  }

  private async assertNoActiveFilterAttributes(
    cwd: string,
    signal?: AbortSignal,
    source?: string,
    cached = false,
  ): Promise<void> {
    if (source && cached) {
      throw new Error("Git filter attribute 检查不能同时指定 source 与 cached。");
    }
    const listed = await this.git(
      source
        ? ["ls-tree", "-r", "--name-only", "-z", source]
        : cached
          ? ["ls-files", "-z", "--cached"]
          : ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
      { cwd, ...(signal ? { signal } : {}) },
    );
    if (listed.stdout.includes("\ufffd")) {
      throw new Error("Git 文件名包含无法安全解码的字节，拒绝自动 checkout/提交。");
    }
    const paths = listed.stdout.split("\0").filter(Boolean);
    if (paths.length === 0) return;
    const attributes = await this.git(
      [
        "check-attr",
        "--stdin",
        "-z",
        ...(source ? ["--source", source] : []),
        ...(cached ? ["--cached"] : []),
        "filter",
      ],
      { cwd, stdin: listed.stdout, ...(signal ? { signal } : {}) },
    );
    const records = attributes.stdout.split("\0");
    if (records.at(-1) === "") records.pop();
    if (records.length !== paths.length * 3) {
      throw new Error("Git filter attribute 检查返回了不完整结果，拒绝自动 checkout/提交。");
    }
    for (let recordIndex = 0; recordIndex < records.length; recordIndex += 3) {
      const path = records[recordIndex] ?? "unknown";
      const value = records[recordIndex + 2];
      if (value !== "unspecified" && value !== "unset") {
        throw new Error(
          `文件 ${path} 启用了 Git filter=${value ?? "unknown"}，拒绝在 worker 沙箱外自动 checkout/提交；请人工处理。`,
        );
      }
    }
  }

  /**
   * Git add 会在宿主进程中执行 clean/process filter。先枚举所有生效的
   * filter driver，再用命令行最高优先级配置将它们置空，避免 worker 在
   * 检查与暂存之间更换 .gitattributes 导致外部程序逃逸沙箱。
   */
  private async buildDisabledFilterOverrides(cwd: string, signal?: AbortSignal): Promise<string[]> {
    const result = await this.git(
      [
        "config",
        "--includes",
        "--null",
        "--name-only",
        "--get-regexp",
        GIT_FILTER_DRIVER_CONFIG_PATTERN,
      ],
      { cwd, ...(signal ? { signal } : {}), allowExitCodes: [1] },
    );
    return disabledGitFilterArgs(result.stdout);
  }

  private appendOutput(record: WorktreeTaskRecord, chunk: string): void {
    if (isTerminal(record.status) || !chunk) return;
    record.output.append(chunk);
    record.updatedAt = this.now();
  }

  private drainMessages(record: WorktreeTaskRecord): string[] {
    if (record.pendingMessages.length === 0) return [];
    return record.pendingMessages.splice(0, record.pendingMessages.length);
  }

  private finish(
    record: WorktreeTaskRecord,
    status: Extract<WorktreeTaskStatus, "completed" | "failed" | "stopped">,
    input: { error?: string } = {},
  ): void {
    if (isTerminal(record.status)) return;
    const completedAt = this.now();
    record.status = status;
    record.completedAt = completedAt;
    record.updatedAt = completedAt;
    record.error = input.error;

    const update = {
      notified: true,
      data: this.registryData(record),
    };
    if (status === "completed") {
      this.taskRegistry.complete(record.taskId, update);
    } else if (status === "failed") {
      this.taskRegistry.fail(record.taskId, record.error ?? "worktree task failed", update);
    } else {
      this.taskRegistry.kill(record.taskId, record.error ?? "worktree task stopped", update);
    }
    this.notifyCompletion(record);
  }

  private notifyCompletion(record: WorktreeTaskRecord): void {
    if (record.completionNotified) return;
    record.completionNotified = true;
    const snapshot = this.toSnapshot(record);
    for (const subscriber of this.completionSubscribers) {
      try {
        subscriber(snapshot);
      } catch (error) {
        record.output.append(`\n[supervisor] 完成通知回调失败: ${errorMessage(error)}\n`);
      }
    }
  }

  private registryData(record: WorktreeTaskRecord): Record<string, unknown> {
    return {
      ...(record.request.data ?? {}),
      supervisor: "worktree",
      attempt: record.attempt,
      branch: record.branch,
      worktreePath: record.worktreePath,
      baseRef: record.baseRef,
      pendingMessageCount: record.pendingMessages.length,
      ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
      ...(record.commitHash ? { commitHash: record.commitHash } : {}),
      ...(record.dirty !== undefined ? { dirty: record.dirty } : {}),
      ...(record.result ? { result: cloneResult(record.result) } : {}),
      ...(record.finalization ? { finalization: { ...record.finalization } } : {}),
      ...(record.finalization?.status === "blocked" ? { terminalStatus: "partial" } : {}),
    };
  }

  private toSnapshot(record: WorktreeTaskRecord): WorktreeTaskSnapshot {
    const registry = this.taskRegistry.get(record.taskId);
    if (!registry) throw new Error(`TaskRegistry 中缺少任务: ${record.taskId}`);
    return {
      taskId: record.taskId,
      ...(record.parentTaskId ? { parentTaskId: record.parentTaskId } : {}),
      attempt: record.attempt,
      status: record.status,
      description: record.request.description,
      branch: record.branch,
      worktreePath: record.worktreePath,
      baseRef: record.baseRef,
      startedAt: record.startedAt,
      updatedAt: record.updatedAt,
      ...(record.completedAt !== undefined ? { completedAt: record.completedAt } : {}),
      outputTail: record.output.tail(this.maxOutputChars),
      pendingMessageCount: record.pendingMessages.length,
      ...(record.commitHash ? { commitHash: record.commitHash } : {}),
      ...(record.dirty !== undefined ? { dirty: record.dirty } : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.result ? { result: cloneResult(record.result) } : {}),
      ...(record.finalization ? { finalization: { ...record.finalization } } : {}),
      ...(record.cleanedAt !== undefined ? { cleanedAt: record.cleanedAt } : {}),
      registry,
    };
  }

  private requireRecord(taskId: string): WorktreeTaskRecord {
    const record = this.records.get(taskId);
    if (!record) throw new Error(`未知 worktree 任务: ${taskId}`);
    return record;
  }
}

class BoundedTextRing {
  private value = "";

  constructor(private readonly maxChars: number) {}

  append(chunk: string): void {
    this.value += chunk;
    if (this.value.length > this.maxChars) {
      this.value = this.value.slice(this.value.length - this.maxChars);
    }
  }

  tail(maxChars: number): string {
    if (this.value.length <= maxChars) return this.value;
    return this.value.slice(this.value.length - maxChars);
  }
}

function executeGit(
  args: readonly string[],
  options: GitExecutionOptions,
): Promise<GitExecutionResult> {
  return new Promise((resolvePromise, reject) => {
    const child = execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: buildSafeGitEnvironment(),
        maxBuffer: 4 * 1024 * 1024,
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === "number" ? error.code : undefined;
          if (exitCode !== undefined && options.allowExitCodes?.includes(exitCode)) {
            resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
            return;
          }
          reject(
            new Error(`git ${args.join(" ")} 失败: ${String(stderr).trim() || error.message}`, {
              cause: error,
            }),
          );
          return;
        }
        resolvePromise({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
    if (options.stdin !== undefined) {
      child.stdin?.on("error", () => {
        // Git 在输入写完前失败时可能关闭 pipe；最终错误由 execFile 回调统一返回。
      });
      child.stdin?.end(options.stdin);
    }
  });
}

function assertContainedPath(root: string, target: string, name: string): void {
  const child = relative(resolve(root), resolve(target));
  if (!child || child.startsWith("..") || isAbsolute(child)) {
    throw new Error(`${name} 必须位于 ${root} 内且不能等于该目录`);
  }
}

function validateBaseRef(value: string): string {
  const ref = value.trim();
  const hasControlCharacter = [...ref].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  });
  if (
    !ref ||
    ref.startsWith("-") ||
    hasControlCharacter ||
    /[\s~^:?*[\\]/.test(ref) ||
    ref.includes("..")
  ) {
    throw new Error(`非法基准 ref: ${value}`);
  }
  return ref;
}

function validateBranchName(value: string): string {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value) ||
    value.includes("..") ||
    value.includes("//") ||
    value.includes("@{") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    value.endsWith(".lock")
  ) {
    throw new Error(`非法分支名: ${value}`);
  }
  return value;
}

function sanitizeSlug(value: string, fallback: string): string {
  const slug = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "")
    .slice(0, 48);
  return slug || fallback;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} 必须是正整数`);
  return value;
}

function defaultResourceId(): string {
  return randomBytes(6).toString("hex");
}

function isTerminal(status: WorktreeTaskStatus): boolean {
  if (status === "preparing" || status === "running" || status === "stopping") return false;
  return isTerminalTaskStatus(
    status === "stopped" ? "killed" : status === "completed" ? "completed" : "failed",
  );
}

function workerCommitMessage(description: string): string {
  const subject =
    description
      .replace(/[\0\r\n]+/gu, " ")
      .trim()
      .slice(0, 100) || "完成子任务";
  return `feat(worker): ${subject}`;
}

function waitForSettlement(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(false);
    }, timeoutMs);
    void promise.finally(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function abortReason(signal: AbortSignal): string {
  return signal.reason instanceof Error
    ? signal.reason.message
    : String(signal.reason ?? "stopped");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function cloneResult(result: WorktreeRunnerResult): WorktreeRunnerResult {
  return {
    ...(result.summary !== undefined ? { summary: result.summary } : {}),
    ...(result.data ? { data: { ...result.data } } : {}),
  };
}
