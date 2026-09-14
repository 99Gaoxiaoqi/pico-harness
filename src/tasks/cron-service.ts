import {
  CronService as RuntimeCronService,
  type CronServiceOptions as RuntimeCronServiceOptions,
} from "@pico/runtime/cron-service";
import type { RuntimeStoreOptions } from "@pico/storage/runtime-control-store-contracts";
import { resolveWorkspaceSqliteStorageRoot } from "../storage/sqlite/workspace-scopes.js";

export * from "@pico/runtime/cron-service";

export type CronServiceOptions =
  | RuntimeCronServiceOptions
  | (RuntimeStoreOptions & {
      ownerId?: string;
      policyGuard?: RuntimeCronServiceOptions["policyGuard"];
      generateId?: RuntimeCronServiceOptions["generateId"];
    });

/** @deprecated CronService 已迁至 Runtime；此入口仅将旧路径选项转为 Host-resolved storageRoot。 */
export class CronService extends RuntimeCronService {
  constructor(options: CronServiceOptions) {
    super(toRuntimeOptions(options));
  }
}

function toRuntimeOptions(options: CronServiceOptions): RuntimeCronServiceOptions {
  return {
    storageRoot:
      "storageRoot" in options && typeof options.storageRoot === "string"
        ? options.storageRoot
        : resolveWorkspaceSqliteStorageRoot(options),
    ...(options.now ? { now: options.now } : {}),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    ...(options.policyGuard ? { policyGuard: options.policyGuard } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
  };
}
