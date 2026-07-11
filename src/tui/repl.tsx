// TUI REPL entrypoint: wires ink rendering, TuiReporter, local commands, and
// per-turn calls into runAgentFromCli.
//
// Each user prompt builds a fresh engine around the same session and reporter.
// QueryGuard prevents overlapping submissions from racing cleanup state.

import type React from "react";
import { useRef, useState, useSyncExternalStore } from "react";
import { render, Text, useApp, useInput, type Instance, type RenderOptions } from "ink";
import { App } from "./app.js";
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
import { TuiReporter, type TuiEntry } from "./tui-reporter.js";
import { QueryGuard } from "./query-guard.js";
import {
  formatRunningInputQueue,
  parseRunningInputIntent,
  RunningInputQueue,
  type RunningInputIntent,
  type RunningInputQueueSnapshot,
} from "./running-input-queue.js";
import type {
  RunAgentCliDependencies,
  RunAgentCliOptions,
  RunAgentCliResult,
} from "../cli/run-agent.js";
import { runAgentFromCli } from "../cli/run-agent.js";
import { listRewindPointSummaries } from "../cli/file-history.js";
import {
  createCliSessionId,
  removeCliSessionFile,
  type CliSessionSelection,
} from "../cli/session-resolver.js";
import { loadPicoConfig } from "../input/pico-config.js";
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
import { loadModelRouter } from "../provider/model-router.js";
import { isAbortError } from "../provider/errors.js";
import { defaultIsRetryableError } from "../provider/retry.js";
import type { ThinkingEffort } from "../provider/thinking.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  forgetSessionSettings,
  getOrCreateSessionSettings,
  setSessionAdditionalDirectories,
  setSessionMode,
  setSessionTools,
  toolStatusFromRegistry,
  type SessionSettings,
} from "../input/session-settings.js";
import { WorkspaceRoots } from "../tools/workspace-roots.js";
import { globalSessionManager, type Session } from "../engine/session.js";
import type { SteerQueue } from "../engine/steer-queue.js";
import { McpConnectionManager, type McpStatusSnapshot } from "../mcp/manager.js";
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
import { createRewindCommandDialogRequest } from "./rewind-command-dialog.js";
import { applyTuiRewind, rewindInputReplacement } from "./rewind-runtime.js";
import { globalApprovalManager, type ApprovalNotice } from "../approval/manager.js";
import {
  approvalDialogId,
  InteractiveApprovalPanel,
  type ApprovalPanelAction,
} from "./approval-panel.js";
import { createTuiRuntimeState, type TuiRuntimeState } from "./runtime-state.js";
import { resolveTuiRenderStdout } from "./terminal-grid.js";
import { hydrateTuiEntries } from "./session-hydration.js";

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
  thinkingEffort?: ThinkingEffort;
  /** MCP 配置路径(可选,首轮传入) */
  mcpConfigPath?: string;
  /** CLI 已解析的 session 选择结果。 */
  sessionSelection?: CliSessionSelection;
  /** CLI --add-dir 提供的附加工作目录。 */
  addDirs?: string[];
}

const SESSION_SELECTOR_DIALOG_ID = "local-ui:session-selector";
const SELECTOR_DIALOG_PRIORITY = 40;
const APPROVAL_DIALOG_PRIORITY = 80;

export const TUI_RENDER_OPTIONS = {
  alternateScreen: true,
  patchConsole: false,
  exitOnCtrlC: false,
} as const satisfies RenderOptions;

export type TuiInputProcessResult = InputProcessResult;

