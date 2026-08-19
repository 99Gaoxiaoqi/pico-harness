import { resolvePicoPaths } from "../../paths/pico-paths.js";
import { ATTACHMENTS_SCOPE } from "./attachments-scope.js";
import { CONTROL_SCOPE } from "./control-scope.js";
import { KV_SCOPE } from "./kv-scope.js";
import { MEMORY_SCOPE } from "./memory-scope.js";
import { OPERATIONS_SCOPE } from "./operations-scope.js";
import { SESSIONS_SCOPE } from "./sessions-scope.js";
import { TASK_RUNS_SCOPE } from "./task-runs-scope.js";
import { prepareWorkspaceSqliteStorageSync } from "./sqlite-workspace-storage.js";
import type { OperationalDatabaseLease } from "./sqlite-database.js";
import type { SqliteSchemaScope } from "./sqlite-schema.js";

/**
 * 单一 scope 组合点(票 03)。
 *
 * `prepareWorkspaceSqliteStorageSync` 的形状断言按**传入集合** fail-closed:
 * 少传 scope 会在库内出现 "unexpected <table>" 误炸,多传则漏迁移。因此所有
 * workspace 级 prepare 调用必须走本导出,三个 store 构造器也���例外;新增
 * scope(memory/operations/attachments/kv)在各自票落库时加入本数组即可。
 */

export const ALL_WORKSPACE_SQLITE_SCOPES: readonly SqliteSchemaScope[] = [
  SESSIONS_SCOPE,
  TASK_RUNS_SCOPE,
  CONTROL_SCOPE,
  MEMORY_SCOPE,
  OPERATIONS_SCOPE,
  ATTACHMENTS_SCOPE,
  KV_SCOPE,
];

export interface WorkspaceSqliteStorageRootOptions {
  readonly workDir?: string;
  readonly picoHome?: string;
  /** Canonical workspace storage root(优先于 workDir 解析)。 */
  readonly storageRoot?: string;
}

/**
 * 与旧 RuntimeStore/TaskRunStore 的 storageRoot 解析口径一致:
 * 显式 storageRoot 优先,否则经 resolvePicoPaths 从 workDir + picoHome 解析。
 */
export function resolveWorkspaceSqliteStorageRoot(
  options: WorkspaceSqliteStorageRootOptions,
): string {
  if (options.storageRoot !== undefined) {
    if (!options.storageRoot.trim()) {
      throw new Error("Workspace storageRoot must not be empty");
    }
    return options.storageRoot;
  }
  if (!options.workDir?.trim()) {
    throw new Error("Workspace storageRoot resolution requires workDir or storageRoot");
  }
  return resolvePicoPaths(options.workDir, { picoHome: options.picoHome }).workspace.root;
}

/**
 * 单操作级 prepare + 事务 + 归还(票 08)。
 *
 * 供无长生命周期的调用方(operation journal / evidence / todo / file-history
 * manifest):每次操作独立持有 lease,进程内连接按 Owners 引用计数共享,操作
 * 结束即归还——不留常开句柄,临时目录清理(Windows rm)不受影响。高频路径
 * 的常驻 store(RuntimeEvent/Control/TaskRun)仍走各自的构造器持有模型。
 */
export function withWorkspaceSqliteLease<T>(
  storageRoot: string,
  operation: (lease: OperationalDatabaseLease) => T,
): T {
  const preparation = prepareWorkspaceSqliteStorageSync(storageRoot, ALL_WORKSPACE_SQLITE_SCOPES);
  try {
    return operation(preparation.lease);
  } finally {
    preparation.lease.release();
  }
}
