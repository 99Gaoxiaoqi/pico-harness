import type { LLMProvider, Message } from "@pico/core";
import type { GoalEvaluation } from "./goal-manager.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_TOKENS = 1_024;
const MAX_RECENT_MESSAGES = 6;
const MAX_MESSAGE_CODE_UNITS = 500;
const MAX_MESSAGE_BYTES = 1_500;

const EVALUATOR_SYSTEM_PROMPT = `你是独立、只读的 Goal 验收器。你不能调用工具、执行操作或修改任务。
根据 Goal condition 和最近对话判断目标当前状态。只能使用明确可观察到的事实，不要仅因执行模型声称完成就判为 met。
只输出 JSON，字段为 met、impossible、progress、waiting、reason；前四项均为布尔值：
- met：condition 已满足
- impossible：存在明确且不可恢复的原因使 condition 无法满足
- progress：condition 未满足，但本轮有实质进展
- waiting：下一步必须等待用户、外部系统或未来时点
- reason：简短说明判断依据或等待原因`;

export interface GoalEvaluationOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface GoalEvaluationResult extends GoalEvaluation {
  readonly evaluatorFailed: boolean;
}

/** Independent no-tool Goal evaluation. Provider cancellation is awaited before returning. */
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
  const timeout = setTimeout(() => {
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
    clearTimeout(timeout);
    controller.signal.removeEventListener("abort", rejectOnAbort);
    options.signal?.removeEventListener("abort", abortFromCaller);
  }
}

function parseEvaluationResult(content: string): GoalEvaluationResult {
  try {
    const match = content.match(/\{[\s\S]*\}/u);
    if (!match) return failedEvaluation("评估器未返回 JSON");
    const parsed = JSON.parse(match[0]) as Record<string, unknown>;
    const flags = ["met", "impossible", "progress", "waiting"] as const;
    if (flags.some((flag) => typeof parsed[flag] !== "boolean"))
      return failedEvaluation("评估器结果缺少布尔判定字段");
    if (typeof parsed["reason"] !== "string") return failedEvaluation("评估器结果缺少 reason");
    return {
      met: parsed["met"] as boolean,
      impossible: parsed["impossible"] as boolean,
      progress: parsed["progress"] as boolean,
      waiting: parsed["waiting"] as boolean,
      evaluatorFailed: false,
      reason: truncateContextMessage(parsed["reason"] as string),
    };
  } catch {
    return failedEvaluation("评估器结果无法解析");
  }
}

function failedEvaluation(reason: string): GoalEvaluationResult {
  return { evaluatorFailed: true, reason };
}

function truncateContextMessage(value: string): string {
  let text = value.slice(0, MAX_MESSAGE_CODE_UNITS);
  while (Buffer.byteLength(text, "utf8") > MAX_MESSAGE_BYTES) text = text.slice(0, -1);
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
