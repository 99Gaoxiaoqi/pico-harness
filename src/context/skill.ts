// Skill 加载器:扫描 .claude/skills 与 .claw/skills 下的 SKILL.md。
// 对应课程第 10 讲 internal/context/skill.go。
//
// 遵循 Agent Skills 规范 (agentskills.io):
// SKILL.md 以 YAML frontmatter 开头,定义 name 和 description(何时使用),
// 随后是 Markdown 格式的执行指令正文。
// 渐进式暴露:启动时只加载元数据与正文,按需提供给智能体。

import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Dirent } from "node:fs";
import * as yaml from "js-yaml";
import type { BaseTool } from "../tools/registry.js";
import type { ToolDefinition } from "../schema/message.js";
import { logger } from "../observability/logger.js";

// agentskills.io 规范的元数据长度上限,超长截断避免撑爆渐进式暴露清单
const MAX_NAME_LENGTH = 64;
const MAX_DESCRIPTION_LENGTH = 1024;

// 递归扫描时跳过的目录:VCS、依赖、虚拟环境、缓存、构建产物。
// 与 Hermes EXCLUDED_SKILL_DIRS 对齐,避免误扫 node_modules 等巨型目录。
const EXCLUDED_SKILL_DIRS: ReadonlySet<string> = new Set([
  ".git",
  ".github",
  "node_modules",
  ".venv",
  "venv",
  "__pycache__",
  ".cache",
  "dist",
  "build",
]);

/** 从 SKILL.md 中解析出的标准化技能结构 */
export interface Skill {
  name: string;
  description: string;
  /** Markdown 正文指令 */
  body: string;
  /** SKILL.md 绝对路径。由 SkillLoader 扫描文件时填充,parseSkillMD 直接调用时为空。 */
  sourcePath?: string;
}

export interface SkillSummary {
  name: string;
  description: string;
}

/** 负责从本地文件系统中加载并解析符合规范的技能模板 */
export class SkillLoader {
  // 文件签名缓存:每次扫描 SKILL.md 路径和 mtime/size,未变则复用解析结果。
  private cache?: { skills: Skill[]; signature: string };

  constructor(private readonly workDir: string) {}

  /**
   * 扫描 Claude/Pico 两个 Skill 目录,解析所有 SKILL.md,格式化为字符串准备注入 Context。
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

  async viewSourcePath(name: string): Promise<string | undefined> {
    const skills = await this.loadSkillFiles();
    return skills.find((skill) => skill.name === name)?.sourcePath;
  }

  private async loadSkillFiles(): Promise<Skill[]> {
    // 与 slash command 投影保持同一发现顺序；同名时 Claude 目录优先。
    const skillBaseDirs = [
      join(this.workDir, ".claude", "skills"),
      join(this.workDir, ".claw", "skills"),
    ];
    const skillFiles = (await Promise.all(skillBaseDirs.map(walkForSkillMd))).flat();
    const signature = await skillFileSignature(skillFiles);
    if (this.cache && this.cache.signature === signature) {
      return this.cache.skills;
    }

    const skills: Skill[] = [];
    for (const file of skillFiles) {
      try {
        const content = await readFile(file, "utf8");
        // frontmatter 无 name 时回退到 SKILL.md 所在目录名(对齐 Hermes)
        const fallbackName = basename(dirname(file));
        skills.push({ ...parseSkillMD(content, fallbackName), sourcePath: file });
      } catch (err) {
        // 区分权限/编码类可预期错误(debug 跳过)与其他异常(warn 跳过)
        if (isErrnoException(err, "EACCES") || isErrnoException(err, "EISDIR")) {
          logger.debug({ err, file }, "跳过不可读的 SKILL.md");
        } else {
          logger.warn({ err, file }, "解析 SKILL.md 失败,跳过");
        }
      }
    }

    const byName = new Map<string, Skill>();
    for (const skill of skills) {
      if (!byName.has(skill.name)) byName.set(skill.name, skill);
    }
    const sorted = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
    this.cache = { skills: sorted, signature };
    return sorted;
  }
}

async function skillFileSignature(files: readonly string[]): Promise<string> {
  const parts: string[] = [];
  for (const file of [...files].sort()) {
    try {
      const fileStat = await stat(file);
      parts.push(`${file}:${fileStat.mtimeMs}:${fileStat.size}`);
    } catch (err) {
      if (!isErrnoException(err, "ENOENT")) {
        logger.debug({ err, file }, "读取 SKILL.md 签名失败");
      }
    }
  }
  return parts.join("\n");
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
    let parsed: { name?: unknown };
    try {
      parsed = JSON.parse(args) as { name?: unknown };
    } catch {
      throw new Error("参数解析失败:期望 JSON 含 name 字段");
    }
    // 类型校验:name 必须是字符串,拒绝 null/数字等畸形入参
    if (typeof parsed.name !== "string") {
      throw new Error("skill_view 缺少 name 参数或 name 非字符串");
    }
    const name = parsed.name.trim();
    if (!name) {
      throw new Error("skill_view 缺少 name 参数");
    }
    const body = await this.loader.viewBody(name);
    if (!body) {
      // 报错时附带可用技能清单,便于调用方自我纠偏(对齐 Hermes skill_view)
      const all = await this.loader.listSummaries();
      const names = all.map((s) => s.name).join(", ");
      throw new Error(`未找到技能: ${name}。可用技能: ${names}`);
    }
    return body;
  }
}

/**
 * 递归扫描技能目录,返回所有 SKILL.md 的绝对路径(已排除依赖/缓存等目录)。
 * 跟随符号链接:对 Dirent.isSymbolicLink 用 stat 确认真实目标是否目录,
 * 与 Hermes os.walk(followlinks=True) 行为一致。
 */
async function walkForSkillMd(dir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    // 权限不足或竞态消失:静默跳过该子树
    if (isErrnoException(err, "EACCES") || isErrnoException(err, "ENOENT")) return [];
    logger.warn({ err, dir }, "扫描技能子目录失败");
    return [];
  }

