import type { CommandRegistry } from "../input/command-registry.js";
import type { LocalCommandResult } from "../input/types.js";
import type { DialogRequest } from "./dialog-arbiter.js";
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
  /** 选择器确认派发：会话选择 → "/resume <id>"；模型选择 → "/model <route>"。 */
  readonly dispatchInput: (text: string) => void | Promise<void>;
  readonly switchSession: (sessionId: string | undefined) => void | Promise<void>;
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

  if (result.ui) {
    const context: LocalUiDialogHostContext = {
      // 选择器确认（对抗评审 P1：此前 view-only，选中无动作）。
      onModelConfirm: (model) => {
        void deps.dispatchInput(`/model ${model.id}`);
      },
      onSessionConfirm: (session) => {
        void deps.dispatchInput(sessionSelectionToClientInput(session));
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
    dialog = createLocalUiDialogRequest(result.ui, context);
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

  if (result.message) deps.reporter.pushSystemMessage(result.message);
  return { dialog, exit, switchedSession };
}

/** 会话选择确认（SessionBrowser 行选中）→ /resume 派发。 */
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
