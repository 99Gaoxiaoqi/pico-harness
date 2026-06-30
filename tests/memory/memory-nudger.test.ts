// MemoryNudger 单元测试
// 测试周期性记忆提醒的触发逻辑、技能展示、摘要提取

import { describe, it, expect, beforeEach } from 'vitest';
import { MemoryNudger } from '../../src/memory/memory-nudger.js';
import { MockSkillRegistry } from '../mocks/skill-registry.mock.js';
import { MockFTS5Store } from '../mocks/fts5-store.mock.js';
import type { LearnedSkill } from '../../src/memory/skill-schema.js';

describe('MemoryNudger', () => {
  let skillRegistry: MockSkillRegistry;
  let fts5: MockFTS5Store;
  let nudger: MemoryNudger;

  beforeEach(() => {
    skillRegistry = new MockSkillRegistry();
    fts5 = new MockFTS5Store();
    nudger = new MemoryNudger(skillRegistry as any, fts5 as any);
  });

  describe('触发周期', () => {
    it('第 0 轮不触发', async () => {
      const result = await nudger.generate('test-session', 0);
      expect(result).toBeNull();
    });

    it('第 10 轮触发提醒', async () => {
      // 添加一个技能确保有内容返回
      skillRegistry.addSkill(createMockSkill('test-skill', 10, 0));
      
      const result = await nudger.generate('test-session', 10);
      expect(result).not.toBeNull();
      expect(result).toContain('💡 记忆提醒');
    });

    it('第 20 轮触发提醒', async () => {
      skillRegistry.addSkill(createMockSkill('test-skill', 5, 0));
      
      const result = await nudger.generate('test-session', 20);
      expect(result).not.toBeNull();
    });

    it('第 9 轮不触发', async () => {
      const result = await nudger.generate('test-session', 9);
      expect(result).toBeNull();
    });

    it('第 11 轮不触发', async () => {
      const result = await nudger.generate('test-session', 11);
      expect(result).toBeNull();
    });

    it('支持自定义周期', async () => {
      // 每 5 轮触发一次
      const customNudger = new MemoryNudger(skillRegistry as any, fts5 as any, {
        nudgePeriod: 5,
      });
      skillRegistry.addSkill(createMockSkill('test-skill', 1, 0));

      expect(await customNudger.generate('test-session', 5)).not.toBeNull();
      expect(await customNudger.generate('test-session', 10)).not.toBeNull();
      expect(await customNudger.generate('test-session', 7)).toBeNull();
    });
  });

  describe('技能展示', () => {
    it('展示 Top 3 技能', async () => {
      // 添加 5 个技能，按使用频次排序
      skillRegistry.addSkill(createMockSkill('skill-A', 50, 5)); // 总计 55
      skillRegistry.addSkill(createMockSkill('skill-B', 40, 10)); // 总计 50
      skillRegistry.addSkill(createMockSkill('skill-C', 30, 0)); // 总计 30
      skillRegistry.addSkill(createMockSkill('skill-D', 20, 0)); // 总计 20
      skillRegistry.addSkill(createMockSkill('skill-E', 10, 0)); // 总计 10

      const result = await nudger.generate('test-session', 10);
      
      expect(result).toContain('你最近掌握的技能');
      expect(result).toContain('skill-A');
      expect(result).toContain('skill-B');
      expect(result).toContain('skill-C');
      expect(result).not.toContain('skill-D'); // 第4名，不应出现
      expect(result).not.toContain('skill-E'); // 第5名，不应出现
    });

    it('显示技能成功率', async () => {
      skillRegistry.addSkill(createMockSkill('high-success', 90, 10)); // 90% 成功率
      
      const result = await nudger.generate('test-session', 10);
      
      expect(result).toContain('high-success');
      expect(result).toContain('90%'); // 成功率
      expect(result).toContain('使用 90 次'); // 成功次数
    });

    it('显示技能触发条件', async () => {
      const skill = createMockSkill('test-skill', 10, 0);
      skill.trigger = '当用户请求数据分析时';
      skillRegistry.addSkill(skill);
      
      const result = await nudger.generate('test-session', 10);
      
      expect(result).toContain('触发条件: 当用户请求数据分析时');
    });

    it('无技能时不展示技能部分', async () => {
      const result = await nudger.generate('test-session', 10);
      
      // 无技能也无摘要时返回 null
      expect(result).toBeNull();
    });
  });

  describe('会话摘要', () => {
    it('包含 FTS5 中的会话摘要', async () => {
      fts5.setSummary('test-session', '本次对话讨论了 TypeScript 类型系统设计');
      
      const result = await nudger.generate('test-session', 10);
      
      expect(result).toContain('本次对话要点');
      expect(result).toContain('本次对话讨论了 TypeScript 类型系统设计');
    });

    it('无摘要时不展示摘要部分', async () => {
      skillRegistry.addSkill(createMockSkill('test-skill', 10, 0));
      
      const result = await nudger.generate('test-session', 10);
      
      expect(result).not.toContain('本次对话要点');
    });
  });

  describe('综合场景', () => {
    it('同时展示技能和摘要', async () => {
      skillRegistry.addSkill(createMockSkill('skill-A', 10, 0));
      fts5.setSummary('test-session', '讨论了 React Hooks 最佳实践');
      
      const result = await nudger.generate('test-session', 10);
      
      expect(result).toContain('💡 记忆提醒');
      expect(result).toContain('你最近掌握的技能');
      expect(result).toContain('本次对话要点');
      expect(result).toContain('skill-A');
      expect(result).toContain('React Hooks 最佳实践');
    });

    it('既无技能也无摘要时返回 null', async () => {
      const result = await nudger.generate('test-session', 10);
      expect(result).toBeNull();
    });

    it('仅有摘要时也返回提醒', async () => {
      fts5.setSummary('test-session', '纯摘要场景');
      
      const result = await nudger.generate('test-session', 10);
      
      expect(result).not.toBeNull();
      expect(result).toContain('💡 记忆提醒');
      expect(result).toContain('本次对话要点');
      expect(result).not.toContain('你最近掌握的技能');
    });
  });
});

/** 测试辅助函数：创建 mock 技能 */
function createMockSkill(
  name: string,
  successCount: number,
  failCount: number,
): LearnedSkill {
  return {
    id: `skill-${name}`,
    name,
    trigger: `触发 ${name}`,
    instructions: `执行 ${name}`,
    source: 'auto',
    stats: {
      successCount,
      failCount,
      avgExecutionTime: 1000,
      lastUsed: new Date().toISOString(),
    },
    knownFailures: [],
    versions: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}
