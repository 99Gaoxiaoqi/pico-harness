import React from "react";
import { Box, Text } from "ink";
import {
  MAIN_AGENT_ID,
  normalizeAgentNavigationItems,
  type AgentNavigationItem,
  type AgentNavigationStatus,
} from "./agent-navigation.js";
import { terminalWidth, truncateTerminalText } from "./terminal-width.js";

export interface AgentSwitcherProps {
  items: readonly AgentNavigationItem[];
  selectedId: string;
  activeId: string;
  focused: boolean;
  renderWidth?: number;
  maxVisibleItems?: number;
}

export interface AgentSwitcherRow {
  itemId: string;
  text: string;
  status: AgentNavigationStatus;
  selected: boolean;
  active: boolean;
}

export interface AgentSwitcherLayout {
  title: string;
  rows: readonly AgentSwitcherRow[];
  firstItemIndex: number;
  totalItems: number;
  hiddenAbove: number;
  hiddenBelow: number;
  /** 标题占一行，后续每个 item 占一行。 */
  totalRows: number;
}

const STATUS_PRESENTATION = {
  idle: { marker: "○", color: "gray" },
  queued: { marker: "○", color: "gray" },
  running: { marker: "✽", color: "cyan" },
  completed: { marker: "✓", color: "green" },
  partial: { marker: "!", color: "yellow" },
  failed: { marker: "×", color: "red" },
  timed_out: { marker: "×", color: "yellow" },
  cancelled: { marker: "−", color: "gray" },
} as const;

export function AgentSwitcher({
  items,
  selectedId,
  activeId,
  focused,
  renderWidth = 80,
  maxVisibleItems = 4,
}: AgentSwitcherProps): React.ReactNode {
  const layout = buildAgentSwitcherLayout({
    items,
    selectedId,
    activeId,
    focused,
    renderWidth,
    maxVisibleItems,
  });
  return (
    <Box flexDirection="column">
      <Box>
        <Text bold={focused} color={focused ? "cyan" : undefined} wrap="truncate">
          {layout.title}
        </Text>
      </Box>
      {layout.rows.map((row) => (
        <Text
          key={row.itemId}
          color={row.selected && focused ? "cyan" : STATUS_PRESENTATION[row.status].color}
          bold={row.selected || row.active}
          dimColor={!row.selected && !row.active && row.status !== "running"}
          wrap="truncate"
        >
          {row.text}
        </Text>
      ))}
    </Box>
  );
}

export function buildAgentSwitcherLayout({
  items: sourceItems,
  selectedId,
  activeId,
  focused,
  renderWidth = 80,
  maxVisibleItems = 4,
}: AgentSwitcherProps): AgentSwitcherLayout {
  const items = normalizeAgentNavigationItems(sourceItems);
  const width = normalizeWidth(renderWidth);
  const visibleLimit = Math.max(1, Math.min(items.length, normalizeMaxItems(maxVisibleItems)));
  const main = items[0]!;
  const subagents = items.slice(1);
  const selectedSubagentIndex = Math.max(
    0,
    subagents.findIndex((item) => item.id === selectedId),
  );
  const subagentCapacity = Math.max(0, visibleLimit - 1);
  const firstItemIndex = Math.min(
    Math.max(0, selectedSubagentIndex - Math.floor(subagentCapacity / 2)),
    Math.max(0, subagents.length - subagentCapacity),
  );
  const visible =
    subagentCapacity > 0
      ? [main, ...subagents.slice(firstItemIndex, firstItemIndex + subagentCapacity)]
      : [selectedId === MAIN_AGENT_ID ? main : (subagents[selectedSubagentIndex] ?? main)];
  const nameColumnWidth = resolveNameColumnWidth(visible, width);
  const rows = visible.map((item) => {
    const selected = item.id === selectedId;
    const active = item.id === activeId;
    return {
      itemId: item.id,
      text: formatSwitcherRow(item, { selected, active, focused, width, nameColumnWidth }),
      status: item.status,
      selected,
      active,
    };
  });

  const hiddenAbove = subagentCapacity > 0 ? firstItemIndex : selectedSubagentIndex;
  const visibleSubagentCount = rows.filter((row) => row.itemId !== MAIN_AGENT_ID).length;
  const hiddenBelow = Math.max(0, subagents.length - hiddenAbove - visibleSubagentCount);
  const unreadCount = subagents.reduce(
    (total, item) => total + normalizeUnread(item.unreadCount),
    0,
  );

  return {
    title: formatSwitcherTitle({
      subagentCount: subagents.length,
      unreadCount,
      hiddenAbove,
      hiddenBelow,
      width,
    }),
    rows,
    firstItemIndex,
    totalItems: subagents.length,
    hiddenAbove,
    hiddenBelow,
    totalRows: 1 + rows.length,
  };
}

