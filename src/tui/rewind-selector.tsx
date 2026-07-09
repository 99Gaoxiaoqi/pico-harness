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
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  state: RewindSelectorState,
  options: { maxItems?: number; maxIdLength?: number; maxSummaryLength?: number } = {},
): string {
  if (state.phase === "confirm") {
    const snapshot = snapshots.find((item) => item.messageId === state.messageId);
    return formatRewindConfirmText(sessionId, snapshot, state.diffStat, options);
  }
  return formatRewindMessageList(sessionId, snapshots, options);
}

export function formatRewindSelector(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number; maxIdLength?: number; maxSummaryLength?: number } = {},
): string {
  if (snapshots.length === 0) {
    return `session ${sessionId} 暂无可回滚快照。完成一次文件修改后再运行 /snapshots。`;
  }

  const maxItems = options.maxItems ?? 20;
  const maxIdLength = options.maxIdLength ?? 24;
  const maxSummaryLength = options.maxSummaryLength ?? 72;
  const visible = snapshots.slice(-maxItems);
  const lines = [`session ${sessionId} 可回滚快照:`];
  for (const snapshot of visible) {
    const summary = truncateText(
      snapshot.changeSummary ?? formatSnapshotChangeSummary(snapshot),
      maxSummaryLength,
    );
    lines.push([
      `- time=${snapshot.timestamp}`,
      `id=${truncateText(snapshot.messageId, maxIdLength)}`,
      `files=${snapshot.trackedFileCount}`,
      `summary=${summary}`,
    ].join(" "));
    lines.push(`  use: /rewind ${snapshot.messageId} both`);
  }
  const hidden = snapshots.length - visible.length;
  if (hidden > 0) lines.push(`... 已隐藏 ${hidden} 个更早快照`);
  return lines.join("\n");
}

function formatRewindMessageList(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number; maxIdLength?: number; maxSummaryLength?: number } = {},
): string {
  if (snapshots.length === 0) {
    return `session ${sessionId} 暂无可回滚消息。完成一次文件修改后再运行 /snapshots。`;
  }

  const maxItems = options.maxItems ?? 20;
  const maxIdLength = options.maxIdLength ?? 24;
  const maxSummaryLength = options.maxSummaryLength ?? 72;
  const visible = snapshots.slice(-maxItems);
  const lines = [`session ${sessionId}: 选择要 rewind 到的消息:`];
  for (const snapshot of visible) {
    const summary = truncateText(
      snapshot.changeSummary ?? formatSnapshotChangeSummary(snapshot),
      maxSummaryLength,
    );
    lines.push([
      `- time=${snapshot.timestamp}`,
      `id=${truncateText(snapshot.messageId, maxIdLength)}`,
      `files=${snapshot.trackedFileCount}`,
      `summary=${summary}`,
    ].join(" "));
  }
  const hidden = snapshots.length - visible.length;
  if (hidden > 0) lines.push(`... 已隐藏 ${hidden} 个更早快照`);
  return lines.join("\n");
}

export function formatRewindConfirm(
  sessionId: string,
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatRewindConfirmText(sessionId, snapshot, diffStat)
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

function formatRewindConfirmText(
  sessionId: string,
  snapshot: FileHistorySnapshotSummary | undefined,
  diffStat: FileHistoryDiffStat,
  options: { maxItems?: number; maxIdLength?: number } = {},
): string {
  const maxItems = options.maxItems ?? 20;
  const maxIdLength = options.maxIdLength ?? 48;
  const messageId = snapshot?.messageId ?? diffStat.messageId;
  const lines = [
    `session ${sessionId} 确认 rewind: ${messageId}`,
    `changed files=${diffStat.changedFileCount} +${diffStat.addedLines} -${diffStat.removedLines}`,
  ];

  if (snapshot?.messageIndex !== undefined) {
    lines.push(`conversation target messageIndex=${snapshot.messageIndex}`);
  }

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
  if (hidden > 0) lines.push(`... 已隐藏 ${hidden} 个文件`);
  lines.push("选择 mode: code / conversation / both / cancel");
  return lines.join("\n");
}

export function formatRewindUsage(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
): string {
  const latest = snapshots.at(-1);
  const lines = [
    "请提供要回滚的快照和 mode。",
    "用法: /rewind <messageId> code|conversation|both",
    "mode:",
    "- code: 只回滚文件",
    "- conversation: 只回滚对话",
    "- both: 同时回滚文件和对话",
  ];
  if (latest) {
    lines.push(`最近快照: ${latest.messageId}`, "", formatRewindSelector(sessionId, snapshots, { maxItems: 5 }));
  } else {
    lines.push("", formatRewindSelector(sessionId, snapshots));
  }
  return lines.join("\n");
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
