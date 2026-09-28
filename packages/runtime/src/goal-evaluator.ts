import type { LLMProvider, Message } from "@pico/core";
import type { GoalEvaluation } from "./goal-manager.js";
import { scheduleDeadline } from "./deadline.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_RECENT_MESSAGES = 6;
const MAX_MESSAGE_CODE_UNITS = 500;
const MAX_MESSAGE_BYTES = 1_500;

const EVALUATOR_SYSTEM_PROMPT = `你是独立、只读的 Goal 验收器。你不能调用工具、执行操作或修改任务。
根据 Goal condition 和最近对话判断目标当前状态。只输出以下格式的 JSON：
{"met": boolean, "impossible": boolean, "progress": boolean, "waiting": boolean, "reason": "一句话"}
- met：仅在有清晰、具体证据表明 condition 全部满足时为 true。核验范围须覆盖要求，不接受缩小范围的替代结果。
- impossible：仅在目标确实不可实现时为 true，困难本身不构成不可实现。
- progress：本轮有可衡量的进展时为 true；重复操作、原地打转或没有有效工作时为 false。
- waiting：正在合理等待无法自行加速的外部事件（CI、部署、远程队列、人工审查）时为 true。
- reason：简短、具体、可指导下一轮的一句话，少于 120 字。
对 met 和 impossible 保守判断。不确定时，四个布尔字段均为 false。`;

export interface GoalEvaluationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface GoalEvaluationResult extends GoalEvaluation {
  readonly evaluatorFailed: boolean;
}

/** Independent no-tool evaluation; aborts the physical request on cancellation or deadline. */
export async function evaluateGoal(
  provider: LLMProvider,
  condition: string,
  recentMessages: readonly Message[],
  options: GoalEvaluationOptions = {},
): Promise<GoalEvaluationResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0)
    throw new RangeError("Goal evaluator timeoutMs 必须是正整数");

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) abortFromCaller();
  else options.signal?.addEventListener("abort", abortFromCaller, { once: true });
  let rejectAborted!: (reason: unknown) => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const rejectOnAbort = () =>
    rejectAborted(controller.signal.reason ?? new DOMException("Aborted", "AbortError"));
  controller.signal.addEventListener("abort", rejectOnAbort, { once: true });
  if (controller.signal.aborted) rejectOnAbort();
  const timeout = scheduleDeadline(() => {
    timedOut = true;
    controller.abort(new DOMException("Goal evaluator timed out", "TimeoutError"));
  }, timeoutMs);
  const context = recentMessages
    .filter(
      (message) =>
        (message.role === "user" || message.role === "assistant") &&
        !message.toolCallId &&
        !(message.toolCalls && message.toolCalls.length > 0),
    )
    .slice(-MAX_RECENT_MESSAGES)
    .map((message) => `${message.role}: ${truncateContextMessage(message.content)}`);
  const messages: Message[] = [
    { role: "system", content: EVALUATOR_SYSTEM_PROMPT },
    {
      role: "user",
      content: [
        `Goal condition:\n${truncateContextMessage(condition)}`,
        "最近对话：",
        context.join("\n---\n"),
        "请给出独立判断和简短理由。",
      ].join("\n"),
    },
  ];

  try {
    const generation = Promise.resolve().then(() =>
      provider.generate(messages, [], {
        purpose: "goal_evaluation",
        signal: controller.signal,
        timeoutMs,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
      }),
    );
    const result = await Promise.race([generation, aborted]);
    if (timedOut) return failedEvaluation("评估器超时");
    return parseEvaluationResult(result.content);
  } catch (error) {
    if (options.signal?.aborted)
      throw options.signal.reason ?? new DOMException("Aborted", "AbortError");
    return failedEvaluation(timedOut ? "评估器超时" : summarizeError(error));
  } finally {
    timeout.cancel();
    controller.signal.removeEventListener("abort", rejectOnAbort);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseEvaluationResult(content: string): GoalEvaluationResult {
  try {
    const match = content.match(/\{[^{}]*"met"[^{}]*\}/su) ?? content.match(/\{[\s\S]*?\}/u);
    if (!match) return failedEvaluation("评估器未返回 JSON");
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const flags = ["met", "impossible", "progress", "waiting"] as const;
    if (flags.some((flag) => parsed[flag] !== undefined && typeof parsed[flag] !== "boolean"))
      return failedEvaluation("评估器结果包含非布尔判定字段");
    return {
      met: parsed["met"] === true,
      impossible: parsed["impossible"] === true,
      progress: parsed["progress"] === true,
      waiting: parsed["waiting"] === true,
      evaluatorFailed: false,
      reason:
        typeof parsed["reason"] === "string" && parsed["reason"].trim()
          ? truncateContextMessage(parsed["reason"], 200, 600)
          : "未提供原因",
    };
  } catch {
    return failedEvaluation("评估器结果无法解析");
  }
}

function failedEvaluation(reason: string): GoalEvaluationResult {
  return { evaluatorFailed: true, reason };
}

function truncateContextMessage(
  value: string,
  maxCodeUnits = MAX_MESSAGE_CODE_UNITS,
  maxBytes = MAX_MESSAGE_BYTES,
): string {
  let text = value.slice(0, maxCodeUnits);
  while (Buffer.byteLength(text, "utf8") > maxBytes) text = text.slice(0, -1);
  if (text.length > 0) {
    const last = text.charCodeAt(text.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) text = text.slice(0, -1);
  }
  return text;
}

function summarizeError(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return truncateContextMessage(error.message);
  return "评估器暂不可用";
}
