import React from "react";
import type { FileHistorySnapshotSummary } from "../cli/file-history.js";
import type { LocalUiCommandAction } from "../input/types.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import { HelpPanel, type HelpPanelCommand } from "./help-panel.js";
import { isLocalUiCommandAction } from "./local-ui-command.js";
import { ModelSelector, type ModelOption } from "./model-selector.js";
import { RewindSelector } from "./rewind-selector.js";
import { SessionBrowser, type SessionBrowserSession } from "./session-browser.js";

export interface LocalUiDialogHostContext {
  commands?: readonly HelpPanelCommand[];
  models?: readonly ModelOption[];
  currentModelId?: string;
  sessions?: readonly SessionBrowserSession[];
  currentProjectCwd?: string;
  rewindSessionId?: string;
  rewindSnapshots?: readonly FileHistorySnapshotSummary[];
}

type LocalUiDialogKind = "help" | "model" | "session" | "rewind";

const HELP_DIALOG_PRIORITY = 30;
const SELECTOR_DIALOG_PRIORITY = 40;

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
      return <HelpPanel commands={context.commands ?? []} />;
    case "model":
      return <ModelSelector currentModelId={context.currentModelId} models={context.models ?? []} />;
    case "session":
      return (
        <SessionBrowser
          currentProjectCwd={context.currentProjectCwd}
          sessions={context.sessions ?? []}
        />
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
    return panelToDialogKind(action);
  }

  return action.selector;
}

function panelToDialogKind(action: Extract<LocalUiCommandAction, { kind: "open-panel" }>): LocalUiDialogKind {
  if (action.panel === "sessions") return "session";
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
