import {
  computeApprovalDiff as computeHostApprovalDiff,
  type ApprovalDiffPathResolver,
} from "@pico/pico-host/approval-diff";
import { generateSimpleDiff } from "@pico/pico-host/edit-file-tool";
import { safeResolve } from "@pico/pico-host/file-tool-helpers";
import type { WorkspaceRoots } from "@pico/pico-host/workspace-roots";

type ApprovalPathResolver = Pick<WorkspaceRoots, "resolve"> &
  Partial<Pick<WorkspaceRoots, "resolveUnchecked">>;

const toolPort = { generateSimpleDiff, safeResolve };

/** @deprecated Approval diff policy now lives in @pico/pico-host. */
export async function computeApprovalDiff(
  toolName: string,
  args: string,
  workDir: string,
  workspaceRoots?: ApprovalPathResolver,
): Promise<string | undefined> {
  return await computeHostApprovalDiff(
    toolName,
    args,
    workDir,
    workspaceRoots satisfies ApprovalDiffPathResolver | undefined,
    toolPort,
  );
}
