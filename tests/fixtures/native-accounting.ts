import { randomUUID } from "node:crypto";
import type {
  LLMProviderRequestOptions,
  ProviderAttemptLifecycleSnapshot,
  Usage,
} from "@pico/core";
import type { PhysicalAttemptRecord } from "@pico/storage/runtime-control-types";
import type { ProviderCallLedger } from "@pico/runtime/cost-tracker";

/** In-memory observer only; persistence tests must use SQLite. */
export function capturePhysicalAttempts(records: PhysicalAttemptRecord[]): ProviderCallLedger {
  return {
    beginPhysicalAttemptOwner: () => "test-owner",
    recordPhysicalAttempt(record) {
      const index = records.findIndex(
        (item) => item.physicalAttemptId === record.physicalAttemptId,
      );
      if (index < 0) records.push(record);
      else records[index] = record;
      return { record, updated: true };
    },
    listPhysicalAttempts: () => structuredClone(records),
  };
}

/** Explicit lifecycle for deterministic provider fixtures, not inferred from logical results. */
export async function reportFixtureAttempt(
  options: LLMProviderRequestOptions | undefined,
  provider: string,
  model: string,
  usage: Usage,
): Promise<void> {
  const prepared: ProviderAttemptLifecycleSnapshot = {
    physicalAttemptId: randomUUID(),
    revision: 0,
    attempt: 0,
    provider,
    model,
    startedAt: new Date().toISOString(),
    status: "prepared",
    usageBasis: "missing",
  };
  await options?.onProviderAttemptStart?.(prepared);
  await options?.onProviderAttemptUpdate?.({
    ...prepared,
    revision: 1,
    status: "succeeded",
    usageBasis: "reported",
    usage,
    completedAt: new Date().toISOString(),
  });
}
