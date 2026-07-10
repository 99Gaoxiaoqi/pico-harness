// SkillRegistry 单元测试：技能记忆层的 CRUD、统计追踪、失败分析。
//
// 用 mkdtemp 隔离每个用例的工作区，避免相互污染。
// 对应课程第 23 讲：自我改进 AI 系统的技能学习与持久化层。

import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "pathe";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SkillRegistry } from "../../src/memory/skill-registry.js";
import { calculateSuccessRate } from "../../src/memory/skill-schema.js";
import type { LearnedSkill } from "../../src/memory/skill-schema.js";

describe("SkillRegistry", () => {
  let workDir: string;
  let registry: SkillRegistry;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "pico-skill-"));
    registry = new SkillRegistry(workDir);
    await registry.init();
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  describe("初始化", () => {
    it("创建 .claw/skills 目录", async () => {
      const skillsDir = join(workDir, ".claw", "skills");
      // 验证目录存在（通过 readdir 验证）
      await expect(readdir(skillsDir)).resolves.toBeDefined();
    });

    it("多次调用 init() 是幂等的", async () => {
      await registry.init();
      await registry.init();
      expect(registry.getAll()).toEqual([]);
    });

    it("空目录时返回空技能列表", async () => {
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe("添加技能", () => {
    it("添加新技能并自动生成 ID", async () => {
      const skill = await registry.add(
        "部署到生产环境",
        "deploy production",
        "# 步骤\n1. 运行测试\n2. 构建镜像\n3. 推送到 ECR",
        "manual",
      );

      expect(skill.id).toMatch(/^skill_[a-f0-9]{12}$/);
      expect(skill.name).toBe("部署到生产环境");
      expect(skill.trigger).toBe("deploy production");
      expect(skill.source).toBe("manual");
      expect(skill.stats.successCount).toBe(0);
      expect(skill.stats.failCount).toBe(0);
      expect(skill.versions).toHaveLength(1);
      expect(skill.versions[0].version).toBe(1);
      expect(skill.versions[0].reason).toBe("初始版本");
    });

    it("添加的技能自动持久化到磁盘", async () => {
      const skill = await registry.add("测试技能", "test", "执行测试", "auto");

      const filePath = join(workDir, ".claw", "skills", `${skill.id}.json`);
      const content = await readFile(filePath, "utf8");
      const loaded = JSON.parse(content) as LearnedSkill;

      expect(loaded!.name).toBe("测试技能");
      expect(loaded!.instructions).toBe("执行测试");
    });

    it("持久化的 JSON 带有缩进（便于人工查看）", async () => {
      const skill = await registry.add("格式化测试", "format", "指令", "manual");
      const filePath = join(workDir, ".claw", "skills", `${skill.id}.json`);
      const content = await readFile(filePath, "utf8");

      // 验证包含缩进（非压缩格式）
      expect(content).toContain("\n  ");
      expect(content).toContain('"name": "格式化测试"');
    });
  });

  describe("搜索技能", () => {
    beforeEach(async () => {
      await registry.add("部署应用", "deploy app", "部署指令", "manual");
      await registry.add("运行测试", "run test", "测试指令", "auto");
      await registry.add("部署数据库", "deploy database", "数据库部署", "manual");
    });

    it("按 name 关键词搜索（不区分大小写）", async () => {
      const results = registry.search("部署");
      expect(results).toHaveLength(2);
      expect(results.map((s) => s.name)).toEqual(
        expect.arrayContaining(["部署应用", "部署数据库"]),
      );
    });

    it("按 trigger 关键词搜索", async () => {
      const results = registry.search("test");
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("运行测试");
    });

    it("搜索不区分大小写", async () => {
      const results = registry.search("DEPLOY");
      expect(results.length).toBeGreaterThanOrEqual(2);
    });

    it("未匹配时返回空数组", async () => {
      const results = registry.search("不存在的关键词");
      expect(results).toEqual([]);
    });

    it("按成功率降序排序", async () => {
      const skill1 = await registry.add("高成功率", "high", "指令", "auto");
      const skill2 = await registry.add("低成功率", "low", "指令", "auto");

      // skill1: 8 成功 2 失败 (成功率 80%)
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, false, 100);
      await registry.recordExecution(skill1.id, false, 100);

      // skill2: 2 成功 8 失败 (成功率 20%)
      await registry.recordExecution(skill2.id, true, 100);
      await registry.recordExecution(skill2.id, true, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);
      await registry.recordExecution(skill2.id, false, 100);

      const results = registry.search("成功率");
      expect(results[0].name).toBe("高成功率");
      expect(results[1].name).toBe("低成功率");
    });

    it("成功率相同时按使用次数降序排序", async () => {
      const skill1 = await registry.add("频繁使用", "frequent", "指令", "auto");
      const skill2 = await registry.add("偶尔使用", "rare", "指令", "auto");

      // 两个技能成功率都是 100%，但使用次数不同
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);
      await registry.recordExecution(skill1.id, true, 100);

      await registry.recordExecution(skill2.id, true, 100);

      const results = registry.search("使用");
      expect(results[0].name).toBe("频繁使用");
      expect(results[1].name).toBe("偶尔使用");
    });
  });

  describe("获取所有技能", () => {
    it("返回所有已添加的技能", async () => {
      await registry.add("技能1", "t1", "指令1", "manual");
      await registry.add("技能2", "t2", "指令2", "auto");
      await registry.add("技能3", "t3", "指令3", "manual");

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((s) => s.name)).toEqual(expect.arrayContaining(["技能1", "技能2", "技能3"]));
    });
  });

  describe("获取 Top N 技能", () => {
    it("按使用频次降序返回前 N 个技能", async () => {
      const skill1 = await registry.add("最常用", "most", "指令", "auto");
      const skill2 = await registry.add("次常用", "second", "指令", "auto");
      const skill3 = await registry.add("偶尔用", "rare", "指令", "auto");

      // 使用次数: skill1=5, skill2=3, skill3=1
      for (let i = 0; i < 5; i++) {
        await registry.recordExecution(skill1.id, true, 100);
      }
      for (let i = 0; i < 3; i++) {
        await registry.recordExecution(skill2.id, true, 100);
      }
      await registry.recordExecution(skill3.id, true, 100);

      const top2 = registry.getTopSkills(2);
      expect(top2).toHaveLength(2);
      expect(top2[0].name).toBe("最常用");
      expect(top2[1].name).toBe("次常用");
    });

    it("技能数量少于 N 时返回全部", async () => {
      await registry.add("唯一技能", "only", "指令", "auto");
      const top5 = registry.getTopSkills(5);
      expect(top5).toHaveLength(1);
    });
  });

  describe("记录执行结果", () => {
    let skillId: string;

    beforeEach(async () => {
      const skill = await registry.add("测试技能", "test", "指令", "auto");
      skillId = skill.id;
    });

    it("记录成功执行增加 successCount", async () => {
      await registry.recordExecution(skillId, true, 100);
      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.stats.successCount).toBe(1);
      expect(skill.stats.failCount).toBe(0);
    });

    it("记录失败执行增加 failCount", async () => {
      await registry.recordExecution(skillId, false, 100, "错误信息");
      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.stats.successCount).toBe(0);
      expect(skill.stats.failCount).toBe(1);
    });

    it("更新最后使用时间", async () => {
      const before = new Date().toISOString();
      await registry.recordExecution(skillId, true, 100);
      const skill = registry.getAll().find((s) => s.id === skillId)!;

      expect(skill.stats.lastUsed).not.toBeNull();
      expect(skill.stats.lastUsed!).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(new Date(skill.stats.lastUsed!).getTime()).toBeGreaterThanOrEqual(
        new Date(before).getTime(),
      );
    });

    it("计算平均执行时间", async () => {
      await registry.recordExecution(skillId, true, 100);
      await registry.recordExecution(skillId, true, 200);
      await registry.recordExecution(skillId, true, 300);

      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.stats.avgExecutionTime).toBe(200); // (100 + 200 + 300) / 3
    });

    it("不存在的技能 ID 不抛出异常", async () => {
      await expect(registry.recordExecution("不存在的ID", true, 100)).resolves.toBeUndefined();
    });
  });

  describe("失败模式分析", () => {
    let skillId: string;

    beforeEach(async () => {
      const skill = await registry.add("测试技能", "test", "指令", "auto");
      skillId = skill.id;
    });

    it("记录新失败模式", async () => {
      await registry.recordExecution(skillId, false, 100, "连接超时: ETIMEDOUT");

      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.knownFailures).toHaveLength(1);
      expect(skill.knownFailures[0].errorPattern).toContain("连接超时");
      expect(skill.knownFailures[0].occurrences).toBe(1);
    });

    it("相同错误累积计数（去重）", async () => {
      await registry.recordExecution(skillId, false, 100, "连接超时: ETIMEDOUT");
      await registry.recordExecution(skillId, false, 100, "连接超时: ETIMEDOUT on port 443");

      const skill = registry.getAll().find((s) => s.id === skillId)!;
      // 应该去重为同一个失败模式
      expect(skill.knownFailures).toHaveLength(1);
      expect(skill.knownFailures[0].occurrences).toBe(2);
    });

    it("不同错误分别记录", async () => {
      await registry.recordExecution(skillId, false, 100, "连接超时");
      await registry.recordExecution(skillId, false, 100, "认证失败");

      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.knownFailures).toHaveLength(2);
    });

    it("错误模式截取前 200 字符", async () => {
      const longError = "E".repeat(300);
      await registry.recordExecution(skillId, false, 100, longError);

      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.knownFailures[0].errorPattern.length).toBe(200);
    });

    it("成功执行不记录失败模式", async () => {
      await registry.recordExecution(skillId, true, 100);
      const skill = registry.getAll().find((s) => s.id === skillId)!;
      expect(skill.knownFailures).toHaveLength(0);
    });
  });

  describe("失败预警（3 次阈值）", () => {
    it("连续失败 3 次相同错误时触发预警（通过日志）", async () => {
      const skill = await registry.add("预警测试", "warn", "指令", "auto");

      // 连续失败 3 次相同错误
      await registry.recordExecution(skill.id, false, 100, "API 限流");
      await registry.recordExecution(skill.id, false, 100, "API 限流");
      await registry.recordExecution(skill.id, false, 100, "API 限流");

      const loaded = registry.getAll().find((s) => s.id === skill.id)!;
      expect(loaded!.knownFailures[0].occurrences).toBe(3);
      // 注：日志预警由 logger.warn 触发，单元测试无法直接验证日志输出
      // 在集成测试中可通过 mock logger 验证
    });
  });

  describe("持久化与重启加载", () => {
    it("重启后能从磁盘加载已有技能", async () => {
      const skill = await registry.add("持久化测试", "persist", "指令", "manual");
      await registry.recordExecution(skill.id, true, 150);

      // 模拟重启：创建新的 registry 实例
      const registry2 = new SkillRegistry(workDir);
      await registry2.init();

      const loaded = registry2.getAll().find((s) => s.id === skill.id)!;
      expect(loaded).toBeDefined();
      expect(loaded!.name).toBe("持久化测试");
      expect(loaded!.stats.successCount).toBe(1);
      expect(loaded!.stats.avgExecutionTime).toBe(150);
    });

    it("加载后的缓存与磁盘一致", async () => {
      const skill = await registry.add("缓存测试", "cache", "指令", "auto");

      const registry2 = new SkillRegistry(workDir);
      await registry2.init();

      expect(registry2.getAll()).toHaveLength(1);
      expect(registry2.getAll()[0].id).toBe(skill.id);
    });
  });

  describe("calculateSuccessRate 工具函数", () => {
    it("无执行记录时返回 0.5（中性值）", async () => {
      const skill = await registry.add("未使用", "unused", "指令", "auto");
      expect(calculateSuccessRate(skill)).toBe(0.5);
    });

    it("全成功返回 1.0", async () => {
      const skill = await registry.add("全成功", "success", "指令", "auto");
      await registry.recordExecution(skill.id, true, 100);
      await registry.recordExecution(skill.id, true, 100);
      const loaded = registry.getAll().find((s) => s.id === skill.id)!;
      expect(calculateSuccessRate(loaded)).toBe(1.0);
    });

    it("全失败返回 0.0", async () => {
      const skill = await registry.add("全失败", "fail", "指令", "auto");
      await registry.recordExecution(skill.id, false, 100, "错误");
      await registry.recordExecution(skill.id, false, 100, "错误");
      const loaded = registry.getAll().find((s) => s.id === skill.id)!;
      expect(calculateSuccessRate(loaded)).toBe(0.0);
    });

    it("混合成功失败返回正确比率", async () => {
      const skill = await registry.add("混合", "mixed", "指令", "auto");
      await registry.recordExecution(skill.id, true, 100);
      await registry.recordExecution(skill.id, false, 100, "错误");
      const loaded = registry.getAll().find((s) => s.id === skill.id)!;
      expect(calculateSuccessRate(loaded)).toBe(0.5); // 1 / 2
    });
  });

  describe("并发安全", () => {
    it("并发记录执行不丢失统计数据", async () => {
      const skill = await registry.add("并发测试", "concurrent", "指令", "auto");

      // 并发记录 10 次成功
      await Promise.all(
        Array.from({ length: 10 }, () => registry.recordExecution(skill.id, true, 100)),
      );

      const loaded = registry.getAll().find((s) => s.id === skill.id)!;
      expect(loaded!.stats.successCount).toBe(10);
    });
  });
});
