import {
  buildSessionTaskPromptBlock as buildRuntimeSessionTaskPromptBlock,
  createSessionTaskTools as createRuntimeSessionTaskTools,
  type BoundSessionTaskAuthority,
  type SessionTaskRepositoryPort,
} from "@pico/runtime/session-task-tools";
import { logger } from "../observability/logger.js";
import type { BaseTool } from "@pico/pico-host/tool-registry-contract";

export type {
  BoundSessionTaskAuthority,
  SessionTaskRepositoryPort,
  SessionTaskTool,
  SessionTaskToolExecutionContext,
} from "@pico/runtime/session-task-tools";
export {
  SessionTaskCreateTool,
  SessionTaskGetTool,
  SessionTaskUpdateTool,
} from "@pico/runtime/session-task-tools";

/** @deprecated 会话任务工具已迁至 Runtime；此入口保留宿主日志适配。 */
export function createSessionTaskTools(authority: BoundSessionTaskAuthority): readonly BaseTool[] {
  return createRuntimeSessionTaskTools({
    ...authority,
    onObserverError:
      authority.onObserverError ??
      (({ sessionId, revision, error }) => {
        logger.warn(
          { sessionId, revision, error: String(error) },
          "[SessionTasks] resource_changed 通知失败",
        );
      }),
  });
}

export function buildSessionTaskPromptBlock(
  repository: SessionTaskRepositoryPort,
  sessionId: string,
  maxBytes = 8 * 1024,
): string {
  return buildRuntimeSessionTaskPromptBlock(repository, sessionId, maxBytes);
}
