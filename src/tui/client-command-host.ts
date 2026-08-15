import type {
  FileHistorySnapshotSummary,
  RewindMode,
} from "../cli/file-history.js";
import type { FileHistoryDiffStat } from "../safety/file-history.js";
import type { CommandRegistry } from "../input/command-registry.js";
import type { LocalCommandResult } from "../input/types.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import type {
  ChangesJumpToRewindAction,
  ChangesPanelModel,
  ChangesRestoreFileAction,
} from "./changes-panel.js";
import {
  createLocalUiDialogRequest,
  type LocalUiDialogHostContext,
} from "./local-ui-dialog-host.js";
import type { ModelOption } from "./model-selector.js";
import type { SessionBrowserSession } from "./session-browser.js";
import type { TuiReporter } from "./tui-reporter.js";

/**
 * TUI 客户端命令宿主（3-D Phase 3，无 Ink 可测）：把 client-commands 的
 * LocalCommandResult 渲染为 reporter 消息/对话框请求/会话切换/退出。渲染逻辑
 * 全部收在纯函数里，Ink 壳（client-repl）只做 setState 桥接。
 */

export interface ClientCommandHostDeps {
  readonly reporter: Pick<TuiReporter, "pushSystemMessage" | "clear">;
  readonly registry: CommandRegistry;
  /** 当前模型路由 id（model 选择器高亮）。 */
  readonly currentModelId?: () => string | undefined;
  /** 选择器确认派发：会话选择 → "/resume|/fork <id>"；模型选择 → "/model <route>"。 */
  readonly dispatchInput: (text: string) => void | Promise<void>;
  /** 关闭指定对话框（Esc 取消/选择后闭合）。 */
  readonly closeDialog: (id: string) => void;
  readonly switchSession: (sessionId: string | undefined) => void | Promise<void>;
  /** rewind preview 数据源（rewind.preview RPC 桥——客户端 /rewind /changes）。 */
  readonly getRewindDiffStat?: (messageId: string) => Promise<FileHistoryDiffStat>;
  /** rewind 应用（rewind.apply RPC 桥；viewOnly 查看型不触发）。 */
  readonly onRewindApply?: (
    snapshot: FileHistorySnapshotSummary,
    mode: RewindMode,
  ) => void | Promise<void>;
  /** /changes 单文件恢复（tier2 收口）：模型数据源（rewind.changes RPC 桥）。
   * 缺省时 /changes 降级为提示（不打开对话框）。 */
  readonly getRewindChanges?: (messageId: string) => Promise<ChangesPanelModel>;
  /** 单文件恢复执行（rewind.restoreFile RPC 桥）。 */
  readonly onRestoreRewindFile?: (action: ChangesRestoreFileAction) => void | Promise<void>;
  /** Changes 面板 → 完整回滚跳转（默认派发 /rewind <id>）。 */
  readonly onJumpToRewind?: (action: ChangesJumpToRewindAction) => void | Promise<void>;
}

export interface ClientLocalCommandEffect {
  /** 需要打开/替换的对话框（null = 无）。 */
  readonly dialog: DialogRequest | null;
  /** 宿主应退出的信号。 */
  readonly exit: boolean;
  /** 会话切换意图（/new 已在执行器内切换，此处仅上报）。 */
  readonly switchedSession: string | undefined;
}

