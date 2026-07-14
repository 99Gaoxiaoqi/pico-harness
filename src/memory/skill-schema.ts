// 技能记忆层数据结构定义
// 对应课程第 23 讲：自我改进 AI 系统，参考 Hermes Agent 的 Skill Memory 设计
//
// 核心理念：
// - 技能状态外部化：持久化到 workspace memory/skills/*.json
// - 自我改进追踪：记录成功/失败统计、执行时间、已知失败模式
// - 版本演化历史：保留每次改进的版本快照和原因

/** 失败模式分析条目 */
export interface FailurePattern {
  /** 错误特征（截取前 200 字符用于去重匹配） */
  errorPattern: string;
  /** 解决方案（可选，人工或 LLM 填充） */
  solution?: string;
  /** 累积出现次数 */
  occurrences: number;
}

/** 技能版本历史记录 */
export interface SkillVersion {
  /** 版本号（从 1 开始递增） */
  version: number;
  /** 该版本的执行指令（Markdown 格式） */
  instructions: string;
  /** 改进原因（例如："修复 API 调用超时问题"） */
  reason: string;
  /** 版本创建时间（ISO 8601 格式） */
  timestamp: string;
}

/** 技能执行统计数据 */
export interface SkillStats {
  /** 成功执行次数 */
  successCount: number;
  /** 失败执行次数 */
  failCount: number;
  /** 最后使用时间（ISO 8601 格式，null 表示未使用过） */
  lastUsed: string | null;
  /** 平均执行时间（毫秒） */
  avgExecutionTime: number;
}

/** 学习到的技能完整结构 */
export interface LearnedSkill {
  /** 技能唯一标识（例如 "skill_abc12345"，使用 crypto.randomUUID() 生成） */
  id: string;
  /** 技能名称（用于展示和搜索） */
  name: string;
  /** 触发条件描述（关键词，用于匹配用户需求） */
  trigger: string;
  /** 执行步骤（Markdown 格式的详细指令） */
  instructions: string;
  /** 技能来源（auto: 自动学习，manual: 人工录入） */
  source: "auto" | "manual";
  /** 创建时间（ISO 8601 格式） */
  createdAt: string;
  /** 最后更新时间（ISO 8601 格式） */
  updatedAt: string;

  /** 执行统计数据（用于自我改进排序） */
  stats: SkillStats;

  /** 已知失败模式列表（用于快速定位重复性问题） */
  knownFailures: FailurePattern[];

  /** 版本演化历史（记录每次改进的快照） */
  versions: SkillVersion[];
}

/**
 * 创建新技能的工厂函数
 * @param name 技能名称
 * @param trigger 触发关键词
 * @param instructions 执行指令（Markdown）
 * @param source 来源标记
 * @returns 初始化完整的 LearnedSkill 对象
 */
export function createLearnedSkill(
  name: string,
  trigger: string,
  instructions: string,
  source: "auto" | "manual",
): LearnedSkill {
  const now = new Date().toISOString();
  const id = `skill_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

  return {
    id,
    name,
    trigger,
    instructions,
    source,
    createdAt: now,
    updatedAt: now,
    stats: {
      successCount: 0,
      failCount: 0,
      lastUsed: null,
      avgExecutionTime: 0,
    },
    knownFailures: [],
    versions: [
      {
        version: 1,
        instructions,
        reason: "初始版本",
        timestamp: now,
      },
    ],
  };
}

/**
 * 计算技能的成功率（用于排序）
 * @param skill 技能对象
 * @returns 成功率（0.0 - 1.0），无执行记录时返回 0.5（中性值）
 */
export function calculateSuccessRate(skill: LearnedSkill): number {
  const total = skill.stats.successCount + skill.stats.failCount;
  if (total === 0) return 0.5; // 未使用过的技能给予中性分数
  return skill.stats.successCount / total;
}
