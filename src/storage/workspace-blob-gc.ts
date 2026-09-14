import { resolvePicoPaths } from "../paths/pico-paths.js";
import {
  runWorkspaceBlobGcOnce as runWorkspaceBlobGcOnceImplementation,
  type RunWorkspaceBlobGcOptions as StorageWorkspaceBlobGcOptions,
} from "@pico/storage/workspace-blob-gc";

export type { WorkspaceBlobGcPaths, WorkspaceBlobGcResult } from "@pico/storage/workspace-blob-gc";

/** @deprecated 新代码应解析宿主路径后从 @pico/storage 调用。 */
export interface RunWorkspaceBlobGcOptions {
  readonly workDir: string;
  readonly picoHome: string;
  readonly limit?: number;
  readonly now?: () => Date;
}

/** 兼容 workDir/picoHome 构造方式；Blob GC 实现已迁至 @pico/storage。 */
export async function runWorkspaceBlobGcOnce(
  options: RunWorkspaceBlobGcOptions,
): Promise<import("@pico/storage/workspace-blob-gc").WorkspaceBlobGcResult> {
  const resolved = resolvePicoPaths(options.workDir, { picoHome: options.picoHome });
  const storageOptions: StorageWorkspaceBlobGcOptions = {
    paths: {
      workspaceRoot: resolved.workspace.root,
      workspaceEvidenceDirectory: resolved.workspace.evidence,
      homeFileHistoryDirectory: resolved.home.fileHistory,
      homeWorkspacesDirectory: resolved.home.workspaces,
    },
    ...(options.limit !== undefined ? { limit: options.limit } : {}),
    ...(options.now !== undefined ? { now: options.now } : {}),
  };
  return runWorkspaceBlobGcOnceImplementation(storageOptions);
}
