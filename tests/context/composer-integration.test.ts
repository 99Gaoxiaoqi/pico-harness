// PromptComposer 集成测试
// 端到端验证技能记忆与 Session 的协同工作

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PromptComposer } from "../../src/context/composer.js";
import { MockSkillRegistry } from "../mocks/skill-registry.mock.js";
import { MockMemoryNudger } from "../mocks/memory-nudger.mock.js";
import { createLearnedSkill } from "../../src/memory/skill-schema.js";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PromptComposer 集成测试", () => {
  let workDir: string;
  let mockRegistry: MockSkillRegistry;
  let mockNudger: MockMemoryNudger;

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "pico-integration-"));
    mockRegistry = new MockSkillRegistry();
    mockNudger = new MockMemoryNudger();
  });

  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });

  it("✅ 端到端场景：添加技能 + 记录执行 + 生成 Prompt", async () => {
    // 1. 添加 3 个技能
    const skill1 = createLearnedSkill(
      "数据库查询优化",
      "慢查询、索引",
      "1. EXPLAIN 分析\n2. 添加索引\n3. 验证性能",
      "auto",
    );
    skill1.stats.successCount = 10;
    skill1.stats.failCount = 1;

    const skill2 = createLearnedSkill(
      "API 重试机制",
      "超时、网络错误",
      "1. 指数退避\n2. 最大重试 3 次\n3. 记录日志",
      "auto",
    );
    skill2.stats.successCount = 15;
    skill2.stats.failCount = 0;

    const skill3 = createLearnedSkill(
      "错误日志分析",
      "日志、错误追踪",
      "1. 提取堆栈\n2. 定位根因\n3. 修复验证",
      "manual",
    );
    skill3.stats.successCount = 5;
    skill3.stats.failCount = 5;

    mockRegistry.addSkill(skill1);
    mockRegistry.addSkill(skill2);
    mockRegistry.addSkill(skill3);

    // 2. 创建 Composer
    const composer = new PromptComposer(workDir, false, {
      sessionId: "integration-session",
      skillRegistry: mockRegistry,
      memoryNudger: mockNudger,
    });

    // 3. 生成 Prompt
    const prompt = await composer.build();

    // 4. 验证包含技能统计
    expect(prompt).toContain("# 已掌握的技能");
    expect(prompt).toContain("API 重试机制"); // 成功率 100%，应排第一
    expect(prompt).toContain("数据库查询优化"); // 成功率 91%
    expect(prompt).toContain("错误日志分析"); // 成功率 50%

    // 验证成功率显示
    expect(prompt).toContain("成功率 100%");
    expect(prompt).toContain("成功率 91%");
    expect(prompt).toContain("成功率 50%");
  });

  it("✅ turnCount=10 时包含 Nudge", async () => {
    // 设置第 10 轮的 Nudge
    mockNudger.setNudge(
      10,
      "# ⏰ 阶段性提示\n\n已完成 10 轮对话，建议回顾任务目标。",
    );

    const skill = createLearnedSkill("测试技能", "测试", "步骤", "auto");
    skill.stats.successCount = 3;
    mockRegistry.addSkill(skill);

    const composer = new PromptComposer(workDir, false, {
      sessionId: "nudge-session",
      skillRegistry: mockRegistry,
      memoryNudger: mockNudger,
    });

    const prompt = await composer.build(10);

    expect(prompt).toContain("# ⏰ 阶段性提示");
    expect(prompt).toContain("已完成 10 轮对话");
  });

  it("✅ 与 AGENTS.md 协同工作", async () => {
    // 创建 AGENTS.md
    writeFileSync(
      join(workDir, "AGENTS.md"),
      "# 项目规范\n\n- 使用 TypeScript strict 模式\n- 遵循 ESLint 规则",
    );

    const skill = createLearnedSkill("代码规范检查", "lint", "运行 ESLint", "auto");
    skill.stats.successCount = 8;
    mockRegistry.addSkill(skill);

    const composer = new PromptComposer(workDir, false, {
      sessionId: "agents-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    // 验证同时包含 AGENTS.md 和技能记忆
    expect(prompt).toContain("# 项目专属指南");
    expect(prompt).toContain("TypeScript strict 模式");
    expect(prompt).toContain("# 已掌握的技能");
    expect(prompt).toContain("代码规范检查");
  });

  it("✅ 与 Plan Mode 协同工作", async () => {
    const skill = createLearnedSkill("任务拆解", "复杂任务", "1. 分析\n2. 拆解", "auto");
    skill.stats.successCount = 5;
    mockRegistry.addSkill(skill);

    // 启用 Plan Mode
    const composer = new PromptComposer(workDir, true, {
      sessionId: "plan-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    // 验证包含 Plan Mode 规范和技能记忆
    expect(prompt).toContain("Plan Mode");
    expect(prompt).toContain("PLAN.md");
    expect(prompt).toContain("# 已掌握的技能");
    expect(prompt).toContain("任务拆解");
  });

  it("✅ 技能失败模式展示", async () => {
    const skill = createLearnedSkill(
      "Git 操作",
      "git push",
      "1. 检查远程\n2. 推送\n3. 验证",
      "auto",
    );
    skill.stats.successCount = 20;
    skill.stats.failCount = 3;
    skill.knownFailures = [
      {
        errorPattern: "fatal: Could not read from remote repository",
        solution: "检查 SSH 密钥配置",
        occurrences: 2,
      },
      {
        errorPattern: "rejected: non-fast-forward",
        solution: "先执行 git pull --rebase",
        occurrences: 1,
      },
    ];

    mockRegistry.addSkill(skill);

    const composer = new PromptComposer(workDir, false, {
      sessionId: "failure-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    // 验证只显示第一个失败模式
    expect(prompt).toContain("已知问题");
    expect(prompt).toContain("出现 2 次");
    expect(prompt).toContain("fatal: Could not read from remote repository");
    expect(prompt).toContain("解决方案: 检查 SSH 密钥配置");

    // 第二个失败模式不应出现（只显示首个）
    expect(prompt).not.toContain("non-fast-forward");
  });

  it("✅ 技能记忆缩进格式正确", async () => {
    const skill = createLearnedSkill(
      "多行指令",
      "测试",
      "第一步：准备\n第二步：执行\n  - 子步骤 A\n  - 子步骤 B\n第三步：验证",
      "auto",
    );
    skill.stats.successCount = 1;
    mockRegistry.addSkill(skill);

    const composer = new PromptComposer(workDir, false, {
      sessionId: "indent-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    // 验证缩进（instructions 应整体缩进 2 空格）
    expect(prompt).toContain("- **执行步骤**:");
    expect(prompt).toContain("  第一步：准备");
    expect(prompt).toContain("  第二步：执行");
    expect(prompt).toContain("    - 子步骤 A"); // 原本缩进 2 空格，加上整体缩进 2，共 4 空格
    expect(prompt).toContain("  第三步：验证");
  });

  it("✅ 空技能列表时正常工作", async () => {
    // 不添加任何技能
    const composer = new PromptComposer(workDir, false, {
      sessionId: "empty-session",
      skillRegistry: mockRegistry,
      memoryNudger: mockNudger,
    });

    const prompt = await composer.build();

    // 验证核心部分正常生成
    expect(prompt).toContain("# 核心身份");
    expect(prompt).toContain("你名叫 pico");

    // 验证不包含技能章节
    expect(prompt).not.toContain("# 已掌握的技能");
  });

  it("✅ SkillRegistry 初始化失败不阻断 Prompt 生成", async () => {
    // 创建一个会抛异常的 mock
    const brokenRegistry = new MockSkillRegistry();
    brokenRegistry.getTopSkills = () => {
      throw new Error("模拟初始化失败");
    };

    const composer = new PromptComposer(workDir, false, {
      sessionId: "broken-session",
      skillRegistry: brokenRegistry,
    });

    // 不应抛异常
    const prompt = await composer.build();

    // 核心部分应正常生成
    expect(prompt).toContain("# 核心身份");
  });

  it("✅ Nudger 生成失败不阻断 Prompt", async () => {
    const brokenNudger = new MockMemoryNudger();
    brokenNudger.generate = async () => {
      throw new Error("模拟 Nudger 失败");
    };

    const composer = new PromptComposer(workDir, false, {
      sessionId: "broken-nudger",
      skillRegistry: mockRegistry,
      memoryNudger: brokenNudger,
    });

    // 不应抛异常
    const prompt = await composer.build(10);

    expect(prompt).toContain("# 核心身份");
  });
});
