import type { WorkspaceSqliteStorageRootOptions } from "@pico/storage";
import { resolvePicoPaths } from "../../paths/pico-paths.js";

// Legacy Host adapter: resolve a workDir only at the product boundary.
export function resolveWorkspaceSqliteStorageRoot(
  options: WorkspaceSqliteStorageRootOptions,
): string {
  if (options.storageRoot !== undefined) {
    if (!options.storageRoot.trim()) throw new Error("Workspace storageRoot must not be empty");
    return options.storageRoot;
  }
  if (!options.workDir?.trim()) {
    throw new Error("Workspace storageRoot resolution requires workDir or storageRoot");
  }
  return resolvePicoPaths(options.workDir, { picoHome: options.picoHome }).workspace.root;
}

export {
  ALL_WORKSPACE_SQLITE_SCOPES,
  prepareCurrentWorkspaceSqliteStorageSync,
  withWorkspaceSqliteLease,
} from "@pico/storage";
export type { WorkspaceSqliteStorageRootOptions } from "@pico/storage";
