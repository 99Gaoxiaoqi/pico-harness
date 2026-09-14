import {
  JobService as RuntimeJobService,
  type JobServiceOptions as RuntimeJobServiceOptions,
} from "@pico/runtime/job-service";
import type { RuntimeStoreOptions } from "@pico/storage/runtime-control-store-contracts";
import { resolveWorkspaceSqliteStorageRoot } from "../storage/sqlite/workspace-scopes.js";

export * from "@pico/runtime/job-service";

export type JobServiceOptions =
  | RuntimeJobServiceOptions
  | (RuntimeStoreOptions & {
      ownerId?: string;
      generateId?: RuntimeJobServiceOptions["generateId"];
    });

export interface JobServiceCreateResult {
  service: JobService;
}

/** @deprecated JobService 已迁至 Runtime；此入口仅将旧路径选项转为 Host-resolved storageRoot。 */
export class JobService extends RuntimeJobService {
  constructor(options: JobServiceOptions) {
    super(toRuntimeOptions(options));
  }

  static override async create(options: JobServiceOptions): Promise<JobServiceCreateResult> {
    return { service: new JobService(options) };
  }
}

function toRuntimeOptions(options: JobServiceOptions): RuntimeJobServiceOptions {
  if ("storageRoot" in options && typeof options.storageRoot === "string") {
    return {
      storageRoot: options.storageRoot,
      ...(options.now ? { now: options.now } : {}),
      ...(options.ownerId ? { ownerId: options.ownerId } : {}),
      ...(options.generateId ? { generateId: options.generateId } : {}),
    };
  }
  return {
    storageRoot: resolveWorkspaceSqliteStorageRoot(options),
    ...(options.now ? { now: options.now } : {}),
    ...(options.ownerId ? { ownerId: options.ownerId } : {}),
    ...(options.generateId ? { generateId: options.generateId } : {}),
  };
}
