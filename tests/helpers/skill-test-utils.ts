// 技能测试辅助工具
// 提供 mock 对象创建、临时目录管理等测试基础设施

import { randomUUID } from "node:crypto";
import type { LearnedSkill, SkillStats, FailurePattern } from "../../src/memory/skill-schema.js";

/**
 * 创建 Mock 技能对象（用于测试）
 * @param overrides 覆盖默认值的字段
 * @returns 完整的 LearnedSkill 对象
 */
export function createMockSkill(overrides?: Partial<LearnedSkill>): LearnedSkill {
  const now = new Date().toISOString();
  const id = `skill_${randomUUID().replace(/-/g, "").slice(0, 12)}`;

  return {
    id,
    name: "Mock Skill",
    trigger: "test trigger",
    instructions: "step 1\nstep 2",
    source: "manual",
    createdAt: now,
    updatedAt: now,
    stats: {
      successCount: 0,
      failCount: 0,
      lastUsed: null,
      avgExecutionTime: 0,
    },
    knownFailures: [],
    versions: [
      {
        version: 1,
        instructions: "step 1\nstep 2",
        reason: "初始版本",
        timestamp: now,
      },
    ],
    ...overrides,
  };
}

/**
 * 创建 Mock 失败模式
 */
export function createMockFailurePattern(overrides?: Partial<FailurePattern>): FailurePattern {
  return {
    errorPattern: "Error: test error",
    solution: undefined,
    occurrences: 1,
    ...overrides,
  };
}

/**
 * 创建 Mock 统计数据
 */
export function createMockStats(overrides?: Partial<SkillStats>): SkillStats {
  return {
    successCount: 0,
    failCount: 0,
    lastUsed: null,
    avgExecutionTime: 0,
    ...overrides,
  };
}

/**
 * 延迟执行（用于模拟异步操作）
 */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
