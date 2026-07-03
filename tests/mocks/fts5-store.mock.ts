// Mock FTS5Store for testing
import { vi } from 'vitest';
import type { Message } from '../../src/schema/message.js';

/** FTS5 检索结果项 */
export interface FTS5SearchResult {
  content: string;
  turnIndex: number;
  score?: number;
}

/**
 * MockFTS5Store: FTS5Store 的测试 mock 实现。
 * 使用内存数组模拟索引和检索功能。
 */
export class MockFTS5Store {
  // 内存索引: sessionId -> turnIndex -> content
  private index = new Map<string, Map<number, string>>();
  // 会话摘要
  private summaries = new Map<string, string>();

  insert = vi.fn((sessionId: string, turnIndex: number, message: Message) => {
    let sessionIndex = this.index.get(sessionId);
    if (!sessionIndex) {
      sessionIndex = new Map();
      this.index.set(sessionId, sessionIndex);
    }
    
    // 提取消息文本内容
    let content = '';
    if (typeof message.content === 'string') {
      content = message.content;
    } else if (Array.isArray(message.content)) {
      // 使用类型断言处理 content blocks
      const blocks = message.content as Array<{ type: string; text?: string }>;
      content = blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text || '')
        .join(' ');
    }
    
    sessionIndex.set(turnIndex, content);
  });

  search = vi.fn((query: string, limit = 10): FTS5SearchResult[] => {
    const results: FTS5SearchResult[] = [];
    
    // 简单的字符串匹配检索
    for (const [_sessionId, sessionIndex] of this.index.entries()) {
      for (const [turnIndex, content] of sessionIndex.entries()) {
        if (content.toLowerCase().includes(query.toLowerCase())) {
          results.push({
            content,
            turnIndex,
            score: 1.0,
          });
        }
      }
    }
    
    return results.slice(0, limit);
  });

  getSummary = vi.fn((sessionId: string): string | null => {
    return this.summaries.get(sessionId) ?? null;
  });

  setSummary(sessionId: string, summary: string): void {
    this.summaries.set(sessionId, summary);
  }

  close = vi.fn();

  // 测试辅助方法
  clear(): void {
    this.index.clear();
    this.summaries.clear();
  }

  // ── 连接池化静态接口(与真实 FTS5Store 对齐)──
  // mock 实现:每次 acquire new 一个内存实例,不做真正共享(测试无需验证池语义)。
  private static instances = new Map<string, MockFTS5Store>();

  static acquire(workDir: string): MockFTS5Store | null {
    const existing = MockFTS5Store.instances.get(workDir);
    if (existing) return existing;
    const store = new MockFTS5Store();
    MockFTS5Store.instances.set(workDir, store);
    return store;
  }

  static release(_workDir: string): void {
    // mock 不做引用计数,release 为空操作(实例仍可被测试持有)
  }

  static closeAll(): void {
    MockFTS5Store.instances.clear();
  }
}
