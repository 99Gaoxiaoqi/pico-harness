// TUI REPL entrypoint: wires ink rendering, TuiReporter, local commands, and
// per-turn calls into executeAgentRuntime.
//
// Each user prompt builds a fresh engine around the same session and reporter.
// QueryGuard prevents overlapping submissions from racing cleanup state.

import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import type React from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { render, Text, useApp, useInput, type Instance, type RenderOptions } from "ink";
import { App } from "./app.js";
import type { InputBoxSubmission } from "./input-box.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { createLocalUiDialogRequest } from "./local-ui-dialog-host.js";
import { buildModelOptions, modelSelectionToCommand } from "./model-options.js";
import {
  createModelSelectorState,
  ModelSelector,
  resolveModelSelectorKey,
  type ModelOption,
  type ModelSelectorState,
} from "./model-selector.js";
import { TuiReporter, type TuiEntry, type TuiProjection } from "./tui-reporter.js";
import { projectAgentNavigationItems } from "./agent-navigation.js";
import { QueryGuard } from "./query-guard.js";
import {
  formatRunningInputQueue,
  parseRunningInputIntent,
  RunningInputQueue,
  type RunningInputIntent,
  type RunningInputQueueSnapshot,
} from "./running-input-queue.js";
import {
  executeAgentRuntime,
  type RunAgentCliDependencies,
  type RunAgentCliOptions,
  type RunAgentCliResult,
} from "../runtime/agent-runtime.js";
import { listRewindPointSummaries } from "../cli/file-history.js";
import {
  createCliSessionId,
  removeCliSessionFile,
  type CliSessionSelection,
} from "../cli/session-resolver.js";
import { loadPicoConfig } from "../input/pico-config.js";
import type { EffectiveConfigDefaults } from "../input/effective-config.js";
import { UserConfigStore } from "../input/user-config-store.js";
import { resolveCompatibleModelRoute } from "../provider/compatible-model-route.js";
import {
  commandArgumentSuggestions,
  commandSuggestions,
  createPicoCommandRegistry,
} from "../input/pico-command-registry.js";
import { preparePromptForMessage, type PreparedUserPrompt } from "../input/prepare-prompt.js";
import { processUserInput } from "../input/process-user-input.js";
import { parseSlashInput } from "../input/slash-parser.js";
import type { CommandRegistry } from "../input/command-registry.js";
import { getCommandAvailability, type CommandInputState } from "../input/command-availability.js";
import type {
  InputProcessResult,
  LocalCommandResult,
  ResumeSessionCommandData,
} from "../input/types.js";
import type { ImagePart } from "../schema/message.js";
import type { ProviderKind } from "../provider/factory.js";
import type { ModelRoute, ModelRouter } from "../provider/model-router.js";
import {
  loadEffectiveModelRuntime,
  type EffectiveModelRuntime,
} from "../provider/effective-model-runtime.js";
import { createPlatformCredentialVault } from "../provider/credential-vault.js";
import { resolveAutomationCredentialTarget } from "../provider/automation-credential.js";
import { isAbortError } from "../provider/errors.js";
import { defaultIsRetryableError } from "../provider/retry.js";
import { ModelRuntimeCommandService } from "../provider/model-runtime-report.js";
import { coordinateReasoningLevel } from "../provider/reasoning-capability.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { ToolRegistry } from "../tools/registry-impl.js";
import type { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  coordinateSessionReasoningLevel,
  DEFAULT_INTERACTION_MODE,
  effectiveSessionReasoningLevel,
  getOrCreateSessionSettings,
  migrateSessionModelRoute,
  resolveRestoredSessionModelRoute,
  restoreSessionInteractionMode,
  setSessionAdditionalDirectories,
  setSessionTools,
  toolStatusFromRegistry,
  type SessionSettings,
} from "../input/session-settings.js";
import { forgetSessionPolicyState } from "../input/session-policy.js";
import { WorkspaceRoots } from "../tools/workspace-roots.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import type { PersistedSessionSettings } from "../engine/session-runtime.js";
import {
  reconcileUnfinishedSessionForksOrThrow,
  SessionForkService,
} from "../engine/session-fork-service.js";
import type { Reporter } from "../engine/reporter.js";
import type { SteerQueue } from "../engine/steer-queue.js";
import { McpConnectionManager, type McpStatusSnapshot } from "../mcp/manager.js";
import { resolveProjectMcpConfigPath } from "../mcp/config-path.js";
import { createHookedElicitationHandler, McpElicitationUiHandler } from "../mcp/elicitation-ui.js";
import { hasLocalUiCommandAction } from "./local-ui-command.js";
import {
  confirmSessionBrowserSelection,
  createSessionBrowserState,
  moveSessionBrowserSelection,
  SessionBrowser,
  type SessionBrowserSession,
  type SessionBrowserState,
} from "./session-browser.js";
import {
  mapCliSessionsToBrowserSessions,
  searchSessionBrowserSessions,
  sessionSelectionToCommand,
  type CliSessionBrowserSummary,
} from "./session-browser-adapter.js";
import {
  createRewindCommandDialogRequest,
  type RewindCommandDialogState,
} from "./rewind-command-dialog.js";
import { applyTuiRewind, rewindInputReplacement } from "./rewind-runtime.js";
import { globalApprovalManager, type ApprovalNotice } from "../approval/manager.js";
import {
  approvalDialogId,
  InteractiveApprovalPanel,
  type ApprovalPanelAction,
} from "./approval-panel.js";
import {
  createSessionRuntime as createTuiRuntimeState,
  DelegationWakeCoordinator,
  HookRewakeCoordinator,
  type SessionRuntime as TuiRuntimeState,
} from "../runtime/session-runtime.js";
import { createTuiTerminalGridSession } from "./terminal-grid.js";
import { hydrateTuiReporter } from "./session-hydration.js";
import { projectTuiEntriesForRendering } from "./tui-event-store.js";
import { AskUserHandler } from "../tools/ask-user.js";
import { bindAskUserDialogs } from "./ask-user-dialog.js";
import { bindMcpElicitationDialogs } from "./mcp-elicitation-dialog.js";
import { createHooksPanelDialogRequest, HOOKS_PANEL_DIALOG_ID } from "./hooks-panel.js";
import {
  createArtifactInspectorContext,
  createInspectorDialogRequest,
  createToolInspectorSource,
} from "./inspector.js";
import { copyTextToClipboard, locateFileInShell } from "./system-actions.js";
import { imagePasteShortcutLabel } from "./system-actions.js";
import { fileHistoryChanges, fileHistoryRestoreFile } from "../safety/file-history.js";
import { createChangesDialogRequest, createChangesPanelModel } from "./changes-panel.js";
import { TaskHostRuntime } from "../tasks/task-runtime.js";
import { CronService } from "../tasks/cron-service.js";
import type { ScheduleDraftCoordinator as ScheduleDraftCoordinatorContract } from "../tasks/cron-draft.js";
import {
  CronDraftApplication,
  type CronDraftApplicationOptions,
} from "../tasks/cron-draft-application.js";
import { ScheduleDraftCoordinator } from "../tasks/cron-draft-coordinator.js";
import { LocalCronDaemonBridge } from "../input/cron-daemon-bridge.js";
import { ScheduleDraftReviewHandler } from "./schedule-draft-review.js";
import { bindScheduleDraftDialogs } from "./schedule-draft-dialog.js";
import { SkillLoader } from "../context/skill.js";
import { PluginManagementService } from "../plugins/plugin-management-service.js";
import {
  loadPluginRuntimeSnapshot,
  type PluginRuntimeSnapshot,
} from "../plugins/plugin-runtime-snapshot.js";
import { resolvePicoPaths } from "../paths/pico-paths.js";
import { RuntimeEventStore } from "../runtime/runtime-event-store.js";
import { RuntimeRun } from "../runtime/runtime-run.js";

export interface ReplOptions {
  /** 工作区 */
  workDir: string;
  /** provider 类型 */
  provider?: ProviderKind;
  /** 模型名(顶栏展示) */
  model: string;
  /** Whether model came from an explicit --model argument rather than an environment/default. */
  modelExplicit?: boolean;
  /** Provider 原生思考强度 */
  thinkingEffort?: string;
  /** MCP 配置路径(可选,首轮传入) */
  mcpConfigPath?: string;
  /** CLI 已解析的 session 选择结果。 */
  sessionSelection?: CliSessionSelection;
  /** CLI --add-dir 提供的附加工作目录。 */
  addDirs?: string[];
}

/** Resolve durable startup defaults while keeping an explicit CLI thinking value authoritative. */
export function resolveTuiStartupSettingDefaults(
  defaults: EffectiveConfigDefaults,
  explicitThinkingEffort?: string,
): Partial<Pick<SessionSettings, "mode" | "thinkingEffort">> {
  return {
    ...(defaults.mode ? { mode: defaults.mode } : {}),
    ...(explicitThinkingEffort !== undefined
      ? { thinkingEffort: explicitThinkingEffort }
      : defaults.thinkingEffort
        ? { thinkingEffort: defaults.thinkingEffort }
        : {}),
  };
}

function effectiveRuntimeConfigurationChanged(
  previous: EffectiveModelRuntime,
  current: EffectiveModelRuntime,
): boolean {
  return (
    previous.config.revisions.user !== current.config.revisions.user ||
    previous.config.revisions.project !== current.config.revisions.project
  );
}

interface TuiStartupModelOptions {
  cliModel: string;
  modelExplicit?: boolean;
  projectDefaultRouteId?: string;
}

/**
 * Resolve the initial route with the same precedence in Ink and TERM=dumb:
 * an explicit CLI override wins, otherwise a restorable session wins before defaults.
 */
export function resolveTuiStartupModelRoute(
  router: ModelRouter,
  restored: PersistedSessionSettings | undefined,
  options: TuiStartupModelOptions,
): ModelRoute {
  if (options.modelExplicit) return router.require(options.cliModel);
  return resolveRestoredSessionModelRoute(
    router,
    restored,
    options.projectDefaultRouteId ?? options.cliModel,
  );
}

/** Apply explicit startup overrides after hydration, then persist a coordinated route/level. */
export function coordinateTuiStartupSettings(
  settings: SessionSettings,
  router: ModelRouter,
  route: ModelRoute,
  thinkingEffort?: string,
): string | undefined {
  const routeChanged =
    settings.modelRouteId !== route.id ||
    settings.model !== route.model ||
    settings.provider !== route.provider;
  if (thinkingEffort !== undefined) {
    settings.thinkingEffort = thinkingEffort;
    settings.thinkingEffortExplicit = true;
  }
  if (routeChanged || thinkingEffort !== undefined) {
    migrateSessionModelRoute(settings, route);
  }
  return coordinateSessionReasoningLevel(settings, router);
}

/** Resolve a command frontmatter model for one run without mutating persisted session routing. */
export function resolveTuiPromptModelRoute(
  router: ModelRouter,
  settings: SessionSettings,
  requestedModel?: string,
  claudeCompatibility?: {
    enabled: boolean;
    modelAliases: Readonly<Record<string, string>>;
  },
): { route: ModelRoute; reasoningLevel?: string } {
  const requested = requestedModel?.trim();
  const inheritsModel = !requested || requested === "inherit";
  const route = inheritsModel
    ? router.require(settings.modelRouteId)
    : claudeCompatibility?.enabled
      ? resolveCompatibleModelRoute(router, requested, claudeCompatibility.modelAliases)
      : router.require(requested);
  const reasoningLevel = inheritsModel
    ? effectiveSessionReasoningLevel(settings, router)
    : coordinateReasoningLevel(
        route.capabilities.reasoningProfile,
        settings.thinkingEffortExplicit ? settings.thinkingEffort : undefined,
      ).level;
  return { route, ...(reasoningLevel === undefined ? {} : { reasoningLevel }) };
}

const SESSION_SELECTOR_DIALOG_ID = "local-ui:session-selector";
const HISTORY_PREPARING_DIALOG_ID = "local-ui:history-preparing";
const SELECTOR_DIALOG_PRIORITY = 40;
const APPROVAL_DIALOG_PRIORITY = 80;

export const TUI_RENDER_OPTIONS = {
  alternateScreen: true,
  incrementalRendering: true,
  patchConsole: true,
  exitOnCtrlC: false,
} as const satisfies RenderOptions;

/**
 * TERM=dumb 没有 Ink 多帧重绘所需的光标控制保证。此环境必须走
 * line-mode，而不是尝试通过 interactive:true 或关闭增量渲染来补救；
 * 标准 Ink renderer 同样依赖 cursor-up / erase。
 */
export function requiresTuiLineMode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TERM?.trim().toLowerCase() === "dumb";
}

export type TuiInputProcessResult = InputProcessResult;

