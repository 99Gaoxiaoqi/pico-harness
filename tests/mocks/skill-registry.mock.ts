// Mock SkillRegistry for testing PromptComposer
// 真实实现在子代理2完成后替换

import type { LearnedSkill } from "../../src/memory/skill-schema.js";

export class MockSkillRegistry {
  private skills: LearnedSkill[] = [];

  async init(): Promise<void> {
    // Mock: 初始化不做任何操作
  }

  getTopSkills(limit: number): LearnedSkill[] {
    // 按使用频次（总次数）排序，与真实 SkillRegistry 一致
    return this.skills
      .sort((a, b) => {
        const countA = a.stats.successCount + a.stats.failCount;
        const countB = b.stats.successCount + b.stats.failCount;
        return countB - countA;
      })
      .slice(0, limit);
  }

  search(query: string): LearnedSkill[] {
    return this.skills.filter(
      (s) =>
        s.name.includes(query) ||
        s.trigger.includes(query) ||
        s.instructions.includes(query),
    );
  }

  // 测试辅助方法
  addSkill(skill: LearnedSkill): void {
    this.skills.push(skill);
  }

  clear(): void {
    this.skills = [];
  }
}
