// TUI REPL entrypoint: wires ink rendering, TuiReporter, local commands, and
// per-turn calls into runAgentFromCli.
//
// Each user prompt builds a fresh engine around the same session and reporter.
// QueryGuard prevents overlapping submissions from racing cleanup state.

import type React from "react";
import { useRef, useState, useSyncExternalStore } from "react";
import { render, useApp, useInput } from "ink";
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
import { RunningInputQueue } from "./running-input-queue.js";
import type {
  RunAgentCliDependencies,
  RunAgentCliOptions,
  RunAgentCliResult,
} from "../cli/run-agent.js";
import { runAgentFromCli } from "../cli/run-agent.js";
import { listFileHistorySnapshotSummaries } from "../cli/file-history.js";
import { createCliSessionId, type CliSessionSelection } from "../cli/session-resolver.js";
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
import type { InputProcessResult, LocalCommandResult } from "../input/types.js";
import type { ImagePart } from "../schema/message.js";
import type { ProviderKind } from "../provider/factory.js";
import { isAbortError } from "../provider/errors.js";
import { defaultIsRetryableError } from "../provider/retry.js";
import type { ThinkingEffort } from "../provider/thinking.js";
import { buildDefaultToolRegistry } from "../tools/default-registry.js";
import type { ToolDisclosure } from "../tools/tool-disclosure.js";
import {
  getOrCreateSessionSettings,
  getStoredSessionSettings,
  setSessionAdditionalDirectories,
  setSessionTools,
  toolStatusFromRegistry,
} from "../input/session-settings.js";
import { WorkspaceRoots } from "../tools/workspace-roots.js";
import { globalSessionManager } from "../engine/session.js";
import { McpConnectionManager, type McpStatusSnapshot } from "../mcp/manager.js";
import { hasLocalUiCommandAction } from "./local-ui-command.js";
import {
  confirmSessionBrowserSelection,
  createSessionBrowserState,
  moveSessionBrowserSelection,
  SessionBrowser,
  toggleSessionBrowserScope,
  type SessionBrowserSession,
  type SessionBrowserState,
} from "./session-browser.js";
import {
  mapCliSessionsToBrowserSessions,
  sessionSelectionToCommand,
  type CliSessionBrowserSummary,
} from "./session-browser-adapter.js";
import { createRewindCommandDialogRequest } from "./rewind-command-dialog.js";
import {
  globalApprovalManager,
  globalApprovalPolicy,
  type ApprovalNotice,
} from "../approval/manager.js";
import { InteractiveApprovalPanel, type ApprovalPanelAction } from "./approval-panel.js";
import { createTuiRuntimeState, type TuiRuntimeState } from "./runtime-state.js";

export interface ReplOptions {
  /** 工作区 */
  workDir: string;
  /** provider 类型 */
  provider?: ProviderKind;
  /** 模型名(顶栏展示) */
  model: string;
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
const APPROVAL_DIALOG_ID = "approval:pending";
const APPROVAL_DIALOG_PRIORITY = 80;

export type TuiInputProcessResult = InputProcessResult;

export interface HandleTuiInputSubmissionDeps {
  reporter: TuiReporter;
  registry: CommandRegistry;
  workDir: string;
  runAgent: (prompt: string, options?: { images?: ImagePart[] }) => Promise<void>;
  exit: () => void;
  processInput?: (text: string) => Promise<TuiInputProcessResult>;
  openDialog?: (request: DialogRequest) => void;
  closeDialog?: (id: string) => void;
  dispatchInput?: (text: string) => Promise<void> | void;
  openLocalUiDialog?: (result: LocalCommandResult) => void;
  sessionId?: string;
  currentModelId?: string;
  modelOptions?: readonly ModelOption[];
  createModelSelectorContent?: (effect: LocalTuiModelSelectorDialogEffect) => React.ReactNode;
  commandAvailabilityState?: CommandInputState;
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
}

export type TuiRunAgent = (
  options: RunAgentCliOptions,
  dependencies: RunAgentCliDependencies,
) => Promise<RunAgentCliResult>;

export interface TuiAbortControllerRef {
  current: AbortController | null;
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

