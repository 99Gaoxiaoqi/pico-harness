import type { LLMProvider, Message } from "@pico/core";
import { raceWithDeadlineReject } from "./deadline.js";

const EVALUATOR_TIMEOUT_MS = 30_000;
const MAX_RECENT_MESSAGES = 6;
const MAX_MESSAGE_CHARS = 500;

const EVALUATOR_SYSTEM_PROMPT = `你是一个严格的目标完成评估器。
判断工作模型的产出是否达成了给定目标。

判断规则：
- met=true 仅当有明确证据表明目标已完全达成（如测试通过、文件已修改、命令成功执行）
- impossible=true 当目标因技术原因无法达成
- progress=true 当最近一轮有实质进展（不是原地打转）
- 不确定时全部返回 false（保守判断）

只输出一个 JSON 对象，不要其他内容：
{"met": boolean, "impossible": boolean, "progress": boolean, "reason": "简短原因(≤120字)"}`;

/** The evaluator needs only user-visible Goal facts, not the Engine state machine. */
export interface GoalEvaluationTarget {
  readonly title: string;
  readonly description: string;
  readonly progress?: string;
}

export interface GoalEvaluationResult {
  met: boolean;
  impossible: boolean;
  progress: boolean;
  reason: string;
  /** Provider, timeout, or model-output failure; callers intentionally fail open. */
  evaluatorFailed: boolean;
}

export async function evaluateGoalCompletion(
  provider: LLMProvider,
  goal: GoalEvaluationTarget,
  recentMessages: readonly Message[],
  signal?: AbortSignal,
): Promise<GoalEvaluationResult> {
  const contextMessages = recentMessages
    .filter((message) => message.role === "user" || message.role === "assistant")
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => message.content.slice(0, MAX_MESSAGE_CHARS));

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
    const result = await raceWithDeadlineReject(
      provider.generate(messages, [], { purpose: "hook", ...(signal ? { signal } : {}) }),
      EVALUATOR_TIMEOUT_MS,
      () => new Error("评估器超时"),
    );
    return parseEvaluationResult(result.content);
  } catch {
    return failedEvaluation();
  }
}

function parseEvaluationResult(content: string): GoalEvaluationResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/u);
    if (!jsonMatch) return failedEvaluation();
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    return {
      met: parsed["met"] === true,
      impossible: parsed["impossible"] === true,
      progress: parsed["progress"] === true,
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 200) : "",
      evaluatorFailed: false,
    };
  } catch {
    return failedEvaluation();
  }
}

function failedEvaluation(): GoalEvaluationResult {
  return { met: false, impossible: false, progress: false, reason: "", evaluatorFailed: true };
}
