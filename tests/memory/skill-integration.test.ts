// SkillRegistry 集成测试
// 对应课程第 23 讲：自我改进 AI 系统的全面验证
//
// 测试范围：
// 1. 技能生命周期（创建、执行、持久化、恢复）
// 2. 搜索与排序逻辑
// 3. 失败模式去重
// 4. 并发安全性
// 5. 边界条件处理
// 6. 真实场景模拟

import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { SkillRegistry } from "../../src/memory/skill-registry.js";
import { logger } from "../../src/observability/logger.js";
import { resolvePicoPaths } from "../../src/paths/pico-paths.js";

function skillStateDirectory(workDir: string): string {
  return join(resolvePicoPaths(workDir).workspace.memory, "skills");
}

describe("SkillRegistry 集成测试", () => {
  let testDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    // 为每个测试创建独立临时目录
    testDir = mkdtempSync(join(tmpdir(), "pico-skill-test-"));
    registry = new SkillRegistry(testDir);
    await registry.init();
  });

  afterEach(() => {
    // 清理临时文件
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      // 忽略清理失败（Windows 文件锁问题）
    }
  });

  // ========================================
  // 1. 技能生命周期测试
  // ========================================

  describe("技能生命周期", () => {
    test("创建技能 → 执行成功 → 统计更新 → 持久化 → 重启恢复", async () => {
      // 1. 创建技能
      const skill = await registry.add(
        "测试技能",
        "测试触发词",
        "执行步骤 1\n执行步骤 2",
        "manual",
      );

      expect(skill.id).toMatch(/^skill_[a-f0-9]{12}$/);
      expect(skill.name).toBe("测试技能");
      expect(skill.stats.successCount).toBe(0);

      // 2. 执行成功 3 次
      await registry.recordExecution(skill.id, true, 1000);
      await registry.recordExecution(skill.id, true, 1200);
      await registry.recordExecution(skill.id, true, 1400);

      // 3. 验证统计更新
      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.stats.successCount).toBe(3);
      expect(updated?.stats.failCount).toBe(0);
      expect(updated?.stats.avgExecutionTime).toBeCloseTo(1200); // (1000+1200+1400)/3
      expect(updated?.stats.lastUsed).not.toBeNull();

      // 4. 验证持久化（文件存在）
      const skillFile = join(skillStateDirectory(testDir), `${skill.id}.json`);
      const content = await readFile(skillFile, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.stats.successCount).toBe(3);

      // 5. 模拟重启：创建新实例加载数据
      const registry2 = new SkillRegistry(testDir);
      await registry2.init();
      const recovered = registry2.getAll().find((s) => s.id === skill.id);
      expect(recovered?.stats.successCount).toBe(3);
      expect(recovered?.stats.avgExecutionTime).toBeCloseTo(1200);
    });

    test("技能连续失败 3 次触发预警", async () => {
      // spy on logger.warn
      const warnSpy = vi.spyOn(logger, "warn");

      const skill = await registry.add("易失败技能", "失败触发", "可能失败的步骤", "auto");

      // 失败 1 次：不触发
      await registry.recordExecution(skill.id, false, 500, "Error: API timeout");
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          occurrences: 3,
        }),
        expect.any(String),
      );

      // 失败 2 次：不触发
      await registry.recordExecution(skill.id, false, 500, "Error: API timeout again");
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.objectContaining({
          occurrences: 3,
        }),
        expect.any(String),
      );

      // 失败 3 次：触发预警
      await registry.recordExecution(skill.id, false, 500, "Error: API timeout third time");

      // 验证 logger.warn 被调用，且包含正确的 occurrences
      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          occurrences: 3,
        }),
        expect.stringContaining("技能重复失败 3 次"),
      );

      warnSpy.mockRestore();
    });

    test("新技能创建时记录初始版本", async () => {
      const skill = await registry.add("可改进技能", "改进触发", "旧版本指令", "manual");

      expect(skill.versions).toHaveLength(1);
      expect(skill.versions[0].version).toBe(1);
      expect(skill.versions[0].reason).toBe("初始版本");
    });
  });

  // ========================================
  // 2. 搜索与排序测试
  // ========================================

  describe("搜索与排序", () => {
    test("添加 10 个技能，搜索关键词返回相关技能", async () => {
      // 创建 10 个技能（包含不同关键词）
      await registry.add("HTTP 请求", "发送请求", "instructions", "auto");
      await registry.add("数据库查询", "查询数据", "instructions", "auto");
      await registry.add("HTTP 重试", "重试逻辑", "instructions", "auto");
      await registry.add("文件读取", "读取文件", "instructions", "auto");
      await registry.add("HTTP 缓存", "缓存策略", "instructions", "auto");
      await registry.add("Git 提交", "提交代码", "instructions", "auto");
      await registry.add("日志记录", "记录日志", "instructions", "auto");
      await registry.add("邮件发送", "发送邮件", "instructions", "auto");
      await registry.add("HTTP 代理", "代理设置", "instructions", "auto");
      await registry.add("测试运行", "运行测试", "instructions", "auto");

      // 搜索 "HTTP" 应返回 4 个结果
      const results = registry.search("HTTP");
      expect(results).toHaveLength(4);
      expect(results.every((s) => s.name.includes("HTTP"))).toBe(true);
    });

    test("相同成功率时按使用次数排序", async () => {
      const skill1 = await registry.add("技能 A", "trigger A", "inst", "auto");
      const skill2 = await registry.add("技能 B", "trigger B", "inst", "auto");
      const skill3 = await registry.add("技能 C", "trigger C", "inst", "auto");

      // 技能 A：3 次成功，成功率 100%
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);

      // 技能 B：5 次成功，成功率 100%
      await registry.recordExecution(skill2.id, true, 100);
      await registry.recordExecution(skill2.id, true, 100);
      await registry.recordExecution(skill2.id, true, 100);
      await registry.recordExecution(skill2.id, true, 100);
      await registry.recordExecution(skill2.id, true, 100);

      // 技能 C：1 次成功，成功率 100%
      await registry.recordExecution(skill3.id, true, 100);

      // 搜索所有技能（空关键词）
      const results = registry.search("");

      // 相同成功率（100%）时，按使用次数排序：B(5) > A(3) > C(1)
      expect(results[0].id).toBe(skill2.id);
      expect(results[1].id).toBe(skill1.id);
      expect(results[2].id).toBe(skill3.id);
    });

    test("0 成功 0 失败的新技能排在中间位置", async () => {
      const skill1 = await registry.add("高成功率", "high", "inst", "auto");
      const skill2 = await registry.add("新技能", "new", "inst", "auto");
      const skill3 = await registry.add("低成功率", "low", "inst", "auto");

      // 技能 1：成功率 100%
      await registry.recordExecution(skill1.id, true, 100);

      // 技能 2：未使用（成功率 0.5）

      // 技能 3：成功率 0%
      await registry.recordExecution(skill3.id, false, 100);

      const results = registry.search("");

      // 排序：skill1(1.0) > skill2(0.5) > skill3(0.0)
      expect(results[0].id).toBe(skill1.id);
      expect(results[1].id).toBe(skill2.id);
      expect(results[2].id).toBe(skill3.id);
    });

    test("大小写不敏感搜索", async () => {
      await registry.add("HTTP Request", "Send HTTP", "inst", "auto");

      const results1 = registry.search("http");
      const results2 = registry.search("HTTP");
      const results3 = registry.search("HtTp");

      expect(results1).toHaveLength(1);
      expect(results2).toHaveLength(1);
      expect(results3).toHaveLength(1);
    });

    test("空关键词返回所有技能", async () => {
      await registry.add("技能 1", "trigger 1", "inst", "auto");
      await registry.add("技能 2", "trigger 2", "inst", "auto");
      await registry.add("技能 3", "trigger 3", "inst", "auto");

      const results = registry.search("");
      expect(results).toHaveLength(3);
    });
  });

  // ========================================
  // 3. 失败模式去重测试
  // ========================================

  describe("失败模式去重", () => {
    test("相同错误多次出现只记录一次（occurrences 递增）", async () => {
      const skill = await registry.add("重复失败", "trigger", "inst", "auto");

      // 第 1 次失败
      await registry.recordExecution(skill.id, false, 100, "Error: ENOENT: no such file");

      let updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.knownFailures).toHaveLength(1);
      expect(updated?.knownFailures[0].occurrences).toBe(1);

      // 第 2 次相同错误
      await registry.recordExecution(skill.id, false, 100, "Error: ENOENT: no such file");

      updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.knownFailures).toHaveLength(1); // 仍然只有 1 个
      expect(updated?.knownFailures[0].occurrences).toBe(2); // 计数递增
    });

    test("不同错误分别记录", async () => {
      const skill = await registry.add("多种错误", "trigger", "inst", "auto");

      await registry.recordExecution(skill.id, false, 100, "Error: API timeout");
      await registry.recordExecution(skill.id, false, 100, "Error: Database connection failed");

      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.knownFailures).toHaveLength(2);
    });

    test("子串匹配去重", async () => {
      const skill = await registry.add("子串匹配", "trigger", "inst", "auto");

      // 第 1 次：短错误
      await registry.recordExecution(skill.id, false, 100, "Error: ENOENT");

      // 第 2 次：长错误（包含第 1 次的子串）
      await registry.recordExecution(
        skill.id,
        false,
        100,
        "Error: ENOENT: no such file or directory '/path/to/file.txt'",
      );

      const updated = registry.getAll().find((s) => s.id === skill.id);
      // 应该匹配为同一个错误（子串匹配）
      expect(updated?.knownFailures).toHaveLength(1);
      expect(updated?.knownFailures[0].occurrences).toBe(2);
    });

    test("错误消息截断到 200 字符", async () => {
      const skill = await registry.add("长错误", "trigger", "inst", "auto");

      const longError = "Error: " + "x".repeat(300);
      await registry.recordExecution(skill.id, false, 100, longError);

      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.knownFailures[0].errorPattern.length).toBe(200);
    });
  });

  // ========================================
  // 4. 并发执行记录测试
  // ========================================

  describe("并发安全性", () => {
    test("10 个并发 recordExecution 调用（同一技能）", async () => {
      const skill = await registry.add("并发测试", "trigger", "inst", "auto");

      // 并发执行 10 次（5 成功 + 5 失败）
      const promises = [
        ...Array.from({ length: 5 }, () => registry.recordExecution(skill.id, true, 100)),
        ...Array.from({ length: 5 }, () =>
          registry.recordExecution(skill.id, false, 100, "Error: test"),
        ),
      ];

      await Promise.all(promises);

      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.stats.successCount).toBe(5);
      expect(updated?.stats.failCount).toBe(5);
    });

    test("并发记录不同技能（无相互影响）", async () => {
      const skill1 = await registry.add("技能 A", "trigger A", "inst", "auto");
      const skill2 = await registry.add("技能 B", "trigger B", "inst", "auto");
      const skill3 = await registry.add("技能 C", "trigger C", "inst", "auto");

      await Promise.all([
        registry.recordExecution(skill1.id, true, 100),
        registry.recordExecution(skill2.id, true, 100),
        registry.recordExecution(skill3.id, false, 100, "Error"),
      ]);

      const updated1 = registry.getAll().find((s) => s.id === skill1.id);
      const updated2 = registry.getAll().find((s) => s.id === skill2.id);
      const updated3 = registry.getAll().find((s) => s.id === skill3.id);

      expect(updated1?.stats.successCount).toBe(1);
      expect(updated2?.stats.successCount).toBe(1);
      expect(updated3?.stats.failCount).toBe(1);
    });

    test("并发记录 + 并发搜索（无死锁）", async () => {
      const skill = await registry.add("并发搜索", "search", "inst", "auto");

      // 并发执行记录和搜索操作
      const promises = [
        registry.recordExecution(skill.id, true, 100),
        registry.search("search"),
        registry.recordExecution(skill.id, false, 100, "Error"),
        registry.search("search"),
        registry.getAll(),
      ];

      // 不应抛出异常或死锁
      await expect(Promise.all(promises)).resolves.toBeDefined();
    });
  });

  // ========================================
  // 5. 边界条件测试
  // ========================================

  describe("边界条件", () => {
    test("技能名称包含特殊字符", async () => {
      const skill = await registry.add(
        "HTTP/2 推送 (Push:Async)",
        "特殊字符 trigger",
        "instructions",
        "auto",
      );

      expect(skill.name).toBe("HTTP/2 推送 (Push:Async)");

      // 验证文件名安全（ID 不含特殊字符）
      const skillFile = join(skillStateDirectory(testDir), `${skill.id}.json`);
      expect(skillFile).toMatch(/skill_[a-f0-9]{12}\.json$/);
    });

    test("超长 instructions（10KB）", async () => {
      const longInstructions = "步骤 1\n".repeat(2000); // ~14KB
      const skill = await registry.add("超长技能", "trigger", longInstructions, "auto");

      expect(skill.instructions.length).toBeGreaterThanOrEqual(10000);

      // 验证持久化和恢复
      const registry2 = new SkillRegistry(testDir);
      await registry2.init();
      const recovered = registry2.getAll().find((s) => s.id === skill.id);
      expect(recovered?.instructions).toBe(longInstructions);
    });

    test("errorMessage 为空字符串", async () => {
      const skill = await registry.add("空错误", "trigger", "inst", "auto");

      // 空错误消息不应崩溃（但可能不会记录到 knownFailures）
      await expect(registry.recordExecution(skill.id, false, 100, "")).resolves.toBeUndefined();

      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.stats.failCount).toBe(1);
      // 空字符串错误会被记录
      if (updated?.knownFailures.length ?? 0 > 0) {
        expect(updated?.knownFailures[0].errorPattern).toBe("");
      }
    });

    test("executionTime 为 0 或负数", async () => {
      const skill = await registry.add("零耗时", "trigger", "inst", "auto");

      await registry.recordExecution(skill.id, true, 0);
      await registry.recordExecution(skill.id, true, -100); // 异常情况

      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.stats.avgExecutionTime).toBeCloseTo(-50); // (0 + (-100)) / 2
    });

    test("技能文件手动损坏（JSON 解析失败）", async () => {
      const skill = await registry.add("损坏测试", "trigger", "inst", "auto");

      // 手动损坏文件
      const skillFile = join(skillStateDirectory(testDir), `${skill.id}.json`);
      const { writeFile } = await import("node:fs/promises");
      await writeFile(skillFile, "{ invalid json", "utf8");

      // 创建新实例加载（应跳过损坏文件）
      const registry2 = new SkillRegistry(testDir);
      await registry2.init();

      const recovered = registry2.getAll().find((s) => s.id === skill.id);
      expect(recovered).toBeUndefined(); // 损坏文件被跳过
    });

    test("记录不存在的技能执行", async () => {
      const warnSpy = vi.spyOn(logger, "warn");

      await registry.recordExecution("skill_nonexistent", true, 100);

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ skillId: "skill_nonexistent" }),
        expect.stringContaining("技能不存在"),
      );

      warnSpy.mockRestore();
    });
  });

  // ========================================
  // 6. 真实场景模拟
  // ========================================

  describe("真实场景", () => {
    test('场景 1: 学习"添加新工具"技能', async () => {
      const registry = new SkillRegistry(testDir);
      await registry.init();

      // 用户第一次手动添加工具
      const skill = await registry.add(
        "添加新工具",
        "需要添加工具",
        "1. 在 src/tools/ 创建文件\n2. 在 ToolRegistry 注册\n3. 定义 schema",
        "manual",
      );

      // 第 2-5 次使用该技能（全部成功）
      for (let i = 0; i < 4; i++) {
        await registry.recordExecution(skill.id, true, 1200);
      }

      // 第 6 次因为忘记注册而失败
      await registry.recordExecution(
        skill.id,
        false,
        500,
        "Error: Tool not registered in ToolRegistry",
      );

      // 验证统计
      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.stats.successCount).toBe(4);
      expect(updated?.stats.failCount).toBe(1);
      // 增量平均计算：(0*0 + 1200*4 + 500) / 5 = 1060
      expect(updated?.stats.avgExecutionTime).toBeCloseTo(1060);
      expect(updated?.knownFailures).toHaveLength(1);
      expect(updated?.knownFailures[0].errorPattern).toContain("not registered");
    });

    test("场景 2: 同名技能冲突", async () => {
      const registry = new SkillRegistry(testDir);
      await registry.init();

      // 两个不同的"重试"技能
      await registry.add("HTTP 重试", "HTTP 超时", "exponential backoff", "auto");
      await registry.add("数据库重试", "数据库锁", "linear backoff", "auto");

      // 搜索"重试"应返回两个结果
      const results = registry.search("重试");
      expect(results).toHaveLength(2);
      expect(results.some((s) => s.name === "HTTP 重试")).toBe(true);
      expect(results.some((s) => s.name === "数据库重试")).toBe(true);
    });

    test("场景 3: 技能从失败到成功的改进过程", async () => {
      const skill = await registry.add(
        "API 调用",
        "调用外部 API",
        "直接发送请求（无重试）",
        "auto",
      );

      // 初期连续失败 3 次（触发预警）
      const warnSpy = vi.spyOn(logger, "warn");

      await registry.recordExecution(skill.id, false, 200, "Error: Timeout");
      await registry.recordExecution(skill.id, false, 200, "Error: Timeout");
      await registry.recordExecution(skill.id, false, 200, "Error: Timeout");

      expect(warnSpy).toHaveBeenCalledWith(
        expect.objectContaining({ occurrences: 3 }),
        expect.any(String),
      );

      // 人工改进后（添加重试逻辑），后续成功
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution(skill.id, true, 300);
      }

      const updated = registry.getAll().find((s) => s.id === skill.id);
      expect(updated?.stats.successCount).toBe(5);
      expect(updated?.stats.failCount).toBe(3);
      expect(
        updated?.stats.successCount / (updated?.stats.successCount + updated?.stats.failCount),
      ).toBeCloseTo(0.625);

      warnSpy.mockRestore();
    });
  });

  // ========================================
  // 7. API 完整性测试
  // ========================================

  describe("API 完整性", () => {
    test("getTopSkills 返回使用频次最高的技能", async () => {
      const skill1 = await registry.add("低频技能", "trigger 1", "inst", "auto");
      const skill2 = await registry.add("高频技能", "trigger 2", "inst", "auto");
      const skill3 = await registry.add("中频技能", "trigger 3", "inst", "auto");

      // skill1: 1 次
      await registry.recordExecution(skill1.id, true, 100);

      // skill2: 10 次
      for (let i = 0; i < 10; i++) {
        await registry.recordExecution(skill2.id, true, 100);
      }

      // skill3: 5 次
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution(skill3.id, true, 100);
      }

      const top2 = registry.getTopSkills(2);
      expect(top2).toHaveLength(2);
      expect(top2[0].id).toBe(skill2.id); // 10 次
      expect(top2[1].id).toBe(skill3.id); // 5 次
    });

    test("getAll 返回所有技能（不排序）", async () => {
      await registry.add("技能 A", "trigger A", "inst", "auto");
      await registry.add("技能 B", "trigger B", "inst", "auto");
      await registry.add("技能 C", "trigger C", "inst", "auto");

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      // 不验证顺序（因为不保证）
    });

    test("重复 init 调用是幂等的", async () => {
      const registry = new SkillRegistry(testDir);

      await registry.init();
      await registry.init();
      await registry.init();

      // 不应抛出异常
      expect(registry.getAll()).toHaveLength(0);
    });
  });

  // ========================================
  // 8. 持久化边界测试
  // ========================================

  describe("持久化边界", () => {
    test("目录不存在时自动创建", async () => {
      const nonExistentDir = join(testDir, "deep", "nested", "path");
      const registry = new SkillRegistry(nonExistentDir);

      await registry.init();
      await registry.add("测试", "trigger", "inst", "auto");

      // 验证目录被创建
      const files = await readdir(skillStateDirectory(nonExistentDir));
      expect(files.length).toBeGreaterThan(0);
    });

    test("持久化失败不阻断主流程", async () => {
      const skill = await registry.add("持久化测试", "trigger", "inst", "auto");

      // 模拟持久化失败（无法验证，因为 save 是 private）
      // 这里只验证即使有文件系统错误，API 不抛异常
      await expect(registry.recordExecution(skill.id, true, 100)).resolves.toBeUndefined();
    });
  });
});
