import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { TaskRegistry, type TaskSnapshot } from "./task-registry.js";
import { TaskStore } from "./task-store.js";
import { WorktreeMergeQueue, type WorktreeMergeSnapshot } from "./merge-queue.js";
import {
  WorktreeSupervisor,
  type WorktreeTaskRequest,
  type WorktreeTaskRunner,
  type WorktreeTaskSnapshot,
} from "./worktree-supervisor.js";

export interface TaskHostRuntimeOptions {
  workDir: string;
  repoRoot?: string;
}

/** TUI-lifetime owner for durable task state and isolated worktree execution. */
export class TaskHostRuntime {
  readonly taskRegistry: TaskRegistry;
  readonly taskStore: TaskStore;
  readonly supervisor: WorktreeSupervisor;
  readonly mergeQueue: WorktreeMergeQueue;
  readonly repoRoot: string;
  readonly targetBranch: string;

  private constructor(repoRoot: string, targetBranch: string) {
    this.repoRoot = repoRoot;
    this.targetBranch = targetBranch;
    this.taskRegistry = new TaskRegistry();
    this.taskStore = new TaskStore({
      filePath: join(repoRoot, ".claw", "tasks", "state.json"),
    });
    this.taskStore.loadInto(this.taskRegistry);
    this.taskStore.bind(this.taskRegistry);
    this.supervisor = new WorktreeSupervisor({
      taskRegistry: this.taskRegistry,
      repoRoot,
    });
    this.mergeQueue = new WorktreeMergeQueue();
  }

  static async create(options: TaskHostRuntimeOptions): Promise<TaskHostRuntime> {
    const cwd = resolve(options.workDir);
    const repoRoot = options.repoRoot
      ? resolve(options.repoRoot)
      : await gitOutput(["rev-parse", "--show-toplevel"], cwd);
    const targetBranch = await gitOutput(["branch", "--show-current"], repoRoot);
    if (!targetBranch) throw new Error("当前 Git 工作树处于 detached HEAD，无法启动任务监督器");
    return new TaskHostRuntime(repoRoot, targetBranch);
  }

  start(request: WorktreeTaskRequest, runner: WorktreeTaskRunner): WorktreeTaskSnapshot {
    return this.supervisor.start(request, runner);
  }

  list(): TaskSnapshot[] {
    return this.taskRegistry.list();
  }

  get(taskId: string): TaskSnapshot | undefined {
    return this.taskRegistry.get(taskId);
  }

  tail(taskId: string, maxChars?: number): string {
    return this.supervisor.get(taskId)
      ? this.supervisor.tail(taskId, maxChars)
      : "Output tail is unavailable for a task restored after host restart.";
  }

  stop(taskId: string): Promise<WorktreeTaskSnapshot> {
    return this.supervisor.stop(taskId);
  }

  retry(taskId: string): WorktreeTaskSnapshot {
    return this.supervisor.retry(taskId);
  }

  sendMessage(taskId: string, message: string): WorktreeTaskSnapshot {
    return this.supervisor.sendMessage(taskId, message);
  }

  async merge(taskId: string): Promise<WorktreeMergeSnapshot> {
    const task = this.supervisor.get(taskId);
    if (!task) throw new Error(`任务 ${taskId} 不属于当前 TUI 的 worktree supervisor`);
    if (task.status !== "completed") throw new Error(`任务 ${taskId} 尚未完成，不能合并`);
    if (task.dirty) throw new Error(`任务 ${taskId} 的 worktree 仍有未提交修改，不能合并`);
    return this.mergeQueue.enqueue({
      taskId,
      sourceBranch: task.branch,
      sourceWorktree: task.worktreePath,
      targetBranch: this.targetBranch,
      targetWorktree: this.repoRoot,
    });
  }

  async cleanupMerged(taskId: string): Promise<void> {
    const merged = this.mergeQueue.get(taskId);
    if (merged?.status !== "merged") throw new Error(`任务 ${taskId} 尚未完成合并`);
    await this.supervisor.cleanup(taskId, { merged: true });
  }

  async close(): Promise<void> {
    const running = this.supervisor
      .list()
      .filter(
        (task) =>
          task.status === "preparing" || task.status === "running" || task.status === "stopping",
      );
    await Promise.allSettled(
      running.map((task) => this.supervisor.stop(task.taskId, "TUI closed")),
    );
    await this.mergeQueue.waitForIdle();
    this.taskStore.close();
  }
}

function gitOutput(args: readonly string[], cwd: string): Promise<string> {
  return new Promise((resolveOutput, reject) => {
    execFile("git", [...args], { cwd, encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }
      resolveOutput(stdout.trim());
    });
  });
}
