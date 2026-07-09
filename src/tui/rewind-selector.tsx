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
  | { phase: "select" }
  | { phase: "confirm"; messageId: string; diffStat: FileHistoryDiffStat };

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
  return { phase: "select" };
}

export function selectRewindSnapshot(
  _state: RewindSelectorState,
  messageId: string,
  diffStat: FileHistoryDiffStat,
): RewindSelectorState {
  return { phase: "confirm", messageId, diffStat };
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
  return formatRewindMessageList(snapshots, options);
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
  options: { maxItems?: number; maxIdLength?: number; maxSummaryLength?: number } = {},
): string {
  if (snapshots.length === 0) {
    return "Rewind\nNothing to rewind to yet.";
  }

  const maxItems = options.maxItems ?? 7;
  const maxIdLength = options.maxIdLength ?? 24;
  const maxSummaryLength = options.maxSummaryLength ?? 72;
  const visible = snapshots.slice(-maxItems);
  const lines = ["Rewind", "Restore the code and/or conversation to the point before..."];
  for (const snapshot of visible) {
    const summary = truncateText(
      formatClaudeStyleSnapshotSummary(snapshot),
      maxSummaryLength,
    );
    lines.push(`- ${truncateText(snapshot.messageId, maxIdLength)}`);
    lines.push(`  ${summary}`);
  }
  const hidden = snapshots.length - visible.length;
  if (hidden > 0) lines.push(`... ${hidden} earlier messages hidden`);
  lines.push("Enter to continue · Esc to exit");
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
    "Confirm you want to restore to the point before you sent this message:",
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
  lines.push("Restore code and conversation");
  lines.push("Restore conversation");
  lines.push("Restore code");
  lines.push("Never mind");
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
  const fileLabel = snapshot.trackedFileCount === 1 ? "1 file changed" : `${snapshot.trackedFileCount} files changed`;
  return `${fileLabel} · ${snapshot.changeSummary ?? formatSnapshotChangeSummary(snapshot)}`;
}

function formatChangedFiles(files: readonly FileHistoryDiffStat["files"][number][]): string {
  if (files.length === 0) return "no files";
  const basenames = files.map((file) => file.filePath.split(/[\\/]/).at(-1) ?? file.filePath);
  if (basenames.length === 1) return basenames[0]!;
  if (basenames.length === 2) return `${basenames[0]} and ${basenames[1]}`;
  return `${basenames[0]} and ${basenames.length - 1} other files`;
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
