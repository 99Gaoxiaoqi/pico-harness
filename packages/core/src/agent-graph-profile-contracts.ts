import type { AgentGraphProfileSnapshot } from "./agent-graph-contracts.js";

export interface AgentGraphOperatorProfileSummary {
  readonly profileId: string;
  readonly revision: string;
  readonly description: string;
}

export interface ResolveAgentGraphOperatorProfileInput {
  readonly profileId: string;
  readonly rootModelRouteId: string;
  readonly requireConfiguredPreset?: boolean;
  readonly legacyCapabilityId?: boolean;
}

/** Immutable profile snapshot resolver used by Graph admission and execution. */
export interface AgentGraphOperatorProfileCatalog {
  listPublicProfiles(): readonly AgentGraphOperatorProfileSummary[];
  resolve(input: ResolveAgentGraphOperatorProfileInput): AgentGraphProfileSnapshot;
  resolveForExecution?(
    input: ResolveAgentGraphOperatorProfileInput,
  ): Promise<AgentGraphProfileSnapshot>;
  listAvailableProfiles?(): Promise<readonly AgentGraphOperatorProfileSummary[]>;
}

/** Minimal declarative Agent shape consumed when freezing a Graph Operator profile. */
export interface AgentGraphCatalogProfile {
  readonly name: string;
  readonly description: string;
  readonly systemPrompt: string;
  /** Catalog provenance is retained for compatibility; Graph snapshots never execute it. */
  readonly source?: string;
  readonly sourcePath?: string;
  readonly hooks?: unknown;
  readonly maxTurns?: number;
  readonly modelRouteId?: string;
  readonly thinkingEffort?: string;
  readonly tools: readonly string[];
}
