// Prompt 动态组装器:像搭积木一样拼接极简内核 + AGENTS.md + Skills。
// 对应课程第 10 讲 internal/context/composer.go。
//
// 分层加载策略:
// 1. 极简内核 (Minimal Core):硬编码最基础的身份认知与红线纪律 (<1000 Tokens)
// 2. 工作区守则 (AGENTS.md):读取工作区根目录 AGENTS.md,项目专属规范
// 3. 技能外挂 (Skills):特定领域 SOP,按需加载
//
// System Prompt 被视为大模型运行时的"操作系统内核",模块化编译、动态链接。
// 冗长的无关信息会消耗 Token 并稀释注意力,故按需加载。

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SkillLoader } from "./skill.js";

/** 负责根据工作区环境动态生成 System Prompt */
export class PromptComposer {
  private readonly skillLoader: SkillLoader;

  constructor(private readonly workDir: string) {
    this.skillLoader = new SkillLoader(workDir);
  }

  /** 组装并返回完整的系统提示词字符串 */
  async build(): Promise<string> {
    const parts: string[] = [];

    // 1. 极简内核:仅确立基本身份与最底线红线纪律
    parts.push(`# 核心身份
你名叫 tiny-claw,一个由驾驭工程 (Harness Engineering) 驱动的骨灰级研发助手。
你具备极简主义哲学,拒绝废话。你能通过系统提供的内置工具,创建、读取、修改和执行工作区中的代码。

# 核心纪律 (CRITICAL)
1. 如需检查文件是否存在,请使用 bash 的 ls 或 test -f,而不是对目录使用 read_file。
2. 创建新文件时,务必使用 write_file,并同时提供 path 和 content 参数。
3. 编辑文件前务必先读取现有文件,以理解上下文。
4. 遇到工具执行报错时,仔细阅读 stderr,尝试自己修正命令并重试。
5. 始终用中文回复,以便传达你的进展和想法。`);

    // 2. 外部化状态:加载项目专属规范 (AGENTS.md)
    const agentsPath = join(this.workDir, "AGENTS.md");
    try {
      const agentsContent = await readFile(agentsPath, "utf8");
      parts.push(`# 项目专属指南 (来自 AGENTS.md)
以下是当前工作区特有的架构规范与注意事项,你的行为必须绝对遵守:
\`\`\`markdown
${agentsContent}
\`\`\``);
    } catch {
      // 无 AGENTS.md,跳过
    }

    // 3. 动态加载技能外挂 (Skills)
    const skillsContent = await this.skillLoader.loadAll();
    if (skillsContent) {
      parts.push(skillsContent);
    }

    return parts.join("\n\n");
  }
}
