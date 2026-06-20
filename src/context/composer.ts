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
  private readonly workDir: string;
  private readonly skillLoader: SkillLoader;
  private readonly planMode: boolean;

  constructor(workDir: string, planMode = false) {
    this.workDir = workDir;
    this.skillLoader = new SkillLoader(workDir);
    this.planMode = planMode;
  }

  /** 组装并返回完整的系统提示词字符串 */
  async build(): Promise<string> {
    const parts: string[] = [];

    // 1. 极简内核:仅确立基本身份与最底线红线纪律
    parts.push(`# 核心身份
你名叫 pico,一个由驾驭工程 (Harness Engineering) 驱动的骨灰级研发助手。
你具备极简主义哲学,拒绝废话。你能通过系统提供的内置工具,创建、读取、修改和执行工作区中的代码。

# 核心纪律 (CRITICAL)
1. 如需检查文件是否存在,请使用 bash 的 ls 或 test -f,而不是对目录使用 read_file。
2. 创建新文件时,务必使用 write_file,并同时提供 path 和 content 参数。
3. 编辑文件前务必先读取现有文件,以理解上下文。
4. 遇到工具执行报错时,仔细阅读 stderr,尝试自己修正命令并重试。
5. 始终用中文回复,以便传达你的进展和想法。`);

    // 2. (可选)长程任务与状态外部化强制规范:Plan Mode 开关
    // 借鉴 Claude Code:重型记忆管理是可选的计划模式,只对复杂长程任务开启,
    // 避免简单问答也官僚地建 PLAN.md/TODO.md 浪费 Token。
    if (this.planMode) {
      parts.push(PLAN_MODE_SPEC);
    }

    // 3. 外部化状态:加载项目专属规范 (AGENTS.md)
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

    // 4. 动态加载技能外挂 (Skills)
    const skillsContent = await this.skillLoader.loadAll();
    if (skillsContent) {
      parts.push(skillsContent);
    }

    return parts.join("\n\n");
  }
}

/**
 * Plan Mode 强制规范:状态外部化 (Externalized State) 的工作流指令。
 *
 * 摒弃内存状态机,引导大模型把宏观规划与微观待办以 PLAN.md / TODO.md 实体化到文件系统。
 * 这段提示词在人看是语言,在大模型眼中是强有力的微代码 (Micro-code):
 * - STEP 1 环境嗅探:全新任务建文件 / 断点续传读文件(绝对不覆盖)
 * - STEP 2 单步执行 + 实时打勾:做一步打勾一步,禁止一口气写完
 * - STEP 3 迷失自救:报错或迷茫时 read_file TODO.md 重新定位
 *
 * 由此实现:跨会话断电持久化 + 零成本人机协同(人类改 TODO.md 即可纠偏)。
 */
const PLAN_MODE_SPEC = `# 长程任务与状态外部化强制规范 (Plan Mode: ON)
!!! 警告:本模式下,你绝对不能依赖自己的短期记忆。你必须将所有的架构思路和执行进度持久化到物理文件。

当你收到一条新指令被唤醒时,你必须、且只能按照以下【绝对顺序】执行你的动作:

**[STEP 1: 强制环境嗅探 (Bootstrapping)]**
- 收到指令后,你必须第一时间使用 bash (如: ls -la) 检查当前工作区根目录下是否已存在 PLAN.md 和 TODO.md。
- **分支 A (全新任务)**:如果这两个文件不存在,说明这是一个全新的任务。你必须使用 write_file:
  1. 先创建 PLAN.md,写下你的理解、架构设计、技术选型。
  2. 再创建 TODO.md,拆解出具体的可执行步骤(使用标准的 Markdown Checkbox 格式: - [ ] 任务描述)。
- **分支 B (断点续传 / 任务唤醒)**:如果这两个文件已经存在,**绝对不要覆盖它们!** 这意味着系统刚从崩溃中恢复。你必须用 read_file 读取它们,从上次中断的断点继续执行。

**[STEP 2: 严格的单步执行与实时打勾]**
- 开始执行 TODO.md 中未完成的任务。
- **强制约束**:每当你通过 write_file 或 bash 真正完成了一个子任务后,你**必须立即停下来**,使用 edit_file 把 TODO.md 中对应条目的 \`- [ ]\` 改成 \`- [x]\`。
- 绝对不允许"一口气写完所有代码最后再打勾"。做完一步,必须打勾一步!

**[STEP 3: 迷失时的自救]**
- 如果你在执行中遇到了报错,或者不知道下一步该干嘛了,立即使用 read_file 重新读取 TODO.md,确认当前进度后再决定下一步。`;
