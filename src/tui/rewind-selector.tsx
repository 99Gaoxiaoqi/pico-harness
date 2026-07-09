import React from "react";
import { Box, Text } from "ink";
import {
  formatSnapshotChangeSummary,
  type FileHistorySnapshotSummary,
  type RewindMode,
} from "../cli/file-history.js";
import type { FileHistoryDiffStat } from "../safety/file-history.js";

export interface RewindSelectorProps {
  sessionId: string;
  snapshots: readonly FileHistorySnapshotSummary[];
  maxItems?: number;
  state?: RewindSelectorState;
}

export type RewindSelectorState =
  | { phase: "select"; selectedIndex: number }
  | {
      phase: "confirm";
      messageId: string;
      diffStat: FileHistoryDiffStat;
      selectedAction: RewindConfirmAction;
    };

export type RewindConfirmAction = RewindMode | "cancel";

export interface RewindSelectorCallbacks {
  onConfirm?: (messageId: string, mode: RewindMode) => void;
  onCancel?: () => void;
}

export function RewindSelector({
  sessionId,
  snapshots,
  maxItems,
  state = createRewindSelectorState(),
}: RewindSelectorProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatRewindSelectorState(sessionId, snapshots, state, { maxItems })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function createRewindSelectorState(): RewindSelectorState {
  return { phase: "select", selectedIndex: 0 };
}

export function selectRewindSnapshot(
  _state: RewindSelectorState,
  messageId: string,
  diffStat: FileHistoryDiffStat,
): RewindSelectorState {
  return { phase: "confirm", messageId, diffStat, selectedAction: "both" };
}

export function moveRewindSelection(
  state: RewindSelectorState,
  snapshots: readonly FileHistorySnapshotSummary[],
  direction: "up" | "down",
): RewindSelectorState {
  if (state.phase === "confirm") {
    return {
      ...state,
      selectedAction: moveConfirmAction(state.selectedAction, direction),
    };
  }

  if (snapshots.length === 0) return state;
  return {
    ...state,
    selectedIndex: moveIndex(state.selectedIndex, snapshots.length, direction),
  };
}

export function selectRewindPreview(
  state: RewindSelectorState,
  snapshots: readonly FileHistorySnapshotSummary[],
  diffStat: FileHistoryDiffStat,
): RewindSelectorState {
  if (state.phase !== "select" || snapshots.length === 0) return state;
  const selected = snapshots[clampIndex(state.selectedIndex, snapshots.length)];
  if (!selected) return state;
  return selectRewindSnapshot(state, selected.messageId, {
    ...diffStat,
    messageId: selected.messageId,
  });
}

export function selectRewindConfirmAction(
  state: RewindSelectorState,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  if (state.phase !== "confirm") return state;
  if (state.selectedAction === "cancel") {
    callbacks.onCancel?.();
    return createRewindSelectorState();
  }
  callbacks.onConfirm?.(state.messageId, state.selectedAction);
  return createRewindSelectorState();
}

export function escapeRewindSelector(
  _state: RewindSelectorState,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  callbacks.onCancel?.();
  return createRewindSelectorState();
}

export function cancelRewindSelection(
  state: RewindSelectorState,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  if (state.phase === "confirm") {
    callbacks.onCancel?.();
  }
  return createRewindSelectorState();
}

export function confirmRewindSelection(
  state: RewindSelectorState,
  mode: RewindMode,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  if (state.phase === "confirm") {
    callbacks.onConfirm?.(state.messageId, mode);
  }
  return createRewindSelectorState();
}

export function formatRewindSelectorState(
  _sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  state: RewindSelectorState,
  options: { maxItems?: number; maxIdLength?: number; maxSummaryLength?: number } = {},
): string {
  if (state.phase === "confirm") {
    const snapshot = snapshots.find((item) => item.messageId === state.messageId);
    return formatRewindConfirmText(snapshot, state.diffStat, options);
  }
  return formatRewindMessageList(snapshots, { ...options, selectedIndex: state.selectedIndex });
}

export function formatRewindSelector(
  _sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number; maxIdLength?: number; maxSummaryLength?: number } = {},
): string {
  return formatRewindMessageList(snapshots, options);
}

function formatRewindMessageList(
  snapshots: readonly FileHistorySnapshotSummary[],
  options: {
    maxItems?: number;
    maxIdLength?: number;
    maxSummaryLength?: number;
    selectedIndex?: number;
  } = {},
): string {
  if (snapshots.length === 0) {
    return "Rewind\nNothing to rewind to yet.";
  }

  const maxItems = options.maxItems ?? 7;
  const maxIdLength = options.maxIdLength ?? 24;
  const maxSummaryLength = options.maxSummaryLength ?? 72;
  const visible = snapshots.slice(-maxItems);
  const firstVisibleIndex = snapshots.length - visible.length;
  const selectedIndex = options.selectedIndex ?? -1;
  const lines = [
    "Rewind",
    "Choose a message to preview before deciding whether to rewind.",
    "Preview first; confirm happens on the next screen.",
  ];
  for (const [visibleIndex, snapshot] of visible.entries()) {
    const snapshotIndex = firstVisibleIndex + visibleIndex;
    const marker = snapshotIndex === selectedIndex ? ">" : " ";
    const summary = truncateText(formatClaudeStyleSnapshotSummary(snapshot), maxSummaryLength);
    lines.push(`${marker} ${truncateText(snapshot.messageId, maxIdLength)}`);
    lines.push(`  ${summary}`);
  }
  const hidden = snapshots.length - visible.length;
  if (hidden > 0) lines.push(`... ${hidden} earlier messages hidden`);
  lines.push("Up/Down to choose · Enter to preview · Esc to cancel");
  return lines.join("\n");
}