export function handleClientLocalCommand(
  result: LocalCommandResult,
  deps: ClientCommandHostDeps,
): ClientLocalCommandEffect {
  let dialog: DialogRequest | null = null;
  let exit = false;
  let switchedSession: string | undefined;
  let suppressDialog = false;
  let messageOverride: string | undefined;

  if (result.ui) {
    const context: LocalUiDialogHostContext = {
      // 选择器确认（对抗评审二轮 P0）：先关对话框再派发——与 in-process 闭合
      // 顺序一致，避免对话框叠留。Esc 取消走 onClose 同一闭合口。
      onClose: (id) => deps.closeDialog(id),
      onModelConfirm: (model) => {
        deps.closeDialog("local-ui:model-selector");
        void deps.dispatchInput(`/model ${model.id}`);
      },
      onSessionConfirm: (session, mode) => {
        deps.closeDialog("local-ui:session-selector");
        void deps.dispatchInput(mode === "fork" ? `/fork ${session.id}` : `/resume ${session.id}`);
      },
    };
    if (result.ui.kind === "open-selector" && result.ui.selector === "model") {
      const routes = (result.data as { modelRoutes?: { id: string; name: string }[] } | undefined)
        ?.modelRoutes;
      context.models = (routes ?? []).map<ModelOption>((route) => ({
        id: route.id,
        name: route.name,
      }));
      context.currentModelId = deps.currentModelId?.();
    }
    if (
      (result.ui.kind === "open-selector" && result.ui.selector === "session") ||
      (result.ui.kind === "open-panel" && result.ui.panel === "sessions")
    ) {
      context.sessions = (result.data as SessionBrowserSession[] | undefined) ?? [];
    }
    if (result.ui.kind === "open-selector" && result.ui.selector === "rewind") {
      const data = result.data as
        | {
            sessionId?: string;
            snapshots?: FileHistorySnapshotSummary[];
            viewOnly?: boolean;
            selectedMessageId?: string;
          }
        | undefined;
      context.rewindSessionId = data?.sessionId ?? "";
      context.rewindSnapshots = data?.snapshots ?? [];
      // 有 preview 数据源才渲染交互版（纯浏览调用方不受影响）。
      if (deps.getRewindDiffStat) {
        context.rewindGetDiffStat = deps.getRewindDiffStat;
        if (!data?.viewOnly && deps.onRewindApply) {
          const onApply = deps.onRewindApply;
          context.rewindOnApply = async (snapshot, mode) => {
            await onApply(snapshot, mode);
          };
        }
        if (data?.viewOnly) context.rewindViewOnly = true;
        if (data?.selectedMessageId) context.rewindSelectedMessageId = data.selectedMessageId;
      }
    }
    if (result.ui.kind === "open-selector" && result.ui.selector === "changes") {
      const data = result.data as { sessionId?: string; checkpointId?: string } | undefined;
      // 有模型数据源才打开单文件恢复对话框（rewind.changes RPC 桥）；缺省时
      // 命令层已降级为提示，此处兜底不再打开。
      if (deps.getRewindChanges && data?.checkpointId) {
        context.changesMessageId = data.checkpointId;
        context.changesLoadModel = deps.getRewindChanges;
        if (deps.onRestoreRewindFile) {
          context.changesOnRestoreFile = deps.onRestoreRewindFile;
        }
        context.changesOnJumpToRewind =
          deps.onJumpToRewind ??
          ((action) => {
            deps.closeDialog("local-ui:changes");
            void deps.dispatchInput(`/rewind ${action.messageId}`);
          });
      } else {
        suppressDialog = true;
        messageOverride = "Changes 面板不可用（宿主未接入 rewind.changes 数据源）。";
      }
    }
    if (result.ui.kind === "open-panel" && result.ui.panel === "help") {
      context.commands = deps.registry
        .list({ includeHidden: false })
        .map((command) => ({
          name: command.name,
          description: command.description,
          usage: command.usage,
          category: command.category,
          kind: command.kind ?? "local",
          aliases: command.aliases ?? [],
        }));
    }
    dialog = suppressDialog ? null : createLocalUiDialogRequest(result.ui, context);
  }

  switch (result.action) {
    case "clear":
      deps.reporter.clear();
      break;
    case "exit":
      exit = true;
      break;
    case "resume": {
      const data = result.data as { mode?: string; sessionId?: string } | undefined;
      if (data?.mode === "resume" && typeof data.sessionId === "string") {
        void deps.switchSession(data.sessionId);
        switchedSession = data.sessionId;
      }
      break;
    }
    default:
      break;
  }

  if (messageOverride) deps.reporter.pushSystemMessage(messageOverride);
  else if (result.message) deps.reporter.pushSystemMessage(result.message);
  return { dialog, exit, switchedSession };
}

/** 会话选择确认（SessionBrowser 行选中）→ /resume 派发。 */
/** 会话选择确认 → 命令文本（resume 模式；fork 由调用方拼 /fork）。 */
export function sessionSelectionToClientInput(session: SessionBrowserSession): string {
  return `/resume ${session.id}`;
}

/**
 * 输入框建议源：CommandRegistry.commandSuggestions 的薄适配（autocomplete 模式
 * + availability 标注灰显不滤除）——共享实现消除两份漂移（对抗评审 P2）。
 */
export function clientSlashSuggestions(
  registry: CommandRegistry,
  query: string,
  availabilityState: "idle" | "running",
): { value: string; description?: string; argumentHint?: string; usage?: string; category?: string; disabled?: boolean; disabledReason?: string }[] {
  return registry
    .commandSuggestions(query, { availabilityState, matchMode: "autocomplete" })
    .map((command) => ({
      value: command.insertText,
      description: command.description,
      ...(command.category === undefined ? {} : { category: command.category }),
      ...(command.usage === undefined ? {} : { usage: command.usage }),
      ...(command.argumentHint === undefined ? {} : { argumentHint: command.argumentHint }),
      ...(command.disabled === true ? { disabled: true } : {}),
      ...(command.disabledReason === undefined ? {} : { disabledReason: command.disabledReason }),
    }));
}
