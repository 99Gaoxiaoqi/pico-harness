import React from "react";
import { Box, Text } from "ink";
import {
  MAIN_AGENT_ID,
  normalizeAgentNavigationItems,
  type AgentNavigationItem,
  type AgentNavigationStatus,
} from "./agent-navigation.js";
import { truncateTerminalText } from "./terminal-width.js";

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
  rows: readonly AgentSwitcherRow[];
  firstItemIndex: number;
  totalItems: number;
  hiddenAbove: number;
  hiddenBelow: number;
  /** 标题占一行，后续每个 item 占一行。 */
  totalRows: number;
}

const STATUS_PRESENTATION = {
  idle: { marker: "○", color: "gray", label: "idle" },
  queued: { marker: "○", color: "gray", label: "queued" },
  running: { marker: "✽", color: "cyan", label: "running" },
  completed: { marker: "✓", color: "green", label: "completed" },
  failed: { marker: "×", color: "red", label: "failed" },
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
  const overflow = [
    layout.hiddenAbove > 0 ? `↑${layout.hiddenAbove}` : "",
    layout.hiddenBelow > 0 ? `↓${layout.hiddenBelow}` : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <Box flexDirection="column">
      <Box>
        <Text bold={focused} color={focused ? "cyan" : undefined}>
          Agents
        </Text>
        <Text dimColor>{` · ${layout.totalItems}${overflow ? ` · ${overflow}` : ""}`}</Text>
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
  const visibleCount = Math.max(1, Math.min(items.length, normalizeMaxItems(maxVisibleItems)));
  const selectedIndex = Math.max(
    0,
    items.findIndex((item) => item.id === selectedId),
  );
  const firstItemIndex = Math.min(
    Math.max(0, selectedIndex - Math.floor(visibleCount / 2)),
    Math.max(0, items.length - visibleCount),
  );
  const width = normalizeWidth(renderWidth);
  const visible = items.slice(firstItemIndex, firstItemIndex + visibleCount);
  const rows = visible.map((item) => {
    const selected = item.id === selectedId;
    const active = item.id === activeId;
    return {
      itemId: item.id,
      text: formatSwitcherRow(item, { selected, active, focused, width }),
      status: item.status,
      selected,
      active,
    };
  });

  return {
    rows,
    firstItemIndex,
    totalItems: items.length,
    hiddenAbove: firstItemIndex,
    hiddenBelow: Math.max(0, items.length - firstItemIndex - rows.length),
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
  options: { selected: boolean; active: boolean; focused: boolean; width: number },
): string {
  const presentation = STATUS_PRESENTATION[item.status];
  const cursor = options.focused && options.selected ? "›" : " ";
  const active = options.active ? "●" : " ";
  const marker = item.id === MAIN_AGENT_ID ? " " : presentation.marker;
  const prefix = `${cursor}${active} ${marker} `;
  const unread = normalizeUnread(item.unreadCount);
  const suffixParts = [
    options.width >= 40 && item.id !== MAIN_AGENT_ID ? presentation.label : "",
    unread > 0 ? `+${unread}` : "",
  ].filter(Boolean);
  const suffix = suffixParts.length > 0 ? ` · ${suffixParts.join(" · ")}` : "";
  const label = item.id === MAIN_AGENT_ID ? "Main" : formatAgentLabel(item);
  return `${prefix}${truncateTerminalText(label, Math.max(1, options.width - prefix.length - suffix.length))}${suffix}`;
}

function formatAgentLabel(item: AgentNavigationItem): string {
  const agentName = item.agentName?.replace(/\s+/gu, " ").trim();
  const task = item.task?.replace(/\s+/gu, " ").trim();
  if (agentName && task) return `${agentName} · ${task}`;
  return agentName || task || "Agent";
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