export function formatRewindConfirm(
  _sessionId: string,
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatRewindConfirmText(snapshot, diffStat)
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

function formatRewindConfirmText(
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
  options: { maxItems?: number; maxIdLength?: number } = {},
): string {
  const maxItems = options.maxItems ?? 20;
  const maxIdLength = options.maxIdLength ?? 48;
  const messageId = snapshot?.messageId ?? diffStat.messageId;
  const lines = [
    "Rewind",
    "Preview changes before confirming rewind:",
    `- ${truncateText(messageId, maxIdLength)}`,
  ];

  if (snapshot?.messageIndex !== undefined) {
    lines.push(`  messageIndex=${snapshot.messageIndex}`);
  }

  lines.push("The conversation will be forked.");
  lines.push(
    diffStat.changedFileCount > 0
      ? `The code will be restored +${diffStat.addedLines} -${diffStat.removedLines} in ${formatChangedFiles(diffStat.files)}.`
      : "The code has not changed (nothing will be restored).",
  );
  for (const file of diffStat.files.slice(0, maxItems)) {
    lines.push(
      [
        `- ${truncateText(file.filePath, maxIdLength)}`,
        file.status,
        `+${file.addedLines}`,
        `-${file.removedLines}`,
      ].join(" "),
    );
  }
  const hidden = diffStat.files.length - Math.min(diffStat.files.length, maxItems);
  if (hidden > 0) lines.push(`... ${hidden} files hidden`);
  lines.push("Confirm: restore code and conversation");
  lines.push("Confirm: restore conversation only");
  lines.push("Confirm: restore code only");
  lines.push("Cancel: keep current session");
  lines.push("Up/Down to choose · Enter to confirm selected action · Esc to cancel");
  if (diffStat.changedFileCount > 0) {
    lines.push("! Rewinding does not affect files edited manually or via bash.");
  }
  return lines.join("\n");
}

export function formatRewindUsage(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
): string {
  return formatRewindSelector(sessionId, snapshots, { maxItems: 7 });
}

function formatClaudeStyleSnapshotSummary(snapshot: FileHistorySnapshotSummary): string {
  if (snapshot.trackedFileCount === 0) return "No code changes";
  const fileLabel =
    snapshot.trackedFileCount === 1
      ? "1 file changed"
      : `${snapshot.trackedFileCount} files changed`;
  return `${fileLabel} · ${snapshot.changeSummary ?? formatSnapshotChangeSummary(snapshot)}`;
}

function formatChangedFiles(files: readonly FileHistoryDiffStat["files"][number][]): string {
  if (files.length === 0) return "no files";
  const basenames = files.map((file) => file.filePath.split(/[\\/]/).at(-1) ?? file.filePath);
  if (basenames.length === 1) return basenames[0]!;
  if (basenames.length === 2) return `${basenames[0]} and ${basenames[1]}`;
  return `${basenames[0]} and ${basenames.length - 1} other files`;
}

function moveIndex(index: number, itemCount: number, direction: "up" | "down"): number {
  const current = clampIndex(index, itemCount);
  return direction === "down" ? (current + 1) % itemCount : (current - 1 + itemCount) % itemCount;
}

function clampIndex(index: number, itemCount: number): number {
  return Math.min(Math.max(index, 0), itemCount - 1);
}

function moveConfirmAction(
  action: RewindConfirmAction,
  direction: "up" | "down",
): RewindConfirmAction {
  const actions: readonly RewindConfirmAction[] = ["both", "conversation", "code", "cancel"];
  const index = actions.indexOf(action);
  return actions[moveIndex(index === -1 ? 0 : index, actions.length, direction)]!;
}

export function latestSnapshotMessageId(
  snapshots: readonly FileHistorySnapshotSummary[],
): string | undefined {
  return snapshots.at(-1)?.messageId;
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliceLength = Math.max(0, maxLength - 3);
  const sliced = value.slice(0, sliceLength);
  const punctuationIndex = findLastPunctuationIndex(sliced);
  const prefix = punctuationIndex > 0 ? sliced.slice(0, punctuationIndex) : sliced;
  return `${prefix}...`;
}

function findLastPunctuationIndex(value: string): number {
  return Math.max(
    value.lastIndexOf(","),
    value.lastIndexOf("，"),
    value.lastIndexOf(";"),
    value.lastIndexOf("；"),
  );
}
