// Session FTS5 集成测试
// 测试 Session.append() 自动索引、Session.search() 检索、FTS5 降级逻辑

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MockFTS5Store } from '../mocks/fts5-store.mock.js';

// Mock FTS5Store 以避免依赖真实实现（必须在顶层）
vi.mock('../../src/memory/fts5-store.js', () => ({
  FTS5Store: MockFTS5Store,
}));

import { Session } from '../../src/engine/session.js';
import type { Message } from '../../src/schema/message.js';

describe('Session FTS5 集成', () => {
  let workDir: string;
  let session: Session;

  beforeEach(() => {
    // 创建临时工作目录
    workDir = mkdtempSync(join(tmpdir(), 'pico-session-fts5-'));

    // 创建 Session（关闭持久化以简化测试）
    session = new Session('test-session-fts5', workDir, { persistence: false });
  });

  afterEach(() => {
    // 清理临时目录
    rmSync(workDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe('FTS5 初始化', () => {
    it('Session 构造时自动初始化 FTS5', () => {
      // fts5Store getter 应返回 FTS5 实例
      expect(session.fts5Store).toBeDefined();
    });

    it('FTS5 初始化失败时降级为 undefined', () => {
      // 测试降级逻辑：直接修改 fts5 为 undefined 模拟初始化失败
      const testSession = new Session('test-degraded', workDir, {
        persistence: false,
      });
      
      // 模拟初始化失败后的降级状态
      (testSession as any).fts5 = undefined;

      // 降级后应为 undefined
      expect(testSession.fts5Store).toBeUndefined();
      
      // 但 Session 本身应正常工作
      testSession.append({ role: 'user', content: 'test' });
      expect(testSession.length).toBe(1);
    });
  });

  describe('append() 自动索引', () => {
    it('append 单条消息时自动建立 FTS5 索引', () => {
      const msg: Message = { role: 'user', content: 'Hello, pico!' };
      session.append(msg);

      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      expect(fts5.insert).toHaveBeenCalledTimes(1);
      expect(fts5.insert).toHaveBeenCalledWith('test-session-fts5', 0, msg);
    });

    it('append 批量消息时按顺序索引', () => {
      const msgs: Message[] = [
        { role: 'user', content: 'Message 1' },
        { role: 'assistant', content: 'Reply 1' },
        { role: 'user', content: 'Message 2' },
      ];
      session.append(...msgs);

      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      expect(fts5.insert).toHaveBeenCalledTimes(3);
      expect(fts5.insert).toHaveBeenNthCalledWith(
        1,
        'test-session-fts5',
        0,
        msgs[0],
      );
      expect(fts5.insert).toHaveBeenNthCalledWith(
        2,
        'test-session-fts5',
        1,
        msgs[1],
      );
      expect(fts5.insert).toHaveBeenNthCalledWith(
        3,
        'test-session-fts5',
        2,
        msgs[2],
      );
    });

    it('多次 append 时 turnIndex 连续递增', () => {
      session.append({ role: 'user', content: 'First' });
      session.append({ role: 'assistant', content: 'Second' });
      session.append({ role: 'user', content: 'Third' });

      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      expect(fts5.insert).toHaveBeenCalledTimes(3);
      
      // 验证 turnIndex 分别为 0, 1, 2
      expect(vi.mocked(fts5.insert).mock.calls[0]![1]).toBe(0);
      expect(vi.mocked(fts5.insert).mock.calls[1]![1]).toBe(1);
      expect(vi.mocked(fts5.insert).mock.calls[2]![1]).toBe(2);
    });

    it('FTS5 索引失败时不影响 Session 主流程', () => {
      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      fts5.insert.mockImplementation(() => {
        throw new Error('索引写入失败');
      });

      // 即使索引失败，append 也应成功
      expect(() => {
        session.append({ role: 'user', content: 'test' });
      }).not.toThrow();

      expect(session.length).toBe(1);
      expect(session.getHistory()[0]!.content).toBe('test');
    });

    it('FTS5 未初始化时 append 不抛出异常', () => {
      // 通过直接设置 fts5 为 undefined 模拟未初始化
      // 由于 fts5 是 private，我们用 any 类型绕过
      (session as any).fts5 = undefined;

      expect(() => {
        session.append({ role: 'user', content: 'test' });
      }).not.toThrow();

      expect(session.length).toBeGreaterThan(0);
    });
  });

  describe('search() 全文检索', () => {
    beforeEach(() => {
      // 准备测试数据
      session.append(
        { role: 'user', content: 'How do I use TypeScript generics?' },
        { role: 'assistant', content: 'TypeScript generics allow...' },
        { role: 'user', content: 'What about React hooks?' },
        { role: 'assistant', content: 'React hooks are functions...' },
      );
    });

    it('search() 返回匹配的对话片段', () => {
      const searchResults = session.search('TypeScript');
      
      expect(searchResults).toHaveLength(2); // user + assistant 都包含 TypeScript
      expect(searchResults[0]!.content).toContain('TypeScript');
    });

    it('search() 默认返回最多 10 条结果', () => {
      session.search('test');
      
      // MockFTS5Store.search 现在接收 3 个参数: query, limit, sessionId
      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      expect(fts5.search).toHaveBeenCalledWith('test', 10, 'test-session-fts5');
    });

    it('search() 支持自定义 limit', () => {
      session.search('React', 5);
      
      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      expect(fts5.search).toHaveBeenCalledWith('React', 5, 'test-session-fts5');
    });

    it('FTS5 未初始化时 search 返回空数组', () => {
      // 通过直接设置 fts5 为 undefined 模拟未初始化
      (session as any).fts5 = undefined;

      const results = session.search('test');
      expect(results).toEqual([]);
    });

    it('FTS5 检索失败时返回空数组', () => {
      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      fts5.search.mockImplementation(() => {
        throw new Error('查询语法错误');
      });

      const results = session.search('invalid query');
      expect(results).toEqual([]);
    });

    it('search 结果包含 turnIndex', () => {
      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      fts5.search.mockReturnValue([
        { content: 'Match 1', turnIndex: 5, score: 0.9 },
        { content: 'Match 2', turnIndex: 12, score: 0.7 },
      ]);

      const results = session.search('keyword');
      
      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({ content: 'Match 1', turnIndex: 5 });
      expect(results[1]).toEqual({ content: 'Match 2', turnIndex: 12 });
    });
  });

  describe('并发场景', () => {
    it('并发 append 时 FTS5 索引顺序正确', async () => {
      // 模拟并发追加（通过 Session.serialize 确保串行）
      const promises = [
        session.serialize(async () => {
          session.append({ role: 'user', content: 'Msg A' });
        }),
        session.serialize(async () => {
          session.append({ role: 'user', content: 'Msg B' });
        }),
        session.serialize(async () => {
          session.append({ role: 'user', content: 'Msg C' });
        }),
      ];

      await Promise.all(promises);

      // 验证索引调用顺序和 turnIndex
      const fts5 = session.fts5Store as unknown as MockFTS5Store;
      expect(fts5.insert).toHaveBeenCalledTimes(3);
      expect(vi.mocked(fts5.insert).mock.calls[0]![1]).toBe(0); // turnIndex=0
      expect(vi.mocked(fts5.insert).mock.calls[1]![1]).toBe(1); // turnIndex=1
      expect(vi.mocked(fts5.insert).mock.calls[2]![1]).toBe(2); // turnIndex=2
    });
  });

  describe('fts5Store getter', () => {
    it('暴露 FTS5Store 实例供外部使用', () => {
      const fts5 = session.fts5Store;
      
      expect(fts5).toBeInstanceOf(MockFTS5Store);
      expect(fts5).toBe(session.fts5Store); // 应返回同一实例
    });

    it('FTS5 未初始化时返回 undefined', () => {
      // 通过直接设置 fts5 为 undefined 模拟未初始化
      (session as any).fts5 = undefined;

      expect(session.fts5Store).toBeUndefined();
    });
  });
});
