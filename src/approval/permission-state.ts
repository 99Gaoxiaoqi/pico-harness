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