export function measureAgentSwitcherRows(
  items: readonly AgentNavigationItem[],
  maxVisibleItems = 4,
): number {
  return (
    1 + Math.min(normalizeAgentNavigationItems(items).length, normalizeMaxItems(maxVisibleItems))
  );
}

/** localRow 是相对 switcher 顶部的 0-based 行；第 0 行标题不可点击。 */
export function hitTestAgentSwitcherRow(
  layout: AgentSwitcherLayout,
  localRow: number,
): string | null {
  if (!Number.isInteger(localRow) || localRow < 1) return null;
  return layout.rows[localRow - 1]?.itemId ?? null;
}

function formatSwitcherRow(
  item: AgentNavigationItem,
  options: {
    selected: boolean;
    active: boolean;
    focused: boolean;
    width: number;
    nameColumnWidth: number;
  },
): string {
  const presentation = STATUS_PRESENTATION[item.status];
  const indicator = options.focused && options.selected ? "›" : options.active ? "●" : " ";
  const prefix = `${indicator} ${presentation.marker} `;
  const unread = normalizeUnread(item.unreadCount);
  const unreadLabel = unread > 0 ? (options.width >= 32 ? `${unread} new` : `+${unread}`) : "";
  const suffix = unreadLabel ? `  ${unreadLabel}` : "";
  const contentWidth = Math.max(1, options.width - terminalWidth(prefix) - terminalWidth(suffix));

  if (item.id === MAIN_AGENT_ID) {
    return `${prefix}${truncateTerminalText("Main", contentWidth)}${suffix}`;
  }

  const name = normalizeLabel(item.agentName) || "Agent";
  const task = normalizeLabel(item.task);
  const nameWidth = Math.min(options.nameColumnWidth, contentWidth);
  const renderedName = padTerminalText(truncateTerminalText(name, nameWidth), nameWidth);
  const taskWidth = Math.max(0, contentWidth - nameWidth - (task ? 2 : 0));
  const renderedTask = task && taskWidth > 0 ? `  ${truncateTerminalText(task, taskWidth)}` : "";
  return `${prefix}${renderedName}${renderedTask}${suffix}`;
}

function resolveNameColumnWidth(items: readonly AgentNavigationItem[], width: number): number {
  const widest = Math.max(
    4,
    ...items
      .filter((item) => item.id !== MAIN_AGENT_ID)
      .map((item) => terminalWidth(normalizeLabel(item.agentName) || "Agent")),
  );
  const available = Math.max(4, width - terminalWidth("› ✽ ") - 4);
  return Math.max(4, Math.min(12, widest, Math.floor(available * 0.35)));
}

function formatSwitcherTitle(options: {
  subagentCount: number;
  unreadCount: number;
  hiddenAbove: number;
  hiddenBelow: number;
  width: number;
}): string {
  const parts = [`Agents · ${options.subagentCount}`];
  if (options.hiddenAbove > 0) parts.push(`↑${options.hiddenAbove} hidden`);
  if (options.hiddenBelow > 0) parts.push(`↓${options.hiddenBelow} hidden`);
  if (options.unreadCount > 0) {
    parts.push(options.width >= 24 ? `${options.unreadCount} new` : `+${options.unreadCount}`);
  }
  return truncateTerminalText(parts.join(" · "), options.width);
}

function normalizeLabel(value: string | undefined): string {
  return value?.replace(/\s+/gu, " ").trim() ?? "";
}

function padTerminalText(value: string, width: number): string {
  return `${value}${" ".repeat(Math.max(0, width - terminalWidth(value)))}`;
}

function normalizeUnread(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function normalizeWidth(value: number): number {
  if (!Number.isFinite(value) || value < 8) return 80;
  return Math.floor(value);
}

function normalizeMaxItems(value: number): number {
  if (!Number.isFinite(value) || value < 1) return 4;
  return Math.floor(value);
}
