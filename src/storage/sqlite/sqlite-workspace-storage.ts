// 兼容旧的 SQLite Storage 导入路径；实现已收敛到 @pico/storage。
export {
  adoptWorkspaceSqliteStorageRootSync,
  assertWorkspaceSqliteStorageRootIdentitySync,
  discardWorkspaceStorageRepair,
  prepareWorkspaceSqliteStorageSync,
  prepareWorkspaceStorageRepairSync,
  readWorkspaceSqliteStorageRootIdentitySync,
  repairWorkspaceStorageSync,
  withWorkspaceBindingScope,
  WORKSPACE_SQLITE_STORAGE_LAYOUT,
} from "@pico/storage";
export type {
  WorkspacePhysicalIdentity,
  WorkspaceSqliteStoragePreparation,
  WorkspaceStorageRepairCandidate,
  WorkspaceStorageRootIdentity,
} from "@pico/storage";
