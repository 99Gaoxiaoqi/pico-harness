// 兼容旧的 SQLite Storage 导入路径；实现已收敛到 @pico/storage。
export {
  acquireOperationalDatabase,
  backupOperationalDatabaseSync,
  closeAllOperationalDatabasesForTest,
  hasOperationalDatabaseOwner,
  openOperationalDatabaseForBindingRepairSync,
  openOperationalDatabaseReadOnly,
  operationalDatabasePath,
  OPERATIONAL_DATABASE_FILENAME,
} from "@pico/storage";
export type { OperationalDatabaseLease, OperationalTransactionMode } from "@pico/storage";