export interface HandleTuiInputSubmissionDeps {
  reporter: TuiReporter;
  registry: CommandRegistry;
  workDir: string;
  runAgent: (
    prompt: string,
    options?: {
      images?: ImagePart[];
      resumeExistingSession?: boolean;
      model?: string;
      allowedTools?: readonly string[];
    },
  ) => Promise<void>;
  setRewindContext?: (context: { prompt: string; transcriptIndex: number }) => void;
  exit: () => void;
  processInput?: (text: string) => Promise<TuiInputProcessResult>;
  openDialog?: (request: DialogRequest) => void;
  closeDialog?: (id: string) => void;
  dispatchInput?: (text: string) => Promise<void> | void;
  openLocalUiDialog?: (result: LocalCommandResult) => Promise<void> | void;
  switchSession?: (selection: ResumeSessionCommandData) => Promise<void>;
  openChanges?: (messageId: string) => Promise<void>;
  sessionId?: string;
  currentModelId?: string;
  modelOptions?: readonly ModelOption[];
  createModelSelectorContent?: (effect: LocalTuiModelSelectorDialogEffect) => React.ReactNode;
  commandAvailabilityState?: CommandInputState;
  abortControllerRef?: TuiAbortControllerRef;
  /** 异步解析后确认该输入仍属于当前 bundle generation。 */
  isActive?: () => boolean;
  activateAgentHooks?: (metadata: Record<string, unknown>) => void | Promise<void>;
  clearComponentHooks?: () => void | Promise<void>;
  skillLoader?: SkillLoader;
}

export type LocalTuiCommandUiEffect = { kind: "none" } | LocalTuiModelSelectorDialogEffect;

export interface LocalTuiModelSelectorDialogEffect {
  kind: "dialog";
  selector: "model";
  request: DialogRequest;
  models: readonly ModelOption[];
  currentModelId?: string;
}

export interface HandleTuiRunningInputSubmissionDeps extends HandleTuiInputSubmissionDeps {
  guard: Pick<QueryGuard, "tryStart" | "end" | "getSnapshot">;
  queue: RunningInputQueue;
  onQueueSizeChange?: (size: number) => void;
  onQueueStateChange?: (snapshot: RunningInputQueueSnapshot) => void;
  steerQueue?: SteerQueue;
  abortControllerRef?: TuiAbortControllerRef;
}

export type TuiRunAgent = (
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies,
) => Promise<RunAgentCliResult>;

export interface TuiAbortControllerRef {
  current: AbortController | null;
}

interface TuiSessionBundle {
  readonly generation: number;
  readonly selection: CliSessionSelection;
  readonly sessionId: string;
  readonly session: Session;
  readonly runtimeState: TuiRuntimeState;
  readonly settings: SessionSettings;
  readonly workspaceRoots: WorkspaceRoots;
  readonly toolRegistry: ToolRegistry;
  readonly registry: CommandRegistry;
  readonly reporter: TuiReporter;
  readonly askUserHandler: AskUserHandler;
  readonly scheduleDraft?: TuiScheduleDraftRuntime;
  readonly mcpElicitationHandler: McpElicitationUiHandler;
  readonly skillLoader: SkillLoader;
  readonly recoveredRewindInputText?: string;
  latestMcpStatus?: McpStatusSnapshot;
}

interface TuiScheduleDraftRuntime {
  readonly handler: ScheduleDraftReviewHandler;
  readonly coordinator: ScheduleDraftCoordinatorContract;
}

function createTuiScheduleDraftRuntime(
  options: CronDraftApplicationOptions,
): TuiScheduleDraftRuntime {
  const handler = new ScheduleDraftReviewHandler();
  const application = new CronDraftApplication(options);
  const coordinator = new ScheduleDraftCoordinator({
    reviewer: handler,
    resolveContext: () => application.context(),
    commit: (draft, signal) => application.commit(draft, signal),
  });
  return { handler, coordinator };
}

export function getTuiCommandAvailabilityState(status: string): CommandInputState {
  return status === "idle" ? "idle" : "running";
}

export async function handleTuiInputSubmission(
  text: string,
  deps: HandleTuiInputSubmissionDeps,
  attachments: readonly ImagePart[] = [],
): Promise<void> {
  if (handleApprovalCommand(text, deps)) return;

  const processed = await processTuiInput(text, {
    ...deps,
    commandAvailabilityState: deps.commandAvailabilityState ?? "idle",
  });
  if (deps.isActive && !deps.isActive()) return;

  switch (processed.type) {
    case "empty":
      return;
    case "prompt": {
      const rewindTranscriptIndex = deps.reporter.getEntryCount();
      deps.reporter.pushUserMessage(processed.raw);
      await runPreparedUserPrompt(
        processed.prompt,
        deps,
        {
          rewindPrompt: processed.raw,
          rewindTranscriptIndex,
        },
        attachments,
      );
      return;
    }
    case "prompt-command": {
      const rewindTranscriptIndex = deps.reporter.getEntryCount();
      deps.reporter.pushUserMessage(processed.raw);
      const skillActivation = skillActivationFromMetadata(processed.result.metadata);
      if (skillActivation) {
        deps.reporter.pushSkillActivation(skillActivation);
      }
      await runPreparedUserPrompt(
        processed.result.prompt,
        deps,
        {
          rewindPrompt: processed.raw,
          rewindTranscriptIndex,
        },
        attachments,
        processed.result.metadata
          ? () => deps.activateAgentHooks?.(processed.result.metadata!)
          : undefined,
        () => deps.clearComponentHooks?.(),
        processed.result.execution,
      );
      return;
    }
    case "local-command":
      await handleLocalTuiCommand(processed.result, deps);
      return;
    case "unknown-command":
      deps.reporter.pushSystemMessage(formatUnknownCommand(processed));
      return;
  }
}

function skillActivationFromMetadata(
  metadata: Record<string, unknown> | undefined,
): { name: string; args: string; trigger: "user-slash" | "model-tool" } | undefined {
  if (!metadata) return undefined;
  const name = metadata["skillName"];
  const args = metadata["skillArgs"];
  const trigger = metadata["skillTrigger"];
  if (
    typeof name !== "string" ||
    typeof args !== "string" ||
    (trigger !== "user-slash" && trigger !== "model-tool")
  ) {
    return undefined;
  }
  return { name, args, trigger };
}

async function runPreparedUserPrompt(
  prompt: string,
  deps: Pick<
    HandleTuiInputSubmissionDeps,
    "workDir" | "reporter" | "runAgent" | "setRewindContext" | "abortControllerRef" | "skillLoader"
  >,
  rewind: { rewindPrompt: string; rewindTranscriptIndex: number },
  attachments: readonly ImagePart[],
  beforeRun?: () => void | Promise<void>,
  afterRun?: () => void | Promise<void>,
  execution?: { model?: string; allowedTools?: readonly string[] },
): Promise<void> {
  let prepared: PreparedUserPrompt;
  try {
    deps.abortControllerRef?.current?.signal.throwIfAborted();
    prepared = await preparePromptForMessage(prompt, deps.workDir, deps.skillLoader);
    deps.abortControllerRef?.current?.signal.throwIfAborted();
  } catch (error) {
    appendTuiRunError(deps.reporter, error);
    return;
  }

  for (const notice of prepared.notices ?? []) {
    deps.reporter.pushSystemMessage(notice);
  }
  deps.setRewindContext?.({
    prompt: rewind.rewindPrompt,
    transcriptIndex: rewind.rewindTranscriptIndex,
  });
  try {
    await beforeRun?.();
    const images = [...(prepared.images ?? []), ...attachments];
    const runOptions = {
      ...(execution?.model === undefined ? {} : { model: execution.model }),
      ...(execution?.allowedTools === undefined ? {} : { allowedTools: execution.allowedTools }),
    };
    if (images.length > 0) {
      await deps.runAgent(prepared.prompt, { ...runOptions, images });
      return;
    }
    if (Object.keys(runOptions).length === 0) {
      await deps.runAgent(prepared.prompt);
    } else {
      await deps.runAgent(prepared.prompt, runOptions);
    }
  } finally {
    await afterRun?.();
  }
}

export async function handleTuiRunningInputSubmission(
  text: string,
  deps: HandleTuiRunningInputSubmissionDeps,
  attachments: readonly ImagePart[] = [],
): Promise<void> {
  if (handleApprovalCommand(text, deps)) return;

  const running = deps.guard.getSnapshot() !== "idle";
  if (running && attachments.length > 0) {
    deps.reporter.pushSystemMessage("图片附件请在当前运行结束后提交。");
    return;
  }
  const availabilityState: CommandInputState = running ? "running" : "idle";

  if (running && isExplicitRunningInputCommand(text)) {
    applyRunningInputIntent(parseRunningInputIntent(text), deps);
    return;
  }

  const processed = await processTuiInput(text, {
    ...deps,
    commandAvailabilityState: availabilityState,
  });
  if (deps.isActive && !deps.isActive()) return;
  if (!needsAgentRun(processed)) {
    await handleTuiInputSubmission(
      text,
      {
        ...deps,
        processInput: async () => processed,
        commandAvailabilityState: availabilityState,
      },
      attachments,
    );
    return;
  }

  const gen = deps.guard.tryStart();
  if (gen === null) {
    const steerText = agentPromptFromProcessed(processed);
    if (deps.steerQueue) {
      deps.queue.inject(steerText, "steer");
      deps.steerQueue.push(steerText);
      deps.reporter.pushUserMessage(steerText);
      emitRunningQueueState(deps);
      deps.reporter.pushSystemMessage("Steer accepted for the next model boundary.");
    } else {
      enqueueRunningInput(text, processed, availabilityState, deps);
    }
    return;
  }

  await runProcessedAgentInput(
    text,
    processed,
    { ...deps, commandAvailabilityState: availabilityState },
    gen,
    { drainAfter: true },
    attachments,
  );
}

async function runProcessedAgentInput(
  text: string,
  processed: TuiInputProcessResult,
  deps: HandleTuiRunningInputSubmissionDeps,
  gen: number,
  options: { drainAfter: boolean },
  attachments: readonly ImagePart[] = [],
): Promise<void> {
  const controller = new AbortController();
  if (deps.abortControllerRef) deps.abortControllerRef.current = controller;
  try {
    await handleTuiInputSubmission(
      text,
      {
        ...deps,
        processInput: async () => processed,
      },
      attachments,
    );
  } finally {
    const drainAfterAbort =
      !controller.signal.aborted ||
      (controller.signal.reason instanceof DOMException &&
        controller.signal.reason.message === "replaced");
    if (!drainAfterAbort) {
      deps.steerQueue?.drain();
      deps.queue.clear();
    }
    if (deps.abortControllerRef?.current === controller) {
      deps.abortControllerRef.current = null;
    }
    if (deps.steerQueue && !deps.steerQueue.pending) deps.queue.acknowledgeSteers();
    emitRunningQueueState(deps);
    if (deps.guard.end(gen) && options.drainAfter && drainAfterAbort) {
      await drainQueuedTuiInputs(deps);
    }
  }
}

async function drainQueuedTuiInputs(deps: HandleTuiRunningInputSubmissionDeps): Promise<void> {
  while (deps.queue.size > 0) {
    const queued = deps.queue.drain();
    emitRunningQueueState(deps);
    for (const item of queued) {
      if (deps.isActive && !deps.isActive()) return;
      if (item.kind !== "normal" && item.kind !== "replace") continue;
      const commandAvailabilityState = item.commandAvailabilityState ?? "idle";
      const processed =
        item.processed ?? (await processTuiInput(item.text, { ...deps, commandAvailabilityState }));
      if (deps.isActive && !deps.isActive()) return;
      if (!needsAgentRun(processed)) {
        await handleTuiInputSubmission(item.text, {
          ...deps,
          processInput: async () => processed,
          commandAvailabilityState,
        });
        continue;
      }

      const gen = deps.guard.tryStart();
      if (gen === null) {
        const queuedAgain = deps.queue.enqueue(item.text, processed, {
          commandAvailabilityState,
        });
        if (queuedAgain.type === "rejected") {
          deps.reporter.pushSystemMessage(
            `Input queue is full (${queuedAgain.capacity}). Please wait.`,
          );
        } else {
          emitRunningQueueState(deps);
        }
        return;
      }

      await runProcessedAgentInput(
        item.text,
        processed,
        {
          ...deps,
          commandAvailabilityState,
        },
        gen,
        { drainAfter: false },
      );
    }
  }
}

function isExplicitRunningInputCommand(text: string): boolean {
  return /^\/(?:steer|queue|replace)(?:\s|$)/u.test(text.trim()) || text.trim() === "/interrupt";
}

function agentPromptFromProcessed(
  processed: Extract<TuiInputProcessResult, { type: "prompt" | "prompt-command" }>,
): string {
  return processed.type === "prompt" ? processed.prompt : processed.result.prompt;
}

function applyRunningInputIntent(
  intent: RunningInputIntent,
  deps: HandleTuiRunningInputSubmissionDeps,
): void {
  if (intent.kind === "interrupt") {
    handleTuiInterrupt(
      deps.abortControllerRef?.current ?? null,
      deps.queue,
      deps.reporter,
      deps.onQueueSizeChange,
      deps.onQueueStateChange,
      deps.steerQueue,
    );
    return;
  }

  if (!intent.text) {
    deps.reporter.pushSystemMessage(`Usage: /${intent.kind} <text>`);
    return;
  }

  if (intent.kind === "steer") {
    if (!deps.steerQueue) {
      deps.reporter.pushSystemMessage("Steer is unavailable for the current runtime.");
      return;
    }
    deps.queue.inject(intent.text, "steer");
    deps.steerQueue.push(intent.text);
    deps.reporter.pushUserMessage(intent.text);
    emitRunningQueueState(deps);
    deps.reporter.pushSystemMessage("Steer accepted for the next model boundary.");
    return;
  }

  if (intent.kind === "queue") {
    enqueueRunningInput(intent.text, undefined, "idle", deps);
    return;
  }

  deps.steerQueue?.drain();
  deps.queue.acknowledgeSteers();
  const replacement = deps.queue.replace(intent.text);
  deps.abortControllerRef?.current?.abort(new DOMException("replaced", "AbortError"));
  emitRunningQueueState(deps);
  deps.reporter.pushSystemMessage(
    replacement.dropped > 0
      ? `Replacing the active run; dropped ${replacement.dropped} queued input(s).`
      : "Replacing the active run after it stops.",
  );
}

