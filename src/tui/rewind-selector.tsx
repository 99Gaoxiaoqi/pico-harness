import React from "react";
import { Box, Text } from "ink";
import type { FileHistorySnapshotSummary } from "../cli/file-history.js";

export interface RewindSelectorProps {
  sessionId: string;
  snapshots: readonly FileHistorySnapshotSummary[];
  maxItems?: number;
}

export function RewindSelector({ sessionId, snapshots, maxItems }: RewindSelectorProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatRewindSelector(sessionId, snapshots, { maxItems })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function formatRewindSelector(
  sessionId: string,
  snapshots: readonly FileHistorySnapshotSummary[],
  options: { maxItems?: number } = {},
): string {
  if (snapshots.length === 0) {
    return `session ${sessionId} 暂无可回滚快照。`;
  }

  const maxItems = options.maxItems ?? 20;
  const visible = snapshots.slice(-maxItems);
  const lines = [`session ${sessionId} 可回滚快照:`];
  for (const snapshot of visible) {
    lines.push(
      [
        `- ${snapshot.messageId}`,
        `time=${snapshot.timestamp}`,
        `tracked=${snapshot.trackedFileCount}`,
        `backups=${snapshot.backedUpFileCount}`,
        `deleted=${snapshot.deletedFileCount}`,
        `use=/rewind ${snapshot.messageId}`,
      ].join(" "),
    );
  }
  const hidden = snapshots.length - visible.length;
  if (hidden > 0) lines.push(`... 已隐藏 ${hidden} 个更早快照`);
  return lines.join("\n");
}

export function latestSnapshotMessageId(
  snapshots: readonly FileHistorySnapshotSummary[],
): string | undefined {
  return snapshots.at(-1)?.messageId;
}
