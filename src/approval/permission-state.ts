export type PermissionRuleDecision = "allow" | "ask" | "deny";

export interface PermissionRule {
  decision: PermissionRuleDecision;
  label: string;
  tool?: string;
  pattern?: string;
  source?: string;
  reason?: string;
}

export interface PermissionRuleBuckets {
  allow: PermissionRule[];
  ask: PermissionRule[];
  deny: PermissionRule[];
}

export interface PermissionRecentDenial {
  tool: string;
  target: string;
  reason?: string;
  deniedAt?: string;
}

export interface PermissionState {
  mode: string;
  rules: PermissionRuleBuckets;
  recentDenials: PermissionRecentDenial[];
}

export type PermissionRuleInput =
  | string
  | {
      label?: string;
      tool?: string;
      pattern?: string;
      source?: string;
      reason?: string;
    };

export interface PermissionRulesInput {
  allow?: readonly PermissionRuleInput[];
  ask?: readonly PermissionRuleInput[];
  deny?: readonly PermissionRuleInput[];
}

export interface PermissionStateInput {
  mode?: string;
  rules?: PermissionRulesInput;
  recentDenials?: readonly PermissionRecentDenial[];
  maxRecentDenials?: number;
}

export function createPermissionState(input: PermissionStateInput = {}): PermissionState {
  const maxRecentDenials = input.maxRecentDenials ?? 5;
  return {
    mode: input.mode ?? "ask",
    rules: {
      allow: normalizeRules("allow", input.rules?.allow ?? []),
      ask: normalizeRules("ask", input.rules?.ask ?? []),
      deny: normalizeRules("deny", input.rules?.deny ?? []),
    },
    recentDenials: [...(input.recentDenials ?? [])]
      .sort((left, right) => compareDeniedAtDesc(left, right))
      .slice(0, maxRecentDenials)
      .map((denial) => ({ ...denial })),
  };
}

function normalizeRules(
  decision: PermissionRuleDecision,
  rules: readonly PermissionRuleInput[],
): PermissionRule[] {
  return rules.map((rule) => normalizeRule(decision, rule));
}

function normalizeRule(
  decision: PermissionRuleDecision,
  rule: PermissionRuleInput,
): PermissionRule {
  if (typeof rule === "string") {
    return { decision, label: rule };
  }

  const inferredLabel = [rule.tool, rule.pattern].filter(Boolean).join(" ");
  const label = rule.label ?? (inferredLabel || "(unnamed rule)");
  return {
    decision,
    label,
    ...(rule.tool ? { tool: rule.tool } : {}),
    ...(rule.pattern ? { pattern: rule.pattern } : {}),
    ...(rule.source ? { source: rule.source } : {}),
    ...(rule.reason ? { reason: rule.reason } : {}),
  };
}

function compareDeniedAtDesc(left: PermissionRecentDenial, right: PermissionRecentDenial): number {
  const leftTime = left.deniedAt ? Date.parse(left.deniedAt) : 0;
  const rightTime = right.deniedAt ? Date.parse(right.deniedAt) : 0;
  return rightTime - leftTime;
}
