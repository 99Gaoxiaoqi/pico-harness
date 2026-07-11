const DELEGATION_TOOL_NAME = "delegate_task" as const;
const REQUIRED_COMPLETION_POLICY = "required" as const;

const CHINESE_AGENT = String.raw`(?:子代理|子\s*agents?|sub[\s-]?agents?|agents)`;
const ENGLISH_AGENT = String.raw`(?:sub[\s-]?agents?|agents)`;

const CHINESE_DISCUSSION_PATTERNS = [
  new RegExp(
    String.raw`(?:什么是|解释|介绍|讲讲|说说|原理|为什么|为何|怎么设计|如何设计|怎么工作|如何工作|区别|对比).{0,32}${CHINESE_AGENT}`,
    "iu",
  ),
  new RegExp(
    String.raw`${CHINESE_AGENT}.{0,32}(?:是什么|的原理|为什么|为何|怎么设计|如何设计|怎么工作|如何工作|有什么区别|有什么好处|适合什么|的优缺点)`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:是否应该|该不该|要不要|是否值得).{0,16}(?:使用|启用|调用)?${CHINESE_AGENT}`,
    "iu",
  ),
] as const;

const ENGLISH_DISCUSSION_PATTERNS = [
  new RegExp(
    String.raw`\b(?:what (?:is|are)|why|explain|describe|compare|how (?:does|do|is|are)|difference between)\b.{0,40}\b${ENGLISH_AGENT}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:should|would)\s+(?:i|we)\s+(?:use|call|run)\b.{0,20}\b${ENGLISH_AGENT}\b`,
    "iu",
  ),
] as const;

const EXPLICIT_BACKGROUND_PATTERNS = [
  new RegExp(
    String.raw`(?:后台|异步|不用等|无需等待|不要等待).{0,24}${CHINESE_AGENT}|${CHINESE_AGENT}.{0,24}(?:后台|异步|不用等|无需等待|不要等待)`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:background|asynchronously|do not wait|don't wait|without waiting)\b.{0,40}\b${ENGLISH_AGENT}\b|\b${ENGLISH_AGENT}\b.{0,40}\b(?:in the background|asynchronously|without waiting)\b`,
    "iu",
  ),
] as const;

const NEGATED_EXECUTION_PATTERNS = [
  /(?:不要|别|不必|无需|禁止).{0,20}(?:启动|调用|创建|派出|拉起|分派|委派|使用|用|让)/iu,
  /\b(?:do not|don't|never|must not)\b.{0,32}\b(?:spawn|launch|start|create|dispatch|run|call|use|have|ask)\b/iu,
] as const;

const CONDITIONAL_EXECUTION_PATTERNS = [
  /(?:如果|若|假如|必要时|视情况|可以|可考虑|有必要的话).{0,32}(?:启动|调用|创建|派出|拉起|分派|委派|使用|用|让)/iu,
  /\b(?:if|when necessary|if needed|optionally|may|might|could|can)\b.{0,40}\b(?:spawn|launch|start|create|dispatch|run|call|use|have|ask)\b/iu,
] as const;

const STRONG_EXECUTION_PATTERNS = [
  new RegExp(
    String.raw`(?:启动|调用|创建|派出|拉起|召唤|分派|委派|安排).{0,18}${CHINESE_AGENT}`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:请|帮我|麻烦|务必|必须|直接|先|现在).{0,12}(?:使用|用|让).{0,12}${CHINESE_AGENT}`,
    "iu",
  ),
  new RegExp(
    String.raw`让.{0,12}${CHINESE_AGENT}.{0,12}(?:处理|检查|阅读|分析|实现|修复|审查|调研|并行)`,
    "iu",
  ),
  new RegExp(
    String.raw`(?:使用|用).{0,12}${CHINESE_AGENT}.{0,16}(?:处理|检查|阅读|分析|实现|修复|审查|调研|开发|并行)`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:please\s+|must\s+|first\s+|now\s+|directly\s+)?(?:spawn|launch|start|create|dispatch|run|call)\b.{0,32}\b${ENGLISH_AGENT}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:please\s+|must\s+|first\s+|now\s+|directly\s+)(?:use|have|ask)\b.{0,24}\b${ENGLISH_AGENT}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\bdelegate\b.{0,40}\bto\s+(?:one\s+or\s+more\s+|multiple\s+|several\s+|\d+\s+)?${ENGLISH_AGENT}\b`,
    "iu",
  ),
  new RegExp(
    String.raw`\b(?:use|have|ask)\b.{0,24}\b${ENGLISH_AGENT}\b.{0,16}\b(?:to|for)\b`,
    "iu",
  ),
] as const;

const MULTIPLE_PATTERNS = [
  /(?:多个|几个|两个|三个|四个|五个|一个或多个|一组).{0,8}(?:子代理|子\s*agents?|sub[\s-]?agents?|agents?)/iu,
  /\b(?:multiple|several|many|two|three|four|five|one or more|[2-9]\d*)\s+(?:sub[\s-]?agents?|agents?)\b/iu,
] as const;

