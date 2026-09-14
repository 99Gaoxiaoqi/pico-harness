import { existsSync } from "node:fs";
import { resolvePicoPaths } from "./pico-paths.js";
import { operationalDatabasePath } from "@pico/storage";
import { SqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEventStoreOptions } from "@pico/storage/runtime-event-store-contracts";
import {
  createConfiguredSubagentOutputStore as createConfiguredSubagentOutputStoreFromRuntime,
  findParentRecord as findParentRecordFromRuntime,
} from "@pico/runtime/configured-subagent-output-store";
import type {
  ConfiguredSubagentOutputPort,
  ConfiguredSubagentOutputQuery,
} from "@pico/runtime/configured-subagent-output-tool";

export {
  ConfiguredSubagentOutputNotFoundError,
  childRecord,
  type ChildRecord,
} from "@pico/runtime/configured-subagent-output-store";

export interface ConfiguredSubagentOutputStoreOptions {
  readonly parentSessionId: string;
  readonly workDir: string;
  readonly picoHome?: string;
  readonly eventStore: SqliteRuntimeEventStore;
  /** Preserves host diagnostics when opening a child workspace store. */
  readonly warningLogger?: RuntimeEventStoreOptions["warningLogger"];
}

/** @deprecated Runtime owns child-output authorization and bounded projection. */
export function createConfiguredSubagentOutputStore(
  options: ConfiguredSubagentOutputStoreOptions,
): ConfiguredSubagentOutputPort {
  return createConfiguredSubagentOutputStoreFromRuntime({
    parentSessionId: options.parentSessionId,
    workDir: options.workDir,
    eventStore: options.eventStore,
    childStoreOpener: {
      open: (workDir) => {
        const storageRoot = resolvePicoPaths(
          workDir,
          options.picoHome === undefined ? {} : { picoHome: options.picoHome },
        ).workspace.root;
        if (!existsSync(operationalDatabasePath(storageRoot))) return undefined;
        const store = new SqliteRuntimeEventStore({
          storageRoot,
          ...(options.warningLogger ? { warningLogger: options.warningLogger } : {}),
        });
        return { store, close: () => store.close() };
      },
    },
  });
}

export async function findParentRecord(
  options: ConfiguredSubagentOutputStoreOptions,
  query: ConfiguredSubagentOutputQuery,
) {
  return findParentRecordFromRuntime(
    {
      parentSessionId: options.parentSessionId,
      workDir: options.workDir,
      eventStore: options.eventStore,
    },
    query,
  );
}
