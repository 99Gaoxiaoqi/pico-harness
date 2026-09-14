import {
  WorkspaceRoots,
  workspaceAccessesFromCall,
} from "@pico/pico-host/workspace-roots";
import type { RequestMiddleware } from "@pico/pico-host/tool-registry-contract";

export * from "@pico/pico-host/workspace-roots";

export function buildWorkspaceBoundaryMiddleware(roots: WorkspaceRoots): RequestMiddleware {
  return async (call) => {
    for (const access of workspaceAccessesFromCall(call)) {
      try {
        await roots.assertAllowed(access.path, { access: access.access });
      } catch (error) {
        return {
          allowed: false,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    }
    return { allowed: true };
  };
}