const SINGLE_PATTERNS = [
  /(?:一个|单个).{0,8}(?:子代理|子\s*agent|sub[\s-]?agent|agent)/iu,
  /\b(?:one|a single)\s+(?:sub[\s-]?agent|agent)\b/iu,
] as const;

export type RequestedDelegationCount = "single" | "multiple" | "unspecified";

export interface ExplicitDelegationIntent {
  readonly kind: "explicit-delegation";
  readonly requestedCount: RequestedDelegationCount;
}

export type FirstTurnDelegationPolicy =
  | {
      readonly kind: "none";
    }
  | {
      readonly kind: "required-first-delegation";
      readonly intent: ExplicitDelegationIntent;
      readonly toolName: typeof DELEGATION_TOOL_NAME;
      readonly completionPolicy: typeof REQUIRED_COMPLETION_POLICY;
      readonly exclusive: true;
      readonly hiddenConstraint: string;
    };

/**
 * 识别用户是否在最新一条输入中明确要求执行子代理委派。
 *
 * 这是一个保守的语法策略：讨论子代理概念、实现或“是否应该使用”
 * 不会触发；只有同时出现代理对象和明确执行动词才返回意图。
 */
export function detectExplicitDelegationIntent(
  latestUserInput: string,
): ExplicitDelegationIntent | null {
  const normalized = normalizeInput(latestUserInput);
  if (normalized.length === 0) return null;
  // 条件前置和后置的后台语义可能被逗号/then 分开，必须先在
  // 整条用户消息上判断，否则会把“如果失败再启动”或“启动后放到后台”
  // 误升级为必须立即等待的 required 委派。
  if (
    CONDITIONAL_EXECUTION_PATTERNS.some((pattern) => pattern.test(normalized)) ||
    EXPLICIT_BACKGROUND_PATTERNS.some((pattern) => pattern.test(normalized))
  ) {
    return null;
  }

  const actionableClauses = splitClauses(normalized).filter(
    (clause) =>
      STRONG_EXECUTION_PATTERNS.some((pattern) => pattern.test(clause)) &&
      !isDiscussionOnly(clause) &&
      !EXPLICIT_BACKGROUND_PATTERNS.some((pattern) => pattern.test(clause)) &&
      !NEGATED_EXECUTION_PATTERNS.some((pattern) => pattern.test(clause)) &&
      !CONDITIONAL_EXECUTION_PATTERNS.some((pattern) => pattern.test(clause)),
  );
  if (actionableClauses.length === 0) return null;

  return {
    kind: "explicit-delegation",
    requestedCount: detectRequestedCount(actionableClauses.join(" ")),
  };
}

/** 从最新用户输入构造可在模型首轮前注入的类型安全策略。 */
export function createFirstTurnDelegationPolicy(
  latestUserInput: string,
): FirstTurnDelegationPolicy {
  const intent = detectExplicitDelegationIntent(latestUserInput);
  if (intent === null) return { kind: "none" };

  return {
    kind: "required-first-delegation",
    intent,
    toolName: DELEGATION_TOOL_NAME,
    completionPolicy: REQUIRED_COMPLETION_POLICY,
    exclusive: true,
    hiddenConstraint: buildRequiredFirstDelegationConstraint(),
  };
}

/**
 * 首轮隐藏约束不带用户文本，可作为 system/developer 附加消息注入。
 * 它只规定调度语义，具体任务仍由原始用户消息提供。
 */
export function buildRequiredFirstDelegationConstraint(): string {
  return [
    "[HIDDEN FIRST-TURN DELEGATION POLICY]",
    "The latest user message explicitly requires subagent delegation.",
    'Your first and only action in this response must be exactly one delegate_task tool call with completion_policy="required".',
    "Do not emit assistant prose and do not call any ordinary tool before or alongside delegate_task.",
    "Put every requested subtask into that single delegate_task call; the delegated agents must discover the project structure themselves.",
    "Wait for all required delegated agents to finish before continuing with synthesis or further tool use.",
  ].join("\n");
}

function normalizeInput(input: string): string {
  return input.normalize("NFKC").replace(/\s+/gu, " ").trim();
}

function splitClauses(input: string): string[] {
  return input
    .split(/[，。！？；,.!?;]|(?:然后|随后|接着)|\bthen\b/iu)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isDiscussionOnly(input: string): boolean {
  return [...CHINESE_DISCUSSION_PATTERNS, ...ENGLISH_DISCUSSION_PATTERNS].some((pattern) =>
    pattern.test(input),
  );
}

function detectRequestedCount(input: string): RequestedDelegationCount {
  if (MULTIPLE_PATTERNS.some((pattern) => pattern.test(input))) return "multiple";
  if (SINGLE_PATTERNS.some((pattern) => pattern.test(input))) return "single";
  return "unspecified";
}
