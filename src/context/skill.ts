// Skill 加载器:扫描 .claw/skills/*/SKILL.md,解析 YAML frontmatter + Markdown 正文。
// 对应课程第 10 讲 internal/context/skill.go。
//
// 遵循 Agent Skills 规范 (agentskills.io):
// SKILL.md 以 YAML frontmatter 开头,定义 name 和 description(何时使用),
// 随后是 Markdown 格式的执行指令正文。
// 渐进式暴露:启动时只加载元数据与正文,按需提供给智能体。

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Dirent } from "node:fs";
import type { BaseTool } from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";

/** 从 SKILL.md 中解析出的标准化技能结构 */
export interface Skill {
  name: string;
  description: string;
  /** Markdown 正文指令 */
  body: string;
}

export interface SkillSummary {
  name: string;
  description: string;
}

/** 负责从本地文件系统中加载并解析符合规范的技能模板 */
export class SkillLoader {
  constructor(private readonly workDir: string) {}

  /**
   * 扫描 .claw/skills 目录,解析所有 SKILL.md,格式化为字符串准备注入 Context。
   * 目录不存在则静默返回空 (当前工作区未配置技能)。
   */
  async loadAll(): Promise<string> {
    const skills = await this.listSummaries();
    if (skills.length === 0) return "";

    let builder = "\n### 可用专业技能 (Agent Skills)\n";
    builder += "以下是你拥有的标准化外挂技能清单。需要完整执行指南时,请调用 skill_view 工具按名称读取。\n\n";
    for (const skill of skills) {
      builder += `#### 技能名称: ${skill.name}\n`;
      builder += `**触发条件**: ${skill.description}\n\n`;
    }
    return builder;
  }

  async listSummaries(): Promise<SkillSummary[]> {
    const skills = await this.loadSkillFiles();
    return skills.map(({ name, description }) => ({ name, description }));
  }

  async viewBody(name: string): Promise<string | undefined> {
    const skills = await this.loadSkillFiles();
    return skills.find((skill) => skill.name === name)?.body;
  }

  private async loadSkillFiles(): Promise<Skill[]> {
    const skillBaseDir = join(this.workDir, ".claw", "skills");
    let entries: Dirent[];
    try {
      entries = await readdir(skillBaseDir, { withFileTypes: true });
    } catch {
      // 目录不存在,静默返回
      return [];
    }

    const skills: Skill[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const skillFile = join(skillBaseDir, entry.name, "SKILL.md");
      try {
        const content = await readFile(skillFile, "utf8");
        skills.push(parseSkillMD(content));
      } catch {
        // 该技能目录无 SKILL.md,跳过
      }
    }
    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }
}

export class SkillViewTool implements BaseTool {
  readonly readOnly = true;

  constructor(private readonly loader: SkillLoader) {}

  name(): string {
    return "skill_view";
  }

  definition(): ToolDefinition {
    return {
      name: "skill_view",
      description: "按技能名称读取完整 SKILL.md 正文。当系统提示词只展示技能清单时,用它查看具体执行指南。",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "技能名称,例如 deploy" },
        },
        required: ["name"],
      },
    };
  }

  async execute(args: string): Promise<string> {
    let parsed: { name?: string };
    try {
      parsed = JSON.parse(args) as { name?: string };
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 name 字段");
    }
    const name = parsed.name ?? "";
    if (!name) {
      throw new Error("skill_view 缺少 name 参数");
    }
    const body = await this.loader.viewBody(name);
    if (!body) {
      throw new Error(`未找到技能: ${name}`);
    }
    return body;
  }
}

/** 极简解析带有 YAML Frontmatter 的 Markdown 内容 */
export function parseSkillMD(content: string): Skill {
  const skill: Skill = {
    name: "Unknown Skill",
    description: "No description provided.",
    body: content, // 默认全量作为 body
  };

  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (match) {
    const frontmatter = match[1] ?? "";
    skill.body = (match[2] ?? "").trim();

    // 逐行提取 metadata
    for (const rawLine of frontmatter.split("\n")) {
      const line = rawLine.trim();
      if (line.startsWith("name:")) {
        skill.name = line.slice("name:".length).trim();
      } else if (line.startsWith("description:")) {
        skill.description = line.slice("description:".length).trim();
      }
    }
  }

  return skill;
}
