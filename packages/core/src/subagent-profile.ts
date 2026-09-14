/** Stable profile identities shared by Graph contracts and the local protocol. */
export const SUBAGENT_PROFILES = ["local_read", "web_research", "implementation"] as const;
export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];

export const SUBAGENT_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];

/** Data-only preset shape; protocol validation and availability stay outside Core. */
export interface RuntimeSubagentPresetContract {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly profile: SubagentProfile;
  readonly connectionSlug: string;
  readonly model: string;
  readonly thinkingLevel?: SubagentThinkingLevel;
  readonly enabled: boolean;
}
