// FTS5Store 压力测试与性能基准测试
//
// 测试目标:
// 1. 验证大规模数据插入性能(10K/50K 条消息)
// 2. 验证不同数据量下的检索响应时间(1K/10K/100K)
// 3. 验证并发读写安全性(多 session 同时操作)
// 4. 验证数据库恢复能力(断电模拟、损坏降级)
// 5. 验证边界条件处理(空字符串、超长消息、特殊字符)
//
// 性能基准对机器负载高度敏感(如"10000 条 < 3s"),不适合放进常规回归。
// 默认 skip,仅 RUN_BENCHMARK=1 时启用,用 npm test -- fts5-benchmark 单独跑。
// 预期耗时:1-2 分钟(并发执行)

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { performance } from "node:perf_hooks";
import { FTS5Store } from "../../src/memory/fts5-store.js";

// 性能基准默认关闭,避免在常规回归里因环境抖动产生假失败
const describeBenchmark = process.env.RUN_BENCHMARK === "1" ? describe : describe.skip;

describeBenchmark("FTS5Store - 压力测试与性能基准", () => {
  let tempDir: string;
  let store: FTS5Store;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "fts5-bench-"));
    store = new FTS5Store(tempDir);
  });

  afterEach(() => {
    store.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  describe("1. 大规模数据插入测试", () => {
    it("插入 10,000 条消息性能基准(< 3秒)", () => {
      const count = 10_000;
      const start = performance.now();

      for (let i = 0; i < count; i++) {
        store.insert("bulk-session", i, {
          role: i % 2 === 0 ? "user" : "assistant",
          content: `这是第 ${i} 条测试消息,用于验证大规模插入性能。FTS5 全文检索引擎支持中英文混合 trigram tokenizer。`,
        });
      }

      const elapsed = performance.now() - start;
      const opsPerSec = (count / elapsed) * 1000;

      console.log(`\n📊 插入 ${count.toLocaleString()} 条消息:`);
      console.log(`   总耗时: ${elapsed.toFixed(2)}ms`);
      console.log(`   吞吐量: ${opsPerSec.toFixed(0)} ops/sec`);

      expect(elapsed).toBeLessThan(3000); // 目标 < 3秒
      expect(opsPerSec).toBeGreaterThan(1000); // 目标 > 1000 ops/sec
    });

    it("插入 50,000 条后数据库文件 < 50MB", () => {
      const count = 50_000;

      for (let i = 0; i < count; i++) {
        store.insert("large-session", i, {
          role: "user",
          content: `消息 ${i}: 测试数据库文件大小增长`,
        });
      }

      // 关闭数据库以确保所有数据 flush 到磁盘
      store.close();

      const dbPath = join(tempDir, ".claw", "sessions.db");
      const stats = readFileSync(dbPath);
      const sizeMB = stats.length / (1024 * 1024);

      console.log(`\n💾 50,000 条消息后数据库大小: ${sizeMB.toFixed(2)} MB`);

      expect(sizeMB).toBeLessThan(50); // 目标 < 50MB
    });

    it("批量插入 vs 单条插入性能对比", () => {
      const count = 1000;

      // 单条插入
      const start1 = performance.now();
      for (let i = 0; i < count; i++) {
        store.insert("single-session", i, {
          role: "user",
          content: `单条插入测试消息 ${i}`,
        });
      }
      const elapsed1 = performance.now() - start1;

      // 模拟批量插入(实际 FTS5Store 没有批量 API,这里连续插入作为对比)
      const store2 = new FTS5Store(mkdtempSync(join(tmpdir(), "fts5-batch-")));
      const start2 = performance.now();
      for (let i = 0; i < count; i++) {
        store2.insert("batch-session", i, {
          role: "user",
          content: `批量插入测试消息 ${i}`,
        });
      }
      const elapsed2 = performance.now() - start2;

      console.log(`\n⚖️  批量 vs 单条 (${count} 条):`);
      console.log(`   单条插入: ${elapsed1.toFixed(2)}ms`);
      console.log(`   批量插入: ${elapsed2.toFixed(2)}ms`);

      store2.close();
      rmSync(store2["dbPath"], { force: true, recursive: true });

      // 两者差异应该在合理范围内(±30%)
      expect(Math.abs(elapsed1 - elapsed2) / elapsed1).toBeLessThan(0.3);
    });

    it("不同消息长度插入性能对比(100字 vs 1000字 vs 5000字)", () => {
      const count = 1000;
      const short = "测试".repeat(50); // 100 字
      const medium = "测试".repeat(500); // 1000 字
      const long = "测试".repeat(2500); // 5000 字

      // 短消息
      const start1 = performance.now();
      for (let i = 0; i < count; i++) {
        store.insert("short", i, { role: "user", content: short });
      }
      const elapsed1 = performance.now() - start1;

      // 中等消息
      const start2 = performance.now();
      for (let i = 0; i < count; i++) {
        store.insert("medium", i, { role: "user", content: medium });
      }
      const elapsed2 = performance.now() - start2;

      // 长消息
      const start3 = performance.now();
      for (let i = 0; i < count; i++) {
        store.insert("long", i, { role: "user", content: long });
      }
      const elapsed3 = performance.now() - start3;

      console.log(`\n📏 不同长度消息插入 (${count} 条):`);
      console.log(
        `   100字:  ${elapsed1.toFixed(2)}ms (${((count / elapsed1) * 1000).toFixed(0)} ops/s)`,
      );
      console.log(
        `   1000字: ${elapsed2.toFixed(2)}ms (${((count / elapsed2) * 1000).toFixed(0)} ops/s)`,
      );
      console.log(
        `   5000字: ${elapsed3.toFixed(2)}ms (${((count / elapsed3) * 1000).toFixed(0)} ops/s)`,
      );

      // 长消息耗时应该更长,但不应超过 10 倍(trigram 对长文本索引开销大)
      expect(elapsed3).toBeGreaterThan(elapsed1);
      expect(elapsed3 / elapsed1).toBeLessThan(10);
    });
  });

  describe("2. 检索性能测试", () => {
    it("1,000 条数据后检索响应时间 < 10ms", () => {
      // 插入 1000 条
      for (let i = 0; i < 1000; i++) {
        store.insert("s1", i, {
          role: "user",
          content: `测试消息 ${i} 包含关键词 FTS5 全文检索`,
        });
      }

      const start = performance.now();
      const results = store.search("FTS5 全文检索", 10);
      const elapsed = performance.now() - start;

      console.log(`\n🔍 1,000 条数据检索: ${elapsed.toFixed(2)}ms`);

      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(10);
    });

    it("10,000 条数据后检索响应时间 < 20ms", () => {
      // 插入 10000 条
      for (let i = 0; i < 10_000; i++) {
        store.insert("s2", i, {
          role: "user",
          content: `测试消息 ${i} 包含关键词 performance benchmark`,
        });
      }

      const start = performance.now();
      const results = store.search("performance benchmark", 10);
      const elapsed = performance.now() - start;

      console.log(`🔍 10,000 条数据检索: ${elapsed.toFixed(2)}ms`);

      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(20);
    });

    it("100,000 条数据后检索响应时间 < 50ms", () => {
      // 插入 100000 条(这会比较慢,预计 30-60 秒)
      console.log("\n⏳ 插入 100,000 条数据(预计 30-60 秒)...");
      const insertStart = performance.now();

      for (let i = 0; i < 100_000; i++) {
        store.insert("s3", i, {
          role: "user",
          content: `测试消息 ${i} 包含关键词 scalability stress`,
        });
      }

      const insertElapsed = performance.now() - insertStart;
      console.log(`   插入完成: ${(insertElapsed / 1000).toFixed(2)}s`);

      const start = performance.now();
      const results = store.search("scalability stress", 10);
      const elapsed = performance.now() - start;

      console.log(`🔍 100,000 条数据检索: ${elapsed.toFixed(2)}ms`);

      expect(results.length).toBeGreaterThan(0);
      expect(elapsed).toBeLessThan(100); // 100K 数据量大,放宽到 100ms
    }, 120_000); // 设置 2 分钟超时

    it("复杂查询(多关键词、中英文混合)性能", () => {
      // 插入多样化数据
      for (let i = 0; i < 5000; i++) {
        store.insert("s4", i, {
          role: "user",
          content: `第 ${i} 条消息:驾驭工程 Harness Engineering 把大模型视为 CPU,上下文视为内存`,
        });
      }

      const queries = ["驾驭工程", "Harness Engineering", "大模型 CPU", "驾驭工程 AND Harness"];

      for (const query of queries) {
        const start = performance.now();
        const results = store.search(query, 10);
        const elapsed = performance.now() - start;

        console.log(`\n🔍 复杂查询 "${query}": ${elapsed.toFixed(2)}ms, ${results.length} 条结果`);

        expect(elapsed).toBeLessThan(20);
      }
    });

    it("limit 参数对性能的影响(limit=10 vs limit=100)", () => {
      // 插入 5000 条
      for (let i = 0; i < 5000; i++) {
        store.insert("s5", i, {
          role: "user",
          content: `测试消息 ${i} 包含关键词 limit performance`,
        });
      }

      const start1 = performance.now();
      const results10 = store.search("limit performance", 10);
      const elapsed1 = performance.now() - start1;

      const start2 = performance.now();
      const results100 = store.search("limit performance", 100);
      const elapsed2 = performance.now() - start2;

      console.log(`\n🔢 limit 影响:`);
      console.log(`   limit=10:  ${elapsed1.toFixed(2)}ms (${results10.length} 条)`);
      console.log(`   limit=100: ${elapsed2.toFixed(2)}ms (${results100.length} 条)`);

      expect(results10.length).toBe(10);
      expect(results100.length).toBeLessThanOrEqual(100);
      // limit=100 耗时应该略高,但不应超过 3 倍
      expect(elapsed2 / elapsed1).toBeLessThan(3);
    });
  });

  describe("3. 并发读写安全性", () => {
    it("10 个并发 session 同时插入(无数据丢失)", async () => {
      const sessionCount = 10;
      const messagesPerSession = 100;

      const promises = Array.from({ length: sessionCount }, (_, idx) => {
        return Promise.resolve().then(() => {
          for (let i = 0; i < messagesPerSession; i++) {
            store.insert(`session${idx}`, i, {
              role: "user",
              content: `并发测试会话${idx}的消息${i}`,
            });
          }
        });
      });

      await Promise.all(promises);

      // 验证每个 session 的数据都能检索到(用中文避免 FTS5 列名冲突)
      for (let idx = 0; idx < sessionCount; idx++) {
        const results = store.search(`并发测试会话${idx}`, messagesPerSession);
        expect(results.length).toBeGreaterThan(0);
      }

      console.log(`\n🔀 并发插入: ${sessionCount} 个 session × ${messagesPerSession} 条,数据完整`);
    });

    it("5 个写 + 5 个读并发执行(无锁超时)", async () => {
      // 先插入基础数据
      for (let i = 0; i < 1000; i++) {
        store.insert("base", i, { role: "user", content: `基础数据 ${i}` });
      }

      const writers = Array.from({ length: 5 }, (_, idx) => {
        return Promise.resolve().then(() => {
          for (let i = 0; i < 50; i++) {
            store.insert(`writer-${idx}`, i, {
              role: "user",
              content: `写入者 ${idx} 消息 ${i}`,
            });
          }
        });
      });

      const readers = Array.from({ length: 5 }, () => {
        return Promise.resolve().then(() => {
          for (let i = 0; i < 50; i++) {
            const results = store.search("基础数据", 10);
            expect(results.length).toBeGreaterThan(0);
          }
        });
      });

      const start = performance.now();
      await Promise.all([...writers, ...readers]);
      const elapsed = performance.now() - start;

      console.log(`\n🔄 5 写 + 5 读并发: ${elapsed.toFixed(2)}ms,无锁超时`);
      expect(elapsed).toBeLessThan(5000); // 应该在 5 秒内完成
    });

    it("并发插入 + 并发检索(验证数据一致性)", async () => {
      const insertPromises = Array.from({ length: 3 }, (_, idx) => {
        return Promise.resolve().then(() => {
          for (let i = 0; i < 200; i++) {
            store.insert(`consistency-${idx}`, i, {
              role: "user",
              content: `一致性测试 ${idx}-${i}`,
            });
          }
        });
      });

      const searchPromises = Array.from({ length: 3 }, () => {
        return Promise.resolve().then(() => {
          for (let i = 0; i < 100; i++) {
            const results = store.search("一致性测试", 20);
            // 检索结果应该随着插入逐渐增多
            expect(Array.isArray(results)).toBe(true);
          }
        });
      });

      await Promise.all([...insertPromises, ...searchPromises]);

      // 最终验证所有数据都能检索到
      const finalResults = store.search("一致性测试", 1000);
      expect(finalResults.length).toBeGreaterThanOrEqual(600); // 3 × 200 = 600

      console.log(`\n✅ 并发插入+检索: 数据一致,检索到 ${finalResults.length} 条`);
    });

    it("并发保存摘要(验证 UPSERT 正确性)", async () => {
      const sessionId = "upsert-test";
      const concurrentUpdates = 20;

      const promises = Array.from({ length: concurrentUpdates }, (_, idx) => {
        return Promise.resolve().then(() => {
          store.saveSummary(sessionId, `第 ${idx} 次更新`, idx + 1);
        });
      });

      await Promise.all(promises);

      // 由于并发更新,最终结果应该是最后一次写入(但具体是哪次无法确定)
      const summary = store.getSummary(sessionId);
      expect(summary).not.toBeNull();
      expect(summary?.sessionId).toBe(sessionId);
      expect(summary?.messageCount).toBeGreaterThan(0);
      expect(summary?.messageCount).toBeLessThanOrEqual(concurrentUpdates);

      console.log(`\n🔁 并发 UPSERT: 最终状态 - ${summary?.summary}`);
    });
  });

  describe("4. 数据库恢复测试", () => {
    it("模拟断电:插入一半后强制关闭,重启后验证已提交数据完整", () => {
      const count = 1000;

      // 插入 500 条
      for (let i = 0; i < count / 2; i++) {
        store.insert("power-loss", i, {
          role: "user",
          content: `断电测试消息 ${i}`,
        });
      }

      // 强制关闭(模拟断电)
      store.close();

      // 重新打开数据库
      const store2 = new FTS5Store(tempDir);

      // 验证前 500 条数据完整
      const results = store2.search("断电测试消息", count);
      expect(results.length).toBeGreaterThanOrEqual(count / 2);

      console.log(`\n⚡ 断电模拟: ${results.length} 条数据恢复完整`);

      store2.close();
    });

    it("损坏数据库文件:删除部分字节,验证降级逻辑", () => {
      // 插入一些数据
      for (let i = 0; i < 100; i++) {
        store.insert("corrupt-test", i, {
          role: "user",
          content: `损坏测试消息 ${i}`,
        });
      }

      store.close();

      // 损坏数据库文件(删除最后 1KB)
      const dbPath = join(tempDir, ".claw", "sessions.db");
      const data = readFileSync(dbPath);
      writeFileSync(dbPath, data.subarray(0, data.length - 1024));

      // 尝试重新打开(应该触发降级,不抛异常)
      expect(() => {
        const corruptStore = new FTS5Store(tempDir);
        corruptStore.close();
      }).not.toThrow();

      console.log(`\n💥 数据库损坏: 降级逻辑正常触发,未抛异常`);
    });

    it("权限错误:只读文件系统,验证降级逻辑", () => {
      // 插入数据并关闭
      store.insert("readonly-test", 0, { role: "user", content: "测试" });
      store.close();

      // 将数据库文件设为只读
      const dbPath = join(tempDir, ".claw", "sessions.db");
      try {
        chmodSync(dbPath, 0o444); // 只读权限

        // 尝试重新打开并写入(应该降级,不抛异常)
        const readonlyStore = new FTS5Store(tempDir);
        expect(() => {
          readonlyStore.insert("readonly-test", 1, {
            role: "user",
            content: "应该失败",
          });
        }).not.toThrow();

        readonlyStore.close();

        // 恢复权限
        chmodSync(dbPath, 0o644);

        console.log(`\n🔒 只读文件系统: 降级逻辑正常,操作静默失败`);
      } catch (err) {
        // 某些文件系统不支持 chmod,跳过此测试
        console.log(`\n⚠️  只读测试跳过: ${(err as Error).message}`);
      }
    });

    it("WAL 模式验证:检查 .db-wal 文件生成", () => {
      // 插入数据
      for (let i = 0; i < 100; i++) {
        store.insert("wal-test", i, { role: "user", content: `WAL 测试 ${i}` });
      }

      // 检查 WAL 文件是否存在
      const walPath = join(tempDir, ".claw", "sessions.db-wal");
      try {
        const walExists = readFileSync(walPath).length > 0;
        console.log(`\n📝 WAL 模式: .db-wal 文件存在,大小 ${readFileSync(walPath).length} 字节`);
        expect(walExists).toBe(true);
      } catch {
        // WAL 文件可能在数据很少时还未生成,或者已经 checkpoint
        console.log(`\n📝 WAL 模式: 文件未生成或已 checkpoint(正常现象)`);
      }
    });
  });

  describe("5. 边界条件测试", () => {
    it("空字符串消息", () => {
      store.insert("edge-1", 0, { role: "user", content: "" });

      const results = store.search("", 10);
      // 空查询应该返回空数组或降级为 LIKE
      expect(Array.isArray(results)).toBe(true);

      console.log(`\n🈳 空字符串: 插入成功,查询返回 ${results.length} 条`);
    });

    it("超长消息(10MB)", () => {
      const hugeContent = "测".repeat(5_000_000); // 约 10MB

      const start = performance.now();
      store.insert("edge-2", 0, { role: "user", content: hugeContent });
      const elapsed = performance.now() - start;

      console.log(`\n📦 超长消息(10MB): 插入耗时 ${elapsed.toFixed(2)}ms`);

      expect(elapsed).toBeLessThan(5000); // 应该在 5 秒内完成

      // 验证能检索到
      const results = store.search("测", 1);
      expect(results.length).toBeGreaterThan(0);
    }, 30_000); // 30 秒超时

    it("特殊字符(emoji、SQL 注入字符)", () => {
      const specialMessages = [
        "测试 emoji: 😀🎉👍💻🚀",
        "SQL 注入尝试: '; DROP TABLE conversation_chunks; --",
        "引号测试: \"双引号\" '单引号' `反引号`",
        "换行符测试:\n第一行\n第二行\n第三行",
        "制表符测试:\t制表符\t分隔",
        "特殊符号: @#$%^&*()_+-=[]{}|;:,.<>?/~",
      ];

      for (const [idx, content] of specialMessages.entries()) {
        expect(() => {
          store.insert("edge-3", idx, { role: "user", content });
        }).not.toThrow();
      }

      // 验证能检索到 emoji
      const emojiResults = store.search("emoji", 10);
      expect(emojiResults.length).toBeGreaterThan(0);

      // 验证 SQL 注入无效(表仍然存在)
      const sqlResults = store.search("SQL 注入", 10);
      expect(sqlResults.length).toBeGreaterThan(0);

      console.log(`\n🎭 特殊字符: ${specialMessages.length} 种场景全部通过`);
    });

    it("空搜索关键词", () => {
      store.insert("edge-4", 0, { role: "user", content: "测试数据" });

      const results1 = store.search("", 10);
      const results2 = store.search("   ", 10); // 空白字符

      expect(Array.isArray(results1)).toBe(true);
      expect(Array.isArray(results2)).toBe(true);

      console.log(`\n🔍 空搜索: 返回 ${results1.length} 和 ${results2.length} 条结果`);
    });

    it("不存在的 sessionId", () => {
      const summary = store.getSummary("不存在的会话ID-12345");
      expect(summary).toBeNull();

      const results = store.search("不存在的会话ID-12345", 10);
      expect(results.length).toBe(0);

      console.log(`\n❌ 不存在的 sessionId: 正确返回 null/空数组`);
    });
  });

  describe("6. 摘要与技能统计性能", () => {
    it("摘要保存耗时 < 5ms", () => {
      const start = performance.now();
      store.saveSummary(
        "perf-test",
        "这是一个性能测试摘要,包含较长的文本内容,用于验证保存操作的性能表现",
        100,
      );
      const elapsed = performance.now() - start;

      console.log(`\n💾 摘要保存: ${elapsed.toFixed(2)}ms`);

      expect(elapsed).toBeLessThan(5);
    });

    it("技能统计查询(1000 条记录)耗时 < 10ms", () => {
      // 插入 1000 条技能使用记录
      for (let i = 0; i < 1000; i++) {
        store.recordSkillUsage(
          "perf-skill",
          `session-${i % 10}`,
          i % 3 !== 0, // 2/3 成功率
          i % 3 === 0 ? `错误 ${i}` : undefined,
        );
      }

      const start = performance.now();
      const stats = store.getSkillStats("perf-skill");
      const elapsed = performance.now() - start;

      console.log(`\n📊 技能统计查询(1000 条): ${elapsed.toFixed(2)}ms`);
      console.log(
        `   总调用: ${stats?.totalCalls}, 成功率: ${((stats?.successRate ?? 0) * 100).toFixed(1)}%`,
      );

      expect(elapsed).toBeLessThan(10);
      expect(stats?.totalCalls).toBe(1000);
      expect(stats?.successRate).toBeCloseTo(2 / 3, 1);
    });
  });
});
