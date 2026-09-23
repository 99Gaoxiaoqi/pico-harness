import { randomUUID } from "node:crypto";
import type { LLMProvider, ProviderAttemptLifecycleSnapshot } from "@pico/core";

/** Deterministic model fixture that exercises durable admission and settlement. */
export function physicalProviderFixture(inner: LLMProvider, model: string): LLMProvider {
  return {
    async generate(messages, tools, options) {
      const start: ProviderAttemptLifecycleSnapshot = {
        physicalAttemptId: randomUUID(),
        revision: 0,
        attempt: 0,
        provider: "openai",
        model,
        startedAt: new Date().toISOString(),
        status: "prepared",
        usageBasis: "missing",
      };
      await options?.onProviderAttemptStart?.(start);
      const result = await inner.generate(messages, tools, options);
      const completedAt = new Date().toISOString();
      const settled = {
        ...start,
        revision: 1,
        status: "succeeded" as const,
        completedAt,
        latencyMs: Date.parse(completedAt) - Date.parse(start.startedAt),
        usageBasis: result.usage ? ("reported" as const) : ("missing" as const),
        ...(result.usage ? { usage: result.usage } : {}),
      };
      await options?.onProviderAttemptUpdate?.(settled);
      options?.onProviderAttempt?.({ ...settled, attemptId: start.physicalAttemptId });
      return result;
    },
  };
}
