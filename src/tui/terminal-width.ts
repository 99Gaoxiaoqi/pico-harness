import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function terminalWidth(text: string): number {
  return stringWidth(text);
}

export function truncateTerminalText(text: string, maxWidth: number): string {
  const width = Math.max(0, Math.floor(maxWidth));
  if (terminalWidth(text) <= width) return text;
  if (width === 0) return "";
  if (width === 1) return "…";

  let result = "";
  let resultWidth = 0;
  for (const { segment } of graphemeSegmenter.segment(text)) {
    const segmentWidth = terminalWidth(segment);
    if (resultWidth + segmentWidth > width - 1) break;
    result += segment;
    resultWidth += segmentWidth;
  }
  return `${result}…`;
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

export function wrappedVisualRows(text: string, wrapWidth: number): string[] {
  return wrapAnsi(text, normalizeWrapWidth(wrapWidth), {
    trim: false,
    hard: true,
  }).split("\n");
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width < 1) return 80;
  return Math.max(1, Math.floor(width));
}
