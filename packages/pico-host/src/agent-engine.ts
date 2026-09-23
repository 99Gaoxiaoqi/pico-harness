import type { Message, Reporter } from "@pico/core";
import {
  AgentEngine as RuntimeAgentEngine,
  type AgentEngineOptions as RuntimeAgentEngineOptions,
} from "@pico/runtime/agent-engine";
import type { EngineFileHistoryScope, EngineToolRegistry } from "@pico/runtime/agent-engine-ports";
import type { Tracer } from "@pico/runtime/trace";
import { canonicalizeWorkspacePath } from "./pico-paths.js";
import { safeResolve } from "./file-tool-helpers.js";
import type { WorkspaceRoots } from "./workspace-roots.js";
import type { Registry } from "./tool-registry-contract.js";
import type { Session } from "./session.js";
import type { EngineRuntimePort } from "./engine-runtime-port.js";
import type { HookService } from "./hooks/service.js";
import type { HookEventPayloadMap } from "./hooks/types.js";
import { PromptComposer } from "./product-prompt-composer.js";
import type { TodoStore } from "./product-todo-store.js";
import { logger } from "./logger.js";
import { exportTraceToFile } from "./trace.js";
import {
  fileHistoryAddJournalWarning,
  fileHistoryBeginJournal,
  fileHistoryCommitJournal,
  fileHistoryJournalCoversPath,
  fileHistoryTrackEdit,
  type FileHistoryJournal,
} from "./file-history-runtime.js";

export { isPlanProviderTool } from "@pico/runtime/agent-engine";

export interface AgentEngineOptions extends Omit<
  RuntimeAgentEngineOptions,
  "host" | "diagnostics" | "registry" | "runtimePort" | "hookService"
> {
  registry: Registry;
  runtimePort?: EngineRuntimePort;
  hookService?: HookService;
  workspaceRoots?: WorkspaceRoots;
  /** Shared with tools and the host-owned dynamic Plan prompt. */
  todoStore?: TodoStore;
}

/** Product defaults and physical services are injected once; model execution stays in Runtime. */
export class AgentEngine extends RuntimeAgentEngine {
  constructor(options: AgentEngineOptions) {
    const { registry, runtimePort, hookService, workspaceRoots, todoStore, ...runtimeOptions } =
      options;
    super({
      ...runtimeOptions,
      registry,
      ...(runtimePort ? { runtimePort } : {}),
      ...(hookService
        ? {
            hookService: {
              dispatch: (event, payload, context) =>
                hookService.dispatch(
                  event,
                  payload as HookEventPayloadMap[typeof event],
                  context?.signal ? { signal: context.signal } : {},
                ),
            },
          }
        : {}),
      diagnostics: logger,
      host: {
        sessionCapability(session: Session) {
          return JSON.stringify([
            canonicalizeWorkspacePath(session.workDir),
            session.id,
            session.runtimeEventStore?.storageRoot ?? null,
          ]);
        },
        createFileHistoryScope(session: Session, tools) {
          return createFileHistoryScope(session, tools, options.workDir, workspaceRoots);
        },
        async buildPlanPrompt(signal) {
          const composer = new PromptComposer(options.workDir, true, {
            ...(options.goalManager ? { goalManager: options.goalManager } : {}),
            ...(todoStore ? { todoStore } : {}),
            ...(hookService
              ? {
                  onInstructionsLoaded: async (paths: readonly string[]) => {
                    await hookService.dispatch(
                      "InstructionsLoaded",
                      { paths },
                      signal ? { signal } : {},
                    );
                  },
                }
              : {}),
          });
          return composer.buildLayers();
        },
        exportTrace(root, session: Session) {
          return exportTraceToFile(root, session.workDir, session.id, undefined, session.picoHome);
        },
      },
    });
  }

  override run(
    session: Session,
    reporter?: Reporter,
    tracer?: Tracer,
    signal?: AbortSignal,
  ): Promise<Message[]> {
    return super.run(session, reporter, tracer, signal);
  }
}

function createFileHistoryScope(
  session: Session,
  registry: EngineToolRegistry,
  workDir: string,
  workspaceRoots?: WorkspaceRoots,
): EngineFileHistoryScope {
  const messageId = session.fileHistory.snapshots.findLast(
    (snapshot) => snapshot.messageId === session.fileHistory.currentMessageId,
  )?.messageId;
  const roots = workspaceRoots?.list() ?? (registry.setPreWriteHook ? [workDir] : []);
  let runJournal: FileHistoryJournal | undefined;
  let activeJournal: FileHistoryJournal | undefined;
  return {
    async trackToolWrite(toolName, args) {
      if (!messageId) return;
      try {
        const effects = registry.getFileSideEffects?.({
          id: `file-history:${messageId}`,
          name: toolName,
          arguments: args,
        });
        if (effects?.kind !== "exact") return;
        for (const path of effects.paths) {
          const resolvedPath = workspaceRoots?.resolve(path) ?? safeResolve(workDir, path);
          if (activeJournal && fileHistoryJournalCoversPath(activeJournal, resolvedPath)) continue;
          await fileHistoryTrackEdit(
            session.fileHistory,
            resolvedPath,
            messageId,
            session.id,
            session.fileHistoryIo,
          );
        }
      } catch {
        // File-history tracking is best-effort and must not block the tool call.
      }
    },
    async beginJournal(signal) {
      if (!messageId || roots.length === 0) return;
      runJournal ??= await fileHistoryBeginJournal(
        roots,
        session.id,
        signal,
        session.fileHistoryBaseDir,
      );
      activeJournal = runJournal;
    },
    addJournalWarning(message) {
      if (runJournal) fileHistoryAddJournalWarning(runJournal, message);
    },
    async commit() {
      if (!runJournal || !messageId) return [];
      try {
        const commit = await fileHistoryCommitJournal(
          session.fileHistory,
          runJournal,
          messageId,
          session.id,
          session.fileHistoryIo,
        );
        if (commit.incomplete)
          logger.warn({ warnings: commit.warnings }, "[FileHistory] 本轮文件 journal 覆盖不完整");
        return commit.changedPaths;
      } catch (err) {
        logger.warn({ err: String(err) }, "[FileHistory] 本轮文件 journal 提交失败");
        return [];
      }
    },
    finish() {
      activeJournal = undefined;
    },
  };
}
