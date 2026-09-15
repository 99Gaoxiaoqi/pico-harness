import type { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import { decodeRuntimeEventJson } from "@pico/storage/runtime-event";
import {
  AgentGraphReadOnlyQueryService as RuntimeAgentGraphReadOnlyQueryService,
  type AgentGraphLaunchStateQueryPort,
  type AgentGraphRuntimeEventQueryPort,
} from "@pico/runtime";
import type { SqliteAgentGraphControlStore } from "@pico/storage/sqlite/agent-graph-control-store";
import type { AgentGraphQueryInput } from "@pico/runtime";

export type {
  AgentGraphLaunchStateQueryPort,
  AgentGraphQueryInput,
  AgentGraphRuntimeEventQueryPort,
  AgentGraphTimelineItem,
} from "@pico/runtime";

/** Bridges the host-owned event schema and decoder to Runtime's stable read Port. */
export function createSqliteAgentGraphRuntimeEventQueryPort(
  store: SqliteRuntimeEventStore,
): AgentGraphRuntimeEventQueryPort {
  return {
    readRun: (sessionId, runId) => store.readRun(sessionId, runId),
    readEvent: async (eventId) => {
      const row = (await store.readEventRowsByEventIds([eventId])).get(eventId);
      return row ? decodeRuntimeEventJson(row.payloadJson) : undefined;
    },
  };
}

/**
 * Backward-compatible source entry point. New composition should import the
 * Runtime service directly and use createSqliteAgentGraphRuntimeEventQueryPort.
 */
export class AgentGraphReadOnlyQueryService {
  private readonly runtime: RuntimeAgentGraphReadOnlyQueryService;

  constructor(store: SqliteAgentGraphControlStore) {
    this.runtime = new RuntimeAgentGraphReadOnlyQueryService(store);
  }

  query(input: AgentGraphQueryInput): unknown {
    return this.runtime.query(input);
  }

  queryRuntimeFacts(
    graphId: string,
    runtimeStore: SqliteRuntimeEventStore,
    launchStatePort?: AgentGraphLaunchStateQueryPort,
  ) {
    return this.runtime.queryRuntimeFacts(
      graphId,
      createSqliteAgentGraphRuntimeEventQueryPort(runtimeStore),
      launchStatePort,
    );
  }
}
