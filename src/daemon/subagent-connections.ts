import type { UserConfigStore } from "../input/user-config-store.js";
import {
  listSubagentConnections as listHostSubagentConnections,
  type SubagentConnectionsConfigSource,
} from "@pico/pico-host/subagent-connections";
import type { RuntimeSubagentConnection } from "@pico/protocol";

/** @deprecated Subagent connection projection has moved to @pico/pico-host. */
export async function listSubagentConnections(
  store: UserConfigStore,
): Promise<readonly RuntimeSubagentConnection[]> {
  return listHostSubagentConnections(store as SubagentConnectionsConfigSource);
}
