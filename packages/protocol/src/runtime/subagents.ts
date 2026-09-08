import type { JsonObject } from "./base.js";

/** Stable model presets; capability definitions and credentials remain Host-owned. */
export const SUBAGENT_PROFILES = ["local_read", "web_research", "implementation"] as const;
export type SubagentProfile = (typeof SUBAGENT_PROFILES)[number];
export const SUBAGENT_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type SubagentThinkingLevel = (typeof SUBAGENT_THINKING_LEVELS)[number];
export const MAX_SUBAGENT_PRESETS = 64;
export const SUBAGENT_PRESET_ID_MAX_CHARS = 128;
export const SUBAGENT_PRESET_NAME_MAX_CHARS = 128;
export const SUBAGENT_PRESET_DESCRIPTION_MAX_CHARS = 1000;

export type RuntimeSubagentPreset = JsonObject & {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly profile: SubagentProfile;
  /** Pico Provider ID is the stable counterpart of Maka's connection slug. */
  readonly connectionSlug: string;
  readonly model: string;
  /** Absent means model default, not the parent's thinking level. */
  readonly thinkingLevel?: SubagentThinkingLevel;
  readonly enabled: boolean;
};

export type RuntimeSubagentAvailability =
  | { readonly status: "available" }
  | { readonly status: "unavailable"; readonly reason: string };

export type RuntimeConfiguredSubagent = RuntimeSubagentPreset & {
  readonly availability: RuntimeSubagentAvailability;
};

export type RuntimeSubagentConnection = JsonObject & {
  readonly id: string;
  readonly name: string;
  readonly enabled: boolean;
  readonly retired?: boolean;
  readonly models: readonly {
    readonly id: string;
    readonly thinkingLevels: readonly SubagentThinkingLevel[];
    readonly offerable: boolean;
  }[];
};

export type RuntimeSubagentSettingsSnapshot = {
  readonly presets: readonly RuntimeConfiguredSubagent[];
  readonly connections: readonly RuntimeSubagentConnection[];
  readonly revision: string;
};

export function isSafeSubagentPresetId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 &&
    value.length <= SUBAGENT_PRESET_ID_MAX_CHARS && /^[A-Za-z0-9._:-]+$/.test(value);
}
