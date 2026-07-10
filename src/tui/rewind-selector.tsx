import React from "react";
import { Box, Text } from "ink";
import type { FileHistorySnapshotSummary, RewindMode } from "../cli/file-history.js";
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
      returnIndex: number;
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
  state = createRewindSelectorState(snapshots),
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

export function createRewindSelectorState(
  snapshots: readonly FileHistorySnapshotSummary[] = [],
): RewindSelectorState {
  // Claude Code 的菜单只列真实用户 prompt；默认聚焦最近一条。
  return { phase: "select", selectedIndex: snapshots.length > 0 ? snapshots.length - 1 : 0 };
}

export function selectRewindSnapshot(
  state: RewindSelectorState,
  messageId: string,
  diffStat: FileHistoryDiffStat,
): RewindSelectorState {
  return {
    phase: "confirm",
    messageId,
    diffStat,
    selectedAction: "both",
    returnIndex: state.phase === "select" ? state.selectedIndex : state.returnIndex,
  };
}

export function moveRewindSelection(
  state: RewindSelectorState,
  snapshots: readonly FileHistorySnapshotSummary[],
  direction: "up" | "down",
): RewindSelectorState {
  if (state.phase === "confirm") {
    return {
      ...state,
      selectedAction: moveConfirmAction(
        state.selectedAction,
        state.diffStat,
        direction,
        usesLegacySelectorData(snapshots),
      ),
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
  if (state.phase !== "select") return state;
  const selected = selectedRewindSnapshot(state, snapshots);
  if (!selected) return state;
  const next = selectRewindSnapshot(state, selected.messageId, {
    ...diffStat,
    messageId: selected.messageId,
  });
  return next.phase === "confirm" && selected.userPrompt !== undefined
    ? {
        ...next,
        selectedAction: diffStat.changedFileCount > 0 ? "both" : "conversation",
      }
    : next;
}

export function selectRewindConfirmAction(
  state: RewindSelectorState,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  if (state.phase !== "confirm") return state;
  if (state.selectedAction === "cancel") {
    callbacks.onCancel?.();
    return { phase: "select", selectedIndex: state.returnIndex };
  }
  callbacks.onConfirm?.(state.messageId, state.selectedAction);
  return createRewindSelectorState();
}

export function escapeRewindSelector(
  state: RewindSelectorState,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  if (state.phase === "confirm") {
    callbacks.onCancel?.();
    return { phase: "select", selectedIndex: state.returnIndex };
  }
  callbacks.onCancel?.();
  return createRewindSelectorState();
}

export function cancelRewindSelection(
  state: RewindSelectorState,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  return escapeRewindSelector(state, callbacks);
}

export function confirmRewindSelection(
  state: RewindSelectorState,
  mode: RewindMode,
  callbacks: RewindSelectorCallbacks = {},
): RewindSelectorState {
  if (state.phase === "confirm") callbacks.onConfirm?.(state.messageId, mode);
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
    if (snapshot?.userPrompt === undefined) {
      return formatLegacyRewindConfirmText(snapshot, state.diffStat, options);
    }
    return formatRewindConfirmText(snapshot, state.diffStat, state.selectedAction, options);
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

export function formatRewindUsage(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
): string {
  return formatRewindSelector(sessionId, snapshots, { maxItems: 7 });
}

function formatRewindMessageList(
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number; maxSummaryLength?: number; selectedIndex?: number } = {},
): string {
  if (snapshots.length === 0) return "Rewind\nNothing to rewind to yet.";
  if (usesLegacySelectorData(snapshots)) return formatLegacyRewindMessageList(snapshots, options);

  const itemCount = snapshots.length;
  const maxItems = options.maxItems ?? 7;
  const selectedIndex = clampIndex(options.selectedIndex ?? snapshots.length, itemCount);
  const firstVisibleIndex = visibleWindowStart(selectedIndex, itemCount, maxItems);
  const lastVisibleIndex = Math.min(itemCount, firstVisibleIndex + maxItems);
  const lines = ["Rewind", "Restore the code and/or conversation to the point before…"];

  for (let index = firstVisibleIndex; index < lastVisibleIndex; index++) {
    const marker = index === selectedIndex ? "❯" : " ";
    const snapshot = snapshots[index]!;
    lines.push(`${marker} ${truncateText(oneLine(snapshot.userPrompt ?? snapshot.messageId), 72)}`);
    lines.push(
      `  ${formatSnapshotChange(snapshot)} · ${formatRelativeTime(new Date(snapshot.timestamp))}`,
    );
  }
  const hidden = itemCount - (lastVisibleIndex - firstVisibleIndex);
  if (hidden > 0) lines.push(`… ${hidden} messages outside this window`);
  lines.push("↑/↓ to choose · Enter to continue · Esc to cancel");
  return lines.join("\n");
}

export function formatRewindConfirm(
  _sessionId: string,
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
): React.ReactNode {
  const content =
    snapshot?.userPrompt === undefined
      ? formatLegacyRewindConfirmText(snapshot, diffStat, {})
      : formatRewindConfirmText(
          snapshot,
          diffStat,
          diffStat.changedFileCount > 0 ? "both" : "conversation",
        );
  return (
    <Box flexDirection="column">
      {content.split("\n").map((line, index) => (
        <Text key={`${index}:${line}`}>{line}</Text>
      ))}
    </Box>
  );
}

function formatRewindConfirmText(
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
  selectedAction: RewindConfirmAction,
  options: { maxItems?: number; maxIdLength?: number } = {},
): string {
  const maxItems = options.maxItems ?? 10;
  const maxPathLength = options.maxIdLength ?? 72;
  const prompt = snapshot?.userPrompt ?? snapshot?.messageId ?? "Selected message";
  const lines = [
    "Rewind",
    "Confirm you want to restore to the point before you sent this message:",
    `  ${truncateText(oneLine(prompt), 72)}`,
  ];
  if (snapshot) lines.push(`  (${formatRelativeTime(new Date(snapshot.timestamp))})`);
  lines.push("The conversation will be forked from this point.");
  lines.push(
    diffStat.changedFileCount > 0
      ? `Code restore: ${diffStat.changedFileCount} file(s), +${diffStat.addedLines} -${diffStat.removedLines}`
      : "Code restore: no file changes",
  );
  for (const file of diffStat.files.slice(0, maxItems)) {
    lines.push(
      `  ${truncateText(file.filePath, maxPathLength)}  ${file.status} +${file.addedLines} -${file.removedLines}`,
    );
  }
  if (diffStat.files.length > maxItems) {
    lines.push(`  … ${diffStat.files.length - maxItems} more files`);
  }
  lines.push("");
  for (const [action, label] of restoreActions(diffStat)) {
    lines.push(`${selectedAction === action ? "❯" : " "} ${label}`);
  }
  lines.push("↑/↓ to choose · Enter to confirm · Esc to go back");
  return lines.join("\n");
}

const CODE_RESTORE_ACTIONS: readonly [RewindConfirmAction, string][] = [
  ["both", "Restore code and conversation"],
  ["conversation", "Restore conversation"],
  ["code", "Restore code"],
  ["cancel", "Never mind"],
];

const CONVERSATION_RESTORE_ACTIONS: readonly [RewindConfirmAction, string][] = [
  ["conversation", "Restore conversation"],
  ["cancel", "Never mind"],
];

function restoreActions(diffStat: FileHistoryDiffStat): readonly [RewindConfirmAction, string][] {
  return diffStat.changedFileCount > 0 ? CODE_RESTORE_ACTIONS : CONVERSATION_RESTORE_ACTIONS;
}

function formatSnapshotChange(snapshot: FileHistorySnapshotSummary): string {
  const count = snapshot.changedFileCount ?? snapshot.trackedFileCount;
  if (count === 0) return "No code changes";
  const name =
    count === 1 && snapshot.changedFiles?.[0]
      ? (snapshot.changedFiles[0].split(/[\\/]/).at(-1) ?? snapshot.changedFiles[0])
      : `${count} files changed`;
  if (snapshot.addedLines === undefined || snapshot.removedLines === undefined) return name;
  return `${name} +${snapshot.addedLines} -${snapshot.removedLines}`;
}

function formatRelativeTime(date: Date, now = new Date()): string {
  const seconds = Math.max(0, Math.floor((now.getTime() - date.getTime()) / 1000));
  if (seconds < 10) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function moveIndex(index: number, itemCount: number, direction: "up" | "down"): number {
  const current = clampIndex(index, itemCount);
  return direction === "down" ? (current + 1) % itemCount : (current - 1 + itemCount) % itemCount;
}

function clampIndex(index: number, itemCount: number): number {
  if (itemCount <= 0) return 0;
  return Math.min(Math.max(index, 0), itemCount - 1);
}

export function selectedRewindSnapshot(
  state: RewindSelectorState,
  snapshots: readonly FileHistorySnapshotSummary[],
): FileHistorySnapshotSummary | undefined {
  if (state.phase !== "select") return undefined;
  return snapshots[state.selectedIndex];
}

function visibleWindowStart(selectedIndex: number, itemCount: number, maxItems: number): number {
  const visibleCount = Math.max(1, maxItems);
  if (itemCount <= visibleCount) return 0;
  return Math.min(
    Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
    itemCount - visibleCount,
  );
}

function moveConfirmAction(
  action: RewindConfirmAction,
  diffStat: FileHistoryDiffStat,
  direction: "up" | "down",
  legacy: boolean,
): RewindConfirmAction {
  const actions = (legacy ? CODE_RESTORE_ACTIONS : restoreActions(diffStat)).map(
    ([value]) => value,
  );
  const index = actions.indexOf(action);
  return actions[moveIndex(index === -1 ? 0 : index, actions.length, direction)]!;
}

export function latestSnapshotMessageId(
  snapshots: readonly FileHistorySnapshotSummary[],
): string | undefined {
  return snapshots.at(-1)?.messageId;
}

function truncateText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 1))}…`;
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function truncateLegacyText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  const sliced = value.slice(0, Math.max(0, maxLength - 3));
  const punctuationIndex = Math.max(
    sliced.lastIndexOf(","),
    sliced.lastIndexOf("，"),
    sliced.lastIndexOf(";"),
    sliced.lastIndexOf("；"),
  );
  return `${punctuationIndex > 0 ? sliced.slice(0, punctuationIndex) : sliced}...`;
}

function usesLegacySelectorData(snapshots: readonly FileHistorySnapshotSummary[]): boolean {
  return (
    snapshots.length > 0 &&
    snapshots.some((snapshot) => snapshot.legacy === true || snapshot.userPrompt === undefined)
  );
}

function formatLegacyRewindMessageList(
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number; maxSummaryLength?: number; selectedIndex?: number },
): string {
  const maxItems = options.maxItems ?? 7;
  const selectedIndex = clampIndex(options.selectedIndex ?? snapshots.length - 1, snapshots.length);
  const firstVisibleIndex = visibleWindowStart(selectedIndex, snapshots.length, maxItems);
  const lastVisibleIndex = Math.min(snapshots.length, firstVisibleIndex + maxItems);
  const lines = [
    "Rewind",
    "Choose a message to preview before deciding whether to rewind.",
    "Preview first; confirm happens on the next screen.",
  ];
  for (let index = firstVisibleIndex; index < lastVisibleIndex; index++) {
    const snapshot = snapshots[index]!;
    const marker = index === selectedIndex ? ">" : " ";
    const fileLabel =
      snapshot.trackedFileCount === 1
        ? "1 file changed"
        : `${snapshot.trackedFileCount} files changed`;
    const summary = `${fileLabel} · ${snapshot.changeSummary ?? "No code changes"}`;
    lines.push(`${marker} ${truncateLegacyText(snapshot.messageId, 24)}`);
    lines.push(`  ${truncateLegacyText(summary, options.maxSummaryLength ?? 72)}`);
  }
  lines.push("Up/Down to choose · Enter to preview · Esc to cancel");
  return lines.join("\n");
}

function formatLegacyRewindConfirmText(
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
  options: { maxItems?: number; maxIdLength?: number },
): string {
  const lines = [
    "Rewind",
    "Preview changes before confirming rewind:",
    `- ${snapshot?.messageId ?? diffStat.messageId}`,
    "The conversation will be forked.",
    `The code will be restored +${diffStat.addedLines} -${diffStat.removedLines}.`,
  ];
  for (const file of diffStat.files.slice(0, options.maxItems ?? 20)) {
    lines.push(`- ${file.filePath} ${file.status} +${file.addedLines} -${file.removedLines}`);
  }
  lines.push("Confirm: restore code and conversation");
  lines.push("Confirm: restore conversation only");
  lines.push("Confirm: restore code only");
  lines.push("Cancel: keep current session");
  lines.push("Up/Down to choose · Enter to confirm selected action · Esc to cancel");
  return lines.join("\n");
}
