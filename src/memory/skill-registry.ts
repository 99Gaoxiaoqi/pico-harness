// SkillRegistry: 技能记忆层的核心管理器
// 对应课程第 23 讲：自我改进 AI 系统
//
// 核心职责：
// - 技能持久化：每个技能一个 JSON 文件存储在 .claw/skills/
// - 执行追踪：记录成功/失败次数、执行时间、失败模式
// - 智能排序：按成功率和使用频次排序技能搜索结果
// - 失败分析：自动去重相似错误，累积到 3 次时触发警告
//
// 参考设计：
// - PlanStore 的路径绑定模式（构造时固定路径，杜绝穿越）
// - Hermes Agent 的 Skill Memory 统计与排序逻辑

import { chmod, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "pathe";
import { logger } from "../observability/logger.js";
import type { LearnedSkill } from "./skill-schema.js";
import { createLearnedSkill, calculateSuccessRate } from "./skill-schema.js";

/** 失败模式匹配时的最大前缀长度（用于去重） */
const ERROR_PATTERN_MAX_LENGTH = 200;

/** 触发警告的重复失败阈值 */
const FAILURE_WARNING_THRESHOLD = 3;

/**
 * 技能注册表：管理学习到的技能的生命周期
 *
 * 设计约定：
 * - 技能文件路径：<workDir>/.claw/skills/<skillId>.json
 * - 并发安全：内存缓存 + 每次变更即刻落盘
 * - 持久化失败：记 warn 但不阻断主流程（优雅降级）
 */
export class SkillRegistry {
  /** 技能存储目录（构造时绑定，外部不可变） */
  private readonly skillsDir: string;

  /** 内存缓存：skillId -> LearnedSkill */
  private readonly cache = new Map<string, LearnedSkill>();

  /** 初始化标记：确保 init() 只执行一次 */
  private initialized = false;

  constructor(workDir: string) {
    this.skillsDir = join(workDir, ".claw", "skills");
  }

  /**
   * 初始化注册表：创建目录并加载所有技能到内存
   * 幂等操作：多次调用安全
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    // 确保目录存在（mkdir -p 语义）
    try {
      await mkdir(this.skillsDir, { recursive: true, mode: 0o700 });
      await chmod(this.skillsDir, 0o700);
    } catch (err) {
      logger.warn({ err, dir: this.skillsDir }, "创建技能目录失败");
      // 不阻断初始化，后续操作会各自处理文件系统错误
    }

    // 加载所有已存在的技能文件到缓存
    await this.loadAllSkills();
    this.initialized = true;
    logger.debug({ count: this.cache.size }, "技能注册表初始化完成");
  }

  /**
   * 添加新技能到注册表
   * @returns 新创建的技能对象（含自动生成的 ID）
   */
  async add(
    name: string,
    trigger: string,
    instructions: string,
    source: "auto" | "manual",
  ): Promise<LearnedSkill> {
    const skill = createLearnedSkill(name, trigger, instructions, source);
    this.cache.set(skill.id, skill);
    await this.save(skill);
    logger.info({ skillId: skill.id, name }, "技能已添加");
    return skill;
  }

  /**
   * 搜索匹配关键词的技能
   * @param keyword 搜索关键词（匹配 name 或 trigger）
   * @returns 按成功率和使用频次排序的技能列表
   */
  search(keyword: string): LearnedSkill[] {
    const lowerKeyword = keyword.toLowerCase();
    const matched = Array.from(this.cache.values()).filter(
      (skill) =>
        skill.name.toLowerCase().includes(lowerKeyword) ||
        skill.trigger.toLowerCase().includes(lowerKeyword),
    );

    // 排序逻辑：成功率优先，成功率相同时按使用次数排序
    return matched.sort((a, b) => {
      const rateA = calculateSuccessRate(a);
      const rateB = calculateSuccessRate(b);
      if (rateA !== rateB) return rateB - rateA; // 成功率降序

      // 成功率相同，按总使用次数排序
      const countA = a.stats.successCount + a.stats.failCount;
      const countB = b.stats.successCount + b.stats.failCount;
      return countB - countA;
    });
  }

  /**
   * 获取所有技能（不排序）
   */
  getAll(): LearnedSkill[] {
    return Array.from(this.cache.values());
  }

  /**
   * 获取使用频次最高的 Top N 技能
   * @param limit 返回数量上限
   */
  getTopSkills(limit: number): LearnedSkill[] {
    return Array.from(this.cache.values())
      .sort((a, b) => {
        const countA = a.stats.successCount + a.stats.failCount;
        const countB = b.stats.successCount + b.stats.failCount;
        return countB - countA;
      })
      .slice(0, limit);
  }

  /**
   * 记录技能执行结果（核心自我改进入口）
   * @param skillId 技能 ID
   * @param success 是否成功
   * @param executionTime 执行耗时（毫秒）
   * @param errorMessage 失败时的错误信息（可选）
   */
  async recordExecution(
    skillId: string,
    success: boolean,
    executionTime: number,
    errorMessage?: string,
  ): Promise<void> {
    const skill = this.cache.get(skillId);
    if (!skill) {
      logger.warn({ skillId }, "记录执行失败：技能不存在");
      return;
    }

    // 更新统计数据
    if (success) {
      skill.stats.successCount++;
    } else {
      skill.stats.failCount++;
      // 失败时分析错误模式
      if (errorMessage) {
        this.analyzeFailure(skill, errorMessage);
      }
    }

    // 更新平均执行时间（增量平均）
    const totalCount = skill.stats.successCount + skill.stats.failCount;
    skill.stats.avgExecutionTime =
      (skill.stats.avgExecutionTime * (totalCount - 1) + executionTime) / totalCount;

    skill.stats.lastUsed = new Date().toISOString();
    skill.updatedAt = new Date().toISOString();

    await this.save(skill);
    logger.debug(
      { skillId, success, executionTime, successRate: calculateSuccessRate(skill) },
      "技能执行已记录",
    );
  }

  /**
   * 分析失败模式：去重、累积、预警
   * @param skill 技能对象
   * @param errorMessage 完整错误信息
   */
  private analyzeFailure(skill: LearnedSkill, errorMessage: string): void {
    // 截取前 200 字符作为错误特征（用于去重）
    const pattern = errorMessage.slice(0, ERROR_PATTERN_MAX_LENGTH);

    // 查找是否已存在相似错误（子串匹配）
    const existing = skill.knownFailures.find(
      (f) => f.errorPattern.includes(pattern) || pattern.includes(f.errorPattern),
    );

    if (existing) {
      // 已存在：累积计数
      existing.occurrences++;

      // 达到阈值时触发警告
      if (existing.occurrences === FAILURE_WARNING_THRESHOLD) {
        logger.warn(
          {
            skillId: skill.id,
            skillName: skill.name,
            errorPattern: existing.errorPattern,
            occurrences: existing.occurrences,
          },
          `技能重复失败 ${FAILURE_WARNING_THRESHOLD} 次，建议人工介入`,
        );
      }
    } else {
      // 新错误：添加到列表
      skill.knownFailures.push({
        errorPattern: pattern,
        solution: undefined,
        occurrences: 1,
      });
    }
  }

  /**
   * 持久化技能到磁盘
   * @param skill 要保存的技能对象
   */
  private async save(skill: LearnedSkill): Promise<void> {
    const filePath = join(this.skillsDir, `${skill.id}.json`);
    try {
      // 格式化 JSON（带缩进，便于人工查看和版本控制）
      const json = JSON.stringify(skill, null, 2);
      await writeFile(filePath, json, { encoding: "utf8", mode: 0o600 });
      await chmod(filePath, 0o600);
    } catch (err) {
      // 持久化失败记 warn，但不抛出异常（优雅降级）
      logger.warn({ err, skillId: skill.id, filePath }, "技能持久化失败");
    }
  }

  /**
   * 从磁盘加载所有技能到内存缓存
   */
  private async loadAllSkills(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.skillsDir);
    } catch (err) {
      // 目录不存在或权限不足：静默跳过（初始化场景）
      if (isErrnoException(err, "ENOENT") || isErrnoException(err, "EACCES")) {
        return;
      }
      logger.warn({ err, dir: this.skillsDir }, "读取技能目录失败");
      return;
    }

    // 并发加载所有 .json 文件
    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const results = await Promise.allSettled(
      jsonFiles.map((file) => this.loadSkill(join(this.skillsDir, file))),
    );

    // 统计加载结果
    let loaded = 0;
    let failed = 0;
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        this.cache.set(result.value.id, result.value);
        loaded++;
      } else {
        failed++;
      }
    }

    if (failed > 0) {
      logger.warn({ loaded, failed }, "部分技能加载失败");
    } else {
      logger.debug({ loaded }, "技能加载完成");
    }
  }

  /**
   * 从单个文件加载技能
   * @param filePath 技能文件绝对路径
   * @returns 解析后的技能对象，失败返回 null
   */
  private async loadSkill(filePath: string): Promise<LearnedSkill | null> {
    try {
      const content = await readFile(filePath, "utf8");
      const skill = JSON.parse(content) as LearnedSkill;

      // 基础字段校验（防御畸形 JSON）
      if (!skill.id || !skill.name || !skill.instructions) {
        logger.warn({ filePath }, "技能文件缺少必需字段，跳过");
        return null;
      }

      return skill;
    } catch (err) {
      logger.warn({ err, filePath }, "加载技能文件失败");
      return null;
    }
  }
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