function enqueueRunningInput(
  text: string,
  processed: TuiInputProcessResult | undefined,
  availabilityState: CommandInputState,
  deps: HandleTuiRunningInputSubmissionDeps,
): void {
  const queued = deps.queue.enqueue(text, processed, {
    commandAvailabilityState: availabilityState,
  });
  if (queued.type === "rejected") {
    deps.reporter.pushSystemMessage(`Input queue is full (${queued.capacity}). Please wait.`);
    return;
  }
  emitRunningQueueState(deps);
  deps.reporter.pushSystemMessage("Input queued for the next user turn.");
}

function emitRunningQueueState(deps: HandleTuiRunningInputSubmissionDeps): void {
  deps.onQueueSizeChange?.(deps.queue.size);
  deps.onQueueStateChange?.(deps.queue.snapshot);
}

async function processTuiInput(
  text: string,
  deps: Pick<
    HandleTuiInputSubmissionDeps,
    "registry" | "processInput" | "commandAvailabilityState"
  >,
): Promise<TuiInputProcessResult> {
  const unavailable = blockedUnavailableCommand(
    text,
    deps.registry,
    deps.commandAvailabilityState ?? "idle",
  );
  if (unavailable !== undefined) {
    return {
      type: "local-command",
      raw: text,
      command: unavailable.name,
      args: unavailable.args,
      argv: unavailable.argv,
      result: {
        type: "local",
        action: "message",
        message: formatUnavailableCommandBlocked(unavailable.name, unavailable.disabledReason),
      },
    };
  }

  return (deps.processInput ?? ((input) => processUserInput(input, { registry: deps.registry })))(
    text,
  );
}

function needsAgentRun(
  processed: TuiInputProcessResult,
): processed is Extract<TuiInputProcessResult, { type: "prompt" | "prompt-command" }> {
  return processed.type === "prompt" || processed.type === "prompt-command";
}

function blockedUnavailableCommand(
  text: string,
  registry: CommandRegistry,
  state: CommandInputState,
):
  | {
      name: string;
      args: string;
      argv: readonly string[];
      disabledReason: string;
    }
  | undefined {
  const parsed = parseSlashInput(text);
  if (!parsed) return undefined;

  const command = registry.resolve(parsed.name);
  if (!command) return undefined;
  const availability = getCommandAvailability(command, state);
  if (availability.available) return undefined;
  return {
    name: command.name,
    args: parsed.args,
    argv: parsed.argv,
    disabledReason: availability.disabledReason ?? "Command is unavailable.",
  };
}

function formatUnavailableCommandBlocked(command: string, disabledReason: string): string {
  return `Cannot run /${command}: ${disabledReason}`;
}

/**
 * TERM=dumb 的最小可用入口。它故意不用 Ink：即使关闭增量渲染，Ink 的
 * 标准 renderer 仍需要 cursor-up / erase，无法防止宿主把每帧追加成日志。
 * 行模式保留可靠的多轮文本会话；依赖实时重绘的候选、面板、图片和鼠标交互
 * 明确不提供，避免给用户一个会损坏屏幕状态的半成品 TUI。
 */
async function startLineModeRepl(opts: ReplOptions): Promise<void> {
  const provider = opts.provider ?? "openai";
  const runtimeEventStore = new RuntimeEventStore({
    databasePath: resolvePicoPaths(opts.workDir).workspace.runtimeDatabase,
  });
  const credentialVault = createPlatformCredentialVault();
  const userConfigStore = new UserConfigStore();
  const loadCurrentModelRuntime = () =>
    loadEffectiveModelRuntime({
      workDir: opts.workDir,
      projectTrusted: true,
      legacyProvider: provider,
      legacyModel: opts.model,
      legacyModelExplicit: opts.modelExplicit,
      credentialVault,
      userConfigStore,
    });
  let effectiveModelRuntime = await loadCurrentModelRuntime();
  let modelRouter = effectiveModelRuntime.router;
  const input = createInterface({
    input: process.stdin,
    output: process.stdout,
    // TERM=dumb 宿主不能可靠处理 readline 的 inline-edit ANSI 序列。
    // 关闭 readline terminal 模式，让内核负责最基本的行编辑与回显。
    terminal: false,
  });
  let selection: CliSessionSelection = opts.sessionSelection ?? {
    mode: "new",
    sessionId: createCliSessionId(),
  };
  let activeAbortController: AbortController | undefined;
  const onSigint = () => {
    if (activeAbortController) {
      if (!activeAbortController.signal.aborted) {
        process.stdout.write("正在中断当前请求…\n");
        activeAbortController.abort();
      }
      return;
    }
    input.close();
  };
  // terminal:false 时 Ctrl+C 通常作为进程信号送达；保留 readline 监听以
  // 兼容能把它交给 readline 的 PTY 实现。
  input.on("SIGINT", onSigint);
  process.on("SIGINT", onSigint);

  const resolveActiveRoute = async () => {
    const previousRuntime = effectiveModelRuntime;
    effectiveModelRuntime = await loadCurrentModelRuntime();
    modelRouter = effectiveModelRuntime.router;
    if (effectiveRuntimeConfigurationChanged(previousRuntime, effectiveModelRuntime)) {
      process.stdout.write(
        "Shared Provider configuration changed; reloaded at the next-run safe boundary.\n",
      );
    }
    const startupDefaults = resolveTuiStartupSettingDefaults(
      effectiveModelRuntime.config.defaults,
      opts.thinkingEffort,
    );
    // 第二轮开始读取会话已持久化的模型选择，与完整 TUI 的 bundle 装配保持一致。
    // fork 首轮由 executeAgentRuntime 先执行 Saga，此时目标会话尚不可安全预创建。
    if (selection.mode !== "fork") {
      const session =
        globalSessionManager.get(selection.sessionId, opts.workDir) ??
        (await globalSessionManager.getOrCreate(selection.sessionId, opts.workDir, {
          persistence: true,
        }));
      if (!session.runtimeEventStore) {
        throw new Error(`TUI requires a durable Session: ${selection.sessionId}`);
      }
      await runtimeEventStore.initializeSession({
        sessionId: session.id,
        workDir: opts.workDir,
      });
      await RuntimeRun.repairSessionProjection(session, {
        workDir: opts.workDir,
        store: runtimeEventStore,
      });
      const restoredSettings = (await session.readHydrationSnapshot()).runtime.settings;
      const route = resolveTuiStartupModelRoute(modelRouter, restoredSettings, {
        cliModel: opts.model,
        modelExplicit: opts.modelExplicit,
        projectDefaultRouteId: effectiveModelRuntime.config.defaultModelRouteId,
      });
      const settings = getOrCreateSessionSettings(
        {
          sessionId: selection.sessionId,
          sessionMode: selection.mode,
          cwd: opts.workDir,
          provider: route.provider,
          model: route.model,
          modelRouteId: route.id,
          ...startupDefaults,
        },
        { persistence: session },
      );
      const thinkingEffort = coordinateTuiStartupSettings(
        settings,
        modelRouter,
        route,
        opts.thinkingEffort,
      );
      return modelRouter.providerConfig(route.id, thinkingEffort);
    }
    const route = modelRouter.require(
      opts.modelExplicit
        ? opts.model
        : (effectiveModelRuntime.config.defaultModelRouteId ?? opts.model),
    );
    return modelRouter.providerConfig(route.id, startupDefaults.thinkingEffort);
  };

  process.stdout.write(
    "Pico 已切换到兼容行模式（TERM=dumb）：支持文本对话和多轮会话；动态候选、面板、图片输入不可用。\n",
  );
  process.stdout.write("输入 /help 查看限制，/exit 或 Ctrl+C 退出。\n");
  input.setPrompt("pico> ");
  input.prompt();

  try {
    for await (const rawInput of input) {
      const text = rawInput.trim();
      if (text.length === 0) {
        input.prompt();
        continue;
      }
      if (text === "/exit" || text === "/q") break;
      if (text === "/help") {
        process.stdout.write(
          "兼容行模式仅支持普通文本提示词；/exit、/q、/help 可用。请在支持完整 ANSI 的终端使用完整 TUI。\n",
        );
        input.prompt();
        continue;
      }
      if (text.startsWith("/")) {
        process.stdout.write("兼容行模式不执行斜杠命令；请输入普通文本，或使用 /help。\n");
        input.prompt();
        continue;
      }

      try {
        const activeRoute = await resolveActiveRoute();
        const abortController = new AbortController();
        activeAbortController = abortController;
        const result = await executeAgentRuntime(
          {
            prompt: rawInput,
            dir: opts.workDir,
            provider: activeRoute.provider,
            baseURL: activeRoute.config.baseURL,
            ...(activeRoute.route.source === "legacy" ? {} : { apiKey: activeRoute.config.apiKey }),
            model: activeRoute.config.model,
            modelRouteId: activeRoute.route.id,
            modelCapabilities: activeRoute.route.capabilities,
            ...(activeRoute.config.thinkingEffort !== undefined
              ? { thinkingEffort: activeRoute.config.thinkingEffort }
              : {}),
            ...(opts.mcpConfigPath !== undefined ? { mcpConfigPath: opts.mcpConfigPath } : {}),
            ...(opts.addDirs !== undefined ? { addDirs: opts.addDirs } : {}),
            sessionSelection: selection,
          },
          {
            reporter: new LineModeReporter(process.stdout),
            signal: abortController.signal,
            modelRouter,
          },
        );
        selection = { mode: "resume", sessionId: result.sessionId };
      } catch (error) {
        process.stdout.write(
          isAbortError(error)
            ? "当前请求已中断。\n"
            : `请求失败：${error instanceof Error ? error.message : String(error)}\n`,
        );
      } finally {
        activeAbortController = undefined;
      }
      input.prompt();
    }
  } finally {
    input.off("SIGINT", onSigint);
    process.off("SIGINT", onSigint);
    input.close();
  }
}

class LineModeReporter implements Reporter {
  private wroteStreamingText = false;

  constructor(private readonly output: NodeJS.WriteStream) {}

  onStart(workDir: string): void {
    this.output.write(`工作区：${workDir}\n`);
  }

  onTurnStart(turn: number): void {
    this.output.write(`第 ${turn} 轮\n`);
  }

  onThinking(): void {
    this.output.write("思考中…\n");
  }

  onToolCall(toolName: string): void {
    this.output.write(`执行工具：${toolName}\n`);
  }

  onToolResult(toolName: string, result: string, isError: boolean): void {
    const summary = result.replace(/\s+/gu, " ").trim().slice(0, 180);
    this.output.write(
      `${isError ? "工具失败" : "工具完成"}：${toolName}${summary ? ` · ${summary}` : ""}\n`,
    );
  }

  onMessage(content: string): void {
    if (this.wroteStreamingText) {
      this.output.write("\n");
      this.wroteStreamingText = false;
      return;
    }
    this.output.write(`回复：${content}\n`);
  }

  onFinish(): void {}

  onTextDelta(delta: string): void {
    this.wroteStreamingText = true;
    this.output.write(delta);
  }
}

