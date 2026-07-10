import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import type {
  SlashCommandCategory,
  SlashCommandKind,
  SlashCommandSource,
} from "../input/types.js";
import { visualRows } from "./terminal-width.js";

export const HELP_PANEL_COMMAND_WIDTH = 44;
export const HELP_PANEL_DESCRIPTION_WIDTH = 72;

export interface HelpPanelCommand {
  name: string;
  aliases?: readonly string[];
  usage?: string;
  argumentHint?: string;
  description?: string;
  kind?: SlashCommandKind;
  category?: SlashCommandCategory;
  source?: SlashCommandSource;
  disabled?: boolean;
  disabledReason?: string;
}

export interface HelpPanelScrollState {
  selectedIndex: number;
  scrollOffset: number;
}

export interface HelpPanelProps {
  commands: readonly HelpPanelCommand[];
  selectedIndex?: number;
  scrollOffset?: number;
  maxItems?: number;
}

export interface InteractiveHelpPanelProps extends HelpPanelProps {
  dialogId?: string;
  onClose?: (id: string) => void;
}

export interface HelpPanelSection {
  title: string;
  rows: HelpPanelRow[];
}

export interface HelpPanelRow {
  key: string;
  commandIndex: number;
  usage: string;
  description: string;
  aliases: string;
  disabled: boolean;
  disabledReason: string;
  selected: boolean;
}

