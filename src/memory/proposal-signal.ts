import type { MemorySignalDecision, MemorySignalKind } from "./proposal-contracts.js";

const ONE_TIME_PATTERNS = [
  /(?:这|本)(?:一)?次/iu,
  /仅(?:限)?这一次/iu,
  /(?:现在|先|暂时|临时|今天)(?:先|帮我|请)?/iu,
  /\b(?:just\s+this\s+once|for\s+this\s+(?:time|task)|temporarily|right\s+now|today)\b/iu,
] as const;

const SIGNAL_PATTERNS: ReadonlyArray<{
  readonly kind: MemorySignalKind;
  readonly patterns: readonly RegExp[];
}> = [
  {
    kind: "explicit",
    patterns: [
      /(?:请)?记住/iu,
      /(?:请)?记下/iu,
      /存为(?:长期)?记忆/iu,
      /\b(?:remember|save\s+this\s+for\s+later)\b/iu,
    ],
  },
  {
    kind: "preference",
    patterns: [
      /我(?:更)?(?:喜欢|偏好|习惯|不喜欢)/iu,
      /(?:以后|今后|接下来|默认)(?:都|请|使用|不要)?/iu,
      /(?:总是|每次|永远|不要再)/iu,
      /\b(?:i\s+prefer|my\s+preference|from\s+now\s+on|always|never)\b/iu,
    ],
  },
  {
    kind: "correction",
    patterns: [
      /(?:更正|纠正|说错了|不是.{0,40}而是)/iu,
      /\b(?:correction|actually|not\s+.+\s+but)\b/iu,
    ],
  },
  {
    kind: "project_fact",
    patterns: [
      /(?:这个|本)(?:项目|仓库|工程).{0,40}(?:使用|采用|命令|规则|是)/iu,
      /(?:项目|仓库)(?:的|中).{0,40}(?:默认|固定|统一|必须)/iu,
      /\b(?:this\s+(?:project|repository)|the\s+(?:project|repo))\b.{0,60}\b(?:uses?|requires?|command|convention)\b/iu,
    ],
  },
];

/** Deterministic, deliberately conservative gate before any model call. */
export function detectStableMemorySignal(content: string): MemorySignalDecision {
  const normalized = content.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  const signals = SIGNAL_PATTERNS.flatMap(({ kind, patterns }) =>
    patterns.some((pattern) => pattern.test(normalized)) ? [kind] : [],
  );
  const hasOneTimeMarker = ONE_TIME_PATTERNS.some((pattern) => pattern.test(normalized));
  const hasExplicitDurability = signals.includes("explicit") || signals.includes("preference");
  if (hasOneTimeMarker && !hasExplicitDurability) {
    return { eligible: false, signals, reason: "one_time_request" };
  }
  if (signals.length === 0) {
    return { eligible: false, signals: [], reason: "no_stable_signal" };
  }
  return { eligible: true, signals: [...new Set(signals)], reason: "durable_signal" };
}
