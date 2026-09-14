/** Stable business attribution for one provider invocation. */
export const PROVIDER_CALL_PURPOSES = [
  "main",
  "subagent",
  "compaction",
  "aux",
  "grace",
  "hook",
  "memory_review",
  "prewarm",
] as const;

export type ProviderCallPurpose = (typeof PROVIDER_CALL_PURPOSES)[number];
