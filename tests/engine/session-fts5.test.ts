// Session FTS5 集成测试
// 测试 Session.append() 自动索引、Session.search() 检索、FTS5 降级逻辑

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MockFTS5Store } from "../mocks/fts5-store.mock.js";

import { Session } from "../../src/engine/session.js";
import type { Message } from "../../src/schema/message.js";

describe("Session FTS5 集成", () => {
  let workDir: string;
  let session: Session;
  let memoryStore: MockFTS5Store;

  beforeEach(() => {
    // 创建临时工作目录
    workDir = mkdtempSync(join(tmpdir(), "pico-session-fts5-"));

    // 通过公开 SessionOptions 注入完整的检索存储契约。
    memoryStore = new MockFTS5Store();
    session = new Session("test-session-fts5", workDir, {
      persistence: false,
      memorySearchStore: memoryStore,
    });
  });

  afterEach(() => {
    // 清理临时目录
    rmSync(workDir, { recursive: true, force: true });
    vi.clearAllMocks();
  });

  describe("FTS5 初始化", () => {
    it("Session 构造时使用注入的检索后端", () => {
      expect(session.memoryStatus).toEqual(memoryStore.status);
    });

    it("降级检索后端不影响 Session 主流程", () => {
      const degradedStore = new MockFTS5Store({
        backend: "jsonl_memory",
        state: "degraded",
        persistentSource: "none",
        reason: "SQLite FTS5 unavailable",
      });
      const testSession = new Session("test-degraded", workDir, {
        persistence: false,
        memorySearchStore: degradedStore,
      });

      expect(testSession.memoryStatus.state).toBe("degraded");
      expect(testSession.memoryStatus.backend).toBe("jsonl_memory");
      testSession.append({ role: "user", content: "test" });
      expect(testSession.length).toBe(1);
      expect(degradedStore.insert).toHaveBeenCalledOnce();
    });
  });

  describe("append() 自动索引", () => {
    it("append 单条消息时自动建立 FTS5 索引", () => {
      const msg: Message = { role: "user", content: "Hello, pico!" };
      session.append(msg);

      expect(memoryStore.insert).toHaveBeenCalledTimes(1);
      expect(memoryStore.insert).toHaveBeenCalledWith("test-session-fts5", 0, msg);
    });

    it("append 批量消息时按顺序索引", () => {
      const msgs: Message[] = [
        { role: "user", content: "Message 1" },
        { role: "assistant", content: "Reply 1" },
        { role: "user", content: "Message 2" },
      ];
      session.append(...msgs);

      expect(memoryStore.insert).toHaveBeenCalledTimes(3);
      expect(memoryStore.insert).toHaveBeenNthCalledWith(1, "test-session-fts5", 0, msgs[0]);
      expect(memoryStore.insert).toHaveBeenNthCalledWith(2, "test-session-fts5", 1, msgs[1]);
      expect(memoryStore.insert).toHaveBeenNthCalledWith(3, "test-session-fts5", 2, msgs[2]);
    });

    it("多次 append 时 turnIndex 连续递增", () => {
      session.append({ role: "user", content: "First" });
      session.append({ role: "assistant", content: "Second" });
      session.append({ role: "user", content: "Third" });

      expect(memoryStore.insert).toHaveBeenCalledTimes(3);

      // 验证 turnIndex 分别为 0, 1, 2
      expect(vi.mocked(memoryStore.insert).mock.calls[0]![1]).toBe(0);
      expect(vi.mocked(memoryStore.insert).mock.calls[1]![1]).toBe(1);
      expect(vi.mocked(memoryStore.insert).mock.calls[2]![1]).toBe(2);
    });

    it("FTS5 索引失败时不影响 Session 主流程", () => {
      memoryStore.insert.mockImplementation(() => {
        throw new Error("索引写入失败");
      });

      // 即使索引失败，append 也应成功
      expect(() => {
        session.append({ role: "user", content: "test" });
      }).not.toThrow();

      expect(session.length).toBe(1);
      expect(session.getHistory()[0]!.content).toBe("test");
    });

    it("降级检索后端时 append 不抛出异常", () => {
      const degradedStore = new MockFTS5Store({
        backend: "jsonl_memory",
        state: "degraded",
        persistentSource: "none",
        reason: "SQLite FTS5 unavailable",
      });
      const degradedSession = new Session("test-degraded-append", workDir, {
        persistence: false,
        memorySearchStore: degradedStore,
      });

      expect(() => {
        degradedSession.append({ role: "user", content: "test" });
      }).not.toThrow();

      expect(degradedSession.length).toBe(1);
      expect(degradedStore.insert).toHaveBeenCalledWith("test-degraded-append", 0, {
        role: "user",
        content: "test",
      });
    });
  });

  describe("search() 全文检索", () => {
    beforeEach(() => {
      // 准备测试数据
      session.append(
        { role: "user", content: "How do I use TypeScript generics?" },
        { role: "assistant", content: "TypeScript generics allow..." },
        { role: "user", content: "What about React hooks?" },
        { role: "assistant", content: "React hooks are functions..." },
      );
    });

    it("search() 返回匹配的对话片段", () => {
      const searchResults = session.search("TypeScript");

      expect(searchResults).toHaveLength(2); // user + assistant 都包含 TypeScript
      expect(searchResults[0]!.content).toContain("TypeScript");
    });

    it("search() 默认返回最多 10 条结果", () => {
      session.search("test");

      // MockFTS5Store.search 现在接收 3 个参数: query, limit, sessionId
      expect(memoryStore.search).toHaveBeenCalledWith("test", 10, "test-session-fts5");
    });

    it("search() 支持自定义 limit", () => {
      session.search("React", 5);

      expect(memoryStore.search).toHaveBeenCalledWith("React", 5, "test-session-fts5");
    });

    it("search 仅返回当前 Session 的结果", () => {
      memoryStore.insert("another-session", 0, { role: "user", content: "TypeScript elsewhere" });

      const results = session.search("TypeScript");
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.sessionId === "test-session-fts5")).toBe(true);
    });

    it("FTS5 检索失败时返回空数组", () => {
      memoryStore.search.mockImplementation(() => {
        throw new Error("查询语法错误");
      });

      const results = session.search("invalid query");
      expect(results).toEqual([]);
    });

    it("search 结果包含 turnIndex", () => {
      memoryStore.search.mockReturnValue([
        {
          sessionId: "test-session-fts5",
          content: "Match 1",
          turnIndex: 5,
          role: "user",
          timestamp: "2026-01-01T00:00:00.000Z",
          relevance: 0.1,
        },
        {
          sessionId: "test-session-fts5",
          content: "Match 2",
          turnIndex: 12,
          role: "assistant",
          timestamp: "2026-01-01T00:00:01.000Z",
          relevance: 0.2,
        },
      ]);

      const results = session.search("keyword");

      expect(results).toHaveLength(2);
      expect(results[0]).toEqual({
        content: "Match 1",
        turnIndex: 5,
        sessionId: "test-session-fts5",
      });
      expect(results[1]).toEqual({
        content: "Match 2",
        turnIndex: 12,
        sessionId: "test-session-fts5",
      });
    });
  });

  describe("并发场景", () => {
    it("并发 append 时 FTS5 索引顺序正确", async () => {
      // 模拟并发追加（通过 Session.serialize 确保串行）
      const promises = [
        session.serialize(async () => {
          session.append({ role: "user", content: "Msg A" });
        }),
        session.serialize(async () => {
          session.append({ role: "user", content: "Msg B" });
        }),
        session.serialize(async () => {
          session.append({ role: "user", content: "Msg C" });
        }),
      ];

      await Promise.all(promises);

      // 验证索引调用顺序和 turnIndex
      expect(memoryStore.insert).toHaveBeenCalledTimes(3);
      expect(vi.mocked(memoryStore.insert).mock.calls[0]![1]).toBe(0); // turnIndex=0
      expect(vi.mocked(memoryStore.insert).mock.calls[1]![1]).toBe(1); // turnIndex=1
      expect(vi.mocked(memoryStore.insert).mock.calls[2]![1]).toBe(2); // turnIndex=2
    });
  });

  describe("memoryStatus getter", () => {
    it("暴露当前检索后端状态", () => {
      expect(session.memoryStatus).toEqual(memoryStore.status);
    });

    it("显式检索后端不伪装成 FTS5 租约", () => {
      expect(session.fts5Store).toBeUndefined();
    });
  });
});
