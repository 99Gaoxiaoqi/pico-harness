import { useCallback, useEffect, useState } from "react";
import { render } from "ink";
import { LocalRuntimeClient } from "../daemon/client.js";
import {
  projectTranscriptEntriesForRendering,
  type TranscriptProjection,
} from "../presentation/transcript-event-store.js";
import { App } from "./app.js";
import { approvalDialogId } from "./approval-panel.js";
import { createApprovalDialogRequest } from "./approval-dialogs.js";
import {
  askUserDialogId,
  createAskUserDialogRequest,
} from "./ask-user-dialog.js";
import type { AskUserRequest } from "../tools/ask-user.js";
import type { InputBoxSubmission } from "./input-box.js";
import { ClientSessionRuntime } from "./client-session-runtime.js";
import {
  createClientCommandRegistry,
  processClientInput,
} from "./client-commands.js";
import {
  clientSlashSuggestions,
  handleClientLocalCommand,
} from "./client-command-host.js";
import { TuiReporter } from "./tui-reporter.js";
import { createTuiUpdateScheduler, TUI_RENDER_OPTIONS } from "./repl.js";
import { diffStatFromRewindPreview } from "./rewind-client-bridge.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import type { FileHistorySnapshotSummary, RewindMode } from "../cli/file-history.js";
import type { FileHistoryDiffStat } from "../safety/file-history.js";

/**
 * TUI 客户端 tracer 入口（3-D Phase 2，`pico --client`）。
 *
 * 薄壳：LocalRuntimeClient（kernel 模式，connectOrSpawn 拉起/连上常驻 daemon）+
 * ClientSessionRuntime（send/事件/审批核心，无 Ink 可测）+ 复用 <App> 展示层。
 * 引擎装配零引用——运行时编排全部在 daemon 侧。v1 边界见 client-session-runtime
 * 头注释（斜杠命令/attachments 暂不支持，Phase 3 RPC 化）。
 */

export interface ClientReplOptions {
  readonly workDir: string;
  readonly sessionId?: string;
  readonly model?: string;
  /** BYOK 思考强度覆盖（--thinking，经 session.settings.update 应用）。 */
  readonly thinkingEffort?: string;
  /** 启动 fork（--fork <id>）：连接后经 session.fork RPC 切到新会话。 */
  readonly forkFrom?: string;
  /** Graph Mode 启动覆盖（--graph，经 session.settings.update 应用）。 */
  readonly graphMode?: boolean;
}

