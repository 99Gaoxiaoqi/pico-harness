// PromptComposer 记忆集成单元测试
// 验证技能记忆和 Periodic Nudge 注入逻辑

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PromptComposer } from "../../src/context/composer.js";
import { MockSkillRegistry } from "../mocks/skill-registry.mock.js";
import { MockMemoryNudger } from "../mocks/memory-nudger.mock.js";
import { createLearnedSkill } from "../../src/memory/skill-schema.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("PromptComposer 记忆集成", () => {
  let workDir: string;
  let mockRegistry: MockSkillRegistry;
  let mockNudger: MockMemoryNudger;

  beforeEach(() => {
    // 创建临时工作目录
    workDir = mkdtempSync(join(tmpdir(), "pico-test-"));
    mockRegistry = new MockSkillRegistry();
    mockNudger = new MockMemoryNudger();
  });

  it("✅ build() 包含技能记忆上下文", async () => {
    // 添加测试技能
    const skill = createLearnedSkill(
      "API 调用重试",
      "API 超时、网络错误",
      "1. 捕获异常\n2. 指数退避重试\n3. 记录日志",
      "auto",
    );
    skill.stats.successCount = 8;
    skill.stats.failCount = 2;
    mockRegistry.addSkill(skill);

    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    // 验证包含技能记忆章节
    expect(prompt).toContain("# 已掌握的技能");
    expect(prompt).toContain("## API 调用重试");
    expect(prompt).toContain("成功率 80%");
    expect(prompt).toContain("触发条件");
    expect(prompt).toContain("执行步骤");
    expect(prompt).toContain("统计");
  });

  it("✅ 无技能时不注入技能上下文", async () => {
    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    expect(prompt).not.toContain("# 已掌握的技能");
  });

  it("✅ 技能按成功率排序（Top 5）", async () => {
    // 添加 7 个技能，验证只返回前 5 个
    for (let i = 0; i < 7; i++) {
      const skill = createLearnedSkill(
        `技能${i}`,
        `trigger-${i}`,
        `指令${i}`,
        "auto",
      );
      skill.stats.successCount = i * 2; // 成功率递增
      skill.stats.failCount = 1;
      mockRegistry.addSkill(skill);
    }

    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    // 验证包含高成功率技能
    expect(prompt).toContain("技能6"); // 最高成功率
    expect(prompt).toContain("技能5");
    expect(prompt).toContain("技能4");
    expect(prompt).toContain("技能3");
    expect(prompt).toContain("技能2");

    // 验证不包含低成功率技能
    expect(prompt).not.toContain("技能0");
    expect(prompt).not.toContain("技能1");
  });

  it("✅ 第 10 轮触发 Periodic Nudge", async () => {
    mockNudger.setNudge(10, "# ⏰ 阶段性提示\n请回顾当前任务进度...");

    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
      memoryNudger: mockNudger,
    });

    const prompt = await composer.build(10);

    expect(prompt).toContain("# ⏰ 阶段性提示");
    expect(prompt).toContain("请回顾当前任务进度");
  });

  it("✅ Nudger 未初始化时不触发 Nudge", async () => {
    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
      // 不传入 memoryNudger
    });

    const prompt = await composer.build(10);

    expect(prompt).not.toContain("⏰ 阶段性提示");
  });

  it("✅ 四层记忆顺序正确", async () => {
    // 添加技能
    const skill = createLearnedSkill("测试技能", "测试", "步骤", "auto");
    skill.stats.successCount = 5;
    mockRegistry.addSkill(skill);

    // 设置 Nudge
    mockNudger.setNudge(5, "# Nudge 内容");

    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
      memoryNudger: mockNudger,
    });

    const prompt = await composer.build(5);

    // 验证顺序：核心身份 → (Plan Mode) → AGENTS.md → Skills → 技能记忆 → Nudge
    const coreIndex = prompt.indexOf("# 核心身份");
    const skillMemoryIndex = prompt.indexOf("# 已掌握的技能");
    const nudgeIndex = prompt.indexOf("# Nudge 内容");

    expect(coreIndex).toBeGreaterThan(-1);
    expect(skillMemoryIndex).toBeGreaterThan(coreIndex);
    expect(nudgeIndex).toBeGreaterThan(skillMemoryIndex);
  });

  it("✅ 技能记忆包含已知问题", async () => {
    const skill = createLearnedSkill("API 调用", "API", "步骤", "auto");
    skill.stats.successCount = 3;
    skill.stats.failCount = 2;
    skill.knownFailures = [
      {
        errorPattern: "ECONNREFUSED: 连接被拒绝",
        solution: "检查服务是否启动",
        occurrences: 5,
      },
    ];
    mockRegistry.addSkill(skill);

    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
    });

    const prompt = await composer.build();

    expect(prompt).toContain("已知问题");
    expect(prompt).toContain("出现 5 次");
    expect(prompt).toContain("ECONNREFUSED");
    expect(prompt).toContain("解决方案: 检查服务是否启动");
  });

  it("✅ turnCount=0 时不触发 Nudge", async () => {
    mockNudger.setNudge(0, "不应该出现");

    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
      memoryNudger: mockNudger,
    });

    const prompt = await composer.build(0);

    expect(prompt).not.toContain("不应该出现");
  });

  it("✅ getSkillRegistry() 返回注入的实例", () => {
    const composer = new PromptComposer(workDir, false, {
      sessionId: "test-session",
      skillRegistry: mockRegistry,
    });

    expect(composer.getSkillRegistry()).toBe(mockRegistry);
  });

  // 清理
  afterEach(() => {
    try {
      rmSync(workDir, { recursive: true, force: true });
    } catch {
      // 忽略清理错误
    }
  });
});