/** 启动 TUI REPL 循环 */
export async function startTuiRepl(opts: ReplOptions): Promise<void> {
  await reconcileUnfinishedSessionForksOrThrow(opts.workDir);
  if (requiresTuiLineMode()) {
    await startLineModeRepl(opts);
    return;
  }

  // Pino 静默由 preload-env.ts 在模块加载前完成；console 由 Ink
  // patchConsole 在清除/恢复帧的记录内协调,避免任何运行期日志移动 PTY 光标。

  // 诊断:hook process.stdout.write,记录 ink 实际输出的 ANSI(看擦除行为)
  if (process.env.TUI_DEBUG) {
    const { appendFileSync, mkdirSync } = await import("node:fs");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const origWrite = process.stdout.write.bind(process.stdout) as any;
    let frame = 0;
    const stdoutAny = process.stdout as any;
    stdoutAny._origWrite = origWrite;
    stdoutAny.write = (chunk: unknown, ...args: unknown[]) => {
      const str = typeof chunk === "string" ? chunk : String(chunk);
      if (str.includes("\x1b[") || frame < 5) {
        const visible = str.replaceAll("\x1b[", "ESC[").replaceAll("\x1b", "ESC").slice(0, 200);
        const paths = resolvePicoPaths(opts.workDir);
        mkdirSync(paths.workspace.root, { recursive: true });
        appendFileSync(paths.workspace.debugLog, `[stdout f${frame}] ${visible}\n`);
      }
      frame++;
      return origWrite(chunk, ...args);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  const provider = opts.provider ?? "openai";
  const picoConfig = await loadPicoConfig(opts.workDir);
  const pluginManagement = new PluginManagementService({ workDir: opts.workDir });
  const claudeCompatibility = picoConfig.compatibility.claude;
  const credentialVault = createPlatformCredentialVault();
  const userConfigStore = new UserConfigStore();
  const loadCurrentModelRuntime = () =>
    loadEffectiveModelRuntime({
      workDir: opts.workDir,
      projectTrusted: true,
      legacyProvider: provider,
      legacyModel: opts.model,
      legacyModelExplicit: opts.modelExplicit,
      credentialVault,
      userConfigStore,
    });
  let effectiveModelRuntime = await loadCurrentModelRuntime();
  let modelRouter = effectiveModelRuntime.router;
  const reloadModelRuntimeAtSafeBoundary = async (): Promise<{
    readonly runtime: EffectiveModelRuntime;
    readonly configurationChanged: boolean;
  }> => {
    const previous = effectiveModelRuntime;
    const current = await loadCurrentModelRuntime();
    effectiveModelRuntime = current;
    modelRouter = current.router;
    return {
      runtime: current,
      configurationChanged: effectiveRuntimeConfigurationChanged(previous, current),
    };
  };
  let cronRuntimeDiagnostic: string | undefined;
  const cronService = (() => {
    try {
      return new CronService({ workDir: opts.workDir });
    } catch (error) {
      cronRuntimeDiagnostic = error instanceof Error ? error.message : String(error);
      return undefined;
    }
  })();
  // 只在用户创建或启用任务时短连接 daemon；TUI 不接管后台 Runtime 生命周期。
  const cronDaemonBridge = new LocalCronDaemonBridge();
  let taskRuntimeDiagnostic: string | undefined;
  const taskHostRuntime = await TaskHostRuntime.create({ workDir: opts.workDir }).catch((error) => {
    taskRuntimeDiagnostic = error instanceof Error ? error.message : String(error);
    return undefined;
  });
  const pluginSnapshot = await loadPluginRuntimeSnapshot({
    workDir: opts.workDir,
    service: pluginManagement,
  });
  const createRuntimeSkillLoader = (workDir: string): SkillLoader =>
    new SkillLoader(workDir, {
      includeUserResources: true,
      includeClaudeProjectResources:
        claudeCompatibility.enabled && claudeCompatibility.projectResources,
      includeClaudeUserResources: claudeCompatibility.enabled && claudeCompatibility.userResources,
      externalSources: pluginSnapshot.skillSources,
    });
  let activeBundle: TuiSessionBundle | undefined;
  const sharedMcpManager = new McpConnectionManager(undefined, {
    stdioCwd: opts.workDir,
    elicitationHandler: async (request, context) => {
      const current = activeBundle;
      if (!current) return { action: "cancel" };
      return await createHookedElicitationHandler({
        ui: current.mcpElicitationHandler,
        hookService: () => current.runtimeState.hookService,
      })(request, context);
    },
  });
  const defaultMcpConfig =
    opts.mcpConfigPath === undefined ? await resolveProjectMcpConfigPath(opts.workDir) : undefined;
  const mcpConfigPath =
    opts.mcpConfigPath ?? defaultMcpConfig?.path ?? join(opts.workDir, ".pico", "mcp.json");
  let mcpInitialized = false;
  let mcpStatusVisible = opts.mcpConfigPath !== undefined || defaultMcpConfig?.exists === true;
  const tuiSessionSelection: CliSessionSelection = opts.sessionSelection ?? {
    mode: "new",
    sessionId: createCliSessionId(),
  };
  const runtimeEventStore = new RuntimeEventStore({
    databasePath: resolvePicoPaths(opts.workDir).workspace.runtimeDatabase,
  });
  // ink render 需要 setState 驱动重渲染。Reporter 回调只更新当前活跃 bundle，
  // 旧 session 的延迟事件不会穿透到新 transcript。
  let setProjection: (projection: TuiProjection) => void = () => {};
  let nextBundleGeneration = 0;
  let shuttingDown = false;
  const pendingSessionSwitches = new Set<Promise<void>>();
  const pendingTuiSubmissions = new Set<Promise<void>>();
  const pendingDelegationWakes = new Set<Promise<void>>();
  const pendingHookWakes = new Set<Promise<void>>();
  const pendingTuiDialogActions = new Set<Promise<unknown>>();
  let activeAbortControllerRef: TuiAbortControllerRef | undefined;
  const unsubscribeMcpStatus = sharedMcpManager.subscribe((snapshot) => {
    mcpStatusVisible =
      snapshot.configPath !== undefined || (snapshot.configSources?.length ?? 0) > 0;
    if (!activeBundle) return;
    activeBundle.latestMcpStatus = snapshot;
    setSessionTools(activeBundle.settings, toolStatusFromRegistry(activeBundle.toolRegistry));
  });
  const unsubscribeTaskCompletion = taskHostRuntime?.supervisor.subscribeCompletion((task) => {
    const current = activeBundle;
    if (!current) return;
    const message = `Task ${task.taskId} ${task.status}: ${task.description}${task.error ? ` · ${task.error}` : ""}`;
    current.reporter.pushSystemMessage(message);
    void current.runtimeState
      .dispatchHook("Notification", {
        level: task.error ? "error" : "info",
        message,
      })
      .catch(() => {});
  });

  const buildSessionBundleUnsafe = async (
    selection: CliSessionSelection,
  ): Promise<TuiSessionBundle> => {
    // Session construction is an idle boundary. Re-resolve both durable config and the OS vault so
    // App/TUI edits and key rotation are visible without replacing an in-flight Provider.
    const { runtime: bundleModelRuntime } = await reloadModelRuntimeAtSafeBoundary();
    const bundleModelRouter = bundleModelRuntime.router;
    let session = globalSessionManager.get(selection.sessionId, opts.workDir);
    if (selection.mode === "fork" && selection.sourceSessionId) {
      const sourceManifest = await runtimeEventStore.readSessionManifest(selection.sourceSessionId);
      if (!sourceManifest) {
        throw new Error(`无法 fork session ${selection.sourceSessionId}: runtime.sqlite 中不存在`);
      }
      if (!(await runtimeEventStore.readSessionManifest(selection.sessionId))) {
        const sourceSession = await globalSessionManager.getOrCreate(
          selection.sourceSessionId,
          opts.workDir,
          { persistence: true },
        );
        await RuntimeRun.repairSessionProjection(sourceSession, {
          workDir: opts.workDir,
          store: runtimeEventStore,
        });
        await new SessionForkService({ workDir: opts.workDir }).fork({
          sourceSessionId: selection.sourceSessionId,
          targetSessionId: selection.sessionId,
          targetMode: DEFAULT_INTERACTION_MODE,
        });
      }
      const forkEvent = (await runtimeEventStore.readSession(selection.sessionId)).findLast(
        (event) => event.kind === "session.forked",
      );
      if (!forkEvent) {
        throw new Error(`fork target ${selection.sessionId} 缺少完整的 RuntimeEvent 历史`);
      }
      if (forkEvent.data.parentSessionId !== selection.sourceSessionId) {
        throw new Error(
          `fork target ${selection.sessionId} 记录的 parent ${forkEvent.data.parentSessionId} 与当前请求不一致`,
        );
      }
    }
    session ??= await globalSessionManager.getOrCreate(selection.sessionId, opts.workDir, {
      persistence: true,
    });
    if (!session.runtimeEventStore) {
      throw new Error(`TUI requires a durable Session: ${selection.sessionId}`);
    }
    await runtimeEventStore.initializeSession({
      sessionId: session.id,
      workDir: opts.workDir,
    });
    await RuntimeRun.repairSessionProjection(session, {
      workDir: opts.workDir,
      store: runtimeEventStore,
    });

    // 在 route / WorkspaceRoots / provider 装配前先冻结 Session 的消息与运行态。
    const hydration = await session.readHydrationSnapshot();
    const restoredSettings = hydration.runtime.settings;
    // 已有 route ID 必须精确恢复；真正没有 route ID 的 legacy session
    // 只有在 provider + model 唯一匹配时才会迁移，避免跨 Provider 静默切换。
    const initialRoute = resolveTuiStartupModelRoute(bundleModelRouter, restoredSettings, {
      cliModel: opts.model,
      modelExplicit: opts.modelExplicit,
      projectDefaultRouteId: bundleModelRuntime.config.defaultModelRouteId,
    });
    const startupDefaults = resolveTuiStartupSettingDefaults(
      bundleModelRuntime.config.defaults,
      opts.thinkingEffort,
    );
    const workspaceRoots = await WorkspaceRoots.create(
      opts.workDir,
      selection.mode === "fork"
        ? []
        : [
            ...picoConfig.additionalDirectories,
            ...(opts.addDirs ?? []),
            ...(restoredSettings?.additionalDirectories ?? []),
          ],
    );
    const runtimeState = await createTuiRuntimeState({
      session,
      lspServers: [...picoConfig.lspServers, ...pluginSnapshot.lspServers],
      hookExtensionSources: pluginSnapshot.hookSources,
      ...(taskHostRuntime ? { taskHostRuntime } : {}),
    });

    try {
      const { toolDisclosure, fileIndex, codeIntelligence } = runtimeState;
      const askUserHandler = new AskUserHandler();
      const mcpElicitationHandler = new McpElicitationUiHandler();
      const skillLoader = createRuntimeSkillLoader(opts.workDir);
      const toolRegistry = buildDefaultToolRegistry(opts.workDir, {
        toolDisclosure,
        workspaceRoots,
        askUserHandler,
        codeIntelligence,
        skillLoader,
      });
      sharedMcpManager.attachRegistry(toolRegistry);
      if (!mcpInitialized) {
        mcpInitialized = true;
        const shouldLoadMcpConfig =
          pluginSnapshot.mcpSources.length > 0 ||
          opts.mcpConfigPath !== undefined ||
          defaultMcpConfig?.exists === true;
        if (shouldLoadMcpConfig) {
          try {
            await sharedMcpManager.replaceSources([
              {
                id: "project",
                path: mcpConfigPath,
                optional: opts.mcpConfigPath === undefined,
              },
              ...pluginSnapshot.mcpSources,
            ]);
            await sharedMcpManager.connectAll();
          } catch {
            // /mcp 展示配置或连接错误；TUI 本身继续可用。
          }
        }
      }
      const latestMcpStatus = mcpStatusVisible ? sharedMcpManager.getStatusSnapshot() : undefined;

      const settings = getOrCreateSessionSettings(
        {
          sessionId: selection.sessionId,
          sessionMode: selection.mode,
          ...(selection.sourceSessionId !== undefined
            ? { forkFrom: selection.sourceSessionId }
            : {}),
          cwd: opts.workDir,
          provider: initialRoute.provider,
          model: initialRoute.model,
          modelRouteId: initialRoute.id,
          ...startupDefaults,
          tools: toolStatusFromRegistry(toolRegistry),
          additionalDirectories: workspaceRoots.list().slice(1),
        },
        { persistence: session },
      );
      coordinateTuiStartupSettings(settings, bundleModelRouter, initialRoute, opts.thinkingEffort);
      setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));

      const scheduleDraft = cronService
        ? createTuiScheduleDraftRuntime({
            cronService,
            workspacePath: opts.workDir,
            resolveModelRoute: () => modelRouter.require(settings.modelRouteId),
            listAllowedTools: () => settings.tools.map((tool) => tool.name),
            credentialVault,
            resolveCredentialTarget: async (route) => {
              const userProvider = (await userConfigStore.read()).config.providers[
                route.providerId
              ];
              return resolveAutomationCredentialTarget({
                route,
                workspacePath: opts.workDir,
                ...(userProvider ? { userProvider } : {}),
                ...(bundleModelRuntime.config.sources[`providers.${route.providerId}`]
                  ? {
                      configSource:
                        bundleModelRuntime.config.sources[`providers.${route.providerId}`],
                    }
                  : {}),
              });
            },
            workspaceRegistrar: cronDaemonBridge,
          })
        : undefined;

      const bundleRef: { current?: TuiSessionBundle } = {};
      const registry = await createPicoCommandRegistry({
        workDir: opts.workDir,
        projectCommandsDir: picoConfig.commandsDir,
        provider: settings.provider,
        model: settings.model,
        modelRouteId: settings.modelRouteId,
        modelRouter: bundleModelRouter,
        modelRouterProvider: async () => (await reloadModelRuntimeAtSafeBoundary()).runtime.router,
        session,
        sessionId: selection.sessionId,
        sessionMode: selection.mode,
        ...(selection.sourceSessionId !== undefined ? { forkFrom: selection.sourceSessionId } : {}),
        thinkingEffort: settings.thinkingEffort,
        permissionMode: settings.permissionMode,
        tools: settings.tools,
        mcpStatus: () => bundleRef.current?.latestMcpStatus,
        mcpControl: sharedMcpManager,
        ...(taskHostRuntime ? { taskRuntime: taskHostRuntime } : {}),
        ...(cronService ? { cronService } : {}),
        // Provider deletion also uses the daemon as the single config/vault coordinator,
        // even when the local Cron ledger itself could not be opened.
        cronDaemonBridge,
        credentialVault,
        userConfigStore,
        effectiveConfig: bundleModelRuntime.config,
        providerCredentialStatuses: bundleModelRuntime.credentials,
        ...(taskRuntimeDiagnostic ? { taskRuntimeDiagnostic } : {}),
        additionalDirectories: settings.additionalDirectories,
        additionalDirectoryManager: workspaceRoots,
        goalManager: runtimeState.goalManager,
        ...(runtimeState.hookService ? { hookService: runtimeState.hookService } : {}),
        hookCommands: runtimeState.hookCommands,
        pluginManagement,
        includeUserSkillResources: true,
        includeClaudeProjectResources:
          claudeCompatibility.enabled && claudeCompatibility.projectResources,
        includeClaudeUserResources:
          claudeCompatibility.enabled && claudeCompatibility.userResources,
        skillSources: pluginSnapshot.skillSources,
        commandSources: pluginSnapshot.commandSources,
        agentSources: pluginSnapshot.agentSources,
        modelRuntime: () => {
          const route = modelRouter.resolve(settings.modelRouteId);
          return route
            ? new ModelRuntimeCommandService(route, session, toolRegistry.getAvailableTools())
            : undefined;
        },
      });
      await fileIndex.refresh().catch(() => undefined);

      const reporterRef: { current?: TuiReporter } = {};
      const scheduleProjectionUpdate = createTuiUpdateScheduler((next: TuiProjection) => {
        if (activeBundle?.reporter === reporterRef.current) setProjection(next);
      }, 33);
      const reporter = new TuiReporter(() => undefined, [], {
        onProjectionUpdate: scheduleProjectionUpdate,
      });
      reporterRef.current = reporter;
      hydrateTuiReporter(reporter, hydration);
      const recoveredRewind = await session.getPendingTuiRewindHandoff();
      if (recoveredRewind) {
        reporter.pushSystemMessage(
          `Recovered rewind ${recoveredRewind.operationId}. Original prompt is ready to edit.`,
        );
      }
      if (taskRuntimeDiagnostic) {
        reporter.pushSystemMessage(
          `Task runtime unavailable; background/worker persistence is disabled. ${taskRuntimeDiagnostic}`,
        );
      }
      if (cronRuntimeDiagnostic) {
        reporter.pushSystemMessage(`Cron unavailable. ${cronRuntimeDiagnostic}`);
      }
      const bundle: TuiSessionBundle = {
        generation: ++nextBundleGeneration,
        selection,
        sessionId: selection.sessionId,
        session,
        runtimeState,
        settings,
        workspaceRoots,
        toolRegistry,
        registry,
        reporter,
        askUserHandler,
        ...(scheduleDraft ? { scheduleDraft } : {}),
        mcpElicitationHandler,
        skillLoader,
        ...(recoveredRewind ? { recoveredRewindInputText: recoveredRewind.inputText } : {}),
        latestMcpStatus,
      };
      bundleRef.current = bundle;
      return bundle;
    } catch (error) {
      await runtimeState.dispose();
      throw error;
    }
  };

  const buildSessionBundle = async (selection: CliSessionSelection): Promise<TuiSessionBundle> => {
    try {
      return await buildSessionBundleUnsafe(selection);
    } catch (error) {
      if (activeBundle) sharedMcpManager.attachRegistry(activeBundle.toolRegistry);
      if (selection.mode === "fork") {
        await discardFailedTuiFork(selection.sessionId, opts.workDir);
      }
      throw error;
    }
  };

  const initialBundle = await buildSessionBundle(tuiSessionSelection);
  activeBundle = initialBundle;

  // 包装组件:管理 entries 状态 + QueryGuard 派生 running,把 setter 暴露给外部
  const instanceRef: { current?: Instance } = {};

  function ReplApp({ redrawBlank = false }: { redrawBlank?: boolean }) {
    const { exit } = useApp();
    const [bundle, setBundle] = useState(initialBundle);
    const activeBundleRef = useRef(initialBundle);
    const [stateProjection, setStateProjection] = useState<TuiProjection>(() =>
      initialBundle.reporter.getProjection(),
    );
    const stateEntries = projectTuiEntriesForRendering(stateProjection);
    const [dialogRequests, setDialogRequests] = useState<DialogRequest[]>([]);
    const [inputReplacement, setInputReplacement] = useState<
      | {
          sequence: number;
          text: string;
        }
      | undefined
    >(() =>
      initialBundle.recoveredRewindInputText
        ? { sequence: 1, text: initialBundle.recoveredRewindInputText }
        : undefined,
    );
    setProjection = setStateProjection;
    activeBundle = activeBundleRef.current;

    // QueryGuard:三态状态机(idle/dispatching/running),useSyncExternalStore 订阅。
    // 稳定引用,放在 useRef 里只创建一次。
    const guardRef = useRef<QueryGuard>(null);
    if (guardRef.current === null) guardRef.current = new QueryGuard();
    const guard = guardRef.current;
    const runningQueueRef = useRef<RunningInputQueue>(null);
    if (runningQueueRef.current === null) runningQueueRef.current = new RunningInputQueue();
    const runningQueue = runningQueueRef.current;
    const [runningInputState, setRunningInputState] = useState(runningQueue.snapshot);
    const abortControllerRef = useRef<AbortController | null>(null);
    activeAbortControllerRef = abortControllerRef;
    const rewindContextRef = useRef<{ prompt: string; transcriptIndex: number } | null>(null);
    const switchingRef = useRef(false);
    const historyPreparationRef = useRef(false);
    const historyMutationRef = useRef(false);
    const runningInputDepsRef = useRef<HandleTuiRunningInputSubmissionDeps | null>(null);
    const delegationWakeRef = useRef<DelegationWakeCoordinator | null>(null);
    const hookRewakeRef = useRef<HookRewakeCoordinator | null>(null);
    const status = useSyncExternalStore(guard.subscribe, guard.getSnapshot);
    const running = status !== "idle"; // 派生:非 idle 即视为运行中
    const trackDialogAction = <T,>(action: () => Promise<T>): Promise<T> => {
      const operation = Promise.resolve().then(action);
      pendingTuiDialogActions.add(operation);
      void operation.then(
        () => pendingTuiDialogActions.delete(operation),
        () => pendingTuiDialogActions.delete(operation),
      );
      return operation;
    };

    useEffect(() => {
      const current = bundle;
      const coordinator = new DelegationWakeCoordinator({
        queue: current.runtimeState.delegationCompletionQueue,
        isIdle: () =>
          !shuttingDown &&
          !switchingRef.current &&
          !historyPreparationRef.current &&
          !historyMutationRef.current &&
          activeBundleRef.current === current &&
          guard.getSnapshot() === "idle" &&
          runningInputDepsRef.current !== null,
        resume: async (_completionSeqs, deliverCompletions) => {
          const deps = runningInputDepsRef.current;
          if (!deps) throw new Error("Delegation wake has no active TUI runtime dependencies");
          const generation = guard.tryStart();
          if (generation === null) {
            throw new Error("Delegation wake lost the idle runtime reservation");
          }

          const operation = (async () => {
            try {
              // 先拿到 QueryGuard 的独占执行权，再把 completion 写入 Session；
              // 否则仍在运行的主循环可能先消费消息，idle 后又被重复续跑。
              const delivered = await deliverCompletions();
              current.reporter.onSubagentActivitiesClaimed(
                delivered.flatMap((completion) => completion.activityIds),
              );
              await deps.runAgent("", { resumeExistingSession: true });
            } finally {
              sharedMcpManager.attachRegistry(current.toolRegistry);
              setSessionTools(current.settings, toolStatusFromRegistry(current.toolRegistry));
              current.runtimeState.fileIndex.markDirty();
              if (guard.end(generation)) await drainQueuedTuiInputs(deps);
            }
          })();
          pendingDelegationWakes.add(operation);
          try {
            await operation;
          } finally {
            pendingDelegationWakes.delete(operation);
          }
        },
        onError: (error) => {
          if (activeBundleRef.current === current) appendTuiRunError(current.reporter, error);
        },
      });
      delegationWakeRef.current = coordinator;
      return () => {
        coordinator.dispose();
        if (delegationWakeRef.current === coordinator) delegationWakeRef.current = null;
      };
    }, [bundle, guard]);

    useEffect(() => {
      if (status === "idle") delegationWakeRef.current?.notifyIdle();
    }, [bundle, status]);

    useEffect(() => {
      const current = bundle;
      const coordinator = new HookRewakeCoordinator({
        queue: current.runtimeState.hookRewakeQueue,
        isIdle: () =>
          !shuttingDown &&
          !switchingRef.current &&
          !historyPreparationRef.current &&
          !historyMutationRef.current &&
          activeBundleRef.current === current &&
          guard.getSnapshot() === "idle" &&
          runningInputDepsRef.current !== null,
        resume: async (_ids, deliver) => {
          const deps = runningInputDepsRef.current;
          if (!deps) throw new Error("Hook rewake has no active TUI runtime dependencies");
          const generation = guard.tryStart();
          if (generation === null) throw new Error("Hook rewake lost the idle reservation");
          const operation = (async () => {
            try {
              await deliver();
              await deps.runAgent("", { resumeExistingSession: true });
            } finally {
              sharedMcpManager.attachRegistry(current.toolRegistry);
              setSessionTools(current.settings, toolStatusFromRegistry(current.toolRegistry));
              current.runtimeState.fileIndex.markDirty();
              if (guard.end(generation)) await drainQueuedTuiInputs(deps);
            }
          })();
          pendingHookWakes.add(operation);
          try {
            await operation;
          } finally {
            pendingHookWakes.delete(operation);
          }
        },
        onError: (error) => {
          if (activeBundleRef.current === current) appendTuiRunError(current.reporter, error);
        },
      });
      hookRewakeRef.current = coordinator;
      return () => {
        coordinator.dispose();
        if (hookRewakeRef.current === coordinator) hookRewakeRef.current = null;
      };
    }, [bundle, guard]);

    useEffect(() => {
      if (status === "idle") hookRewakeRef.current?.notifyIdle();
    }, [bundle, status]);

    const switchSession = async (request: ResumeSessionCommandData): Promise<void> => {
      const operation = (async () => {
        const current = activeBundleRef.current;
        const currentGeneration = current.generation;
        if (shuttingDown) return;
        if (
          guard.getSnapshot() !== "idle" ||
          historyPreparationRef.current ||
          historyMutationRef.current
        ) {
          current.reporter.pushSystemMessage("Session switching is only available while idle.");
          return;
        }
        if (request.mode === "resume" && request.sessionId === current.sessionId) {
          current.reporter.pushSystemMessage(`Session ${request.sessionId} is already active.`);
          setDialogRequests([]);
          return;
        }
        if (switchingRef.current) {
          current.reporter.pushSystemMessage("A session switch is already in progress.");
          return;
        }

        switchingRef.current = true;
        let next: TuiSessionBundle | undefined;
        try {
          const selection: CliSessionSelection =
            request.mode === "fork"
              ? {
                  mode: "fork",
                  sessionId: createCliSessionId(),
                  sourceSessionId: request.sessionId,
                }
              : { mode: "resume", sessionId: request.sessionId };
          next = await buildSessionBundle(selection);

          if (
            shuttingDown ||
            activeBundleRef.current !== current ||
            activeBundleRef.current.generation !== currentGeneration ||
            guard.getSnapshot() !== "idle"
          ) {
            await disposeUnpublishedTuiBundle(next, opts.workDir);
            sharedMcpManager.attachRegistry(current.toolRegistry);
            return;
          }

          // 切换前先取消并等待旧 runtime 的 background/delegation 收口，
          // 防止旧子代理在新会话已可见后继续写入共享工作区。
          await current.runtimeState.dispose();
          await current.session
            .flushPersistence()
            .catch((error: unknown) => appendTuiRunError(current.reporter, error));

          if (shuttingDown) {
            await disposeUnpublishedTuiBundle(next, opts.workDir);
            return;
          }

          // 新 bundle 已完整构建且旧 runtime 已收口，再一次替换引用。
          activeBundleRef.current = next;
          activeBundle = next;
          const recoveredRewindInputText = next.recoveredRewindInputText;
          runningQueue.clear();
          runningInputDepsRef.current = null;
          rewindContextRef.current = null;
          setDialogRequests([]);
          setInputReplacement((current) =>
            recoveredRewindInputText
              ? {
                  sequence: (current?.sequence ?? 0) + 1,
                  text: recoveredRewindInputText,
                }
              : undefined,
          );
          setRunningInputState(runningQueue.snapshot);
          setProjection(next.reporter.getProjection());
          setBundle(next);
          next.reporter.pushSystemMessage(
            request.mode === "fork"
              ? `Forked as “${next.settings.title ?? next.sessionId}”. Workspace files are shared with the source session.`
              : `Resumed session ${next.sessionId}.`,
          );
        } catch (error) {
          if (next && activeBundleRef.current !== next) {
            await disposeUnpublishedTuiBundle(next, opts.workDir).catch(() => undefined);
          }
          appendTuiRunError(current.reporter, error);
        } finally {
          switchingRef.current = false;
        }
      })();

      pendingSessionSwitches.add(operation);
      try {
        await operation;
      } finally {
        pendingSessionSwitches.delete(operation);
      }
    };

    const handleSubmit = async (submission: InputBoxSubmission): Promise<void> => {
      const { text, attachments } = submission;
      const current = activeBundleRef.current;
      const isCurrentGeneration = (): boolean =>
        !shuttingDown &&
        !switchingRef.current &&
        activeBundleRef.current === current &&
        activeBundleRef.current.generation === current.generation;
      if (switchingRef.current) {
        current.reporter.pushSystemMessage("Session switch in progress; input was not submitted.");
        return;
      }
      const { reporter, registry, runtimeState, session, sessionId, settings } = current;
      const { fileIndex, toolDisclosure } = runtimeState;
      if (historyPreparationRef.current || historyMutationRef.current) {
        reporter.pushSystemMessage(
          "A history action is still in progress; input was not submitted.",
        );
        return;
      }
      const preparesHistoryDialog = isHistoryDialogCommand(text);
      if (preparesHistoryDialog) {
        historyPreparationRef.current = true;
        setDialogRequests((items) => [
          ...items.filter((item) => item.id !== HISTORY_PREPARING_DIALOG_ID),
          {
            id: HISTORY_PREPARING_DIALOG_ID,
            layer: "modal",
            priority: 50,
            content: <Text>Preparing history view…</Text>,
          },
        ]);
      }
      const isCurrentIdleGeneration = (): boolean =>
        isCurrentGeneration() && guard.getSnapshot() === "idle";
      const runHistoryMutation = <T,>(action: () => Promise<T>): Promise<T> =>
        trackDialogAction(async () => {
          if (!isCurrentIdleGeneration()) {
            throw new Error("History actions are only available while the session is idle.");
          }
          if (historyMutationRef.current) {
            throw new Error("Another history action is already in progress.");
          }
          historyMutationRef.current = true;
          try {
            return await action();
          } finally {
            historyMutationRef.current = false;
          }
        });
      const openRewindDialog = async (selectedMessageId?: string): Promise<void> => {
        if (!isCurrentIdleGeneration()) {
          throw new Error("Rewind is only available while the session is idle.");
        }
        const snapshots = await listRewindPointSummaries(session);
        if (!isCurrentIdleGeneration()) {
          throw new Error("The session started running before rewind preparation completed.");
        }
        if (snapshots.length === 0) {
          reporter.pushSystemMessage(
            "No user-message checkpoints are available yet. Send a new prompt, then run /rewind again.",
          );
          return;
        }
        const selectedIndex = selectedMessageId
          ? snapshots.findIndex((snapshot) => snapshot.messageId === selectedMessageId)
          : -1;
        const initialState: RewindCommandDialogState | undefined =
          selectedIndex >= 0
            ? { selector: { phase: "select", selectedIndex }, status: "open" }
            : undefined;
        const dialogId = "local-ui:rewind-selector";
        const request = createRewindCommandDialogRequest({
          sessionId,
          snapshots,
          ...(initialState ? { initialState } : {}),
          getDiffStat: async (messageId) => {
            if (!isCurrentIdleGeneration()) {
              throw new Error("The session changed or started running before preview completed.");
            }
            return session.getRewindDiffStat(messageId);
          },
          onClose: () => {
            if (isCurrentGeneration()) {
              setDialogRequests((items) => items.filter((item) => item.id !== dialogId));
            }
          },
          onRewind: (snapshot, mode) =>
            runHistoryMutation(async () => {
              const rewind = await applyTuiRewind({
                session,
                reporter,
                snapshot,
                mode,
                onRestoreInteractionMode: (interactionMode, prePlanMode) => {
                  const restored = restoreSessionInteractionMode(
                    settings,
                    interactionMode,
                    prePlanMode,
                  );
                  if (!restored.ok) throw new Error(restored.message);
                },
              });
              if (!isCurrentGeneration()) return;
              if (rewind.inputText !== undefined) {
                setInputReplacement((replacement) => rewindInputReplacement(replacement, rewind));
              }
            }),
        });
        setDialogRequests((items) => [...items.filter((item) => item.id !== request.id), request]);
      };
      const openChangesDialog = async (messageId: string): Promise<void> => {
        if (!isCurrentIdleGeneration()) {
          throw new Error("Changes is only available while the session is idle.");
        }
        const changes = await fileHistoryChanges(
          session.fileHistory,
          messageId,
          sessionId,
          session.fileHistoryBaseDir,
        );
        if (!isCurrentIdleGeneration()) {
          throw new Error("The session started running before Changes preparation completed.");
        }
        const dialogId = "local-ui:changes";
        const request = createChangesDialogRequest({
          model: createChangesPanelModel(changes),
          onClose: () => setDialogRequests((items) => items.filter((item) => item.id !== dialogId)),
          onRestoreFile: (action) =>
            runHistoryMutation(async () => {
              await fileHistoryRestoreFile(
                session.fileHistory,
                action.messageId,
                action.filePath,
                action.expectedCurrentFingerprint,
                sessionId,
                session.fileHistoryBaseDir,
              );
              if (!isCurrentGeneration()) return;
              fileIndex.markDirty();
              reporter.pushSystemMessage(`Partially rewound ${action.filePath}.`);
              await openChangesDialog(action.messageId);
            }),
          onJumpToRewind: (action) =>
            trackDialogAction(async () => {
              if (!isCurrentIdleGeneration()) {
                throw new Error("Rewind is only available while the session is idle.");
              }
              await openRewindDialog(action.messageId);
              setDialogRequests((items) => items.filter((item) => item.id !== dialogId));
            }),
        });
        setDialogRequests((items) => [...items.filter((item) => item.id !== request.id), request]);
      };
      try {
        const submissionDeps: HandleTuiRunningInputSubmissionDeps = {
          reporter,
          guard,
          queue: runningQueue,
          onQueueStateChange: setRunningInputState,
          steerQueue: runtimeState.steerQueue,
          abortControllerRef,
          isActive: () =>
            !shuttingDown &&
            !switchingRef.current &&
            activeBundleRef.current === current &&
            activeBundleRef.current.generation === current.generation,
          registry,
          workDir: opts.workDir,
          skillLoader: current.skillLoader,
          exit,
          sessionId,
          switchSession,
          openChanges: openChangesDialog,
          setRewindContext: (context) => {
            rewindContextRef.current = context;
          },
          activateAgentHooks: async (metadata) => {
            const componentId = metadata["skillName"];
            const path = metadata["skillSourcePath"];
            const inlineHooks = metadata["skillHookConfig"];
            if (
              typeof componentId !== "string" ||
              typeof path !== "string" ||
              inlineHooks === undefined
            ) {
              return;
            }
            await runtimeState.activateComponentHooks({
              kind: "skill",
              path,
              componentId,
              inlineHooks,
            });
          },
          clearComponentHooks: async () => runtimeState.clearComponentHooks(),
          openDialog: (request) => {
            setDialogRequests((current) => [
              ...current.filter((item) => item.id !== request.id),
              request,
            ]);
          },
          closeDialog: (id) =>
            setDialogRequests((current) => current.filter((item) => item.id !== id)),
          dispatchInput: async (nextText) => {
            await submitTracked({ text: nextText, attachments: [] });
          },
          openLocalUiDialog: async (result) => {
            if (result.ui?.kind === "open-selector" && result.ui.selector === "rewind") {
              await openRewindDialog();
              return;
            }
            if (result.ui?.kind === "open-panel" && result.ui.panel === "hooks") {
              const management = runtimeState.hookManagement;
              if (!management) return;
              setDialogRequests((items) => [
                ...items.filter((item) => item.id !== HOOKS_PANEL_DIALOG_ID),
                createHooksPanelDialogRequest(management, () =>
                  setDialogRequests((items) =>
                    items.filter((item) => item.id !== HOOKS_PANEL_DIALOG_ID),
                  ),
                ),
              ]);
            }
          },
          currentModelId: settings.modelRouteId,
          modelOptions: buildModelOptions(modelRouter.routes),
          createModelSelectorContent: (effect) => (
            <InteractiveModelSelector
              models={effect.models}
              currentModelId={effect.currentModelId}
              onCancel={() => {
                setDialogRequests((current) =>
                  current.filter((item) => item.id !== effect.request.id),
                );
              }}
              onSelect={(modelId) => {
                setDialogRequests((current) =>
                  current.filter((item) => item.id !== effect.request.id),
                );
                dispatchModelSelectorSelection(modelId, (command) => {
                  void submitTracked({ text: command, attachments: [] });
                });
              }}
            />
          ),
          runAgent: async (prompt, runOptions) => {
            const resumeExistingSession = runOptions?.resumeExistingSession === true;
            const refreshed = await reloadModelRuntimeAtSafeBoundary();
            const runModelRouter = refreshed.runtime.router;
            if (refreshed.configurationChanged) {
              reporter.pushSystemMessage(
                "Shared Provider configuration changed; reloaded at this next-run safe boundary. The previous in-flight run was not hot-swapped.",
              );
            }
            const { route, reasoningLevel } = resolveTuiPromptModelRoute(
              runModelRouter,
              settings,
              runOptions?.model,
              picoConfig.compatibility.claude,
            );
            const activeRoute = runModelRouter.providerConfig(route.id, reasoningLevel);
            const rewindContext = resumeExistingSession ? null : rewindContextRef.current;
            if (!resumeExistingSession) rewindContextRef.current = null;
            const cliOpts: RunAgentCliOptions = {
              prompt,
              provider: activeRoute.provider,
              dir: opts.workDir,
              session: sessionId,
              sessionSelection: current.selection,
              baseURL: activeRoute.config.baseURL,
              ...(activeRoute.route.source === "legacy"
                ? {}
                : { apiKey: activeRoute.config.apiKey }),
              model: activeRoute.config.model,
              modelRouteId: activeRoute.route.id,
              modelCapabilities: activeRoute.route.capabilities,
              ...(runOptions?.allowedTools === undefined
                ? {}
                : { allowedTools: [...runOptions.allowedTools] }),
              ...(reasoningLevel !== undefined ? { thinkingEffort: reasoningLevel } : {}),
              planMode: settings.mode === "plan",
              ...(runOptions?.images ? { images: runOptions.images } : {}),
              ...(rewindContext !== null ? { rewindPrompt: rewindContext.prompt } : {}),
              ...(rewindContext !== null
                ? { rewindTranscriptIndex: rewindContext.transcriptIndex }
                : {}),
              ...(rewindContext !== null ? { rewindInteractionMode: settings.mode } : {}),
              ...(rewindContext !== null &&
              settings.mode === "plan" &&
              settings.prePlanMode !== undefined
                ? { rewindPrePlanMode: settings.prePlanMode }
                : {}),
              addDirs: [...settings.additionalDirectories],
            };
            await runTuiAgentPrompt(cliOpts, {
              reporter,
              modelRouter: runModelRouter,
              toolDisclosure,
              runtimeState,
              pluginSnapshot,
              askUserHandler: current.askUserHandler,
              mcpElicitationHandler: current.mcpElicitationHandler,
              openDialog: (request) => {
                setDialogRequests((current) => [
                  ...current.filter((item) => item.id !== request.id),
                  request,
                ]);
              },
              closeDialog: (id) =>
                setDialogRequests((current) => current.filter((item) => item.id !== id)),
              mcpStatusSink: (snapshot) => {
                current.latestMcpStatus = snapshot;
              },
              mcpManager: sharedMcpManager,
              ...(current.scheduleDraft ? { scheduleDraft: current.scheduleDraft } : {}),
              toolStatusSink: (tools) => {
                setSessionTools(settings, tools);
              },
              abortControllerRef,
              ...(resumeExistingSession ? { resumeExistingSession: true } : {}),
            });
          },
        };
        runningInputDepsRef.current = submissionDeps;
        await handleTuiRunningInputSubmission(
          text,
          submissionDeps,
          attachments.map((attachment) => attachment.image),
        );
      } catch (err) {
        appendTuiRunError(reporter, err);
      } finally {
        sharedMcpManager.attachRegistry(current.toolRegistry);
        setSessionTools(settings, toolStatusFromRegistry(current.toolRegistry));
        if (preparesHistoryDialog) {
          historyPreparationRef.current = false;
          setDialogRequests((items) =>
            items.filter((item) => item.id !== HISTORY_PREPARING_DIALOG_ID),
          );
        }
        // Agent writes and external edits invalidate the startup snapshot. Refresh lazily
        // only when the user next opens @ suggestions.
        fileIndex.markDirty();
      }
    };

    const submitTracked = (submission: InputBoxSubmission): Promise<void> => {
      const operation = handleSubmit(submission);
      pendingTuiSubmissions.add(operation);
      void operation.then(
        () => pendingTuiSubmissions.delete(operation),
        () => pendingTuiSubmissions.delete(operation),
      );
      return operation;
    };

    return (
      <App
        model={bundle.settings.model}
        modelRouteId={bundle.settings.modelRouteId}
        provider={bundle.settings.provider}
        workDir={opts.workDir}
        sessionMode={bundle.selection.mode}
        permissionMode={bundle.settings.mode}
        thinkingEffort={bundle.settings.thinkingEffort}
        mcpSummary={formatTuiMcpSummary(bundle.latestMcpStatus)}
        taskSummary={formatRunningInputQueue(runningInputState)}
        queuedCount={0}
        entries={stateEntries}
        agents={projectAgentNavigationItems(stateProjection, running ? "running" : "idle")}
        running={running}
        slashCommandSuggestions={(query) =>
          commandSuggestions(bundle.registry, query, {
            availabilityState:
              dialogRequests.length > 0 ? "modal" : getTuiCommandAvailabilityState(status),
          })
        }
        slashArgumentSuggestions={(command, query) =>
          commandArgumentSuggestions(bundle.registry, command, query)
        }
        fileMentionSuggestions={(query) =>
          bundle.runtimeState.fileIndex
            .query(query, 500)
            .then((files) => files.map((file) => ({ value: file })))
        }
        keybindings={picoConfig.keybindings}
        dialogRequests={dialogRequests}
        inputReplacement={inputReplacement}
        redrawBlank={redrawBlank}
        imagePasteShortcutLabel={imagePasteShortcutLabel()}
        onSubmit={(submission) => void submitTracked(submission)}
        onInspectTool={(toolCallId) => {
          const current = activeBundleRef.current;
          const tool = current.reporter.getProjection().toolCalls[toolCallId];
          if (!tool) {
            current.reporter.pushSystemMessage("Tool result is no longer available.");
            return;
          }
          const source = createToolInspectorSource(
            tool,
            createArtifactInspectorContext({ workDir: opts.workDir, sessionId: current.sessionId }),
          );
          if (!source) {
            current.reporter.pushSystemMessage("This tool call has no inspectable output yet.");
            return;
          }
          const request = createInspectorDialogRequest({
            source,
            onClose: () =>
              setDialogRequests((items) => items.filter((item) => item.id !== request.id)),
            onCopy: (text) => trackDialogAction(() => copyTextToClipboard(text)),
            onLocate: (path) => trackDialogAction(() => locateFileInShell(path)),
          });
          setDialogRequests((items) => [
            ...items.filter((item) => item.id !== request.id),
            request,
          ]);
        }}
        onInterrupt={() => {
          handleTuiInterrupt(
            abortControllerRef.current,
            runningQueue,
            activeBundleRef.current.reporter,
            undefined,
            setRunningInputState,
            activeBundleRef.current.runtimeState.steerQueue,
          );
        }}
        onRedraw={() => {
          // 先经 Ink 输出空帧，再输出完整帧。两次 rerender 均与 Ink 的
          // incremental frame bookkeeping 同步，避免裸写 clear 导致后续差分帧错位。
          instanceRef.current?.rerender(<ReplApp redrawBlank />);
          instanceRef.current?.rerender(<ReplApp />);
        }}
      />
    );
  }

  // ChatGPT.app 可能先改变 xterm 网格、后端 PTY 却仍上报旧宽度。
  // Ink 接管 alt-screen 前先查询前端光标边界，避免隐式换行让擦行记账失步。
  const terminalGrid = await createTuiTerminalGridSession(process.stdin, process.stdout);
  const renderStdout = terminalGrid.stdout;

  // 启动前清掉当前可视区,避免上一次未正常退出的 TUI 帧或 shell scrollback
  // 留在首屏,造成 Logo/Header 看起来重复。
  if (renderStdout.isTTY) {
    renderStdout.write("\x1b[2J\x1b[H");
  }

  // 普通 xterm 使用 alternateScreen + incrementalRendering 避免流式帧闪烁。
  // 根布局保留右侧 1 列，避免中文、Emoji 和长行在右边界立即换行时失配。
  // patchConsole 让剩余 console 输出先擦除当前帧,输出后再恢复,
  // 不绕过 Ink 的光标记账。Pino fd2 已在预加载阶段独立静默。
  try {
    const instance = render(<ReplApp />, { ...TUI_RENDER_OPTIONS, stdout: renderStdout });
    instanceRef.current = instance;
    await instance.waitUntilExit();
  } finally {
    shuttingDown = true;
    try {
      await terminalGrid.dispose();
      activeAbortControllerRef?.current?.abort(new DOMException("TUI shutting down", "AbortError"));
      while (pendingTuiSubmissions.size > 0) {
        await Promise.allSettled([...pendingTuiSubmissions]);
      }
      while (pendingDelegationWakes.size > 0) {
        await Promise.allSettled([...pendingDelegationWakes]);
      }
      while (pendingHookWakes.size > 0) {
        await Promise.allSettled([...pendingHookWakes]);
      }
      while (pendingSessionSwitches.size > 0) {
        await Promise.allSettled([...pendingSessionSwitches]);
      }
      while (pendingTuiDialogActions.size > 0) {
        await Promise.allSettled([...pendingTuiDialogActions]);
      }
      const finalBundle = activeBundle;
      if (finalBundle) {
        await finalBundle.runtimeState.dispose();
        await finalBundle.session.flushPersistence();
      }
      unsubscribeTaskCompletion?.();
      unsubscribeMcpStatus();
      await taskHostRuntime?.close();
      cronService?.close();
      await sharedMcpManager.closeAll();
    } finally {
      await pluginSnapshot.dispose();
    }
  }
}

