import type { LLMProvider, Message, Usage } from "@pico/core";
import type { GoalEvaluationOutcome } from "./goal-manager.js";
import { raceWithDeadlineReject } from "./deadline.js";

const EVALUATOR_TIMEOUT_MS = 30_000;
const MAX_RECENT_MESSAGES = 8;
const MAX_MESSAGE_CHARS = 800;

const EVALUATOR_SYSTEM_PROMPT = `你是独立的 Goal 验收器。你只读给定证据，不调用工具，也不修改任务。
必须逐项核对全部完成标准：只有每项都有直接证据时 outcome 才能是 "met"。
结果只能选一个：
- "met": 所有完成标准均有证据满足；evidence 必须按完成标准顺序提供一条对应证据
- "impossible": 存在明确、不可恢复的技术原因导致目标无法实现
- "progress": 目标未完成且无需等待；同时设置 progress=true/false，表示本轮是否有实质进展
- "waiting": 下一步必须等待用户、外部系统或未来时点
证据不足时使用 outcome="progress"、progress=false；不要把“工作模型声称完成”当作证据。
证据应引用可观察的文件、测试、命令结果或消息事实。
只输出 JSON：{"outcome":"met|impossible|progress|waiting","progress":boolean,"reason":"简短说明","evidence":["按完成标准顺序逐条对应的证据"]}`;

export interface GoalEvaluationTarget {
  readonly title: string;
  readonly description: string;
  readonly completionCriteria: readonly string[];
  readonly constraints?: readonly string[];
  readonly progress?: string;
  readonly evidence?: readonly string[];
}

export interface GoalEvaluationResult {
  readonly outcome: Exclude<GoalEvaluationOutcome, "unknown">;
  readonly progress: boolean;
  readonly reason: string;
  readonly evidence: readonly string[];
  readonly evaluatorFailed: boolean;
  readonly usage?: Usage;
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
    .map((message) => `${message.role}: ${message.content.slice(0, MAX_MESSAGE_CHARS)}`);
  const messages: Message[] = [
    { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `目标: ${goal.title}`,
        `描述: ${goal.description}`,
        `完成标准:\n${goal.completionCriteria.map((item, index) => `${index + 1}. ${item}`).join("\n")}`,
        ...(goal.constraints?.length
          ? [`约束:\n${goal.constraints.map((item) => `- ${item}`).join("\n")}`]
          : []),
        ...(goal.progress ? [`之前记录的进展: ${goal.progress}`] : []),
        ...(goal.evidence?.length
          ? [
              `之前各轮记录的证据（仅作上下文；本轮仍须核验完成标准）:\n${goal.evidence
                .slice(-30)
                .map((item, index) => `${index + 1}. ${item.slice(0, 500)}`)
                .join("\n")}`,
            ]
          : []),
        "\n本轮会话证据:",
        contextMessages.join("\n---\n"),
        "\n请按所有完成标准给出结论和证据摘要。",
      ].join("\n"),
    },
  ];
  try {
    const result = await raceWithDeadlineReject(
      provider.generate(messages, [], { purpose: "hook", ...(signal ? { signal } : {}) }),
      EVALUATOR_TIMEOUT_MS,
      () => new Error("评估器超时"),
    );
    const evaluation = parseEvaluationResult(result.content);
    if (
      evaluation.outcome === "met" &&
      evaluation.evidence.length < goal.completionCriteria.length
    ) {
      return { ...failedEvaluation(), ...(result.usage ? { usage: result.usage } : {}) };
    }
    return {
      ...evaluation,
      ...(result.usage ? { usage: result.usage } : {}),
    };
  } catch (error) {
    if (signal?.aborted) throw error;
    return failedEvaluation();
  }
}

function parseEvaluationResult(content: string): GoalEvaluationResult {
  try {
    const jsonMatch = content.match(/\{[\s\S]*\}/u);
    if (!jsonMatch) return failedEvaluation();
    const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
    const rawOutcome = parsed["outcome"];
    if (
      typeof rawOutcome !== "string" ||
      !["met", "impossible", "progress", "waiting"].includes(rawOutcome)
    )
      return failedEvaluation();
    const evidence = Array.isArray(parsed["evidence"])
      ? parsed["evidence"]
          .filter((item): item is string => typeof item === "string")
          .map((item) => item.trim().slice(0, 500))
          .filter(Boolean)
          .slice(0, 30)
      : [];
    return {
      outcome: rawOutcome as Exclude<GoalEvaluationOutcome, "unknown">,
      progress: parsed["progress"] === true,
      reason: typeof parsed["reason"] === "string" ? parsed["reason"].slice(0, 500) : "",
      evidence,
      evaluatorFailed: false,
    };
  } catch {
    return failedEvaluation();
  }
}

function failedEvaluation(): GoalEvaluationResult {
  return { outcome: "progress", progress: false, reason: "", evidence: [], evaluatorFailed: true };
}
