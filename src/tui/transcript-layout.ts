import type { TuiEntry } from "./tui-reporter.js";
import { groupToolEntries } from "./tool-grouping.js";
import { buildToolCardVisualRows } from "./tool-card.js";
import { buildLogoPanelRows } from "./logo-panel.js";
import { buildErrorEntryRows } from "./message-row.js";
export { terminalWidth, visualRows } from "./terminal-width.js";
import { visualRows } from "./terminal-width.js";

export interface TranscriptLayoutOptions {
  wrapWidth: number;
  expandedToolKey?: string | null;
  approvalRows?: number;
}

export interface TranscriptLayoutItem {
  key: string;
  entry: TuiEntry;
  rows: number;
  separatorRows: number;
}

export interface TranscriptLayout {
  entries: TuiEntry[];
  items: TranscriptLayoutItem[];
  wrapWidth: number;
  contentRows: number;
  approvalRows: number;
  totalRows: number;
}

export function buildTranscriptLayout(
  sourceEntries: readonly TuiEntry[],
  options: TranscriptLayoutOptions,
): TranscriptLayout {
  const entries = groupToolEntries(sourceEntries.slice());
  const items = entries.map((entry, index) => {
    const key = transcriptEntryKey(entry, index);
    const separatorRows = entry.kind === "user" && index > 0 ? 1 : 0;
    return {
      key,
      entry,
      separatorRows,
      rows:
        separatorRows +
        entryRows(
          entry,
          options.wrapWidth,
          key === options.expandedToolKey && index === entries.length - 1,
          index === entries.length - 1,
        ),
    };
  });
  const contentRows = items.reduce((total, item) => total + item.rows, 0);
  const approvalRows = normalizeRows(options.approvalRows);

  return {
    entries,
    items,
    wrapWidth: normalizeWrapWidth(options.wrapWidth),
    contentRows,
    approvalRows,
    totalRows: contentRows + approvalRows,
  };
}

export function transcriptEntryKey(entry: TuiEntry, index: number): string {
  if (entry.kind === "tool") return `tool:${index}:${entry.name}:${entry.args}`;
  return `${entry.kind}:${index}`;
}

function entryRows(entry: TuiEntry, wrapWidth: number, expanded: boolean, isLast: boolean): number {
  if (entry.kind === "thinking") return 0;
  if (entry.kind === "tool") {
    return buildToolCardVisualRows({ ...entry, expanded, isLast, wrapWidth }).length;
  }
  if (entry.kind === "logo")
    return buildLogoPanelRows({ ...entry, renderWidth: wrapWidth }).length + 1;
  if (entry.kind === "error") return buildErrorEntryRows(entry, wrapWidth).length + 1;
  if (entry.kind === "skill") {
    const label = `Skill activated: ${entry.name}${entry.args ? ` ${entry.args}` : ""}`;
    return visualRows(label, wrapWidth).length + 1;
  }
  return visualRows(entry.content, wrapWidth).length + 1;
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width < 1) return 80;
  return Math.max(1, Math.floor(width));
}

function normalizeRows(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows) || rows < 0) return 0;
  return Math.floor(rows);
}
