import type { SessionOptions } from "./session.js";
import type { SessionManager } from "./session-manager.js";
import type { PersistedSessionSettingsWrite, SessionRuntimeStateWritePatch } from "@pico/core";
import type { ExecutionBoundary } from "@pico/core/permission-profile";
import {
  bindAgentGraphOperatorExecutionBoundary as bindHostAgentGraphOperatorExecutionBoundary,
  type AgentGraphOperatorSessionManagerPort,
} from "./index.js";

export interface BindAgentGraphOperatorExecutionBoundaryInput {
  readonly sessionManager: SessionManager;
  readonly rootSessionId: string;
  readonly childSessionId: string;
  readonly parentWorkDir: string;
  readonly childWorkDir: string;
  readonly workspacePolicy: "shared" | "isolated-worktree";
  readonly sessionOptions?: SessionOptions;
  /** Production-only current settings, resolved from the immutable Operator profile. */
  readonly createChildSettings?: (input: {
    readonly permissionMode: "ask" | "full-access";
  }) => PersistedSessionSettingsWrite;
}

/**
 * Binds the generic inheritance policy to the product's persistent Session manager.
 */
export async function bindAgentGraphOperatorExecutionBoundary(
  input: BindAgentGraphOperatorExecutionBoundaryInput,
): Promise<{ readonly parent: ExecutionBoundary; readonly child: ExecutionBoundary }> {
  return bindHostAgentGraphOperatorExecutionBoundary({
    sessionManager: createSessionManagerPort(input.sessionManager),
    rootSessionId: input.rootSessionId,
    childSessionId: input.childSessionId,
    parentWorkDir: input.parentWorkDir,
    childWorkDir: input.childWorkDir,
    workspacePolicy: input.workspacePolicy,
    ...(input.sessionOptions ? { sessionOptions: input.sessionOptions } : {}),
    ...(input.createChildSettings ? { createChildSettings: input.createChildSettings } : {}),
  });
}

function createSessionManagerPort(manager: SessionManager): AgentGraphOperatorSessionManagerPort {
  return {
    async getOrCreatePinned(id, workDir, options) {
      const lease = await manager.getOrCreatePinned(id, workDir, options);
      return {
        session: {
          getRuntimeStateSnapshot: () => lease.session.getRuntimeStateSnapshot(),
          updateRuntimeState: (patch) => {
            lease.session.updateRuntimeState(patch as SessionRuntimeStateWritePatch);
          },
          flushPersistence: () => lease.session.flushPersistence(),
        },
        release: () => lease.release(),
      };
    },
  };
}