  const results: string[] = [];
  for (const entry of entries) {
    if (entry.name === "SKILL.md" && entry.isFile()) {
      results.push(join(dir, entry.name));
      continue;
    }
    // 跳过 VCS/依赖/缓存等目录,避免误入 node_modules 等巨型子树
    if (EXCLUDED_SKILL_DIRS.has(entry.name)) continue;

    let isDir = entry.isDirectory();
    // 符号链接用 stat 跟随确认真实目标类型,避免漏掉链接形式的技能目录
    if (!isDir && entry.isSymbolicLink()) {
      try {
        const s = await stat(join(dir, entry.name));
        isDir = s.isDirectory();
      } catch {
        // 断链或不可访问的符号链接,跳过
        continue;
      }
    }
    if (isDir) {
      const nested = await walkForSkillMd(join(dir, entry.name));
      for (const p of nested) results.push(p);
    }
  }
  return results;
}

/** 判断异常是否为指定 code 的 Node ErrnoException */
function isErrnoException(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code: unknown }).code === code
  );
}

/**
 * 解析带有 YAML Frontmatter 的 SKILL.md 内容。
 *
 * 用 js-yaml 做真正的 frontmatter 解析(支持多行 block scalar、列表等),
 * 解析失败时降级为逐行 key:value 容错(对齐 Hermes parse_frontmatter 的 try/fallback)。
 * fallbackName 在 frontmatter 缺少 name 时使用,通常传入 SKILL.md 所在目录名。
 */
export function parseSkillMD(content: string, fallbackName = "Unknown Skill"): Skill {
  // 剥离 BOM,避免某些编辑器写入的 BOM 破坏 YAML 解析与边界匹配
  const stripped = content.replace(/^\uFEFF/, "");

  // 匹配 frontmatter 块:开头 --- ... 闭合 ---。
  // 闭合 --- 后的换行与 body 均可选,支持只有 frontmatter 无正文的文件。
  const match = stripped.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n([\s\S]*))?$/);

  if (!match) {
    return {
      name: fallbackName,
      description: "",
      body: stripped,
    };
  }

  const frontmatterText = match[1] ?? "";
  const body = (match[2] ?? "").trim();

  let fm: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(frontmatterText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      fm = parsed as Record<string, unknown>;
    }
  } catch {
    // 降级:畸形 YAML 用逐行 key:value 解析,保住 name/description 两个关键字段
    fm = parseSimpleFrontmatter(frontmatterText);
  }

  const rawName = fm["name"];
  const name =
    typeof rawName === "string" && rawName.trim()
      ? truncate(rawName.trim(), MAX_NAME_LENGTH)
      : fallbackName;

  return {
    name,
    description: normalizeDescription(fm["description"]),
    body,
  };
}

/** 降级 frontmatter 解析:逐行按首个冒号切分 key:value */
function parseSimpleFrontmatter(text: string): Record<string, unknown> {
  const fm: Record<string, unknown> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim();
    if (key) fm[key] = value;
  }
  return fm;
}

/** 按 agentskills.io 规范截断 name */
function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max);
}

/**
 * 规范化 description:去空白、剥首尾引号、超长截断。
 * 对齐 Hermes extract_skill_description 的 strip().strip("'\"") + 截断逻辑。
 */
function normalizeDescription(raw: unknown): string {
  if (raw == null) return "";
  let desc = String(raw).trim().replace(/^['"]+|['"]+$/g, "");
  if (desc.length > MAX_DESCRIPTION_LENGTH) {
    desc = desc.slice(0, MAX_DESCRIPTION_LENGTH - 3) + "...";
  }
  return desc;
}
