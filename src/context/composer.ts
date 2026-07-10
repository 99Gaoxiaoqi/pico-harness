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
import { logger } from "../observability/logger.js";
import { PlanStore } from "./plan-store.js";
import { SkillLoader } from "./skill.js";
import { TodoStore } from "./todo-store.js";
import type { LearnedSkill } from "../memory/skill-schema.js";
// GoalManager 用 import type:只取类型签名,避免 context → engine 的循环依赖
// (engine/loop.ts 反向 import composer)。单例实例由 host 注入,本类不 new。
import type { GoalManager } from "../engine/goal-manager.js";

interface ISkillRegistry {
  init(): Promise<void>;
  getTopSkills(limit: number): LearnedSkill[];
  search(query: string): LearnedSkill[];
}

interface IMemoryNudger {
  generate(sessionId: string, turnCount: number): Promise<string | null>;
}

/** 负责根据工作区环境动态生成 System Prompt */
export class PromptComposer {
  private readonly workDir: string;
  private readonly skillLoader: SkillLoader;
  private readonly planMode: boolean;
  private readonly planStore: PlanStore;
  private readonly todoStore: TodoStore;
  private readonly skillRegistry?: ISkillRegistry;
  private readonly nudger?: IMemoryNudger;
  private readonly sessionId?: string;
  /** GoalManager 单例(可选):由 host 注入,注入后把 active goal 渲染进 prompt */
  private readonly goalManager?: GoalManager;

  /**
   * @param workDir 工作目录
   * @param planMode 是否启用 Plan Mode
   * @param options 可选配置
   *   - sessionId: 会话 ID（用于 Nudger）
   *   - skillRegistry: 技能注册表实例（测试时可注入 mock）
   *   - memoryNudger: 记忆提示器实例（测试时可注入 mock）
   *   - goalManager: GoalManager 单例（注入后把 active goal 注入 prompt）
   *   - todoStore: TodoStore 单例（注入后与 TodoTool 共享,根治跨实例不可见 bug）
   */
  constructor(
    workDir: string,
    planMode = false,
    options?: {
      sessionId?: string;
      skillRegistry?: ISkillRegistry;
      memoryNudger?: IMemoryNudger;
      goalManager?: GoalManager;
      todoStore?: TodoStore;
    },
  ) {
    this.workDir = workDir;
    this.skillLoader = new SkillLoader(workDir);
    this.planMode = planMode;
    this.planStore = new PlanStore(workDir);
    // host 注入 TodoStore 单例,与 TodoTool 共享同一实例(对标 GoalManager 范式)。
    // 未注入则内部 new,保持向后兼容;单实例场景不受跨实例 bug 影响。
    this.todoStore = options?.todoStore ?? new TodoStore(workDir);
    this.sessionId = options?.sessionId;

    // Registry lifecycle belongs to the host. The composer never starts hidden
    // asynchronous initialization from its constructor.
    this.skillRegistry = options?.skillRegistry;

    // 初始化 Nudger（可选）
    this.nudger = options?.memoryNudger;

    // GoalManager（可选注入）
    this.goalManager = options?.goalManager;
  }

