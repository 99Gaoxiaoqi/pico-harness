import type {
  MemorySignalDecision,
  MemorySignalKind,
  RawMemoryProposalCandidate,
} from "./proposal-contracts.js";

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

const EXPLICIT_DIRECTIVE_RE =
  /^(?:(?:请)?(?:记住|记下)(?:这(?:一点|件事)?)?|(?:please\s+)?remember(?:\s+that)?|save\s+this\s+for\s+later)\s*[:：]?/iu;
const NEGATED_MEMORY_RE =
  /(?:(?:请)?(?:不要|别|无需|不必).{0,12}(?:记住|记下|保存|存为)|\b(?:do\s+not|don't|never|should\s+not|shouldn't)\b.{0,24}\b(?:remember|save)\b)/iu;
const DISCUSSION_MEMORY_RE =
  /(?:(?:如何|怎么|是否|能否|该不该|讨论|解释|示例|例如|引用|原话).{0,48}(?:记住|记下|记忆)|\b(?:how\s+(?:can|to)|whether|discuss|explain|example|quote)\b.{0,64}\b(?:remember|memory|save)\b)/iu;
const QUOTED_MEMORY_RE = /(?:["“‘'].{0,80}(?:记住|记下|remember|save).{0,80}["”’'])/iu;

/** Deterministic, deliberately conservative gate before any model call. */
export function detectStableMemorySignal(content: string): MemorySignalDecision {
  const normalized = content.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  const explicitDirective = EXPLICIT_DIRECTIVE_RE.test(normalized);
  if (
    NEGATED_MEMORY_RE.test(normalized) ||
    (!explicitDirective &&
      (/[?？]/u.test(normalized) ||
        DISCUSSION_MEMORY_RE.test(normalized) ||
        QUOTED_MEMORY_RE.test(normalized)))
  ) {
    return { eligible: false, signals: [], reason: "no_stable_signal" };
  }
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

const DETERMINISTIC_MAX_CONTENT_LENGTH = 500;
const AMBIGUOUS_REFERENCE_RE =
  /(?:\b(?:it|that|those|above|earlier|previous)\b|(?:它|那个|这些|那些|上述|前面|刚才|之前|这样))/iu;
const MULTI_FACT_RE =
  /(?:\b(?:also|additionally|as\s+well\s+as)\b|(?:并且|而且|另外|同时|以及|还要|以下几点))/iu;
const PROJECT_FACT_RE =
  /(?:项目|仓库|工程).{0,48}(?:规定|约定|规则|默认|固定|统一|必须|使用|采用)|\b(?:project|repository|repo)\b.{0,64}\b(?:uses?|requires?|must|convention|rule)\b/iu;
const REFERENCE_RE =
  /(?:\b(?:branch|path|file|url)\b|(?:分支|路径|文件|地址|位于)|(?:^|\s)(?:docs\/|\.?\.?\/)[^\s]+)/iu;
const PREFERENCE_RE =
  /(?:我(?:更)?(?:喜欢|偏好|习惯|不喜欢)|(?:以后|今后|接下来|默认|总是|每次|永远|不要再)|\b(?:i\s+prefer|my\s+preference|from\s+now\s+on|always|never|do\s+not)\b)/iu;
const CORRECTION_RE = /(?:^(?:更正|纠正)\s*[:：]?|\bcorrection\s*:)/iu;
const PROMPT_INJECTION_MARKER_RE =
  /(?:\bignore\s+(?:all\s+)?(?:previous|prior|above)\s+(?:instructions?|rules?|prompts?)\b|忽略.{0,20}(?:之前|上面|所有).{0,20}(?:指令|规则|提示))/iu;

/**
 * Converts only a single, explicit user-authored statement without semantic rewriting.
 * Ambiguous references and multi-fact statements deliberately fall back to the model.
 */
export function deriveDeterministicMemoryProposal(
  content: string,
  evidenceEventIds: readonly string[],
): RawMemoryProposalCandidate | undefined {
  const normalized = content.normalize("NFKC").replaceAll(/\s+/gu, " ").trim();
  const decision = detectStableMemorySignal(normalized);
  if (!decision.eligible || normalized.length > DETERMINISTIC_MAX_CONTENT_LENGTH) return undefined;
  if (MULTI_FACT_RE.test(normalized)) return undefined;
  if (/[?？]/u.test(normalized)) return undefined;

  const extracted = extractExplicitStatement(normalized);
  if (!extracted || extracted.length < 2) return undefined;
  if (AMBIGUOUS_REFERENCE_RE.test(extracted) && !PROMPT_INJECTION_MARKER_RE.test(extracted)) {
    return undefined;
  }
  const kind = deterministicKind(normalized, extracted, decision.signals);
  return {
    kind,
    title: deterministicTitle(kind, extracted),
    content: extracted,
    reason: "用户明确表达的稳定记忆（本地规则提案）",
    confidence: 0.99,
    evidenceEventIds: [...evidenceEventIds],
  };
}

function extractExplicitStatement(content: string): string | undefined {
  const explicit = content.match(
    /^(?:(?:请)?(?:记住|记下)(?:这(?:一点|件事)?)?|(?:please\s+)?remember(?:\s+that)?|save\s+this\s+for\s+later)\s*[:：]?\s*(.+)$/iu,
  )?.[1];
  if (explicit) return cleanStatement(explicit);

  const correction = content.match(/^(?:更正|纠正|correction)\s*[:：]?\s*(.+)$/iu)?.[1];
  if (correction) return cleanStatement(correction);

  if (PROJECT_FACT_RE.test(content) || PREFERENCE_RE.test(content)) {
    return cleanStatement(content);
  }
  return undefined;
}

function cleanStatement(value: string): string {
  return value
    .replaceAll(/\s+/gu, " ")
    .replace(/\s+as\s+(?:its|the)\s+[^.]{0,40}\s+command\.?$/iu, "")
    .trim();
}

function deterministicKind(
  original: string,
  statement: string,
  signals: readonly MemorySignalKind[],
): RawMemoryProposalCandidate["kind"] {
  if (CORRECTION_RE.test(original)) {
    // A correction that clearly updates a preference remains a preference so title-based
    // conflict detection can compare it with the active preference.
    return PREFERENCE_RE.test(statement) ? "preference" : "correction";
  }
  if (PROJECT_FACT_RE.test(statement)) return "project_fact";
  if (REFERENCE_RE.test(statement)) return "reference";
  if (signals.includes("preference") || PREFERENCE_RE.test(statement)) return "preference";
  return "reference";
}

function deterministicTitle(kind: RawMemoryProposalCandidate["kind"], statement: string): string {
  if (/(?:中文|英文|chinese|english).{0,12}(?:回复|回答|reply|answer)/iu.test(statement)) {
    return /[\u3400-\u9fff]/u.test(statement) ? "回复语言" : "Response language";
  }
  if (
    /(?:(?:pnpm|npm|yarn|bun).{0,20}(?:依赖|package|manager)|(?:pnpm|npm|yarn|bun)\s+instead\s+of\s+(?:pnpm|npm|yarn|bun))/iu.test(
      statement,
    )
  ) {
    return /[\u3400-\u9fff]/u.test(statement) ? "包管理器" : "Package manager";
  }
  if (/(?:时区|timezone)/iu.test(statement)) {
    return /[\u3400-\u9fff]/u.test(statement) ? "用户时区" : "Timezone";
  }
  if (/(?:缩进|indentation|spaces?.{0,12}tabs?)/iu.test(statement)) return "Indentation";
  const prefix =
    kind === "preference"
      ? "偏好"
      : kind === "correction"
        ? "更正"
        : kind === "project_fact"
          ? "项目约定"
          : "参考";
  return `${prefix}: ${[...statement].slice(0, 48).join("")}`;
}
