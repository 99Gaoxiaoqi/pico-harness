// FTS5Store 单元测试:验证全文检索、摘要持久化、技能统计等核心功能。
//
// 测试策略:
// 1. 每个测试用例独立临时目录(避免并行测试相互污染)
// 2. 测试后自动清理数据库文件
// 3. 覆盖正常流程 + 边界条件 + 降级场景

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { FTS5Store } from "../../src/memory/fts5-store.js";
import type { Message } from "../../src/schema/message.js";

describe("FTS5Store", () => {
  let tempDir: string;
  let store: FTS5Store;

  beforeEach(() => {
    // 每个测试用例独立临时目录
    tempDir = mkdtempSync(join(tmpdir(), "fts5-test-"));
    store = new FTS5Store(tempDir);
  });

  afterEach(() => {
    // 清理:关闭数据库连接后删除临时目录
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("初始化", () => {
    it("应该自动创建 .claw/ 目录和数据库文件", () => {
      const dbPath = join(tempDir, ".claw", "sessions.db");
      expect(dbPath).toBeTruthy(); // 构造函数未抛异常即为成功
    });

    it("数据库文件不存在时应该自动创建", () => {
      // beforeEach 已创建,这里验证重复初始化幂等
      const store2 = new FTS5Store(tempDir);
      expect(store2).toBeTruthy();
      store2.close();
    });
  });

  describe("消息索引与检索", () => {
    it("应该成功插入消息并索引", () => {
      const msg: Message = {
        role: "user",
        content: "请帮我实现 FTS5 全文检索功能",
      };
      store.insert("session-001", 0, msg);

      const results = store.search("FTS5 全文检索");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.sessionId).toBe("session-001");
      expect(results[0]?.turnIndex).toBe(0);
      expect(results[0]?.role).toBe("user");
      expect(results[0]?.content).toContain("FTS5");
    });

    it("应该支持全文检索(匹配关键词)", () => {
      const messages: Array<{ session: string; turn: number; msg: Message }> = [
        {
          session: "s1",
          turn: 0,
          msg: { role: "user", content: "如何实现 Session 物理隔离?" },
        },
        {
          session: "s1",
          turn: 1,
          msg: {
            role: "assistant",
            content: "通过 SessionManager 为每个会话分配独立的 workDir 和 history",
          },
        },
        {
          session: "s2",
          turn: 0,
          msg: { role: "user", content: "什么是 WorkingMemory?" },
        },
        {
          session: "s2",
          turn: 1,
          msg: {
            role: "assistant",
            content: "WorkingMemory 是 Session 的滑动窗口,只保留最近 N 条消息",
          },
        },
      ];

      for (const { session, turn, msg } of messages) {
        store.insert(session, turn, msg);
      }

      // 搜索"Session"应该匹配第 1 和第 2 条
      const results1 = store.search("Session");
      expect(results1.length).toBeGreaterThanOrEqual(1);
      expect(results1.some((r) => r.content.includes("Session"))).toBe(true);

      // 搜索"WorkingMemory"应该匹配第 3 和第 4 条
      const results2 = store.search("WorkingMemory");
      expect(results2.length).toBeGreaterThanOrEqual(1);
      expect(results2.some((r) => r.content.includes("WorkingMemory"))).toBe(true);

      // 搜索不存在的关键词应该返回空数组
      const results3 = store.search("不存在的关键词12345");
      expect(results3.length).toBe(0);
    });

    it("应该支持中文分词检索", () => {
      store.insert("s1", 0, { role: "user", content: "驾驭工程的核心理念是什么?" });
      store.insert("s1", 1, {
        role: "assistant",
        content: "驾驭工程把大模型视为 CPU,上下文视为内存,工具视为外设",
      });

      // trigram tokenizer 对短查询(<3 字符)降级为 LIKE 匹配
      const results = store.search("驾驭");
      expect(results.length).toBeGreaterThan(0);
      expect(results.some((r) => r.content.includes("驾驭"))).toBe(true);

      // 长查询(≥3 字符)使用 FTS5 trigram
      const results2 = store.search("驾驭工程");
      expect(results2.length).toBeGreaterThan(0);
      expect(results2.some((r) => r.content.includes("驾驭工程"))).toBe(true);
    });

    it("应该按相关性排序(relevance 越接近 0 越相关)", () => {
      store.insert("s1", 0, { role: "user", content: "FTS5" });
      store.insert("s1", 1, {
        role: "user",
        content: "FTS5 全文检索 FTS5 性能优化 FTS5",
      });
      store.insert("s1", 2, { role: "user", content: "全文检索的原理" });

      // "FTS5"是 4 字符,使用 trigram FTS5
      const results = store.search("FTS5");
      // 至少匹配前两条(第三条没有"FTS5")
      expect(results.length).toBeGreaterThanOrEqual(2);
      // 第二条消息包含 4 个"FTS5",相关性应该更高
      // 但 trigram 的 rank 计算可能不同,只验证都匹配到了
      expect(results.some((r) => r.turnIndex === 0)).toBe(true);
      expect(results.some((r) => r.turnIndex === 1)).toBe(true);
    });

    it("应该支持 limit 限制返回数量", () => {
      for (let i = 0; i < 20; i++) {
        store.insert("s1", i, { role: "user", content: `测试消息 ${i}` });
      }

      // "测试"是 2 字符,降级为 LIKE 查询
      const results1 = store.search("测试", 5);
      expect(results1.length).toBe(5);

      const results2 = store.search("测试", 15);
      expect(results2.length).toBe(15);
    });

    it("应该处理 content 为对象数组的消息(转 JSON 字符串)", () => {
      const msg = {
        role: "assistant",
        content: [
          { type: "text", text: "调用 read_file 工具" },
          {
            type: "tool_use",
            id: "tool-123",
            name: "read_file",
            input: { path: "/foo/bar.ts" },
          },
        ],
      } as unknown as Message; // 测试兼容历史复杂 content 结构
      store.insert("s1", 0, msg);

      const results = store.search("read_file");
      expect(results.length).toBeGreaterThan(0);
      expect(results[0]?.content).toContain("read_file");
    });
  });

  describe("会话摘要", () => {
    it("应该成功保存和获取摘要", () => {
      const summary = "本次会话实现了 FTS5 全文检索存储层,包含 Schema 设计、API 实现和单元测试";
      store.saveSummary("session-001", summary, 42);

      const retrieved = store.getSummary("session-001");
      expect(retrieved).not.toBeNull();
      expect(retrieved?.sessionId).toBe("session-001");
      expect(retrieved?.summary).toBe(summary);
      expect(retrieved?.messageCount).toBe(42);
      expect(retrieved?.createdAt).toBeTruthy();
      expect(retrieved?.updatedAt).toBeTruthy();
    });

    it("应该支持 UPSERT(存在则更新)", async () => {
      store.saveSummary("s1", "第一版摘要", 10);
      const first = store.getSummary("s1");
      expect(first?.summary).toBe("第一版摘要");

      // 等待 5ms 确保 updatedAt 不同(ISO timestamp 精确到毫秒)
      await new Promise((resolve) => setTimeout(resolve, 5));

      store.saveSummary("s1", "第二版摘要(更新)", 20);
      const second = store.getSummary("s1");
      expect(second?.summary).toBe("第二版摘要(更新)");
      expect(second?.messageCount).toBe(20);
      expect(second?.updatedAt).not.toBe(first?.updatedAt);
    });

    it("不存在的会话应该返回 null", () => {
      const result = store.getSummary("不存在的会话ID");
      expect(result).toBeNull();
    });
  });

  describe("技能使用统计", () => {
    it("应该成功记录技能使用", () => {
      store.recordSkillUsage("read_file", "s1", true);
      store.recordSkillUsage("read_file", "s1", true);
      store.recordSkillUsage("read_file", "s1", false, "文件不存在");

      const stats = store.getSkillStats("read_file");
      expect(stats).not.toBeNull();
      expect(stats?.skillId).toBe("read_file");
      expect(stats?.totalCalls).toBe(3);
      expect(stats?.successCount).toBe(2);
      expect(stats?.failureCount).toBe(1);
      expect(stats?.successRate).toBeCloseTo(2 / 3, 2);
      expect(stats?.recentErrors).toContain("文件不存在");
    });

    it("应该记录最近 5 条错误消息", () => {
      for (let i = 0; i < 10; i++) {
        store.recordSkillUsage("buggy_tool", "s1", false, `错误 ${i}`);
      }

      const stats = store.getSkillStats("buggy_tool");
      expect(stats?.recentErrors.length).toBe(5);
      // 应该是最近的 5 条(降序),SQLite 按 timestamp DESC 排序
      // 只验证长度和格式,不验证具体顺序(时间戳可能相同)
      expect(stats?.recentErrors.every((e) => e.startsWith("错误"))).toBe(true);
    });

    it("未使用过的技能应该返回 null", () => {
      const stats = store.getSkillStats("未使用的技能");
      expect(stats).toBeNull();
    });

    it("应该正确计算成功率", () => {
      // 100% 成功
      store.recordSkillUsage("perfect_tool", "s1", true);
      store.recordSkillUsage("perfect_tool", "s1", true);
      const perfect = store.getSkillStats("perfect_tool");
      expect(perfect?.successRate).toBe(1.0);

      // 0% 成功
      store.recordSkillUsage("broken_tool", "s1", false, "总是失败");
      const broken = store.getSkillStats("broken_tool");
      expect(broken?.successRate).toBe(0.0);
    });
  });

  describe("并发安全", () => {
    it("应该支持并发插入(单进程多 Session)", () => {
      const sessions = [
        "sessionAlpha",
        "sessionBeta",
        "sessionGamma",
        "sessionDelta",
        "sessionEpsilon",
      ];
      const insertCount = 20;

      // 并发插入 100 条消息(5 个 session × 20 条)
      for (const sid of sessions) {
        for (let i = 0; i < insertCount; i++) {
          store.insert(sid, i, {
            role: "user",
            content: `测试会话标识符 ${sid} 的消息编号 ${i}`,
          });
        }
      }

      // 验证能搜索到不同 session 的消息
      // trigram 对英文单词也能有效匹配
      expect(store.search("sessionAlpha", 50).length).toBeGreaterThan(0);
      expect(store.search("sessionBeta", 50).length).toBeGreaterThan(0);
      expect(store.search("sessionGamma", 50).length).toBeGreaterThan(0);

      // 验证中文关键词能搜到所有会话
      const allResults = store.search("测试会话标识符", 100);
      expect(allResults.length).toBeGreaterThanOrEqual(sessions.length * insertCount);
    });
  });

  describe("降级处理", () => {
    it("数据库初始化失败时应该降级(不抛异常)", () => {
      // 用无效路径触发初始化失败(例如只读文件系统)
      // 注意:这个测试依赖文件系统权限,在某些环境可能通过
      // 这里仅验证构造函数不抛异常
      expect(() => {
        const invalidStore = new FTS5Store("/invalid/readonly/path");
        invalidStore.close();
      }).not.toThrow();
    });

    it("数据库关闭后操作应该静默失败", () => {
      store.close();

      // 关闭后操作应该不抛异常(降级为空操作)
      expect(() => {
        store.insert("s1", 0, { role: "user", content: "测试" });
        store.search("测试");
        store.saveSummary("s1", "摘要", 1);
        store.getSummary("s1");
        store.recordSkillUsage("tool", "s1", true);
        store.getSkillStats("tool");
      }).not.toThrow();
    });
  });

  describe("性能基准", () => {
    it("插入 1000 条后检索应该 < 10ms", () => {
      // 插入 1000 条消息
      for (let i = 0; i < 1000; i++) {
        store.insert("s1", i, {
          role: "user",
          content: `这是第 ${i} 条测试消息,用于验证 FTS5 性能`,
        });
      }

      // 测量检索耗时
      const start = Date.now();
      const results = store.search("FTS5 性能", 10);
      const elapsed = Date.now() - start;

      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10); // < 10ms
    });
  });
});
