import type { UsageDashboardDetails, UsagePrice } from "@pico/protocol";
import {
  buildUsageDashboard as buildHostUsageDashboard,
  type UsageDashboardInput as HostUsageDashboardInput,
  type UsageRuntimeEventReader,
} from "@pico/pico-host";
import type { ProviderCallRecord } from "@pico/storage/runtime-control-types";
import { SqliteRuntimeEventStore } from "../storage/sqlite/sqlite-runtime-event-store.js";

export interface UsageDashboardInput {
  readonly sources: readonly {
    readonly workspacePath: string;
    readonly storageRoot: string;
    readonly calls: readonly ProviderCallRecord[];
  }[];
  readonly from?: number;
  readonly to?: number;
  readonly sessionId?: string;
  readonly pricing: readonly UsagePrice[];
  readonly unavailableWorkspaces: readonly {
    readonly workspacePath: string;
    readonly error: string;
  }[];
}

/** Legacy composition adapter for the Storage-owned SQLite Runtime ledger. */
export function buildUsageDashboard(input: UsageDashboardInput): Promise<UsageDashboardDetails> {
  return buildHostUsageDashboard({
    ...input,
    createRuntimeEventReader: (storageRoot) =>
      new SqliteRuntimeEventStore({ storageRoot }) as UsageRuntimeEventReader,
  } satisfies HostUsageDashboardInput);
}
