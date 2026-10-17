import {
  computeApprovalDiff as computeHostApprovalDiff,
  type ApprovalDiffPathResolver,
} from "@pico/pico-host/approval-diff";
import { generateSimpleDiff } from "@pico/pico-host/edit-file-tool";
import { safeResolve } from "@pico/pico-host/file-tool-helpers";
import {
  readApprovedWriteFileSnapshot,
  type ApprovedFileReadChunk,
} from "./atomic-workspace-file.js";
import type { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

type ApprovalPathResolver = Pick<WorkspaceRoots, "resolve"> &
  Partial<Pick<WorkspaceRoots, "resolveUnchecked">>;

/** @deprecated Approval diff policy now lives in @pico/pico-host. */
export async function computeApprovalDiff(
  toolName: string,
  args: string,
  workDir: string,
  workspaceRoots?: ApprovalPathResolver,
  signal?: AbortSignal,
  readChunk?: ApprovedFileReadChunk,
): Promise<string | undefined> {
  const toolPort = {
    generateSimpleDiff,
    safeResolve,
    readFileSnapshot: async (path: string, readSignal?: AbortSignal) =>
      (
        await readApprovedWriteFileSnapshot(path, {
          ...(readSignal ? { signal: readSignal } : {}),
          ...(readChunk ? { readChunk } : {}),
        })
      ).content ?? "",
  };
  return await computeHostApprovalDiff(
    toolName,
    args,
    workDir,
    workspaceRoots satisfies ApprovalDiffPathResolver | undefined,
    toolPort,
    signal,
  );
}
