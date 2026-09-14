/**
 * 兼容旧 SQLite Store 导入路径。实现归属 @pico/storage；旧入口补入原有
 * 宿主 logger，保留写入歧义仲裁的结构化告警行为。
 */
import { logger } from "../../observability/logger.js";
import { SqliteRuntimeEventStore as StorageSqliteRuntimeEventStore } from "@pico/storage/sqlite/sqlite-runtime-event-store";
import type { RuntimeEventStoreOptions } from "@pico/storage/runtime-event-store-contracts";

export * from "@pico/storage/sqlite/sqlite-runtime-event-store";

export class SqliteRuntimeEventStore extends StorageSqliteRuntimeEventStore {
  constructor(options: RuntimeEventStoreOptions) {
    super({ ...options, warningLogger: options.warningLogger ?? logger });
  }
}