  switch (processed.type) {
    case "empty":
      return;
    case "prompt": {
      deps.reporter.pushUserMessage(processed.raw);
      await runPreparedUserPrompt(processed.prompt, deps);
      return;
    }
    case "prompt-command": {
      deps.reporter.pushUserMessage(processed.raw);
      const skillActivation = skillActivationFromMetadata(processed.result.metadata);
      if (skillActivation) {
        deps.reporter.pushSkillActivation(skillActivation);
      }
      await runPreparedUserPrompt(processed.result.prompt, deps);
      return;
    }
    case "local-command":
      handleLocalTuiCommand(processed.result, deps);
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
  deps: Pick<HandleTuiInputSubmissionDeps, "workDir" | "reporter" | "runAgent">,
): Promise<void> {
  let prepared: PreparedUserPrompt;
  try {
    prepared = await preparePromptForMessage(prompt, deps.workDir);
  } catch (error) {
    appendTuiRunError(deps.reporter, error);
    return;
  }

  for (const notice of prepared.notices ?? []) {
    deps.reporter.pushSystemMessage(notice);
  }
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

  const processed = await processTuiInput(text, {
    ...deps,
    commandAvailabilityState: availabilityState,
  });
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
    const queued = deps.queue.enqueue(text, processed, {
      commandAvailabilityState: availabilityState,
    });
    if (queued.type === "rejected") {
      deps.reporter.pushSystemMessage(`Input queue is full (${queued.capacity}). Please wait.`);
    } else {
      deps.onQueueSizeChange?.(deps.queue.size);
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
  try {
    await handleTuiInputSubmission(text, {
      ...deps,
      processInput: async () => processed,
    });
  } finally {
    if (deps.guard.end(gen) && options.drainAfter) {
      await drainQueuedTuiInputs(deps);
    }
  }
}

async function drainQueuedTuiInputs(deps: HandleTuiRunningInputSubmissionDeps): Promise<void> {
  while (deps.queue.size > 0) {
    const queued = deps.queue.drain();
    deps.onQueueSizeChange?.(deps.queue.size);
    for (const item of queued) {
      if (item.kind !== "normal") continue;
      const processed = item.processed ?? (await processTuiInput(item.text, deps));
      if (!needsAgentRun(processed)) {
        await handleTuiInputSubmission(item.text, {
          ...deps,
          processInput: async () => processed,
          commandAvailabilityState: item.commandAvailabilityState ?? deps.commandAvailabilityState,
        });
        continue;
      }

      const gen = deps.guard.tryStart();
      if (gen === null) {
        const queuedAgain = deps.queue.enqueue(item.text, processed, {
          commandAvailabilityState: item.commandAvailabilityState ?? deps.commandAvailabilityState,
        });
        if (queuedAgain.type === "rejected") {
          deps.reporter.pushSystemMessage(
            `Input queue is full (${queuedAgain.capacity}). Please wait.`,
          );
        } else {
          deps.onQueueSizeChange?.(deps.queue.size);
        }
        return;
      }

      await runProcessedAgentInput(
        item.text,
        processed,
        {
          ...deps,
          commandAvailabilityState: item.commandAvailabilityState ?? deps.commandAvailabilityState,
        },
        gen,
        { drainAfter: false },
      );
    }
  }
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

function needsAgentRun(processed: TuiInputProcessResult): boolean {
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
  const tuiSessionSelection: CliSessionSelection = opts.sessionSelection ?? {
    mode: "new",
    sessionId: createCliSessionId(),
  };
  const tuiSessionId = tuiSessionSelection.sessionId;
  const tuiSession = await globalSessionManager.getOrCreate(tuiSessionId, opts.workDir);
  const runtimeState = await createTuiRuntimeState({
    workDir: opts.workDir,
    sessionId: tuiSessionId,
    session: tuiSession,
  });
  const { toolDisclosure, fileIndex } = runtimeState;
  const storedSettings = getStoredSessionSettings(tuiSessionId);
  const restoredAdditionalDirectories =
    storedSettings?.cwd === opts.workDir ? storedSettings.additionalDirectories : [];
  const workspaceRoots = await WorkspaceRoots.create(opts.workDir, [
    ...picoConfig.additionalDirectories,
    ...(opts.addDirs ?? []),
    ...restoredAdditionalDirectories,
  ]);
  const toolRegistry = buildDefaultToolRegistry(opts.workDir, { toolDisclosure, workspaceRoots });
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
  const initialThinkingEffort = opts.thinkingEffort ?? "medium";
  const settings = getOrCreateSessionSettings({
    sessionId: tuiSessionId,
    sessionMode: tuiSessionSelection.mode,
    ...(tuiSessionSelection.sourceSessionId !== undefined
      ? { forkFrom: tuiSessionSelection.sourceSessionId }
      : {}),
    cwd: opts.workDir,
    provider,
    model: opts.model,
    thinkingEffort: initialThinkingEffort,
    permissionMode: "ask",
    tools: toolStatusFromRegistry(toolRegistry),
    additionalDirectories: workspaceRoots.list().slice(1),
  });
  setSessionAdditionalDirectories(settings, workspaceRoots.list().slice(1));
  const registry = await createPicoCommandRegistry({
    workDir: opts.workDir,
    projectCommandsDir: picoConfig.commandsDir,
    provider,
    model: settings.model,
    session: tuiSession,
    sessionId: tuiSessionId,
    sessionMode: tuiSessionSelection.mode,
    ...(tuiSessionSelection.sourceSessionId !== undefined
      ? { forkFrom: tuiSessionSelection.sourceSessionId }
      : {}),
    thinkingEffort: settings.thinkingEffort,
    permissionMode: settings.permissionMode,
    tools: settings.tools,
    toolDisclosure,
    mcpStatus: () => latestMcpStatus,
    additionalDirectories: settings.additionalDirectories,
    additionalDirectoryManager: workspaceRoots,
  });
  await fileIndex.refresh().catch(() => undefined);

  // 共享状态:TuiReporter 和 App 共用同一个 entries 数组引用
  const entries: TuiEntry[] = [];

  // ink render 需要 setState 驱动重渲染,用一个包装组件管理 entries 状态
  let setEntries: (e: TuiEntry[]) => void = () => {};
  const scheduleEntriesUpdate = createTuiUpdateScheduler((next) => setEntries(next), 33);

  // TuiReporter:onUpdate 回调把新 entries 推给 ink 的 setState
  const reporter = new TuiReporter(scheduleEntriesUpdate, entries);

  // 包装组件:管理 entries 状态 + QueryGuard 派生 running,把 setter 暴露给外部
  function ReplApp() {
    const { exit } = useApp();
    const [stateEntries, setStateEntries] = useState<TuiEntry[]>([]);
    const [dialogRequests, setDialogRequests] = useState<DialogRequest[]>([]);
    const [queuedCount, setQueuedCount] = useState(0);
    setEntries = setStateEntries;

    // QueryGuard:三态状态机(idle/dispatching/running),useSyncExternalStore 订阅。
    // 稳定引用,放在 useRef 里只创建一次。
    const guardRef = useRef<QueryGuard>(null);
    if (guardRef.current === null) guardRef.current = new QueryGuard();
    const guard = guardRef.current;
    const runningQueueRef = useRef<RunningInputQueue>(null);
    if (runningQueueRef.current === null) runningQueueRef.current = new RunningInputQueue();
    const runningQueue = runningQueueRef.current;
    const abortControllerRef = useRef<AbortController | null>(null);
    const status = useSyncExternalStore(guard.subscribe, guard.getSnapshot);
    const running = status !== "idle"; // 派生:非 idle 即视为运行中

    const handleSubmit = async (text: string): Promise<void> => {
      try {
        await handleTuiRunningInputSubmission(text, {
          reporter,
          guard,
          queue: runningQueue,
          onQueueSizeChange: setQueuedCount,
          registry,
          workDir: opts.workDir,
          exit,
          sessionId: tuiSessionId,
          openDialog: (request) => {
            setDialogRequests((current) => [
              ...current.filter((item) => item.id !== request.id),
              request,
            ]);
          },
          closeDialog: (id) =>
            setDialogRequests((current) => current.filter((item) => item.id !== id)),
          dispatchInput: async (nextText) => {
            await handleSubmit(nextText);
          },
          openLocalUiDialog: (result) => {
            if (result.ui?.kind !== "open-selector" || result.ui.selector !== "rewind") return;
            const request = createRewindCommandDialogRequest({
              sessionId: tuiSessionId,
              snapshots: listFileHistorySnapshotSummaries(tuiSession),
              getDiffStat: (messageId) => tuiSession.getRewindDiffStat(messageId),
              onClose: () => setDialogRequests([]),
              onDispatchCommand: (command) => {
                setDialogRequests([]);
                void handleSubmit(command);
              },
            });
            setDialogRequests((current) => [
              ...current.filter((item) => item.id !== request.id),
              request,
            ]);
          },
          currentModelId: settings.model,
          modelOptions: buildModelOptions(),
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
                  void handleSubmit(command);
                });
              }}
            />
          ),
          runAgent: async (prompt, runOptions) => {
            const cliOpts: RunAgentCliOptions = {
              prompt,
              provider,
              dir: opts.workDir,
              session: tuiSessionId,
              sessionSelection: tuiSessionSelection,
              model: settings.model,
              thinkingEffort: settings.thinkingEffort,
              planMode: settings.mode === "plan" || settings.permissionMode === "plan",
              ...(runOptions?.images ? { images: runOptions.images } : {}),
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
                latestMcpStatus = snapshot;
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

    return (
      <App
        model={settings.model}
        provider={provider}
        workDir={opts.workDir}
        sessionMode={settings.mode}
        permissionMode={settings.permissionMode}
        thinkingEffort={settings.thinkingEffort}
        mcpSummary={formatTuiMcpSummary(latestMcpStatus)}
        queuedCount={queuedCount}
        entries={stateEntries}
        running={running}
        slashCommandSuggestions={(query) =>
          commandSuggestions(registry, query, {
            availabilityState:
              dialogRequests.length > 0 ? "modal" : getTuiCommandAvailabilityState(status),
          })
        }
        slashArgumentSuggestions={(command, query) =>
          commandArgumentSuggestions(registry, command, query)
        }
        fileMentionSuggestions={(query) =>
          fileIndex.query(query, 500).then((files) => files.map((file) => ({ value: file })))
        }
        keybindings={picoConfig.keybindings}
        dialogRequests={dialogRequests}
        onSubmit={(text) => void handleSubmit(text)}
        onInterrupt={() => {
          handleTuiInterrupt(abortControllerRef.current, runningQueue, reporter, setQueuedCount);
        }}
        onRedraw={() => {
          if (process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H");
          setEntries([...entries]);
        }}
      />
    );
  }

  // 启动前清掉当前可视区,避免上一次未正常退出的 TUI 帧或 shell scrollback
  // 留在首屏,造成 Logo/Header 看起来重复。
  if (process.stdout.isTTY) {
    process.stdout.write("\x1b[2J\x1b[H");
  }

  // alternateScreen:true 进 alt buffer。alt buffer 下 ink 走 clearTerminal 全量重绘
  // (而非 eraseLines 逐行擦除),绕过行数计算 bug(中文字符宽度导致行数不匹配)。
  // patchConsole:false 让 stderr 不被劫持。
  const instance = render(<ReplApp />, {
    alternateScreen: true,
    patchConsole: false,
    exitOnCtrlC: false,
  });
  try {
    await instance.waitUntilExit();
  } finally {
    await runtimeState.dispose();
  }
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

function handleLocalTuiCommand(
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
  >,
): void {
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
  const controller = new AbortController();
  const closeApprovalOnAbort = () => deps.closeDialog?.(APPROVAL_DIALOG_ID);
  controller.signal.addEventListener("abort", closeApprovalOnAbort, { once: true });
  if (deps.abortControllerRef) deps.abortControllerRef.current = controller;
  try {
    const result = await (deps.runAgent ?? runAgentFromCli)(cliOpts, {
      reporter: deps.reporter,
      signal: controller.signal,
      approvalNotifier: (notice) => {
        deps.reporter.onToolAwaitingApproval(notice.toolName, notice.args);
        deps.openDialog?.(
          createApprovalDialogRequest(notice, {
            reporter: deps.reporter,
            closeDialog: deps.closeDialog,
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
    if (deps.abortControllerRef?.current === controller) {
      deps.abortControllerRef.current = null;
    }
  }
}

export function handleTuiInterrupt(
  controller: AbortController | null,
  queue: RunningInputQueue,
  reporter: Pick<TuiReporter, "pushSystemMessage">,
  onQueueSizeChange?: (size: number) => void,
): void {
  controller?.abort(new DOMException("interrupted", "AbortError"));
  const dropped = queue.clear();
  onQueueSizeChange?.(queue.size);
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
    id: APPROVAL_DIALOG_ID,
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
  if (parsed.action === "approve-session") {
    const pending = globalApprovalManager.getPendingTask(parsed.taskId);
    if (pending) {
      globalApprovalPolicy.allowForSession(deps.sessionId ?? "cli", {
        name: pending.toolName,
        arguments: pending.args,
      });
    }
  }

  const ok =
    parsed.action === "modify"
      ? globalApprovalManager.resolveApprovalWithModify(parsed.taskId, "TUI modify", parsed.content)
      : globalApprovalManager.resolveApproval(
          parsed.taskId,
          parsed.action === "approve" || parsed.action === "approve-session",
          `TUI ${parsed.action}`,
        );

  deps.closeDialog?.(APPROVAL_DIALOG_ID);
  deps.reporter.pushSystemMessage(
    ok
      ? `Approval ${parsed.action}: ${parsed.taskId}`
      : `Approval task not found: ${parsed.taskId}`,
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
  onSelect: (session: SessionBrowserSession) => Promise<void> | void;
  onCancel?: () => void;
}

function TuiSessionBrowserDialog({
  sessions,
  currentProjectCwd,
  onSelect,
  onCancel,
}: TuiSessionBrowserDialogProps): React.ReactNode {
  const [state, setState] = useState<SessionBrowserState>(() => createSessionBrowserState());

  useInput((input, key) => {
    if (key.upArrow) {
      setState((current) => moveSessionBrowserSelection(current, sessions, -1, currentProjectCwd));
      return;
    }

    if (key.downArrow) {
      setState((current) => moveSessionBrowserSelection(current, sessions, 1, currentProjectCwd));
      return;
    }

    if (input === "a") {
      setState((current) => toggleSessionBrowserScope(current, sessions, currentProjectCwd));
      return;
    }

    if (key.return) {
      setState((current) =>
        confirmSessionBrowserSelection(current, sessions, currentProjectCwd, {
          onConfirm: (session) => void onSelect(session),
        }),
      );
      return;
    }

    if (key.escape || input === "q") {
      onCancel?.();
    }
  });

  return <SessionBrowser currentProjectCwd={currentProjectCwd} sessions={sessions} state={state} />;
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
        onSelect={async (session) => {
          deps.closeDialog?.(SESSION_SELECTOR_DIALOG_ID);
          await deps.dispatchInput?.(sessionSelectionToCommand(session.id));
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