export function HelpPanel({
  commands,
  selectedIndex,
  scrollOffset,
  maxItems,
}: HelpPanelProps): React.ReactNode {
  return (
    <Box flexDirection="column" marginLeft={2}>
      {formatHelpPanel(commands, { selectedIndex, scrollOffset, maxItems })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function InteractiveHelpPanel({
  commands,
  selectedIndex,
  scrollOffset,
  maxItems,
  dialogId = "local-ui:help",
  onClose,
}: InteractiveHelpPanelProps): React.ReactNode {
  const pageSize = Math.max(1, maxItems ?? commands.length);
  const [state, setState] = useState<HelpPanelScrollState>({
    selectedIndex: selectedIndex ?? 0,
    scrollOffset: scrollOffset ?? 0,
  });

  useInput((input, key) => {
    if (input === "\u001b" || key.escape) {
      onClose?.(dialogId);
      return;
    }

    const delta = helpPanelKeyDelta(key, pageSize);
    if (delta === 0) return;
    setState((current) =>
      updateHelpPanelScroll(current, {
        delta,
        totalItems: commands.length,
        pageSize,
      }),
    );
  });

  return (
    <HelpPanel
      commands={commands}
      selectedIndex={state.selectedIndex}
      scrollOffset={state.scrollOffset}
      maxItems={pageSize}
    />
  );
}

export function formatHelpPanel(
  commands: readonly HelpPanelCommand[],
  options: { selectedIndex?: number; scrollOffset?: number; maxItems?: number } = {},
): string {
  if (commands.length === 0) {
    return "Slash commands\nNo slash commands available.";
  }

  const pageSize = Math.max(1, options.maxItems ?? commands.length);
  const state = normalizeHelpPanelScroll(
    {
      selectedIndex: options.selectedIndex ?? 0,
      scrollOffset: options.scrollOffset ?? 0,
    },
    commands.length,
    pageSize,
  );
  const hiddenAbove = state.scrollOffset;
  const hiddenBelow = Math.max(0, commands.length - state.scrollOffset - pageSize);
  const sections = formatHelpPanelSections(commands, {
    selectedIndex: state.selectedIndex,
    scrollOffset: state.scrollOffset,
    maxItems: pageSize,
  });
  const lines = ["Slash commands"];

  if (hiddenAbove > 0) lines.push(`↑ ${hiddenAbove} hidden`);
  for (const section of sections) {
    lines.push(section.title);
    for (const row of section.rows) {
      lines.push(formatHelpPanelRow(row));
      if (row.aliases) lines.push(`    aliases: ${row.aliases}`);
      if (row.disabledReason) lines.push(`    ${row.disabledReason}`);
    }
  }
  if (hiddenBelow > 0) lines.push(`↓ ${hiddenBelow} hidden`);

  return lines.join("\n");
}

export function measureHelpPanelRows(
  commands: readonly HelpPanelCommand[],
  options: {
    selectedIndex?: number;
    scrollOffset?: number;
    maxItems?: number;
    width?: number;
  } = {},
): number {
  const wrapWidth = Math.max(1, options.width ?? 80);
  return visualRows(formatHelpPanel(commands, options), wrapWidth).length;
}

export function fitHelpPanelMaxItems(
  commands: readonly HelpPanelCommand[],
  options: {
    maxRows: number;
    width?: number;
    selectedIndex?: number;
    scrollOffset?: number;
  },
): number {
  if (commands.length === 0) return 1;

  const maxRows = Math.max(1, options.maxRows);
  let fitted = 1;
  for (let maxItems = 1; maxItems <= commands.length; maxItems++) {
    const rows = measureWorstHelpPanelRows(commands, {
      maxItems,
      width: options.width,
    });
    if (rows > maxRows) break;
    fitted = maxItems;
  }
  return fitted;
}

function measureWorstHelpPanelRows(
  commands: readonly HelpPanelCommand[],
  options: { maxItems: number; width?: number },
): number {
  const maxItems = Math.max(1, options.maxItems);
  const maxScroll = Math.max(0, commands.length - maxItems);
  let rows = 0;
  for (let scrollOffset = 0; scrollOffset <= maxScroll; scrollOffset++) {
    rows = Math.max(
      rows,
      measureHelpPanelRows(commands, {
        selectedIndex: scrollOffset,
        scrollOffset,
        maxItems,
        width: options.width,
      }),
    );
  }
  return rows;
}

export function formatHelpPanelSections(
  commands: readonly HelpPanelCommand[],
  options: { selectedIndex?: number; scrollOffset?: number; maxItems?: number } = {},
): HelpPanelSection[] {
  const selectedIndex = options.selectedIndex ?? 0;
  const scrollOffset = clamp(options.scrollOffset ?? 0, 0, Math.max(0, commands.length - 1));
  const maxItems = Math.max(0, options.maxItems ?? commands.length);
  const visibleCommands = commands.slice(scrollOffset, scrollOffset + maxItems);
  const sections = new Map<string, HelpPanelSection>();

  visibleCommands.forEach((command, visibleIndex) => {
    const commandIndex = scrollOffset + visibleIndex;
    const source = command.source ?? "unknown";
    const category = command.category ?? command.kind ?? "local";
    const title = `${source} / ${category}`;
    const section = sections.get(title) ?? { title, rows: [] };
    section.rows.push({
      key: `${source}:${category}:${command.name}:${commandIndex}`,
      commandIndex,
      usage: formatCommandUsage(command),
      description: truncateInline(
        command.description ?? "(no description)",
        HELP_PANEL_DESCRIPTION_WIDTH,
      ),
      aliases: formatAliases(command.aliases),
      disabled: command.disabled === true,
      disabledReason: command.disabledReason?.trim() ?? "",
      selected: commandIndex === selectedIndex,
    });
    sections.set(title, section);
  });

  return [...sections.values()];
}

export function updateHelpPanelScroll(
  state: HelpPanelScrollState,
  options: { delta: number; totalItems: number; pageSize: number },
): HelpPanelScrollState {
  if (options.totalItems <= 0) {
    return { selectedIndex: 0, scrollOffset: 0 };
  }

  const pageSize = Math.max(1, options.pageSize);
  const selectedIndex = clamp(state.selectedIndex + options.delta, 0, options.totalItems - 1);
  const scrollOffset = scrollOffsetForSelection(
    selectedIndex,
    state.scrollOffset,
    options.totalItems,
    pageSize,
  );

  return { selectedIndex, scrollOffset };
}

function helpPanelKeyDelta(
  key: {
    upArrow?: boolean;
    downArrow?: boolean;
    pageUp?: boolean;
    pageDown?: boolean;
  },
  pageSize: number,
): number {
  if (key.upArrow) return -1;
  if (key.downArrow) return 1;
  if (key.pageUp) return -pageSize;
  if (key.pageDown) return pageSize;
  return 0;
}

function normalizeHelpPanelScroll(
  state: HelpPanelScrollState,
  totalItems: number,
  pageSize: number,
): HelpPanelScrollState {
  if (totalItems <= 0) return { selectedIndex: 0, scrollOffset: 0 };

  const selectedIndex = clamp(state.selectedIndex, 0, totalItems - 1);
  return {
    selectedIndex,
    scrollOffset: scrollOffsetForSelection(selectedIndex, state.scrollOffset, totalItems, pageSize),
  };
}

function scrollOffsetForSelection(
  selectedIndex: number,
  scrollOffset: number,
  totalItems: number,
  pageSize: number,
): number {
  const maxScroll = Math.max(0, totalItems - pageSize);
  let nextOffset = clamp(scrollOffset, 0, maxScroll);
  if (selectedIndex < nextOffset) nextOffset = selectedIndex;
  if (selectedIndex >= nextOffset + pageSize) nextOffset = selectedIndex - pageSize + 1;
  return clamp(nextOffset, 0, maxScroll);
}

function formatHelpPanelRow(row: HelpPanelRow): string {
  const marker = row.selected ? "›" : " ";
  const disabled = row.disabled ? " [disabled]" : "";
  return `${marker} ${row.usage}${disabled}  ${row.description}`;
}

function formatCommandUsage(command: HelpPanelCommand): string {
  const explicitUsage = command.usage?.trim();
  if (explicitUsage) return truncateInline(explicitUsage, HELP_PANEL_COMMAND_WIDTH);
  const hint = command.argumentHint?.trim();
  const usage = hint ? `/${command.name} ${hint}` : `/${command.name}`;
  return truncateInline(usage, HELP_PANEL_COMMAND_WIDTH);
}

function formatAliases(aliases: readonly string[] | undefined): string {
  if (aliases === undefined || aliases.length === 0) return "";
  return aliases.map((alias) => `/${alias.replace(/^\/+/, "")}`).join(", ");
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 3))}...`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
