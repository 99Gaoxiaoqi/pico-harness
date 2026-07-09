import React, { useState } from "react";
import { Text, useInput } from "ink";
import type { FileHistorySnapshotSummary, RewindMode } from "../cli/file-history.js";
import type { FileHistoryDiffStat } from "../safety/file-history.js";
import type { DialogRequest } from "./dialog-arbiter.js";
import {
  createRewindSelectorState,
  moveRewindSelection,
  RewindSelector,
  selectRewindConfirmAction,
  selectRewindPreview,
  selectedRewindSnapshot,
  type RewindSelectorState,
} from "./rewind-selector.js";

export interface RewindCommandDialogState {
  selector: RewindSelectorState;
  status: "open" | "closed";
}

export interface RewindCommandDialogKeyEvent {
  input: string;
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    return?: boolean;
    escape?: boolean;
  };
}

export interface RewindCommandDialogCallbacks {
  getDiffStat: (messageId: string) => Promise<FileHistoryDiffStat>;
  onDispatchCommand?: (command: string) => void;
  onClose?: () => void;
}

export interface RewindCommandDialogViewProps {
  sessionId: string;
  snapshots: readonly FileHistorySnapshotSummary[];
  state: RewindCommandDialogState;
  maxItems?: number;
}

export interface RewindCommandDialogProps {
  sessionId: string;
  snapshots: readonly FileHistorySnapshotSummary[];
  getDiffStat: (messageId: string) => Promise<FileHistoryDiffStat>;
  onDispatchCommand: (command: string) => void;
  onClose: () => void;
  initialState?: RewindCommandDialogState;
  maxItems?: number;
}

export function createRewindCommandDialogState(
  selector: RewindSelectorState = createRewindSelectorState(),
): RewindCommandDialogState {
  return { selector, status: "open" };
}

export function RewindCommandDialogView({
  sessionId,
  snapshots,
  state,
  maxItems,
}: RewindCommandDialogViewProps): React.ReactNode {
  return (
    <RewindSelector
      sessionId={sessionId}
      snapshots={snapshots}
      state={state.selector}
      maxItems={maxItems}
    />
  );
}

export function RewindCommandDialog({
  sessionId,
  snapshots,
  getDiffStat,
  onDispatchCommand,
  onClose,
  initialState,
  maxItems,
}: RewindCommandDialogProps): React.ReactNode {
  const [state, setState] = useState(() =>
    initialState ?? createRewindCommandDialogState(createRewindSelectorState(snapshots)),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useInput((input, key) => {
    if (busy || state.status === "closed") return;
    setBusy(true);
    setError(null);
    void resolveRewindCommandDialogKey(state, snapshots, { input, key }, {
      getDiffStat,
      onDispatchCommand,
      onClose,
    })
      .then(setState)
      .catch((err: unknown) => {
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => setBusy(false));
  });

  return (
    <>
      <RewindCommandDialogView
        sessionId={sessionId}
        snapshots={snapshots}
        state={state}
        maxItems={maxItems}
      />
      {busy && <Text>Loading preview...</Text>}
      {error && <Text color="red">{error}</Text>}
    </>
  );
}

export async function resolveRewindCommandDialogKey(
  state: RewindCommandDialogState,
  snapshots: readonly FileHistorySnapshotSummary[],
  event: RewindCommandDialogKeyEvent,
  callbacks: RewindCommandDialogCallbacks,
): Promise<RewindCommandDialogState> {
  if (state.status === "closed") return state;

  if (event.key.escape || event.input === "\u001b") {
    callbacks.onClose?.();
    return closeRewindDialog();
  }

  if (event.key.upArrow) {
    return {
      ...state,
      selector: moveRewindSelection(state.selector, snapshots, "up"),
    };
  }

  if (event.key.downArrow) {
    return {
      ...state,
      selector: moveRewindSelection(state.selector, snapshots, "down"),
    };
  }

  if (!event.key.return) return state;

  if (state.selector.phase === "select") {
    const snapshot = selectedRewindSnapshot(state.selector, snapshots);
    if (!snapshot) return state;
    const diffStat = await callbacks.getDiffStat(snapshot.messageId);
    return {
      ...state,
      selector: selectRewindPreview(state.selector, snapshots, diffStat),
    };
  }

  let didClose = false;
  const selector = selectRewindConfirmAction(state.selector, {
    onConfirm: (messageId, mode) => {
      callbacks.onDispatchCommand?.(rewindSelectionToCommand(messageId, mode));
      callbacks.onClose?.();
      didClose = true;
    },
    onCancel: () => {
      callbacks.onClose?.();
      didClose = true;
    },
  });

  return didClose ? closeRewindDialog() : { ...state, selector };
}

export function rewindSelectionToCommand(messageId: string, mode: RewindMode): string {
  return `/rewind ${messageId} ${mode}`;
}

export function createRewindCommandDialogRequest(
  props: RewindCommandDialogProps,
): DialogRequest {
  return {
    id: "local-ui:rewind-selector",
    layer: "modal",
    priority: 40,
    content: <RewindCommandDialog {...props} />,
  };
}

function closeRewindDialog(): RewindCommandDialogState {
  return {
    selector: createRewindSelectorState(),
    status: "closed",
  };
}
