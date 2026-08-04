/**
 * Goal 完成评估器：用独立 LLM 调用判断目标是否真的达成。
 *
 * 设计参考 maka-agent 的 goal-evaluator.ts：
 * - 用会话同款模型（不切换模型），但通过 purpose:"hook" 标记流量
 * - 保守判断：不确定时 met=false，让 Agent 继续工作
 * - 失败时 fail-open（不阻塞 Agent 退出）
 *
 * 触发时机：连续无进展 ≥ STALL_EVALUATOR_THRESHOLD(3) 轮时，
 * 在延续协调器决定是否续行前调用一次。
 */

import type { LLMProvider } from "../provider/interface.js";
import type { Goal } from "./goal-manager.js";
import type { Message } from "../schema/message.js";

const EVALUATOR_TIMEOUT_MS = 30_000;
const MAX_RECENT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;

const EVALUATOR_SYSTEM_PROMPT = `你是一个严格的目标完成评估器。
判断工作模型的产出是否达成了给定目标。

判断规则：
- met=true 仅当有明确证据表明目标已完全达成（如测试通过、文件已修改、命令成功执行）
- impossible=true 当目标因技术原因无法达成
- progress=true 当最近一轮有实质进展（不是原地打转）
- 不确定时全部返回 false（���守判断）

只输出一个 JSON 对象，不要其他内容：
{"met": boolean, "impossible": boolean, "progress": boolean, "reason": "简短原因(≤120字)"}`;

export interface GoalEvaluationResult {
  /** 目标是否已达成 */
  met: boolean;
  /** 目标是否不可能达成 */
  impossible: boolean;
  /** 最近一轮是否有实质进展 */
  progress: boolean;
  /** 判断理由 */
  reason: string;
  /** 评估器是否超时或解析失败（fail-open） */
  evaluatorFailed: boolean;
}

/**
 * 评估目标是否已达成。
 *
 * 输入：goal 描述 + 最近 6 条对话消息（每条截断 500 字符）
 * 输出：JSON {met, impossible, progress, reason}
 * 失败：返回 evaluatorFailed=true（fail-open，不阻塞退出）
 */
export async function evaluateGoalCompletion(
  provider: LLMProvider,
  goal: Goal,
  recentMessages: readonly Message[],
  signal?: AbortSignal,
): Promise<GoalEvaluationResult> {
  const contextMessages = recentMessages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-MAX_RECENT_MESSAGES)
    .map((m) => m.content.slice(0, MAX_MESSAGE_CHARS));

  const messages: Message[] = [
    { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `目标: ${goal.title}`,
        `描述: ${goal.description}`,
        ...(goal.progress ? [`当前进度: ${goal.progress}`] : []),
        "",
        "最近工作记录:",
        contextMessages.join("\n---\n"),
        "",
        "请判断目标是否已达成。",
      ].join("\n"),
    },
  ];

  try {
    const result = await Promise.race([
      provider.generate(messages, [], { signal, purpose: "hook" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("评估器超时")), EVALUATOR_TIMEOUT_MS),
      ),
    ]);
    return parseEvaluationResult(result.content);
  } catch {
    // 超时或调用失败 → fail-open
    return {
      met: false,
      impossible: false,
      progress: false,
      reason: "",
      evaluatorFailed: true,
    };
  }
}

function parseEvaluationResult(content: string): GoalEvaluationResult {
  const empty: GoalEvaluationResult = {
    met: false,
    impossible: false,
    progress: false,
    reason: "",
    evaluatorFailed: true,
  };

  try {
    // 提取 JSON（模型可能包裹在 markdown 代码块中）
    const jsonMatch = content.match(/\{[\s\S]*\}/u);
    if (!jsonMatch) return empty;

    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;

    return {
      met: parsed["met"] === true,
      impossible: parsed["impossible"] === true,
      progress: parsed["progress"] === true,
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 200) : "",
      evaluatorFailed: false,
    };
  } catch {
    return empty;
  }
}
