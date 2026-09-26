import type { RuntimeSessionContextSnapshot } from "@pico/protocol";

/** Expected display facts for the context snapshot v3 contract. */
export function contextSnapshot(
  overrides: Partial<RuntimeSessionContextSnapshot> = {},
): RuntimeSessionContextSnapshot {
  return {
    version: 3,
    sessionId: "s",
    generatedAt: 1,
    selectedRoute: {
      routeId: "p/m",
      providerId: "openai",
      modelId: "m",
      connectionId: "p",
      contextWindow: 10000,
    },
    latestRequest: {
      status: "available",
      source: "physical",
      providerCallId: "call-1",
      physicalAttemptId: "attempt-1",
      providerId: "openai",
      modelId: "m",
      routeId: "p/m",
      connectionId: "p",
      completedAt: 1,
      contextWindow: 10000,
      contextWindowSource: "catalog",
      inputTokens: 2500,
      outputTokens: 500,
      cachedInputTokens: 1500,
      usageStatus: "reported",
      compositionStatus: "unrecorded",
    },
    modelHistory: {
      throughSequence: 10,
      messageCount: 5,
      estimatedTokens: 300,
      estimationAlgorithm: "chars_v1",
      projection: "effective_model_history",
      compactedCount: 1,
      latestCompaction: {
        checkpointId: "cp-current",
        throughEventId: "event-4",
        coveredEventCount: 4,
      },
    },
    ...overrides,
  };
}
