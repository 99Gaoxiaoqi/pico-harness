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
import type { InputBoxSubmission } from "./input-box.js";
import { ClientSessionRuntime } from "./client-session-runtime.js";
import { TuiReporter } from "./tui-reporter.js";
import { createTuiUpdateScheduler, TUI_RENDER_OPTIONS } from "./repl.js";
import type { DialogRequest } from "./dialog-arbiter.js";

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
    onRunStateChanged: (running) => runningSink.current?.(running),
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
  });
  const planControl = runtime.createPlanControl();

  function ClientReplApp() {
    const [projection, setProjection] = useState<TranscriptProjection>(() =>
      reporter.getProjection(),
    );
    const [dialogRequests, setDialogs] = useState<DialogRequest[]>([]);
    const [running, setRunning] = useState(false);
    useEffect(() => {
      projectionSink.current = setProjection;
      setDialogRequests = setDialogs;
      runningSink.current = setRunning;
      return () => {
        projectionSink.current = undefined;
        runningSink.current = undefined;
      };
    }, []);

    const handleSubmit = useCallback((submission: InputBoxSubmission) => {
      // v1 忽略 attachments（Phase 3 输入扩展），只上送文本。
      void runtime.sendText(submission.text);
    }, []);
    const handleInterrupt = useCallback(() => {
      void runtime.interrupt();
    }, []);

    return (
      <App
        model={options.model ?? "daemon-managed"}
        workDir={options.workDir}
        entries={projectTranscriptEntriesForRendering(projection)}
        running={running}
        onSubmit={handleSubmit}
        onInterrupt={handleInterrupt}
        dialogRequests={dialogRequests}
      />
    );
  }

  const instance = render(<ClientReplApp />, { ...TUI_RENDER_OPTIONS });
  try {
    await runtime.start();
    reporter.pushSystemMessage(
      `已连接本地 Runtime（客户端模式）。工作区：${options.workDir}`,
    );
    await instance.waitUntilExit();
  } finally {
    runtime.dispose();
    reporter.dispose();
    client.close();
  }
}
