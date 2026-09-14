// 兼容旧的 SQLite Storage 导入路径；实现已收敛到 @pico/storage。
export {
  runIdleSqliteRetentionMaintenance,
  SQLITE_RETENTION_VACUUM_FREELIST_RATIO,
  SQLITE_RETENTION_VACUUM_RECLAIMED_BYTES,
} from "@pico/storage";
export type {
  SqliteRetentionMaintenanceOptions,
  SqliteRetentionMaintenanceResult,
  SqliteRetentionVacuumTrigger,
} from "@pico/storage";
