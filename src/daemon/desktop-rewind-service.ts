import {
  DesktopRewindService as HostDesktopRewindService,
  type DesktopRewindLogger,
} from "@pico/pico-host/desktop-rewind-service";
import type { Session } from "../engine/session.js";
import { logger } from "../observability/logger.js";
import { createSessionForkRuntimePort } from "../runtime/session-fork-runtime-port-adapter.js";
import {
  fileHistoryChanges,
  type FileHistoryState,
} from "@pico/pico-host/file-history-runtime";
import type { DesktopConversationStateStoreLike } from "./desktop-conversation-state.js";

type SessionForkRuntimePort = ReturnType<typeof createSessionForkRuntimePort>;

/** @deprecated Desktop rewind 编排已迁入 @pico/pico-host。 */
export interface DesktopRewindServiceOptions {
  readonly picoHome: string;
  readonly conversationStateStore: DesktopConversationStateStoreLike;
  readonly createSessionId: () => string;
  readonly requireIdleTrustedSession: (
    workspacePath: string,
    sessionId: string,
    operation: string,
  ) => Promise<string>;
  readonly withSession: <Result>(
    workspacePath: string,
    sessionId: string,
    operation: (session: Session) => Promise<Result>,
  ) => Promise<Result>;
  readonly notifyCommitted: (input: {
    readonly workspacePath: string;
    readonly sessionId: string;
    readonly sourceSessionId: string;
    readonly checkpointId: string;
  }) => Promise<void>;
}

/** Compatibility adapter retaining the legacy daemon constructor contract. */
export class DesktopRewindService extends HostDesktopRewindService<
  FileHistoryState,
  SessionForkRuntimePort
> {
  constructor(options: DesktopRewindServiceOptions) {
    const rewindLogger: DesktopRewindLogger = logger;
    super({
      ...options,
      withSession: (workspacePath, sessionId, operation) =>
        options.withSession(workspacePath, sessionId, (session) => operation(session)),
      forkRuntimePort: createSessionForkRuntimePort(),
      readChanges: fileHistoryChanges,
      logger: rewindLogger,
    });
  }
}