export interface HandleTuiInputSubmissionDeps {
  reporter: TuiReporter;
  registry: CommandRegistry;
  workDir: string;
  runAgent: (prompt: string, options?: { images?: ImagePart[] }) => Promise<void>;
  setRewindContext?: (context: { prompt: string; transcriptIndex: number }) => void;
  exit: () => void;
  processInput?: (text: string) => Promise<TuiInputProcessResult>;
  openDialog?: (request: DialogRequest) => void;
  closeDialog?: (id: string) => void;
  dispatchInput?: (text: string) => Promise<void> | void;
  openLocalUiDialog?: (result: LocalCommandResult) => void;
  switchSession?: (selection: ResumeSessionCommandData) => Promise<void>;
  sessionId?: string;
  currentModelId?: string;
  modelOptions?: readonly ModelOption[];
  createModelSelectorContent?: (effect: LocalTuiModelSelectorDialogEffect) => React.ReactNode;
  commandAvailabilityState?: CommandInputState;
  abortControllerRef?: TuiAbortControllerRef;
  /** 异步解析后确认该输入仍属于当前 bundle generation。 */
  isActive?: () => boolean;
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
  readonly registry: CommandRegistry;
  readonly reporter: TuiReporter;
  latestMcpStatus?: McpStatusSnapshot;
}

export function getTuiCommandAvailabilityState(status: string): CommandInputState {
  return status === "idle" ? "idle" : "running";
}

export async function handleTuiInputSubmission(
  text: string,
  deps: HandleTuiInputSubmissionDeps,
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
      await runPreparedUserPrompt(processed.prompt, deps, {
        rewindPrompt: processed.raw,
        rewindTranscriptIndex,
      });
      return;
    }
    case "prompt-command": {
      const rewindTranscriptIndex = deps.reporter.getEntryCount();
      deps.reporter.pushUserMessage(processed.raw);
      const skillActivation = skillActivationFromMetadata(processed.result.metadata);
      if (skillActivation) {
        deps.reporter.pushSkillActivation(skillActivation);
      }
      await runPreparedUserPrompt(processed.result.prompt, deps, {
        rewindPrompt: processed.raw,
        rewindTranscriptIndex,
      });
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
    "workDir" | "reporter" | "runAgent" | "setRewindContext" | "abortControllerRef"
  >,
  rewind: { rewindPrompt: string; rewindTranscriptIndex: number },
): Promise<void> {
  let prepared: PreparedUserPrompt;
  try {
    deps.abortControllerRef?.current?.signal.throwIfAborted();
    prepared = await preparePromptForMessage(prompt, deps.workDir);
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
  if (prepared.images) {
    await deps.runAgent(prepared.prompt, { images: prepared.images });
    return;
  }
  await deps.runAgent(prepared.prompt);
}

export async function handleTuiRunningInputSubmission(
  text: string,
  deps: HandleTuiRunningInputSubmissionDeps,
): Promise<void> {
  if (handleApprovalCommand(text, deps)) return;

  const running = deps.guard.getSnapshot() !== "idle";
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
    await handleTuiInputSubmission(text, {
      ...deps,
      processInput: async () => processed,
      commandAvailabilityState: availabilityState,
    });
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
  );
}