async function disposeUnpublishedTuiBundle(
  bundle: TuiSessionBundle,
  workDir: string,
): Promise<void> {
  await bundle.runtimeState.dispose();
  if (bundle.selection.mode === "fork") {
    await discardFailedTuiFork(bundle.sessionId, workDir);
    return;
  }
  await bundle.session.flushPersistence();
}

async function discardFailedTuiFork(sessionId: string, workDir: string): Promise<void> {
  const orphan = globalSessionManager.delete(sessionId, workDir);
  await orphan?.close();
  await removeCliSessionFile(workDir, sessionId);
  forgetSessionPolicyState(sessionId, workDir);
}

export function createTuiUpdateScheduler<T>(
  apply: (value: T) => void,
  minIntervalMs: number,
): (value: T) => void {
  let latest: T | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastAppliedAt = 0;

  return (value) => {
    latest = value;
    const now = Date.now();
    const elapsed = now - lastAppliedAt;
    if (elapsed >= minIntervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastAppliedAt = now;
      apply(value);
      latest = null;
      return;
    }

    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!latest) return;
      lastAppliedAt = Date.now();
      apply(latest);
      latest = null;
    }, minIntervalMs - elapsed);
  };
}

async function handleLocalTuiCommand(
  result: LocalCommandResult,
  deps: Pick<
    HandleTuiInputSubmissionDeps,
    | "registry"
    | "reporter"
    | "exit"
    | "workDir"
    | "openDialog"
    | "closeDialog"
    | "dispatchInput"
    | "sessionId"
    | "currentModelId"
    | "modelOptions"
    | "createModelSelectorContent"
    | "openLocalUiDialog"
    | "commandAvailabilityState"
    | "switchSession"
    | "openChanges"
  >,
): Promise<void> {
  const uiEffect = resolveLocalTuiCommandUiEffect(result, {
    currentModelId: deps.currentModelId,
    models: deps.modelOptions,
  });
  if (uiEffect.kind === "dialog" && deps.openDialog) {
    deps.openDialog({
      ...uiEffect.request,
      content: deps.createModelSelectorContent?.(uiEffect) ?? uiEffect.request.content,
    });
    return;
  }

  if (isSessionSelectorResult(result) && deps.openDialog) {
    deps.openDialog(createSessionSelectorDialogRequest(result, deps));
    return;
  }

  if (result.ui?.kind === "open-panel" && result.ui.panel === "help" && deps.openDialog) {
    const request = createLocalUiDialogRequest(result.ui, {
      commands: deps.registry.list({
        includeDisabled: true,
        availabilityState: deps.commandAvailabilityState ?? "idle",
      }),
      onClose: deps.closeDialog,
    });
    if (request) {
      deps.openDialog(request);
      return;
    }
  }

  if (result.action === "resume") {
    const request = resumeSessionCommandData(result.data);
    if (!request) {
      deps.reporter.pushSystemMessage("Invalid session switch request.");
      return;
    }
    if (!deps.switchSession) {
      deps.reporter.pushSystemMessage("Session switching is unavailable in this host.");
      return;
    }
    await deps.switchSession(request);
    return;
  }

  if (result.action === "changes") {
    const messageId = changesCommandMessageId(result.data);
    if (!messageId || !deps.openChanges) {
      deps.reporter.pushSystemMessage("Changes is unavailable for this checkpoint.");
      return;
    }
    await deps.openChanges(messageId);
    return;
  }

  switch (result.action) {
    case "clear":
      deps.reporter.clear();
      return;
    case "exit":
      deps.exit();
      return;
    default:
      deps.reporter.pushSystemMessage(result.message ?? "");
      if (result.ui !== undefined) await deps.openLocalUiDialog?.(result);
      return;
  }
}

