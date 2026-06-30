// MemoryNudger: 周期性记忆提醒生成器
// 对应课程第 23 讲：自我改进 AI 系统
//
// 核心职责：
// - 周期性触发：每 10 轮对话生成一次记忆提醒
// - 技能回顾：展示最近掌握的 Top 3 技能及其成功率
// - 会话摘要：提取本次对话的关键要点（如果 FTS5 中有摘要）
// - 注入时机：在 PromptComposer 组装 system prompt 时动态插入
//
// 参考设计：
// - Hermes Agent 的 Periodic Nudge 机制
// - Context7 的 Memory Injection 策略

import type { SkillRegistry } from './skill-registry.js';
import type { FTS5Store } from './fts5-store.js';
import { calculateSuccessRate } from './skill-schema.js';

/**
 * MemoryNudger: 周期性记忆提醒生成器。
 * 参考 Hermes Agent 的 Periodic Nudge 机制。
 */
export class MemoryNudger {
  /** 提醒触发周期（每 N 轮对话触发一次） */
  private readonly nudgePeriod: number;

  constructor(
    private readonly skillRegistry: SkillRegistry,
    private readonly fts5: FTS5Store,
    options?: { nudgePeriod?: number },
  ) {
    this.nudgePeriod = options?.nudgePeriod ?? 10;
  }

  /**
   * 生成记忆提醒文本（注入到 system prompt）
   * @param sessionId - 当前会话 ID
   * @param turnCount - 当前对话轮次（从 1 开始）
   * @returns 提醒文本（null 表示本轮不触发）
   */
  async generate(sessionId: string, turnCount: number): Promise<string | null> {
    // 每 N 轮对话触发一次（第 0 轮不触发）
    if (turnCount % this.nudgePeriod !== 0 || turnCount === 0) {
      return null;
    }

    const parts: string[] = ['# 💡 记忆提醒'];

    // 1. 最近学会的技能（Top 3）
    const topSkills = this.skillRegistry.getTopSkills(3);
    if (topSkills.length > 0) {
      parts.push('\n## 你最近掌握的技能');
      for (const skill of topSkills) {
        const successRate = (calculateSuccessRate(skill) * 100).toFixed(0);
        parts.push(
          `- **${skill.name}** (成功率 ${successRate}%，使用 ${skill.stats.successCount} 次)`,
        );
        parts.push(`  触发条件: ${skill.trigger}`);
      }
      parts.push('\n💡 提示: 遇到类似任务时，优先考虑使用已有技能。');
    }

    // 2. 会话摘要（如果有）
    const summary = this.fts5.getSummary(sessionId);
    if (summary && typeof summary === 'string') {
      parts.push('\n## 本次对话要点');
      parts.push(summary);
    }

    // 如果既没有技能也没有摘要，返回 null
    return parts.length > 1 ? parts.join('\n') : null;
  }
}
