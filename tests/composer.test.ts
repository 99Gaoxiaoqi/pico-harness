// PromptComposer 与 SkillLoader 的单元测试。
// 对应课程第 10 讲:动态 Prompt 三层组装 + SKILL.md 解析。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptComposer } from "../src/context/composer.js";
import { parseSkillMD, SkillLoader } from "../src/context/skill.js";

describe("parseSkillMD", () => {
  it("解析 YAML frontmatter 的 name 和 description", () => {
    const content = `---
name: pdf-processing
description: 提取 PDF 文本、填充表单。当用户需要处理 PDF 文件时使用此技能。
---

# PDF 处理指南

## 提取步骤
1. 使用 python 脚本调用 pdfplumber`;
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("pdf-processing");
    expect(skill.description).toContain("提取 PDF 文本");
    expect(skill.body).toContain("PDF 处理指南");
    expect(skill.body).not.toContain("name:");
  });

  it("无 frontmatter 时用默认值,正文为全部内容", () => {
    const content = "# 普通文档\n\n没有 frontmatter";
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("Unknown Skill");
    expect(skill.body).toContain("普通文档");
  });
});

describe("SkillLoader", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-skill-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("加载 .claw/skills 下的多个 SKILL.md", async () => {
    await mkdir(join(workDir, ".claw", "skills", "pdf"), { recursive: true });
    await mkdir(join(workDir, ".claw", "skills", "git"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "pdf", "SKILL.md"),
      "---\nname: pdf\ndescription: 处理 PDF\n---\n\n# PDF 指南\n步骤...",
    );
    await writeFile(
      join(workDir, ".claw", "skills", "git", "SKILL.md"),
      "---\nname: git\ndescription: Git 操作\n---\n\n# Git 指南\n提交...",
    );

    const loader = new SkillLoader(workDir);
    const result = await loader.loadAll();
    expect(result).toContain("pdf");
    expect(result).toContain("处理 PDF");
    expect(result).toContain("git");
    expect(result).toContain("Git 操作");
  });

  it("无 .claw/skills 目录时返回空", async () => {
    const loader = new SkillLoader(workDir);
    const result = await loader.loadAll();
    expect(result).toBe("");
  });

  it("技能目录无 SKILL.md 时跳过", async () => {
    await mkdir(join(workDir, ".claw", "skills", "empty"), { recursive: true });
    const loader = new SkillLoader(workDir);
    const result = await loader.loadAll();
    expect(result).toBe("");
  });
});

describe("PromptComposer", () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), "claw-compose-"));
  });
  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it("三层组装:极简内核 + AGENTS.md + Skills", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "# 项目规范\n必须用 TypeScript");
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署到生产\n---\n\n# 部署指南\n跑 npm run build",
    );

    const prompt = await new PromptComposer(workDir).build();
    // 极简内核
    expect(prompt).toContain("pico");
    expect(prompt).toContain("核心纪律");
    // AGENTS.md
    expect(prompt).toContain("项目专属指南");
    expect(prompt).toContain("必须用 TypeScript");
    // Skills
    expect(prompt).toContain("可用专业技能");
    expect(prompt).toContain("deploy");
    expect(prompt).toContain("部署到生产");
  });

  it("无 AGENTS.md 和 Skills 时仍包含极简内核", async () => {
    const prompt = await new PromptComposer(workDir).build();
    expect(prompt).toContain("pico");
    expect(prompt).toContain("核心纪律");
    expect(prompt).not.toContain("项目专属指南");
    expect(prompt).not.toContain("可用专业技能");
  });

  it("planMode=false(默认)不注入状态外部化规范", async () => {
    const prompt = await new PromptComposer(workDir).build();
    expect(prompt).not.toContain("Plan Mode: ON");
    expect(prompt).not.toContain("PLAN.md");
    expect(prompt).not.toContain("断点续传");
  });

  it("planMode=true 注入长程任务状态外部化规范", async () => {
    const prompt = await new PromptComposer(workDir, true).build();
    // 标题与三步强制流程
    expect(prompt).toContain("Plan Mode: ON");
    expect(prompt).toContain("STEP 1: 强制环境嗅探");
    expect(prompt).toContain("STEP 2: 严格的单步执行与实时打勾");
    expect(prompt).toContain("STEP 3: 迷失时的自救");
    // 关键约束:分支 A 全新任务 / 分支 B 断点续传不覆盖
    expect(prompt).toContain("分支 A (全新任务)");
    expect(prompt).toContain("分支 B (断点续传 / 任务唤醒)");
    expect(prompt).toContain("绝对不要覆盖");
    // 单步打勾约束
    expect(prompt).toContain("- [ ]");
    expect(prompt).toContain("- [x]");
    // 仍包含极简内核(规范追加在内核之后)
    expect(prompt).toContain("pico");
    expect(prompt).toContain("核心纪律");
  });

  it("planMode=true 与 AGENTS.md/Skills 可共存,三层齐全", async () => {
    await writeFile(join(workDir, "AGENTS.md"), "# 项目规范\n必须用 TypeScript");
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署到生产\n---\n\n# 部署指南\n跑 npm run build",
    );
    const prompt = await new PromptComposer(workDir, true).build();
    expect(prompt).toContain("Plan Mode: ON");
    expect(prompt).toContain("项目专属指南");
    expect(prompt).toContain("必须用 TypeScript");
    expect(prompt).toContain("deploy");
  });
});
