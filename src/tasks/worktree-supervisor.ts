import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { TaskRegistry, type TaskSnapshot, isTerminalTaskStatus } from "./task-registry.js";

export type WorktreeTaskStatus = "preparing" | "running" | "completed" | "failed" | "stopped";

export interface WorktreeTaskRequest {
  description: string;
  /** 用来创建新分支的 Git ref，默认为调用 start/retry 时的 HEAD。 */
  baseRef?: string;
  /** 可读的分支名片段；监督器会再加任务 ID 和 attempt 确保唯一。 */
  branchSlug?: string;
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
  cleanedAt?: number;
  registry: TaskSnapshot;
}

export interface GitExecutionOptions {
  cwd: string;
  signal?: AbortSignal;
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
  cleanedAt?: number;
  completionNotified: boolean;
  settled: boolean;
  promise: Promise<void>;
}

const DEFAULT_MAX_OUTPUT_CHARS = 32_000;
const DEFAULT_MAX_PENDING_MESSAGES = 100;

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
    this.git = options.gitExecutor ?? executeGit;
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

    record.controller.abort(new DOMException(reason, "AbortError"));
    await this.captureRepositoryState(record, false);
    this.finish(record, "stopped", { error: reason });
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
      const status = await this.git(["status", "--porcelain"], { cwd: record.worktreePath });
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
      await this.captureRepositoryState(record, true);
      record.settled = true;
      if (record.controller.signal.aborted) {
        this.finish(record, "stopped", { error: abortReason(record.controller.signal) });
      } else {
        this.finish(record, "completed");
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
    await this.git(["check-ref-format", "--branch", record.branch], { cwd: this.repoRoot });
    const base = await this.git(["rev-parse", "--verify", `${record.baseRef}^{commit}`], {
      cwd: this.repoRoot,
      signal: record.controller.signal,
    });
    const commit = base.stdout.trim();
    if (!/^[0-9a-fA-F]{40,64}$/.test(commit)) {
      throw new Error(`无法解析基准提交: ${record.baseRef}`);
    }
    await this.git(["worktree", "add", "-b", record.branch, record.worktreePath, commit], {
      cwd: this.repoRoot,
      signal: record.controller.signal,
    });
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
      const [commit, status, branch] = await Promise.all([
        this.git(["rev-parse", "HEAD"], { cwd: record.worktreePath }),
        this.git(["status", "--porcelain"], { cwd: record.worktreePath }),
        this.git(["branch", "--show-current"], { cwd: record.worktreePath }),
      ]);
      const actualBranch = branch.stdout.trim();
      if (actualBranch !== record.branch) {
        throw new Error(`worktree 分支异常: 期望 ${record.branch}，实际 ${actualBranch}`);
      }
      record.commitHash = commit.stdout.trim();
      record.dirty = status.stdout.trim().length > 0;
    } catch (error) {
      if (required) throw error;
      this.appendOutput(record, `\n[supervisor] 无法读取 worktree 状态: ${errorMessage(error)}\n`);
    }
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
    execFile(
      "git",
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        ...(options.signal ? { signal: options.signal } : {}),
      },
      (error, stdout, stderr) => {
        if (error) {
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
  if (status === "preparing" || status === "running") return false;
  return isTerminalTaskStatus(
    status === "stopped" ? "killed" : status === "completed" ? "completed" : "failed",
  );
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
