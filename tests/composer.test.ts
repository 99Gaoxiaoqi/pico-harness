// PromptComposer 与 SkillLoader 的单元测试。
// 对应课程第 10 讲:动态 Prompt 三层组装 + SKILL.md 解析。

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PromptComposer } from "../src/context/composer.js";
import { parseSkillMD, SkillLoader, SkillViewTool } from "../src/context/skill.js";

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

  it("frontmatter 解析只匹配开头边界,正文中的 --- 不会截断", () => {
    const content = `---
name: demo
description: 测试
---

# 正文

中间有 --- 分隔线,但仍属于正文。`;
    const skill = parseSkillMD(content);
    expect(skill.body).toContain("中间有 --- 分隔线");
  });

  it("解析 YAML block scalar 多行 description(不丢失内容)", () => {
    const content = `---
name: long-skill
description: |
  第一行触发条件。
  第二行补充说明,跨多行书写。
  第三行结尾。
---

# 正文`;
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("long-skill");
    expect(skill.description).toContain("第一行触发条件");
    expect(skill.description).toContain("第二行补充说明");
    expect(skill.description).toContain("第三行结尾");
    expect(skill.body).toContain("正文");
  });

  it("frontmatter 缺少 name 时回退到传入的目录名", () => {
    const content = "---\ndescription: 无 name 字段\n---\n\n# 正文";
    const skill = parseSkillMD(content, "my-tool-dir");
    expect(skill.name).toBe("my-tool-dir");
    expect(skill.description).toBe("无 name 字段");
  });

  it("description 剥离首尾引号并截断超长内容", () => {
    const long = "x".repeat(1100);
    const content = `---
name: q
description: "${long}"
---
# 正文`;
    const skill = parseSkillMD(content);
    expect(skill.description).toBe("x".repeat(1021) + "...");
  });

  it("只有 frontmatter 无正文时 body 为空且不报错", () => {
    const content = "---\nname: bare\ndescription: 仅元数据\n---";
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("bare");
    expect(skill.description).toBe("仅元数据");
    expect(skill.body).toBe("");
  });

  it("frontmatter 不闭合时降级为默认值，全文作为 body", () => {
    const content = "---\nname: half-open\ndescription: 没有闭合分隔符\n# 这部分仍属于正文";
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("Unknown Skill");
    expect(skill.description).toBe("");
    expect(skill.body).toBe(content);
    expect(skill.body).toContain("name: half-open");
    expect(skill.body).toContain("---");
  });

  it("frontmatter 只有 name 无 description 时 description 为默认值", () => {
    const content = "---\nname: only-name\n---\n\n# 正文";
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("only-name");
    expect(skill.description).toBe("");
    expect(skill.body).toContain("正文");
  });

  it("完全空字符串输入返回默认 name 且 body 为空", () => {
    const skill = parseSkillMD("");
    expect(skill.name).toBe("Unknown Skill");
    expect(skill.description).toBe("");
    expect(skill.body).toBe("");
  });

  it("UTF-8 BOM 前缀的 SKILL.md 能正确解析 frontmatter", () => {
    const content = `\uFEFF---\nname: bom-skill\ndescription: BOM 测试\n---\n\n# BOM 正文`;
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("bom-skill");
    expect(skill.description).toBe("BOM 测试");
    expect(skill.body).toContain("BOM 正文");
  });

  it("CRLF 行尾的 SKILL.md 能正确解析", () => {
    const content = "---\r\nname: crlf-skill\r\ndescription: CRLF 测试\r\n---\r\n\r\n# CRLF 正文";
    const skill = parseSkillMD(content);
    expect(skill.name).toBe("crlf-skill");
    expect(skill.description).toBe("CRLF 测试");
    expect(skill.body).toContain("CRLF 正文");
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
    expect(result).not.toContain("PDF 指南");
    expect(result).not.toContain("Git 指南");
  });

  it("listSummaries 只返回技能元数据,viewBody 按需返回正文", async () => {
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署到生产\n---\n\n# 部署指南\n跑 npm run build",
    );

    const loader = new SkillLoader(workDir);
    const summaries = await loader.listSummaries();
    expect(summaries).toEqual([{ name: "deploy", description: "部署到生产" }]);
    await expect(loader.viewBody("deploy")).resolves.toContain("部署指南");
  });

  it("SkillViewTool 暴露 skill_view 按名称读取技能正文", async () => {
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署到生产\n---\n\n# 部署指南\n跑 npm run build",
    );

    const tool = new SkillViewTool(new SkillLoader(workDir));
    const out = await tool.execute(JSON.stringify({ name: "deploy" }));
    expect(out).toContain("部署指南");
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

  it("递归扫描嵌套子目录中的 SKILL.md", async () => {
    await mkdir(join(workDir, ".claw", "skills", "category", "nested"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "category", "nested", "SKILL.md"),
      "---\nname: nested\ndescription: 嵌套技能\n---\n\n# 嵌套正文",
    );
    const loader = new SkillLoader(workDir);
    const summaries = await loader.listSummaries();
    expect(summaries).toEqual([{ name: "nested", description: "嵌套技能" }]);
  });

  it("递归扫描跳过 node_modules 等排除目录", async () => {
    await mkdir(join(workDir, ".claw", "skills", "real"), { recursive: true });
    await mkdir(join(workDir, ".claw", "skills", "node_modules", "fake"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "real", "SKILL.md"),
      "---\nname: real\ndescription: 真技能\n---\n\n# 真正文",
    );
    await writeFile(
      join(workDir, ".claw", "skills", "node_modules", "fake", "SKILL.md"),
      "---\nname: fake\ndescription: 伪技能\n---\n\n# 伪正文",
    );
    const loader = new SkillLoader(workDir);
    const summaries = await loader.listSummaries();
    expect(summaries.map((s) => s.name)).toEqual(["real"]);
  });

  it("frontmatter 缺少 name 时回退到 SKILL.md 所在目录名", async () => {
    await mkdir(join(workDir, ".claw", "skills", "my-tool"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "my-tool", "SKILL.md"),
      "---\ndescription: 无 name 字段\n---\n\n# 正文",
    );
    const loader = new SkillLoader(workDir);
    const summaries = await loader.listSummaries();
    expect(summaries).toEqual([{ name: "my-tool", description: "无 name 字段" }]);
  });

  it("skill_view 未找到时报错附带可用技能清单", async () => {
    await mkdir(join(workDir, ".claw", "skills", "deploy"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "deploy", "SKILL.md"),
      "---\nname: deploy\ndescription: 部署\n---\n\n# 部署",
    );
    const tool = new SkillViewTool(new SkillLoader(workDir));
    await expect(tool.execute(JSON.stringify({ name: "nope" }))).rejects.toThrow(
      /未找到技能: nope。可用技能: deploy/,
    );
  });

  it("skill_view 拒绝非字符串 name", async () => {
    const tool = new SkillViewTool(new SkillLoader(workDir));
    await expect(tool.execute(JSON.stringify({ name: 123 }))).rejects.toThrow(/非字符串/);
  });

  it("skill_view 参数非合法 JSON 时抛出参数解析失败错误", async () => {
    const tool = new SkillViewTool(new SkillLoader(workDir));
    await expect(tool.execute("not-a-json")).rejects.toThrow(/参数解析失败/);
  });

  it("skill_view name 为空字符串时抛出缺少 name 参数错误", async () => {
    const tool = new SkillViewTool(new SkillLoader(workDir));
    await expect(tool.execute(JSON.stringify({ name: "" }))).rejects.toThrow(/缺少 name 参数/);
  });

  it("多个技能按 name 字典序排序", async () => {
    await mkdir(join(workDir, ".claw", "skills", "z-dir"), { recursive: true });
    await mkdir(join(workDir, ".claw", "skills", "a-dir"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "z-dir", "SKILL.md"),
      "---\nname: zebra\ndescription: Z\n---\n\n# Z 正文",
    );
    await writeFile(
      join(workDir, ".claw", "skills", "a-dir", "SKILL.md"),
      "---\nname: alpha\ndescription: A\n---\n\n# A 正文",
    );
    const loader = new SkillLoader(workDir);
    const summaries = await loader.listSummaries();
    expect(summaries.map((s) => s.name)).toEqual(["alpha", "zebra"]);
  });

  it("两个技能 name 相同时 viewBody 返回第一个匹配", async () => {
    await mkdir(join(workDir, ".claw", "skills", "dup-one"), { recursive: true });
    await mkdir(join(workDir, ".claw", "skills", "dup-two"), { recursive: true });
    await writeFile(
      join(workDir, ".claw", "skills", "dup-one", "SKILL.md"),
      "---\nname: dup\ndescription: 重复技能\n---\n\n# dup 正文一",
    );
    await writeFile(
      join(workDir, ".claw", "skills", "dup-two", "SKILL.md"),
      "---\nname: dup\ndescription: 重复技能\n---\n\n# dup 正文二",
    );
    const loader = new SkillLoader(workDir);
    const body = await loader.viewBody("dup");
    expect(typeof body).toBe("string");
    expect(body).toContain("dup 正文");
  });

  it(".claw/skills 存在但无子目录时返回空", async () => {
    await mkdir(join(workDir, ".claw", "skills"), { recursive: true });
    const loader = new SkillLoader(workDir);
    const summaries = await loader.listSummaries();
    expect(summaries).toEqual([]);
    expect(await loader.loadAll()).toBe("");
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

  it("planMode=true 在空工作区注入全新任务的 Plan Mode 规范", async () => {
    const prompt = await new PromptComposer(workDir, true).build();
    // 标题与全新任务三步强制流程
    expect(prompt).toContain("Plan Mode: ON");
    expect(prompt).toContain("全新任务");
    expect(prompt).toContain("write_file 创建 PLAN.md");
    expect(prompt).toContain("write_file 创建 TODO.md");
    expect(prompt).toContain("edit_file 把 TODO.md 对应条目改成 [x]");
    // 全新任务分支不应出现断点续传专属文案
    expect(prompt).not.toContain("断点续传");
    expect(prompt).not.toContain("绝对不要覆盖");
    // 仍包含极简内核(规范追加在内核之后)
    expect(prompt).toContain("pico");
    expect(prompt).toContain("核心纪律");
  });

  it("planMode=true 在已存在 PLAN.md/TODO.md 的工作区注入断点续传上下文", async () => {
    await writeFile(join(workDir, "PLAN.md"), "# 架构设计\n采用 TypeScript");
    await writeFile(join(workDir, "TODO.md"), "- [ ] 第一步\n- [x] 第二步");
    const prompt = await new PromptComposer(workDir, true).build();
    // 断点续传分支:注入文件内容 + 强制不覆盖
    expect(prompt).toContain("Plan Mode: ON");
    expect(prompt).toContain("断点续传");
    expect(prompt).toContain("采用 TypeScript");
    expect(prompt).toContain("- [ ] 第一步");
    expect(prompt).toContain("绝对不要覆盖 PLAN.md / TODO.md");
    // 不应出现全新任务文案
    expect(prompt).not.toContain("全新任务");
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
