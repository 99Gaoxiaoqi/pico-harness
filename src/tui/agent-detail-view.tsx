import React from "react";
import { Box, Text } from "ink";
import type { AgentNavigationItem, AgentTimelineItem } from "./agent-navigation.js";
import { truncateTerminalText, visualRows } from "./terminal-width.js";

export interface AgentDetailViewProps {
  agent: AgentNavigationItem;
  renderWidth?: number;
  timelineLimit?: number;
  visibleRows?: number;
  startOffsetRows?: number;
}

const STATUS_MARKER = {
  idle: "○",
  queued: "○",
  running: "✽",
  completed: "✓",
  failed: "×",
} as const;

export function AgentDetailView({
  agent,
  renderWidth = 80,
  timelineLimit = 20,
  visibleRows,
  startOffsetRows = 0,
}: AgentDetailViewProps): React.ReactNode {
  const rows = buildAgentDetailRows(agent, { renderWidth, timelineLimit });
  const start = Math.max(0, Math.floor(startOffsetRows));
  const limit = visibleRows === undefined ? undefined : Math.max(0, Math.floor(visibleRows));
  const visible = visibleDetailRows(rows, start, limit);
  if (visible.length === 0) return null;

  return (
    <Box flexDirection="column">
      {visible.map((row, index) => (
        <Text key={`${start + index}:${row}`} wrap="truncate" dimColor={row === ""}>
          {row || " "}
        </Text>
      ))}
    </Box>
  );
}

function visibleDetailRows(rows: readonly string[], start: number, limit?: number): string[] {
  if (limit === undefined) return rows.slice(start);
  if (limit === 0) return [];
  if (start > 0 || rows.length <= limit) return rows.slice(start, start + limit);
  if (limit <= 3) return rows.slice(-limit);
  // 默认详情视图保留面包屑/状态，其余空间尾随最新轨迹。
  const headRows = 2;
  const tailRows = Math.max(1, limit - headRows - 1);
  return [...rows.slice(0, headRows), "…", ...rows.slice(-tailRows)];
}

export function buildAgentDetailRows(
  agent: AgentNavigationItem,
  options: { renderWidth?: number; timelineLimit?: number } = {},
): string[] {
  const width = normalizeWidth(options.renderWidth);
  const limit = normalizeTimelineLimit(options.timelineLimit);
  const name = agent.agentName?.trim() || agent.task?.trim() || "Agent";
  const metadata = [agent.status, agent.mode].filter(Boolean).join(" · ");
  const rows = [
    truncateTerminalText(`← Main / ${name}`, width),
    `${STATUS_MARKER[agent.status]} ${metadata}`,
  ];

  appendSection(rows, "Task", agent.task, width);
  appendSection(rows, "Current", agent.currentAction, width);
  appendSection(rows, "Summary", agent.summary, width);

  const timeline = agent.timeline ?? [];
  if (timeline.length > 0) {
    rows.push("", "Timeline");
    const visible = timeline.slice(-limit);
    const hidden = timeline.length - visible.length;
    if (hidden > 0) rows.push(`… ${hidden} earlier events`);
    for (const item of visible) rows.push(...timelineRows(item, width));
  }

  return rows;
}

function appendSection(
  rows: string[],
  label: string,
  content: string | undefined,
  width: number,
): void {
  if (!content?.trim()) return;
  rows.push("", label, ...visualRows(content.trim(), width));
}

function timelineRows(item: AgentTimelineItem, width: number): string[] {
  switch (item.kind) {
    case "thinking":
      return visualRows(`… ${item.content?.trim() || "Thinking"}`, width);
    case "message":
      return visualRows(`✦ ${item.content.trim()}`, width);
    case "tool": {
      const marker = item.status === "failed" ? "×" : item.status === "completed" ? "✓" : "└";
      const summary = item.summary?.trim();
      return visualRows(`${marker} ${item.name}${summary ? ` · ${summary}` : ""}`, width);
    }
  }
}

function normalizeWidth(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 8) return 80;
  return Math.floor(value);
}

function normalizeTimelineLimit(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 1) return 20;
  return Math.min(100, Math.floor(value));
}