async function runProcessedAgentInput(
  text: string,
  processed: TuiInputProcessResult,
  deps: HandleTuiRunningInputSubmissionDeps,
  gen: number,
  options: { drainAfter: boolean },
): Promise<void> {
  const controller = new AbortController();
  if (deps.abortControllerRef) deps.abortControllerRef.current = controller;
  try {
    await handleTuiInputSubmission(text, {
      ...deps,
      processInput: async () => processed,
    });
  } finally {
    if (deps.abortControllerRef?.current === controller) {
      deps.abortControllerRef.current = null;
    }
    if (deps.steerQueue && !deps.steerQueue.pending) deps.queue.acknowledgeSteers();
    emitRunningQueueState(deps);
    if (deps.guard.end(gen) && options.drainAfter) {
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

/** 启动 TUI REPL 循环 */
export async function startTuiRepl(opts: ReplOptions): Promise<void> {
  // 日志静默由 preload-env.ts 在模块加载前设 LOG_LEVEL=warn 完成
  // (pino transport 是 worker thread,运行时改 logger.level 无效)。

  // 诊断:hook process.stdout.write,记录 ink 实际输出的 ANSI(看擦除行为)
  if (process.env.TUI_DEBUG) {
    const { appendFileSync } = await import("node:fs");
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const origWrite = process.stdout.write.bind(process.stdout) as any;
    let frame = 0;
    const stdoutAny = process.stdout as any;
    stdoutAny._origWrite = origWrite;
    stdoutAny.write = (chunk: unknown, ...args: unknown[]) => {
      const str = typeof chunk === "string" ? chunk : String(chunk);
      if (str.includes("\x1b[") || frame < 5) {
        const visible = str.replaceAll("\x1b[", "ESC[").replaceAll("\x1b", "ESC").slice(0, 200);
        appendFileSync(".claw/tui-debug.log", `[stdout f${frame}] ${visible}\n`);
      }
      frame++;
      return origWrite(chunk, ...args);
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  }

  const provider = opts.provider ?? "openai";
  const picoConfig = await loadPicoConfig(opts.workDir);
  const modelRouter = await loadModelRouter({
    config: picoConfig,
    legacyProvider: provider,
    legacyModel: opts.model,
    legacyModelExplicit: opts.modelExplicit,
  });
  const tuiSessionSelection: CliSessionSelection = opts.sessionSelection ?? {
    mode: "new",
    sessionId: createCliSessionId(),
  };
  // ink render 需要 setState 驱动重渲染。Reporter 回调只更新当前活跃 bundle，
  // 旧 session 的延迟事件不会穿透到新 transcript。
  let setEntries: (e: TuiEntry[]) => void = () => {};
  let activeBundle: TuiSessionBundle | undefined;
  let nextBundleGeneration = 0;
  let shuttingDown = false;
  const pendingSessionSwitches = new Set<Promise<void>>();
  const pendingTuiSubmissions = new Set<Promise<void>>();
  let activeAbortControllerRef: TuiAbortControllerRef | undefined;

  const buildSessionBundleUnsafe = async (
    selection: CliSessionSelection,
  ): Promise<TuiSessionBundle> => {
    const session = await globalSessionManager.getOrCreate(selection.sessionId, opts.workDir);
    if (selection.mode === "fork" && selection.sourceSessionId) {
      await seedTuiFork(session, selection.sourceSessionId, opts.workDir);
    }

    // 在 route / WorkspaceRoots / provider 装配前先冻结 Session 的消息与运行态。
    const hydration = await session.readHydrationSnapshot();
    const restoredSettings = hydration.runtime.settings;
    const requestedModel =
      restoredSettings?.modelRouteId ??
      restoredSettings?.model ??
      picoConfig.model ??
      (opts.modelExplicit || process.env.LLM_MODEL ? opts.model : undefined);
    const initialRoute = modelRouter.require(requestedModel);
    const workspaceRoots = await WorkspaceRoots.create(opts.workDir, [
      ...picoConfig.additionalDirectories,
      ...(opts.addDirs ?? []),
      ...(restoredSettings?.additionalDirectories ?? []),
    ]);
    const runtimeState = await createTuiRuntimeState({
      workDir: opts.workDir,
      sessionId: selection.sessionId,
      session,
    });

    try {
      const { toolDisclosure, fileIndex } = runtimeState;
      const toolRegistry = buildDefaultToolRegistry(opts.workDir, {
        toolDisclosure,
        workspaceRoots,
      });
      let latestMcpStatus: McpStatusSnapshot | undefined;
      if (opts.mcpConfigPath) {
        const mcpStatusManager = new McpConnectionManager(toolRegistry, { stdioCwd: opts.workDir });
        try {
          await mcpStatusManager.loadConfig(opts.mcpConfigPath);
        } catch {
          // /mcp 展示解析错误;TUI 本身继续可用。
        }
        latestMcpStatus = mcpStatusManager.getStatusSnapshot();
      }

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
          thinkingEffort: restoredSettings?.thinkingEffort ?? opts.thinkingEffort ?? "medium",
          tools: toolStatusFromRegistry(toolRegistry),
          additionalDirectories: workspaceRoots.list().slice(1),
        },
        { persistence: session },
      );
      setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));

      let bundle: TuiSessionBundle | undefined;
      const registry = await createPicoCommandRegistry({
        workDir: opts.workDir,
        projectCommandsDir: picoConfig.commandsDir,
        provider: settings.provider,
        model: settings.model,
        modelRouteId: settings.modelRouteId,
        modelRouter,
        session,
        sessionId: selection.sessionId,
        sessionMode: selection.mode,
        ...(selection.sourceSessionId !== undefined ? { forkFrom: selection.sourceSessionId } : {}),
        thinkingEffort: settings.thinkingEffort,
        permissionMode: settings.permissionMode,
        tools: settings.tools,
        toolDisclosure,
        mcpStatus: () => bundle?.latestMcpStatus,
        additionalDirectories: settings.additionalDirectories,
        additionalDirectoryManager: workspaceRoots,
        goalManager: runtimeState.goalManager,
      });
      await fileIndex.refresh().catch(() => undefined);

      const entries = hydrateTuiEntries(hydration);
      let reporter!: TuiReporter;
      const scheduleEntriesUpdate = createTuiUpdateScheduler((next) => {
        if (activeBundle?.reporter === reporter) setEntries(next);
      }, 33);
      reporter = new TuiReporter(scheduleEntriesUpdate, entries);
      bundle = {
        generation: ++nextBundleGeneration,
        selection,
        sessionId: selection.sessionId,
        session,
        runtimeState,
        settings,
        workspaceRoots,
        registry,
        reporter,
        latestMcpStatus,
      };
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
    const [stateEntries, setStateEntries] = useState<TuiEntry[]>(() =>
      initialBundle.reporter.getProjection().entries.map(({ entry }) => entry),
    );
    const [dialogRequests, setDialogRequests] = useState<DialogRequest[]>([]);
    const [inputReplacement, setInputReplacement] = useState<{
      sequence: number;
      text: string;
    }>();
    setEntries = setStateEntries;
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
    const status = useSyncExternalStore(guard.subscribe, guard.getSnapshot);
    const running = status !== "idle"; // 派生:非 idle 即视为运行中

    const switchSession = async (request: ResumeSessionCommandData): Promise<void> => {
      const operation = (async () => {
        const current = activeBundleRef.current;
        const currentGeneration = current.generation;
        if (shuttingDown) return;
        if (guard.getSnapshot() !== "idle") {
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
          runningQueue.clear();
          rewindContextRef.current = null;
          setDialogRequests([]);
          setInputReplacement(undefined);
          setRunningInputState(runningQueue.snapshot);
          setEntries(next.reporter.getProjection().entries.map(({ entry }) => entry));
          setBundle(next);
          next.reporter.pushSystemMessage(
            request.mode === "fork"
              ? `Forked ${request.sessionId} as ${next.sessionId}.`
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

    const handleSubmit = async (text: string): Promise<void> => {
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
      try {
        await handleTuiRunningInputSubmission(text, {
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
          exit,
          sessionId,
          switchSession,
          setRewindContext: (context) => {
            rewindContextRef.current = context;
          },
          openDialog: (request) => {
            setDialogRequests((current) => [
              ...current.filter((item) => item.id !== request.id),
              request,
            ]);
          },
          closeDialog: (id) =>
            setDialogRequests((current) => current.filter((item) => item.id !== id)),
          dispatchInput: async (nextText) => {
            await submitTracked(nextText);
          },
          openLocalUiDialog: (result) => {
            if (result.ui?.kind !== "open-selector" || result.ui.selector !== "rewind") return;
            void listRewindPointSummaries(session)
              .then((snapshots) => {
                if (!isCurrentGeneration()) return;
                if (snapshots.length === 0) {
                  reporter.pushSystemMessage(
                    "No user-message checkpoints are available yet. Send a new prompt, then run /rewind again.",
                  );
                  return;
                }
                const request = createRewindCommandDialogRequest({
                  sessionId,
                  snapshots,
                  getDiffStat: async (messageId) => {
                    if (!isCurrentGeneration()) {
                      throw new Error(
                        "The active session changed before rewind preview completed.",
                      );
                    }
                    return session.getRewindDiffStat(messageId);
                  },
                  onClose: () => {
                    if (isCurrentGeneration()) setDialogRequests([]);
                  },
                  onRewind: async (snapshot, mode) => {
                    if (!isCurrentGeneration()) return;
                    const rewind = await applyTuiRewind({
                      session,
                      reporter,
                      snapshot,
                      mode,
                      onRestoreInteractionMode: (interactionMode) => {
                        const restored = setSessionMode(settings, interactionMode);
                        if (!restored.ok) throw new Error(restored.message);
                      },
                    });
                    if (!isCurrentGeneration()) return;
                    if (rewind.inputText !== undefined) {
                      setInputReplacement((current) => rewindInputReplacement(current, rewind));
                    }
                  },
                });
                setDialogRequests((current) => [
                  ...current.filter((item) => item.id !== request.id),
                  request,
                ]);
              })
              .catch((error: unknown) => {
                if (isCurrentGeneration()) appendTuiRunError(reporter, error);
              });
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
                  void submitTracked(command);
                });
              }}
            />
          ),
          runAgent: async (prompt, runOptions) => {
            const activeRoute = modelRouter.providerConfig(
              settings.modelRouteId,
              settings.thinkingEffort,
            );
            const rewindContext = rewindContextRef.current;
            rewindContextRef.current = null;
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
              allowModelFallback: false,
              thinkingEffort: settings.thinkingEffort,
              planMode: settings.mode === "plan",
              ...(runOptions?.images ? { images: runOptions.images } : {}),
              ...(rewindContext !== null ? { rewindPrompt: rewindContext.prompt } : {}),
              ...(rewindContext !== null
                ? { rewindTranscriptIndex: rewindContext.transcriptIndex }
                : {}),
              ...(rewindContext !== null ? { rewindInteractionMode: settings.mode } : {}),
              ...(opts.mcpConfigPath ? { mcpConfigPath: opts.mcpConfigPath } : {}),
              addDirs: [...settings.additionalDirectories],
            };
            await runTuiAgentPrompt(cliOpts, {
              reporter,
              toolDisclosure,
              runtimeState,
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
              toolStatusSink: (tools) => {
                setSessionTools(settings, tools);
              },
              abortControllerRef,
            });
          },
        });
      } catch (err) {
        appendTuiRunError(reporter, err);
      } finally {
        // Agent writes and external edits invalidate the startup snapshot. Refresh lazily
        // only when the user next opens @ suggestions.
        fileIndex.markDirty();
      }
    };

    const submitTracked = (text: string): Promise<void> => {
      const operation = handleSubmit(text);
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
        provider={bundle.settings.provider}
        workDir={opts.workDir}
        sessionMode={bundle.selection.mode}
        permissionMode={bundle.settings.mode}
        thinkingEffort={bundle.settings.thinkingEffort}
        mcpSummary={formatTuiMcpSummary(bundle.latestMcpStatus)}
        taskSummary={formatRunningInputQueue(runningInputState)}
        queuedCount={0}
        entries={stateEntries}
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
        onSubmit={(text) => void submitTracked(text)}
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
  const renderStdout = await resolveTuiRenderStdout(process.stdin, process.stdout);

  // 启动前清掉当前可视区,避免上一次未正常退出的 TUI 帧或 shell scrollback
  // 留在首屏,造成 Logo/Header 看起来重复。
  if (renderStdout.isTTY) {
    renderStdout.write("\x1b[2J\x1b[H");
  }

  // alternateScreen 隔离 shell scrollback；根布局由 Yoga 按当前终端宽度保留右侧 1 列，
  // 缩放时不依赖 React 尚未更新的宽度状态。保持 Ink 默认全帧渲染，兼容中文与复杂布局。
  // patchConsole:false 让 stderr 不被劫持。
  const instance = render(<ReplApp />, { ...TUI_RENDER_OPTIONS, stdout: renderStdout });
  instanceRef.current = instance;
  try {
    await instance.waitUntilExit();
  } finally {
    shuttingDown = true;
    activeAbortControllerRef?.current?.abort(new DOMException("TUI shutting down", "AbortError"));
    while (pendingTuiSubmissions.size > 0) {
      await Promise.allSettled([...pendingTuiSubmissions]);
    }
    while (pendingSessionSwitches.size > 0) {
      await Promise.allSettled([...pendingSessionSwitches]);
    }
    const finalBundle = activeBundle;
    if (finalBundle) {
      await finalBundle.runtimeState.dispose();
      await finalBundle.session.flushPersistence();
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
  forgetSessionSettings(sessionId);
  await removeCliSessionFile(workDir, sessionId);
}

async function seedTuiFork(
  target: Session,
  sourceSessionId: string,
  workDir: string,
): Promise<void> {
  if (target.length > 0) return;
  const source = await globalSessionManager.getOrCreate(sourceSessionId, workDir);
  const snapshot = await source.readHydrationSnapshot();
  if (snapshot.messages.length > 0) target.append(...snapshot.messages);
  if (snapshot.runtime.settings) {
    target.updateRuntimeState({ settings: snapshot.runtime.settings });
  }
  if (snapshot.runtime.goal) {
    target.updateRuntimeState({ goal: snapshot.runtime.goal });
  }
  await target.flushPersistence();
}

export function createTuiUpdateScheduler(
  apply: (entries: TuiEntry[]) => void,
  minIntervalMs: number,
): (entries: TuiEntry[]) => void {
  let latest: TuiEntry[] | null = null;
  let timer: NodeJS.Timeout | null = null;
  let lastAppliedAt = 0;

  return (entries) => {
    latest = entries;
    const now = Date.now();
    const elapsed = now - lastAppliedAt;
    if (elapsed >= minIntervalMs) {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      lastAppliedAt = now;
      apply(entries);
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
    | "currentModelId"
    | "modelOptions"
    | "createModelSelectorContent"
    | "openLocalUiDialog"
    | "commandAvailabilityState"
    | "switchSession"
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

  switch (result.action) {
    case "clear":
      deps.reporter.clear();
      return;
    case "exit":
      deps.exit();
      return;
    default:
      deps.reporter.pushSystemMessage(result.message ?? "");
      if (result.ui !== undefined) deps.openLocalUiDialog?.(result);
      return;
  }
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

  const models = options.models ?? buildModelOptions();
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

export async function runTuiAgentPrompt(
  cliOpts: RunAgentCliOptions,
  deps: {
    reporter: TuiReporter;
    toolDisclosure?: ToolDisclosure;
    runtimeState?: TuiRuntimeState;
    mcpStatusSink?: (snapshot: McpStatusSnapshot) => void;
    toolStatusSink?: RunAgentCliDependencies["toolStatusSink"];
    openDialog?: (request: DialogRequest) => void;
    closeDialog?: (id: string) => void;
    runAgent?: TuiRunAgent;
    abortControllerRef?: TuiAbortControllerRef;
  },
): Promise<void> {
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
  controller.signal.addEventListener("abort", closeApprovalOnAbort, { once: true });
  if (deps.abortControllerRef && ownsControllerSlot) deps.abortControllerRef.current = controller;
  try {
    const result = await (deps.runAgent ?? runAgentFromCli)(cliOpts, {
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
      ...(deps.runtimeState ? { runtimeState: deps.runtimeState } : {}),
      ...(deps.mcpStatusSink ? { mcpStatusSink: deps.mcpStatusSink } : {}),
      ...(deps.toolStatusSink ? { toolStatusSink: deps.toolStatusSink } : {}),
    });
    if (result.tracePath) {
      deps.reporter.pushSystemMessage(`Trace saved: ${result.tracePath}`);
    }
  } finally {
    controller.signal.removeEventListener("abort", closeApprovalOnAbort);
    closePendingApprovalDialogs();
    if (ownsControllerSlot && deps.abortControllerRef?.current === controller) {
      deps.abortControllerRef.current = null;
    }
  }
}

export function handleTuiInterrupt(
  controller: AbortController | null,
  queue: RunningInputQueue,
  reporter: Pick<TuiReporter, "pushSystemMessage">,
  onQueueSizeChange?: (size: number) => void,
  onQueueStateChange?: (snapshot: RunningInputQueueSnapshot) => void,
  steerQueue?: SteerQueue,
): void {
  controller?.abort(new DOMException("interrupted", "AbortError"));
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
  deps: Pick<HandleTuiInputSubmissionDeps, "workDir" | "closeDialog" | "dispatchInput">,
): DialogRequest {
  const sessions = mapCliSessionsToBrowserSessions(extractSessionSummaries(result.data));

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
