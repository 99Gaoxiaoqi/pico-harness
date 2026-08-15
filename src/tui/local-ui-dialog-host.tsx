import React from "react";
import type { FileHistorySnapshotSummary } from "../cli/file-history.js";
import type { LocalUiCommandAction } from "../input/types.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { InteractiveHelpPanel, type HelpPanelCommand } from "./help-panel.js";
import { isLocalUiCommandAction } from "./local-ui-command.js";
import {
  InteractiveModelSelector,
  ModelSelector,
  type ModelOption,
} from "./model-selector.js";
import { RewindSelector } from "./rewind-selector.js";
import {
  InteractiveSessionBrowser,
  SessionBrowser,
  type SessionBrowserSession,
} from "./session-browser.js";

export interface LocalUiDialogHostContext {
  commands?: readonly HelpPanelCommand[];
  models?: readonly ModelOption[];
  currentModelId?: string;
  /** 模型选择确认（3-D 客户端接线；in-process 选择器由 repl 自管）。 */
  onModelConfirm?: (model: ModelOption) => void;
  sessions?: readonly SessionBrowserSession[];
  /** 会话选择确认 → 宿主派发（mode 区分 /resume 与 /fork）。 */
  onSessionConfirm?: (session: SessionBrowserSession, mode: "resume" | "fork") => void;
  rewindSessionId?: string;
  rewindSnapshots?: readonly FileHistorySnapshotSummary[];
  onClose?: (id: string) => void;
  maxHelpItems?: number;
}

type LocalUiDialogKind = "help" | "model" | "session" | "rewind";

const HELP_DIALOG_PRIORITY = 30;
const SELECTOR_DIALOG_PRIORITY = 40;
export const DEFAULT_HELP_PANEL_MAX_ITEMS = 10;

export function createLocalUiDialogRequest(
  action: unknown,
  context: LocalUiDialogHostContext = {},
): DialogRequest | null {
  const kind = resolveLocalUiDialogKind(action);
  if (kind === null) return null;

  return {
    id: localUiDialogId(kind),
    layer: kind === "help" ? "overlay" : "modal",
    priority: kind === "help" ? HELP_DIALOG_PRIORITY : SELECTOR_DIALOG_PRIORITY,
    content: createLocalUiDialogContent(kind, context),
  };
}

export function createLocalUiDialogContent(
  kind: LocalUiDialogKind,
  context: LocalUiDialogHostContext = {},
): React.ReactNode {
  switch (kind) {
    case "help":
      return (
        <InteractiveHelpPanel
          commands={context.commands ?? []}
          maxItems={context.maxHelpItems ?? DEFAULT_HELP_PANEL_MAX_ITEMS}
          onClose={context.onClose}
        />
      );
    case "model":
      // 有确认回调时渲染键盘交互版（对抗评审二轮 P0：纯渲染版无法操作，对话框
      // 会困死 UI）；无回调保持纯浏览（兼容既有调用方）。
      return context.onModelConfirm ? (
        <InteractiveModelSelector
          models={context.models ?? []}
          currentModelId={context.currentModelId}
          onSelect={(modelId) => context.onModelConfirm?.({ ...(context.models ?? []).find((candidate) => candidate.id === modelId) ?? { id: modelId, name: modelId } })}
          onCancel={() => context.onClose?.(localUiDialogId("model"))}
        />
      ) : (
        <ModelSelector
          currentModelId={context.currentModelId}
          models={context.models ?? []}
        />
      );
    case "session":
      return context.onSessionConfirm ? (
        <InteractiveSessionBrowser
          sessions={context.sessions ?? []}
          onSelect={(session, mode) => context.onSessionConfirm?.(session, mode)}
          onCancel={() => context.onClose?.(localUiDialogId("session"))}
        />
      ) : (
        <SessionBrowser sessions={context.sessions ?? []} />
      );
    case "rewind":
      return (
        <RewindSelector
          sessionId={context.rewindSessionId ?? ""}
          snapshots={context.rewindSnapshots ?? []}
        />
      );
  }
}

function resolveLocalUiDialogKind(action: unknown): LocalUiDialogKind | null {
  if (!isLocalUiCommandAction(action)) return null;

  if (action.kind === "open-panel") {
    if (action.panel === "hooks") return null;
    return panelToDialogKind(action);
  }

  return action.selector;
}

function panelToDialogKind(
  action: Extract<LocalUiCommandAction, { kind: "open-panel" }>,
): LocalUiDialogKind {
  if (action.panel === "sessions") return "session";
  if (action.panel === "hooks") {
    throw new Error("Hooks panel is hosted by the session runtime");
  }
  return action.panel;
}

function localUiDialogId(kind: LocalUiDialogKind): string {
  switch (kind) {
    case "help":
      return "local-ui:help";
    case "model":
      return "local-ui:model-selector";
    case "session":
      return "local-ui:session-selector";
    case "rewind":
      return "local-ui:rewind-selector";
  }
}