export async function startClientRepl(options: ClientReplOptions): Promise<void> {
  const client = new LocalRuntimeClient();
  // 投影推送桥：reporter 在组件外构造，setProjection 经 ref 由组件挂载后接管
  // （与 repl.tsx 的 33ms 渲染合流同款）。
  const projectionSink: {
    current: ((projection: TranscriptProjection) => void) | undefined;
  } = { current: undefined };
  const runningSink: { current: ((running: boolean) => void) | undefined } = { current: undefined };
  const scheduleProjection = createTuiUpdateScheduler<TranscriptProjection>(
    (value) => projectionSink.current?.(value),
    33,
  );
  const reporter = new TuiReporter({ onProjectionUpdate: scheduleProjection });

  let setDialogRequests: ((update: (items: DialogRequest[]) => DialogRequest[]) => void) | undefined;
  const runtime = new ClientSessionRuntime({
    client,
    workspacePath: options.workDir,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    reporter,
    ...(options.model ? { modelOverride: options.model } : {}),
    ...(options.thinkingEffort ? { thinkingOverride: options.thinkingEffort } : {}),
    ...(options.graphMode ? { orchestrationModeOverride: "graph" } : {}),
    onRunStateChanged: (running) => runningSink.current?.(running),
    onSettingsSnapshot: (settings) => {
      currentSettings.current = settings;
      settingsSink.current?.(settings);
    },
    onApproval: (notice) => {
      setDialogRequests?.((items) => [
        ...items.filter((item) => item.id !== approvalDialogId(notice.taskId)),
        createApprovalDialogRequest(notice, {
          reporter,
          closeDialog: (id) =>
            setDialogRequests?.((items) => items.filter((item) => item.id !== id)),
          sessionId: runtime.activeSessionId,
          planControl: planControl,
          resolvePlain: (action, taskId) => runtime.resolvePlain(action, taskId),
        }),
      ]);
    },
    onApprovalResolved: (approvalId) => {
      setDialogRequests?.((items) => items.filter((item) => item.id !== approvalDialogId(approvalId)));
    },
    // ask-user：daemon prompt.requested → AskUserDialog（选项 + freeText 文本
    // 输入态）；settle 动作走 prompt.respond RPC（幂等键在 runtime.respondPrompt）。
    onPrompt: (prompt) => {
      const request = prompt as unknown as AskUserRequest;
      setDialogRequests?.((items) => [
        ...items.filter((item) => item.id !== askUserDialogId(request.requestId)),
        createAskUserDialogRequest(
          request,
          {
            select: (promptId, optionId) => runtime.respondPrompt(promptId, optionId),
            submitText: (promptId, text) => runtime.respondPrompt(promptId, text),
            cancel: (promptId) =>
              runtime
                .request("prompt.cancel", {
                  workspacePath: options.workDir,
                  promptId,
                })
                .then(
                  (result) => result.cancelled,
                  () => false,
                ),
          },
          {
            onClose: (id) =>
              setDialogRequests?.((items) => items.filter((item) => item.id !== id)),
          },
        ),
      ]);
    },
    onPromptResolved: (promptId) => {
      setDialogRequests?.((items) => items.filter((item) => item.id !== askUserDialogId(promptId)));
    },
  });
  const planControl = runtime.createPlanControl();
  const commandRegistry = createClientCommandRegistry({
    runtime,
    workspacePath: options.workDir,
  });

  let exitRequested = false;
  let instanceRef: ReturnType<typeof render> | undefined;
  // 会话设置快照桥（对抗评审二轮 P1：App 的 permissionMode 默认 "yolo" 会误显；
  // runtime 推快照 → sink → 组件 state，与 projectionSink 同款桥接）。
  const currentSettings: {
    current: Partial<Record<"modelRouteId" | "thinkingEffort" | "collaborationMode" | "permissionMode" | "orchestrationMode", string>> | undefined;
  } = { current: undefined };
  const settingsSink: { current: ((value: NonNullable<typeof currentSettings.current>) => void) | undefined } = { current: undefined };
  // rewind 后输入回填桥（fork 会话携带原 prompt 供编辑——与 in-process
  // setInputReplacement 同语义，经 App.inputReplacement 通道）。
  const inputReplacementSink: { current: ((value: { sequence: number; text: string } | undefined) => void) | undefined } = { current: undefined };
  let inputReplacementSeq = 0;
  // rewind preview 的指纹缓存（preview→apply 间一致性校验；键 = sessionId/checkpointId）。
  const rewindFingerprints = new Map<string, string>();
  const getRewindDiffStat = async (messageId: string): Promise<FileHistoryDiffStat> => {
    const sessionId = runtime.activeSessionId;
    if (!sessionId) throw new Error("当前没有活跃会话。");
    const result = await runtime.request("rewind.preview", {
      workspacePath: options.workDir,
      sessionId,
      checkpointId: messageId,
    });
    const projection = diffStatFromRewindPreview(result, messageId);
    rewindFingerprints.set(`${sessionId}/${messageId}`, projection.fingerprint);
    return projection.diffStat;
  };
  const onRewindApply = async (
    snapshot: FileHistorySnapshotSummary,
    mode: RewindMode,
  ): Promise<void> => {
    const sessionId = runtime.activeSessionId;
    if (!sessionId) throw new Error("当前没有活跃会话。");
    const expectedFingerprint = rewindFingerprints.get(`${sessionId}/${snapshot.messageId}`);
    if (expectedFingerprint === undefined) {
      throw new Error("缺少回滚预览指纹；请重新进入 /rewind 预览后再确认。");
    }
    const result = await runtime.request("rewind.apply", {
      workspacePath: options.workDir,
      sessionId,
      checkpointId: snapshot.messageId,
      expectedFingerprint,
      mode,
    });
    // fork 成功：回填原 prompt 并切换到 fork 会话（与 in-process applyTuiRewind
    // 同语义——inputReplacement 先行，switchSession 水化后即可编辑）。
    if (result.applied && typeof snapshot.userPrompt === "string" && snapshot.userPrompt !== "") {
      inputReplacementSeq += 1;
      inputReplacementSink.current?.({ sequence: inputReplacementSeq, text: snapshot.userPrompt });
    }
    if (result.sessionId && result.sessionId !== sessionId) {
      await runtime.switchSession(result.sessionId);
    }
  };
  const requestExit = (): void => {
    if (exitRequested) return;
    exitRequested = true;
    instanceRef?.unmount();
  };

  const closeDialogById = (id: string): void => {
    setDialogRequests?.((items) => items.filter((item) => item.id !== id));
  };

  const applyLocalCommand = (result: Parameters<typeof handleClientLocalCommand>[0]): void => {
    const effect = handleClientLocalCommand(result, {
      reporter,
      registry: commandRegistry,
      currentModelId: () => currentSettings.current?.modelRouteId,
      dispatchInput: (text: string) => {
        void handleSubmittedText(text);
      },
      closeDialog: closeDialogById,
      switchSession: (sessionId: string | undefined) => runtime.switchSession(sessionId),
      getRewindDiffStat,
      onRewindApply,
    });
    const dialog = effect.dialog;
    if (dialog) {
      setDialogRequests?.((items) => [...items.filter((item) => item.id !== dialog.id), dialog]);
    }
    if (effect.exit) requestExit();
  };

  const handleSubmittedText = async (text: string): Promise<void> => {
    const outcome = await processClientInput(text, commandRegistry, runtime);
    if (outcome.kind === "local" && outcome.result) {
      applyLocalCommand(outcome.result);
    } else if (outcome.kind === "unknown" && outcome.message) {
      reporter.pushSystemMessage(outcome.message);
    }
  };

  function ClientReplApp() {
    const [projection, setProjection] = useState<TranscriptProjection>(() =>
      reporter.getProjection(),
    );
    const [dialogRequests, setDialogs] = useState<DialogRequest[]>([]);
    const [running, setRunning] = useState(false);
    const [settings, setSettings] = useState<NonNullable<typeof currentSettings.current>>({});
    const [inputReplacement, setInputReplacement] = useState<
      { sequence: number; text: string } | undefined
    >(undefined);
    useEffect(() => {
      projectionSink.current = setProjection;
      setDialogRequests = setDialogs;
      runningSink.current = setRunning;
      settingsSink.current = setSettings;
      inputReplacementSink.current = setInputReplacement;
      return () => {
        projectionSink.current = undefined;
        runningSink.current = undefined;
        settingsSink.current = undefined;
        inputReplacementSink.current = undefined;
        // 卸载后清桥（对抗评审 P2：退出窗口内的迟到审批不再打已卸载组件）。
        setDialogRequests = undefined;
      };
    }, []);

    const handleSubmit = useCallback((submission: InputBoxSubmission) => {
      // v1 忽略 attachments（Phase 3 输入扩展）；slash 经客户端命令表分派。
      void handleSubmittedText(submission.text);
    }, []);
    const handleInterrupt = useCallback(() => {
      void runtime.interrupt();
    }, []);

    return (
      <App
        model={options.model ?? settings.modelRouteId ?? "daemon-managed"}
        modelRouteId={settings.modelRouteId}
        workDir={options.workDir}
        entries={projectTranscriptEntriesForRendering(projection)}
        running={running}
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        onExit={() => requestExit()}
        dialogRequests={dialogRequests}
        inputReplacement={inputReplacement}
        collaborationMode={settings.collaborationMode}
        permissionMode={settings.permissionMode}
        graphMode={settings.orchestrationMode === "graph"}
        thinkingEffort={settings.thinkingEffort}
        slashCommandSuggestions={(query: string) =>
          clientSlashSuggestions(commandRegistry, query, running ? "running" : "idle")
        }
        slashArgumentSuggestions={(command: string, query: string) =>
          commandRegistry.resolve(command)?.argumentCompleter?.(query) ?? []
        }
      />
    );
  }

  const instance = render(<ClientReplApp />, { ...TUI_RENDER_OPTIONS });
  instanceRef = instance;
  try {
    // 冷启动预算（Phase 4 复核）：慢环境 connectOrSpawn 选举首连可达 24s——
    // UI 先渲染并给出连接提示，避免"敲完命令黑屏数十秒"。
    reporter.pushSystemMessage("正在连接本地 Runtime（冷启动拉起 daemon 可能需要数十秒）…");
    await runtime.start();
    reporter.pushSystemMessage(
      `已连接本地 Runtime（客户端模式）。工作区：${options.workDir}`,
    );
    // 启动 fork（--fork <id>）：连接后从源会话 fork 新会话并切换（原会话不动）。
    if (options.forkFrom) {
      const forked = await runtime.request("session.fork", {
        workspacePath: options.workDir,
        sessionId: options.forkFrom,
      });
      await runtime.switchSession(forked.session.sessionId);
      reporter.pushSystemMessage(`已从 ${options.forkFrom} fork 到新会话 ${forked.session.sessionId}。`);
    }
    await instance.waitUntilExit();
  } finally {
    runtime.dispose();
    reporter.dispose();
    client.close();
  }
}
