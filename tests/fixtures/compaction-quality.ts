/**
 * 语义压缩质量评估 fixture:case + gold anchor + precision/recall 评分。
 *
 * 照搬 memory-quality.ts 的 case-based 评分模式,用于真实大模型验收压缩摘要的保真度。
 * 一个 case = 一段长对话历史 + 一组必须出现在摘要里的 gold anchor(关键事实)。
 * 评分:对真实模型生成的摘要做 anchor 匹配,算 recall(关键事实保留率)。
 */

import type { Message } from "../../src/schema/message.js";

/** anchor 类别:用于区分必须保留的事实类型 */
export type CompactionAnchorCategory =
  | "file" // 文件路径
  | "decision" // 技术决策
  | "error" // 报错原文/错误码
  | "task" // 任务目标/子任务
  | "constraint"; // 约束条件/规范

/** 单个 gold anchor:必须出现在压缩摘要里的关键事实 */
export interface CompactionAnchor {
  /** 匹配模式:字符串(子串匹配)或正则 */
  readonly pattern: RegExp | string;
  readonly category: CompactionAnchorCategory;
  /** 人类可读描述,用于失败诊断 */
  readonly description: string;
}

/** 单个测试 case:长对话场景 + gold anchor 集合 */
export interface CompactionQualityCase {
  readonly id: string;
  readonly scenario: string;
  readonly history: readonly Message[];
  /** 必须保留在摘要里的关键事实 anchor */
  readonly gold: readonly CompactionAnchor[];
}

/** 评分结果 */
export interface CompactionQualityScore {
  readonly totalAnchors: number;
  readonly matchedAnchors: number;
  readonly recall: number;
  readonly matchedCategories: Set<CompactionAnchorCategory>;
  readonly unmatchedDescriptions: readonly string[];
}

/** 检查 anchor 是否匹配摘要文本 */
function anchorMatches(summary: string, anchor: CompactionAnchor): boolean {
  if (typeof anchor.pattern === "string") {
    return summary.includes(anchor.pattern);
  }
  return anchor.pattern.test(summary);
}

/**
 * 评分:对真实模型生成的摘要做 gold anchor 匹配。
 * recall = 匹配到的 anchor 数 / 总 anchor 数。
 */
export function scoreCompactionQuality(
  summary: string,
  gold: readonly CompactionAnchor[],
): CompactionQualityScore {
  const matchedCategories = new Set<CompactionAnchorCategory>();
  const unmatchedDescriptions: string[] = [];
  let matched = 0;
  for (const anchor of gold) {
    if (anchorMatches(summary, anchor)) {
      matched++;
      matchedCategories.add(anchor.category);
    } else {
      unmatchedDescriptions.push(anchor.description);
    }
  }
  const total = gold.length;
  return {
    totalAnchors: total,
    matchedAnchors: matched,
    recall: total === 0 ? 0 : matched / total,
    matchedCategories,
    unmatchedDescriptions,
  };
}

/**
 * 断言质量阈值。默认 recall >= 0.8(关键事实保留 80% 以上)。
 * recall 设 0.8 而非 0.95:真实模型摘要有正常波动,留余量。
 */
export function assertCompactionQualityThresholds(
  score: CompactionQualityScore,
  options: {
    readonly minimumRecall?: number;
    readonly requiredCategories?: readonly CompactionAnchorCategory[];
  } = {},
): void {
  const minimumRecall = options.minimumRecall ?? 0.8;
  if (score.recall < minimumRecall) {
    throw new Error(
      `压缩摘要 recall ${score.recall.toFixed(2)} 低于阈值 ${minimumRecall}。` +
        `未匹配的 anchor:${score.unmatchedDescriptions.join("; ")}`,
    );
  }
  for (const category of options.requiredCategories ?? []) {
    if (!score.matchedCategories.has(category)) {
      throw new Error(`压缩摘要未覆盖必需类别 ${category}`);
    }
  }
}