function changesCommandMessageId(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value.messageId !== "string") return undefined;
  const messageId = value.messageId.trim();
  return messageId || undefined;
}

function isHistoryDialogCommand(text: string): boolean {
  return /^\/(?:changes|rewind|checkpoint)(?:\s|$)/u.test(text.trim());
}

function resumeSessionCommandData(value: unknown): ResumeSessionCommandData | undefined {
  if (!isRecord(value) || typeof value.sessionId !== "string") return undefined;
  if (value.mode !== "resume" && value.mode !== "fork") return undefined;
  const sessionId = value.sessionId.trim();
  return sessionId ? { sessionId, mode: value.mode } : undefined;
}

export function resolveLocalTuiCommandUiEffect(
  result: LocalCommandResult,
  options: {
    currentModelId?: string;
    models?: readonly ModelOption[];
  } = {},
): LocalTuiCommandUiEffect {
  if (result.ui?.kind !== "open-selector" || result.ui.selector !== "model") {
    return { kind: "none" };
  }

  const commandModels = modelOptionsFromLocalCommand(result.data);
  const models = commandModels ?? options.models ?? buildModelOptions();
  const request = createLocalUiDialogRequest(result.ui, {
    currentModelId: options.currentModelId,
    models,
  });
  if (!request) return { kind: "none" };

  return {
    kind: "dialog",
    selector: "model",
    request,
    models,
    currentModelId: options.currentModelId,
  };
}

