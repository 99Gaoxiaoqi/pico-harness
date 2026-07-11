import React from "react";
import { Box, Text } from "ink";
import type { TuiEntry } from "./tui-reporter.js";
import { visualRows } from "./terminal-width.js";

type SubagentActivityEntry = Extract<TuiEntry, { kind: "subagent-activity" }>;

export interface SubagentActivityCardProps {
  entry: SubagentActivityEntry;
  wrapWidth?: number;
  startOffsetRows?: number;
  visibleRows?: number;
}

const STATUS_PRESENTATION = {
  queued: { marker: "○", color: "gray", label: "queued" },
  running: { marker: "✽", color: "cyan", label: "running" },
  completed: { marker: "✓", color: "green", label: "completed" },
  partial: { marker: "!", color: "yellow", label: "partial" },
  failed: { marker: "×", color: "red", label: "failed" },
  timed_out: { marker: "×", color: "yellow", label: "timed out" },
  cancelled: { marker: "−", color: "gray", label: "cancelled" },
} as const;

/** 子代理活动是 transcript 中的可替换快照，不暴露内部关联 ID。 */
export function SubagentActivityCard({
  entry,
  wrapWidth = 80,
  startOffsetRows,
  visibleRows,
}: SubagentActivityCardProps): React.ReactNode {
  const presentation = STATUS_PRESENTATION[entry.status];
  const contentRows = buildSubagentActivityCardRows(entry, wrapWidth);
  const rows = clipRows(["", ...contentRows], startOffsetRows, visibleRows);
  if (rows.length === 0) return null;

  let markerRendered = (startOffsetRows ?? 0) > 1;
  return (
    <Box flexDirection="column">
      {rows.map((row, index) => {
        if (row === "") return <Box key={`${index}:blank`} height={1} />;
        const absoluteRow = (startOffsetRows ?? 0) + index;
        const marker = markerRendered ? "" : presentation.marker;
        markerRendered = true;
        return (
          <Box key={`${index}:${row}`}>
            <Box width={2}>
              <Text color={presentation.color} bold>
                {marker}
              </Text>
            </Box>
            <Text
              color={absoluteRow === 1 ? presentation.color : undefined}
              bold={absoluteRow === 1}
              dimColor={absoluteRow !== 1}
              wrap="truncate"
            >
              {row}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}

export function buildSubagentActivityCardRows(
  entry: SubagentActivityEntry,
  wrapWidth = 80,
): string[] {
  const presentation = STATUS_PRESENTATION[entry.status];
  const completionPolicy =
    entry.completionPolicy === "optional" ? "background" : entry.completionPolicy;
  const details = [entry.agentName, entry.mode, completionPolicy].filter(isVisibleText).join(" · ");
  const logicalRows = [
    `${entry.task} · ${presentation.label}`,
    details,
    entry.currentAction,
    entry.summary,
  ].filter(isVisibleText);
  const contentWidth = Math.max(1, normalizeWrapWidth(wrapWidth) - 2);
  return logicalRows.flatMap((row) => visualRows(row, contentWidth));
}

function clipRows(rows: string[], startOffsetRows = 0, visibleRows?: number): string[] {
  const start = Math.max(0, Math.floor(startOffsetRows));
  const end = visibleRows === undefined ? undefined : start + Math.max(0, Math.floor(visibleRows));
  return rows.slice(start, end);
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width < 3) return 80;
  return Math.floor(width);
}

function isVisibleText(value: string | undefined): value is string {
  return value !== undefined && value.trim().length > 0;
}
