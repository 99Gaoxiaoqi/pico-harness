import stringWidth from "string-width";
import type { TuiEntry } from "./tui-reporter.js";
import { groupToolEntries } from "./tool-grouping.js";

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

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function terminalWidth(text: string): number {
  return stringWidth(text);
}

export function visualRows(text: string, wrapWidth: number): string[] {
  const width = normalizeWrapWidth(wrapWidth);
  const rows: string[] = [];

  for (const logicalLine of text.split("\n")) {
    const graphemes = Array.from(graphemeSegmenter.segment(logicalLine), ({ segment }) => segment);
    if (graphemes.length === 0) {
      rows.push("");
      continue;
    }

    let row = "";
    let rowWidth = 0;
    for (const grapheme of graphemes) {
      const graphemeWidth = terminalWidth(grapheme);
      if (row && rowWidth + graphemeWidth > width) {
        rows.push(row);
        row = "";
        rowWidth = 0;
      }
      row += grapheme;
      rowWidth += graphemeWidth;
    }
    rows.push(row);
  }

  return rows.length > 0 ? rows : [""];
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
        separatorRows + entryRows(entry, options.wrapWidth, key === options.expandedToolKey),
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

function entryRows(entry: TuiEntry, wrapWidth: number, expanded: boolean): number {
  if (entry.kind === "thinking") return 1;
  if (entry.kind === "tool") return expanded ? expandedToolRows(entry, wrapWidth) : 1;
  return visualRows(entry.content, wrapWidth).length + 1;
}

function expandedToolRows(
  entry: Extract<TuiEntry, { kind: "tool" }>,
  wrapWidth: number,
): number {
  const detailWidth = Math.max(1, normalizeWrapWidth(wrapWidth) - 4);
  const argsRows = visualRows(`参数 ${entry.args}`, detailWidth).length;
  if (!entry.summary) return 1 + argsRows;
  const resultRows = visualRows(entry.summary, detailWidth).length;
  return 2 + argsRows + resultRows;
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width < 1) return 80;
  return Math.max(1, Math.floor(width));
}

function normalizeRows(rows: number | undefined): number {
  if (rows === undefined || !Number.isFinite(rows) || rows < 0) return 0;
  return Math.floor(rows);
}