function modelOptionsFromLocalCommand(data: unknown): readonly ModelOption[] | undefined {
  if (!isRecord(data) || !Array.isArray(data.modelRoutes)) return undefined;
  const models = data.modelRoutes.flatMap((value): ModelOption[] => {
    if (
      !isRecord(value) ||
      typeof value.id !== "string" ||
      typeof value.model !== "string" ||
      typeof value.providerId !== "string" ||
      typeof value.provider !== "string"
    ) {
      return [];
    }
    return [
      {
        id: value.id,
        name: value.model,
        description: `${value.providerId} · ${value.provider}`,
      },
    ];
  });
  return models.length > 0 ? models : undefined;
}

export async function runTuiAgentPrompt(
  cliOpts: RunAgentCliOptions,
  deps: {
    reporter: TuiReporter;
    modelRouter?: ModelRouter;
    toolDisclosure?: ToolDisclosure;
    runtimeState?: TuiRuntimeState;
    pluginSnapshot?: PluginRuntimeSnapshot;
    askUserHandler?: AskUserHandler;
    scheduleDraft?: TuiScheduleDraftRuntime;
    mcpElicitationHandler?: McpElicitationUiHandler;
    mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
    mcpManager?: McpConnectionManager;
    toolStatusSink?: RunAgentCliDependencies["toolStatusSink"];
    openDialog?: (request: DialogRequest) => void;
    closeDialog?: (id: string) => void;
    runAgent?: TuiRunAgent;
    abortControllerRef?: TuiAbortControllerRef;
    /** 内部 completion 续跑：复用现有 Session，不追加或伪装用户输入。 */
    resumeExistingSession?: boolean;
  },
): Promise<void> {
  if (deps.askUserHandler && (!deps.openDialog || !deps.closeDialog)) {
    throw new Error("AskUser requires both openDialog and closeDialog host callbacks.");
  }
  if (deps.scheduleDraft && (!deps.openDialog || !deps.closeDialog)) {
    throw new Error(
      "Schedule draft review requires both openDialog and closeDialog host callbacks.",
    );
  }
  if (deps.mcpElicitationHandler && (!deps.openDialog || !deps.closeDialog)) {
    throw new Error("MCP elicitation requires both openDialog and closeDialog host callbacks.");
  }
  const existingController = deps.abortControllerRef?.current;
  const controller = existingController ?? new AbortController();
  const ownsControllerSlot = existingController === null || existingController === undefined;
  const pendingApprovalDialogs = new Set<string>();
  const closePendingApprovalDialogs = () => {
    for (const id of pendingApprovalDialogs) deps.closeDialog?.(id);
    pendingApprovalDialogs.clear();
  };
  const closeApprovalDialog = (id: string) => {
    pendingApprovalDialogs.delete(id);
    deps.closeDialog?.(id);
  };
  const closeApprovalOnAbort = () => closePendingApprovalDialogs();
  const unbindAskUserDialogs = deps.askUserHandler
    ? bindAskUserDialogs(deps.askUserHandler, {
        openDialog: (request) => deps.openDialog?.(request),
        closeDialog: (id) => deps.closeDialog?.(id),
      })
    : undefined;
  const unbindScheduleDraftDialogs = deps.scheduleDraft
    ? bindScheduleDraftDialogs(deps.scheduleDraft.handler, {
        openDialog: (request) => deps.openDialog?.(request),
        closeDialog: (id) => deps.closeDialog?.(id),
      })
    : undefined;
  const unbindMcpElicitationDialogs = deps.mcpElicitationHandler
    ? bindMcpElicitationDialogs(deps.mcpElicitationHandler, {
        openDialog: (request) => deps.openDialog?.(request),
        closeDialog: (id) => deps.closeDialog?.(id),
      })
    : undefined;
  controller.signal.addEventListener("abort", closeApprovalOnAbort, { once: true });
  if (deps.abortControllerRef && ownsControllerSlot) deps.abortControllerRef.current = controller;
  try {
    const runDependencies: RunAgentCliDependencies & { resumeExistingSession?: boolean } = {
      reporter: deps.reporter,
      signal: controller.signal,
      approvalNotifier: (notice) => {
        deps.reporter.onToolAwaitingApproval(notice.toolName, notice.args, notice.providerCallId);
        const dialogId = approvalDialogId(notice.taskId);
        pendingApprovalDialogs.add(dialogId);
        deps.openDialog?.(
          createApprovalDialogRequest(notice, {
            reporter: deps.reporter,
            closeDialog: closeApprovalDialog,
            sessionId: cliOpts.sessionSelection?.sessionId ?? cliOpts.session,
          }),
        );
      },
      ...(deps.toolDisclosure ? { toolDisclosure: deps.toolDisclosure } : {}),
      ...(deps.modelRouter ? { modelRouter: deps.modelRouter } : {}),
      ...(deps.runtimeState ? { runtimeState: deps.runtimeState } : {}),
      ...(deps.pluginSnapshot ? { pluginSnapshot: deps.pluginSnapshot } : {}),
      ...(deps.askUserHandler ? { askUserHandler: deps.askUserHandler } : {}),
      ...(deps.scheduleDraft ? { scheduleDraftCoordinator: deps.scheduleDraft.coordinator } : {}),
      ...(deps.mcpStatusSink ? { mcpStatusSink: deps.mcpStatusSink } : {}),
      ...(deps.mcpManager ? { mcpManager: deps.mcpManager } : {}),
      ...(deps.toolStatusSink ? { toolStatusSink: deps.toolStatusSink } : {}),
      ...(deps.resumeExistingSession ? { resumeExistingSession: true } : {}),
    };
    const result = await (deps.runAgent ?? executeAgentRuntime)(cliOpts, runDependencies);
    if (result.tracePath) {
      deps.reporter.pushSystemMessage(`Trace saved: ${result.tracePath}`);
    }
  } finally {
    controller.signal.removeEventListener("abort", closeApprovalOnAbort);
    closePendingApprovalDialogs();
    deps.askUserHandler?.cancelAll("当前运行已结束。");
    deps.scheduleDraft?.handler.cancelAll();
    unbindScheduleDraftDialogs?.();
    deps.mcpElicitationHandler?.cancelAll();
    unbindAskUserDialogs?.();
    unbindMcpElicitationDialogs?.();
    if (ownsControllerSlot && deps.abortControllerRef?.current === controller) {
      deps.abortControllerRef.current = null;
    }
  }
}

