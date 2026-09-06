import { parseRuntimeResult, RUNTIME_ERROR_CODES, type RuntimeResult } from "@pico/protocol";
import type { RuntimeClientAdapter } from "./runtime-client-adapter.js";

/** One native confirmation per workspace; repair tokens are never exposed to the renderer. */
export function createDesktopWorkspaceStorageRecovery(options: {
  readonly runtime: Pick<RuntimeClientAdapter, "request">;
  readonly confirmRepair: (workspacePath: string, storagePath: string) => Promise<boolean>;
}): (workspacePath: string) => Promise<boolean> {
  const pending = new Map<string, Promise<boolean>>();
  const recover = async (workspacePath: string): Promise<boolean> => {
    let prepared: RuntimeResult<"workspace.storageRepair.prepare">;
    try {
      prepared = parseRuntimeResult(
        "workspace.storageRepair.prepare",
        await options.runtime.request("workspace.storageRepair.prepare", { workspacePath }),
      );
    } catch (error) {
      // An older resident daemon must still be able to open healthy workspaces.
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === RUNTIME_ERROR_CODES.METHOD_NOT_FOUND
      )
        return false;
      throw error;
    }
    const { candidate } = prepared;
    if (!candidate) return true;
    let confirmed = false;
    try {
      confirmed = await options.confirmRepair(workspacePath, candidate.storagePath);
    } finally {
      if (!confirmed) {
        await options.runtime.request("workspace.storageRepair.respond", {
          workspacePath,
          token: candidate.token,
          action: "cancel",
        });
      }
    }
    if (!confirmed)
      throw new Error("工作区尚未加载。确认这是原来的工作区后，可重新选择项目进行修复。");
    parseRuntimeResult(
      "workspace.storageRepair.respond",
      await options.runtime.request("workspace.storageRepair.respond", {
        workspacePath,
        token: candidate.token,
        action: "repair",
      }),
    );
    return true;
  };
  return (workspacePath) => {
    const existing = pending.get(workspacePath);
    if (existing) return existing;
    const request = recover(workspacePath).finally(() => pending.delete(workspacePath));
    pending.set(workspacePath, request);
    return request;
  };
}
