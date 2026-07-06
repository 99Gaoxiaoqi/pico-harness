// Checkpoint Manager:用 git stash create 创建零侵入快照,支持文件回滚。
//
// 解决痛点:Agent 通过 write_file/edit_file/bash 修改文件后,如果误操作,
// 没有回滚手段。Checkpoint 在写操作前用 git stash create 创建临时 stash 对象,
// 不影响工作区、不影响 stash 列表,只在 refs/pico-checkpoints/ 下保存引用。
// 需要回滚时用 git stash apply 恢复。
//
// dedup 设计:同一 turn 内多次写操作只快照一次(第一次写之前的快照已覆盖
// 当前状态,后续写操作即使回滚也应该回到 turn 开头)。

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { logger } from "../observability/logger.js";

const execAsync = promisify(exec);

export interface Checkpoint {
  id: string;
  workDir: string;
  createdAt: Date;
  description: string;
  /** git stash 对象的 SHA(用于 apply) */
  stashRef: string;
}

export class CheckpointManager {
  private readonly workDir: string;
  private readonly checkpoints: Checkpoint[] = [];
  /** 当前 turn 是否已创建快照(dedup) */
  private currentTurnCheckpointed = false;
  /** 是否是 git 仓库(初始化时检测一次) */
  private isGitRepo: boolean | null = null;

  constructor(workDir: string) {
    this.workDir = workDir;
  }

  /** 在新 turn 开始时重置 dedup 标记 */
  newTurn(): void {
    this.currentTurnCheckpointed = false;
  }

  /** 检测工作区是否是 git 仓库 */
  private async checkGitRepo(): Promise<boolean> {
    if (this.isGitRepo !== null) return this.isGitRepo;
    try {
      await execAsync("git rev-parse --git-dir", { cwd: this.workDir });
      this.isGitRepo = true;
    } catch {
      this.isGitRepo = false;
      logger.debug({ workDir: this.workDir }, "[Checkpoint] 非 git 仓库,跳过快照");
    }
    return this.isGitRepo;
  }

  /**
   * 创建 git 快照(如果当前 turn 还没创建过)。
   * 用 git stash create 创建一个临时 stash 对象,不影响工作区。
   * 返回 checkpoint id,失败或跳过时返回 null。
   */
  async createCheckpoint(description: string): Promise<string | null> {
    // dedup:同一 turn 只快照一次
    if (this.currentTurnCheckpointed) {
      return this.checkpoints[this.checkpoints.length - 1]?.id ?? null;
    }

    if (!(await this.checkGitRepo())) return null;

    try {
      // 先暂存所有变更（包括未跟踪的新文件），这样 stash create 能捕获它们
      await execAsync("git add -A", { cwd: this.workDir });
      const { stdout } = await execAsync("git stash create", { cwd: this.workDir });
      // 取消暂存，恢复暂区状态（文件内容不变）
      await execAsync("git reset", { cwd: this.workDir });
      const stashRef = stdout.trim();

      // git stash create 无输出 = 没有变更
      if (!stashRef) {
        logger.debug("[Checkpoint] 无变更,跳过快照");
        return null;
      }

      const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      // 把 stash 对象保存到 refs/pico-checkpoints/ 下,防止 GC
      await execAsync(`git update-ref refs/pico-checkpoints/${id} ${stashRef}`, {
        cwd: this.workDir,
      });

      const checkpoint: Checkpoint = {
        id,
        workDir: this.workDir,
        createdAt: new Date(),
        description,
        stashRef,
      };
      this.checkpoints.push(checkpoint);
      this.currentTurnCheckpointed = true;

      logger.info({ checkpointId: id, description }, `[Checkpoint] 已创建快照: ${description}`);
      return id;
    } catch (err) {
      logger.warn({ err: String(err) }, "[Checkpoint] 创建快照失败");
      return null;
    }
  }

  /**
   * 回滚到指定快照点。
   * 用 git stash apply 恢复文件状态(不删除 stash)。
   */
  async rollback(checkpointId: string): Promise<boolean> {
    const cp = this.checkpoints.find((c) => c.id === checkpointId);
    if (!cp) {
      logger.warn({ checkpointId }, "[Checkpoint] 找不到快照");
      return false;
    }

    try {
      // 先恢复已跟踪文件到 HEAD 状态
      await execAsync("git checkout -- .", { cwd: this.workDir });
      // 清理快照后创建的未跟踪文件
      await execAsync("git clean -fd", { cwd: this.workDir });
      // 再 apply 快照（恢复快照时的文件状态）
      await execAsync(`git stash apply ${cp.stashRef}`, { cwd: this.workDir });
      logger.info({ checkpointId }, `[Checkpoint] 已回滚到快照: ${checkpointId}`);
      return true;
    } catch (err) {
      logger.error({ err: String(err), checkpointId }, "[Checkpoint] 回滚失败");
      return false;
    }
  }

  /** 获取所有快照列表 */
  listCheckpoints(): Checkpoint[] {
    return [...this.checkpoints];
  }

  /** 获取最近的快照 */
  getLatestCheckpoint(): Checkpoint | null {
    return this.checkpoints[this.checkpoints.length - 1] ?? null;
  }

  /** 清理所有快照引用(git update-ref -d) */
  async cleanup(): Promise<void> {
    for (const cp of this.checkpoints) {
      try {
        await execAsync(`git update-ref -d refs/pico-checkpoints/${cp.id}`, {
          cwd: this.workDir,
        });
      } catch {
        // 忽略删除失败
      }
    }
    this.checkpoints.length = 0;
  }
}