export function handleTuiInterrupt(
  controller: AbortController | null,
  queue: RunningInputQueue,
  reporter: Pick<TuiReporter, "pushSystemMessage" | "onInterrupted">,
  onQueueSizeChange?: (size: number) => void,
  onQueueStateChange?: (snapshot: RunningInputQueueSnapshot) => void,
  steerQueue?: SteerQueue,
): void {
  controller?.abort(new DOMException("interrupted", "AbortError"));
  reporter.onInterrupted();
  steerQueue?.drain();
  const dropped = queue.clear();
  onQueueSizeChange?.(queue.size);
  onQueueStateChange?.(queue.snapshot);
  reporter.pushSystemMessage(
    dropped > 0
      ? `Interrupted current run and dropped ${dropped} queued input(s).`
      : "Interrupted current run.",
  );
}

export function formatTuiRunErrorEntry(
  error: unknown,
): Extract<TuiEntry, { kind: "error" }> | undefined {
  if (isAbortError(error)) return undefined;
  const retryable = defaultIsRetryableError(error);
  const action = retryable ? "retry" : undefined;
  return {
    kind: "error",
    message: error instanceof Error ? error.message : String(error),
    retryable,
    ...(action === undefined ? {} : { action }),
  };
}

export function formatTuiRunError(error: unknown): string | undefined {
  const entry = formatTuiRunErrorEntry(error);
  return entry === undefined ? undefined : `⚠️ 执行出错: ${entry.message}`;
}

export function appendTuiRunError(reporter: TuiReporter, error: unknown): void {
  const runError = formatTuiRunErrorEntry(error);
  if (runError === undefined) return;
  reporter.pushError(runError.message, {
    retryable: runError.retryable,
    action: runError.action,
  });
}

export function formatTuiMcpSummary(snapshot: McpStatusSnapshot | undefined): string {
  if (!snapshot) return "MCP none";
  if (snapshot.loadError) return "MCP error";
  const { connected, total, failed, pending, toolCount } = snapshot.summary;
  const parts = [`MCP ${connected}/${total}`];
  if (pending > 0) parts.push(`${pending} pending`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (toolCount > 0) parts.push(`${toolCount} tools`);
  return parts.join(" ");
}

function createApprovalDialogRequest(
  notice: ApprovalNotice,
  deps: Pick<HandleTuiInputSubmissionDeps, "reporter" | "closeDialog" | "sessionId">,
): DialogRequest {
  return {
    id: approvalDialogId(notice.taskId),
    layer: "modal",
    priority: APPROVAL_DIALOG_PRIORITY,
    content: (
      <InteractiveApprovalPanel
        {...notice}
        onAction={(action) => resolveApprovalAction({ action, taskId: notice.taskId }, deps)}
      />
    ),
  };
}

function handleApprovalCommand(
  text: string,
  deps: Pick<HandleTuiInputSubmissionDeps, "reporter" | "closeDialog" | "sessionId">,
): boolean {
  const parsed = parseApprovalCommand(text);
  if (!parsed) return false;

  resolveApprovalAction(parsed, deps);
  return true;
}

function resolveApprovalAction(
  parsed:
    | { action: ApprovalPanelAction; taskId: string }
    | { action: "modify"; taskId: string; content: string },
  deps: Pick<HandleTuiInputSubmissionDeps, "reporter" | "closeDialog" | "sessionId">,
): boolean {
  const ok =
    parsed.action === "modify"
      ? globalApprovalManager.resolveApprovalWithModify(parsed.taskId, "TUI modify", parsed.content)
      : parsed.action === "approve-session"
        ? globalApprovalManager.resolveApprovalForSession(parsed.taskId, "TUI approve-session")
        : globalApprovalManager.resolveApproval(
            parsed.taskId,
            parsed.action === "approve",
            `TUI ${parsed.action}`,
          );

  deps.closeDialog?.(approvalDialogId(parsed.taskId));
  deps.reporter.pushSystemMessage(
    ok
      ? parsed.action === "approve-session"
        ? "Allowed for this session."
        : parsed.action === "approve"
          ? "Allowed once."
          : parsed.action === "reject"
            ? "Rejected."
            : "Approved with changes."
      : "Approval request is no longer active.",
  );
  return ok;
}

type ParsedApprovalCommand =
  | { action: "approve" | "approve-session" | "reject"; taskId: string }
  | { action: "modify"; taskId: string; content: string };

function parseApprovalCommand(text: string): ParsedApprovalCommand | null {
  const trimmed = text.trim();
  const simple = /^(approve|approve-session|reject)\s+(\S+)$/u.exec(trimmed);
  if (simple) {
    const action = simple[1] as "approve" | "approve-session" | "reject";
    return { action, taskId: simple[2]! };
  }

  const modify = /^modify\s+(\S+)\s+([\s\S]+)$/u.exec(trimmed);
  if (!modify) return null;
  return { action: "modify", taskId: modify[1]!, content: modify[2]! };
}

export function dispatchModelSelectorSelection(
  modelId: string,
  submitInput: (text: string) => void,
): void {
  submitInput(modelSelectionToCommand(modelId));
}

interface InteractiveModelSelectorProps {
  models: readonly ModelOption[];
  currentModelId?: string;
  onSelect: (modelId: string) => void;
  onCancel: () => void;
}

function InteractiveModelSelector({
  models,
  currentModelId,
  onSelect,
  onCancel,
}: InteractiveModelSelectorProps): React.ReactNode {
  const [state, setState] = useState<ModelSelectorState>(() =>
    createModelSelectorState(models, currentModelId),
  );

  useInput((input, key) => {
    const next = resolveModelSelectorKey(
      state,
      models,
      { input, key },
      {
        onConfirm: (model) => onSelect(model.id),
        onCancel,
      },
    );
    if (next.status === "selecting") setState(next);
  });

  return <ModelSelector models={models} currentModelId={currentModelId} state={state} />;
}

interface TuiSessionBrowserDialogProps {
  sessions: readonly SessionBrowserSession[];
  currentProjectCwd: string;
  onSelect: (
    session: SessionBrowserSession,
    mode: ResumeSessionCommandData["mode"],
  ) => Promise<void> | void;
  onCancel?: () => void;
}

function TuiSessionBrowserDialog({
  sessions,
  currentProjectCwd,
  onSelect,
  onCancel,
}: TuiSessionBrowserDialogProps): React.ReactNode {
  const [state, setState] = useState<SessionBrowserState>(() => createSessionBrowserState());
  const [search, setSearch] = useState({ active: false, query: "" });
  const visibleSessions = searchSessionBrowserSessions(sessions, search.query);

  useInput((input, key) => {
    if (search.active) {
      if (key.escape || key.return) {
        setSearch((current) => ({ ...current, active: false }));
        return;
      }
      if (key.backspace || key.delete) {
        setSearch((current) => ({ ...current, query: current.query.slice(0, -1) }));
        setState((current) => ({ ...current, selectedIndex: 0 }));
        return;
      }
      if (input && !key.ctrl && !key.meta) {
        setSearch((current) => ({ ...current, query: current.query + input }));
        setState((current) => ({ ...current, selectedIndex: 0 }));
      }
      return;
    }

    if (key.upArrow) {
      setState((current) =>
        moveSessionBrowserSelection(current, visibleSessions, -1, currentProjectCwd),
      );
      return;
    }

    if (key.downArrow) {
      setState((current) =>
        moveSessionBrowserSelection(current, visibleSessions, 1, currentProjectCwd),
      );
      return;
    }

    if (input === "/") {
      setSearch((current) => ({ ...current, active: true }));
      return;
    }

    if (key.return || input === "f") {
      const mode = input === "f" ? "fork" : "resume";
      setState((current) =>
        confirmSessionBrowserSelection(current, visibleSessions, currentProjectCwd, {
          onConfirm: (session) => void onSelect(session, mode),
        }),
      );
      return;
    }

    if (key.escape || input === "q") {
      onCancel?.();
    }
  });

  return (
    <>
      <Text dimColor>
        {search.active
          ? `Search: ${search.query}▋`
          : search.query
            ? `Search: ${search.query}`
            : "/ search"}
        {" · Enter resume · f fork · current workspace"}
      </Text>
      <SessionBrowser
        currentProjectCwd={currentProjectCwd}
        sessions={visibleSessions}
        state={state}
      />
    </>
  );
}

function isSessionSelectorResult(result: LocalCommandResult): result is LocalCommandResult & {
  ui: { kind: "open-selector"; selector: "session" };
} {
  return (
    hasLocalUiCommandAction(result) &&
    result.ui.kind === "open-selector" &&
    result.ui.selector === "session"
  );
}

function createSessionSelectorDialogRequest(
  result: LocalCommandResult,
  deps: Pick<
    HandleTuiInputSubmissionDeps,
    "workDir" | "closeDialog" | "dispatchInput" | "sessionId"
  >,
): DialogRequest {
  const sessions = mapCliSessionsToBrowserSessions(
    extractSessionSummaries(result.data),
    deps.sessionId,
  );

  return {
    id: SESSION_SELECTOR_DIALOG_ID,
    layer: "modal",
    priority: SELECTOR_DIALOG_PRIORITY,
    content: (
      <TuiSessionBrowserDialog
        currentProjectCwd={deps.workDir}
        sessions={sessions}
        onCancel={() => deps.closeDialog?.(SESSION_SELECTOR_DIALOG_ID)}
        onSelect={async (session, mode) => {
          deps.closeDialog?.(SESSION_SELECTOR_DIALOG_ID);
          await deps.dispatchInput?.(sessionSelectionToCommand(session.id, mode));
        }}
      />
    ),
  };
}

function extractSessionSummaries(data: unknown): CliSessionBrowserSummary[] {
  const values = Array.isArray(data)
    ? data
    : isRecord(data) && Array.isArray(data.sessions)
      ? data.sessions
      : [];
  return values.flatMap((value) => {
    const summary = toSessionSummary(value);
    return summary ? [summary] : [];
  });
}

function toSessionSummary(value: unknown): CliSessionBrowserSummary | null {
  if (!isRecord(value)) return null;
  if (typeof value.id !== "string" || typeof value.cwd !== "string") return null;
  if (typeof value.messageCount !== "number") return null;

  const createdAt = toDate(value.createdAt);
  const updatedAt = toDate(value.updatedAt);
  if (!createdAt || !updatedAt) return null;

  return {
    id: value.id,
    cwd: value.cwd,
    createdAt,
    updatedAt,
    messageCount: value.messageCount,
    ...(typeof value.title === "string" ? { title: value.title } : {}),
    ...(typeof value.firstMessage === "string" ? { firstMessage: value.firstMessage } : {}),
    ...(typeof value.lastMessage === "string" ? { lastMessage: value.lastMessage } : {}),
    ...(typeof value.forkFrom === "string" ? { forkFrom: value.forkFrom } : {}),
  };
}

function toDate(value: unknown): Date | null {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function formatUnknownCommand(
  input: Extract<TuiInputProcessResult, { type: "unknown-command" }>,
): string {
  const suffix =
    input.suggestions.length > 0 ? `\nSuggestions: ${input.suggestions.join(", ")}` : "";
  return `${input.message}${suffix}`;
}