  /**
   * 组装并返回完整的系统提示词字符串
   * @param turnCount 当前轮次（用于触发 Periodic Nudge）
   */
  async build(turnCount = 0): Promise<string> {
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
      // 动态嗅探磁盘:文件存在则注入当前进度(断点续传),不存在则引导建文件。
      // buildPlanContext 出错时降级到静态规范,不让 Plan Mode 嗅探阻断主流程。
      try {
        parts.push(await this.planStore.buildPlanContext());
      } catch (err) {
        logger.warn({ err }, "buildPlanContext 失败,降级到静态 PLAN_MODE_SPEC");
        parts.push(PLAN_MODE_SPEC);
      }
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

    // 5. 技能记忆（新增）
    const skillContext = await this.buildSkillContext();
    if (skillContext) {
      parts.push(skillContext);
    }

    // 5.5 结构化 TodoList:注入当前任务清单状态(空清单不注入)
    // todo 失败不阻断 prompt 组装,降级为跳过
    try {
      const todoContext = await this.todoStore.buildTodoContext();
      if (todoContext) {
        parts.push(todoContext);
      }
    } catch (err) {
      logger.warn({ err }, "[composer] 构建 TodoList 上下文失败,降级跳过");
    }

    // 5.6 Goal Mode:注入当前激活目标状态(无 active goal 不注入)
    // 对标 todo 注入,让模型每轮"看到"自己追的长程目标与 budget 约束。
    // GoalManager 单例由 host 注入;未注入(goalManager=undefined)则跳过。
    try {
      if (this.goalManager) {
        const goalCtx = this.goalManager.buildGoalContext();
        if (goalCtx) {
          parts.push(goalCtx);
        }
      }
    } catch (err) {
      logger.warn({ err }, "[composer] 构建 Goal 上下文失败,降级跳过");
    }

    // 6. Periodic Nudge（新增）
    if (this.nudger && this.sessionId && turnCount > 0) {
      try {
        const nudge = await this.nudger.generate(this.sessionId, turnCount);
        if (nudge) {
          parts.push(nudge);
        }
      } catch (err) {
        logger.warn({ err }, "[composer] Nudge 生成失败");
      }
    }

    return parts.join("\n\n");
  }

  /**
   * 构建技能记忆上下文（格式化为 Markdown）
   */
  private async buildSkillContext(): Promise<string | null> {
    if (!this.skillRegistry) return null;
    try {
      const topSkills = this.skillRegistry.getTopSkills(5);
      if (topSkills.length === 0) {
        return null;
      }

      const parts = ["# 已掌握的技能 (来自 .claw/skills/)"];

      for (const skill of topSkills) {
        const { successCount, failCount } = skill.stats;
        const total = successCount + failCount || 1;
        const successRate = ((successCount / total) * 100).toFixed(0);

        parts.push(`\n## ${skill.name} (成功率 ${successRate}%)`);
        parts.push(`- **触发条件**: ${skill.trigger}`);
        parts.push(`- **执行步骤**:`);
        // 缩进 instructions
        const indented = skill.instructions
          .split("\n")
          .map((line) => `  ${line}`)
          .join("\n");
        parts.push(indented);

        // 展示第一个已知问题（如果有）
        if (skill.knownFailures.length > 0) {
          const firstFailure = skill.knownFailures[0];
          if (firstFailure) {
            parts.push(
              `- **已知问题** (出现 ${firstFailure.occurrences} 次): ${firstFailure.errorPattern.slice(0, 100)}`,
            );
            if (firstFailure.solution) {
              parts.push(`  解决方案: ${firstFailure.solution}`);
            }
          }
        }

        parts.push(`- **统计**: 成功 ${successCount} 次，失败 ${failCount} 次`);
      }

      parts.push("\n💡 提示: 遇到匹配的触发条件时，优先使用已掌握的技能。");

      return parts.join("\n");
    } catch (err) {
      logger.warn({ err }, "[composer] 构建技能记忆失败");
      return null;
    }
  }

  /** 获取 SkillRegistry 实例（用于外部记录技能执行） */
  getSkillRegistry(): ISkillRegistry | undefined {
    return this.skillRegistry;
  }
}

/**
 * Plan Mode 静态强制规范:状态外部化 (Externalized State) 的工作流指令。
 *
 * 现仅作为 buildPlanContext 失败时的降级 fallback。正常运行路径下,
 * PromptComposer 会调用 PlanStore.buildPlanContext() 动态嗅探磁盘:
 * - 文件存在:注入 PLAN.md / TODO.md 当前内容,引导断点续传
 * - 文件不存在:提示模型用 write_file 创建两份文件
 *
 * 这段静态文本保留了原始的三步强制流程(环境嗅探 → 单步打勾 → 迷失自救),
 * 在动态路径异常时兜底,确保 Plan Mode 永远有可用的提示词。
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
