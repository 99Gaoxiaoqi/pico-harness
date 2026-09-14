// 兼容旧的 SQLite Storage 导入路径；实现已收敛到 @pico/storage。
export {
  assertCurrentOperationalTargetSchemaSync,
  assertReadOnlySchemaIsCurrentSync,
  migrateOperationalDatabaseSync,
  readOperationalSchemaVersionsSync,
  scopeCurrentVersion,
} from "@pico/storage";
export type { SqliteSchemaScope } from "@pico/storage";
