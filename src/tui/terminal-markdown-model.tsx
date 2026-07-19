import { stripVTControlCharacters } from "node:util";
import React from "react";
import { Box, Text } from "ink";
import { lexer, type Token, type Tokens } from "marked";
import wrapAnsi from "wrap-ansi";
import { isSafeMarkdownHref, sanitizeMarkdownText } from "@pico/protocol";
import { terminalWidth, truncateTerminalText } from "./terminal-width.js";

/**
 * The single semantic representation used by terminal Markdown rendering.
 *
 * Ink is intentionally only used by `render`.  `measure` and `clip` consume
 * the same marked token tree and the same terminal text projection, so a
 * virtual transcript never measures a different document than the one it
 * renders.  The model is immutable and cheap to recreate for a changed
 * streaming value; callers should memoize it when the content is stable.
 */
export class TerminalMarkdownModel {
  readonly content: string;
  readonly parsed: ParsedMarkdown;
  private readonly rowsByWidth = new Map<number, readonly StyledVisualRow[]>();

  constructor(content: string) {
    this.content = sanitizeTerminalText(content);
    this.parsed = parseMarkdown(this.content);
  }

  /** Render the token tree as Ink nodes. Width constrains the root when given. */
  render(width?: number, dimColor = false, startRow = 0, rows?: number): React.ReactNode {
    const normalizedWidth = normalizeWrapWidth(width ?? 80);
    const allRows = this.visualRows(normalizedWidth);
    const start = Math.max(0, Math.floor(Number.isFinite(startRow) ? startRow : 0));
    const end = rows === undefined ? undefined : start + Math.max(0, Math.floor(rows));
    const visualRows = allRows.slice(start, end);
    return (
      <Box flexDirection="column" width={normalizedWidth}>
        {visualRows.map((line, index) => (
          <Text key={`${start + index}:${line.text}`} dimColor={dimColor} wrap="truncate">
            {line.spans.length === 0
              ? " "
              : line.spans.map((span, spanIndex) => (
                  <Text
                    key={spanIndex}
                    bold={span.bold}
                    italic={span.italic}
                    underline={span.underline}
                    strikethrough={span.strikethrough}
                    color={span.color}
                  >
                    {span.text}
                  </Text>
                ))}
          </Text>
        ))}
      </Box>
    );
  }

  /** Number of terminal rows produced at the supplied content width. */
  measure(width: number): number {
    return this.visualRows(width).length;
  }

  /** Return the visual terminal rows in a viewport slice. */
  clip(startRow: number, rows: number | undefined, width: number): string[] {
    const allRows = this.visualRows(width);
    const start = Math.max(0, Math.floor(Number.isFinite(startRow) ? startRow : 0));
    const end = rows === undefined ? undefined : start + Math.max(0, Math.floor(rows));
    return allRows.slice(start, end).map((row) => row.text);
  }

  private visualRows(width: number): readonly StyledVisualRow[] {
    const normalizedWidth = normalizeWrapWidth(width);
    const cached = this.rowsByWidth.get(normalizedWidth);
    if (cached) return cached;
    // Render uses a literal space to allocate blank rows, while Ink's emitted
    // terminal line is empty. The IR therefore keeps the observable empty row.
    const projected = Object.freeze(markdownVisualRows(this.parsed, normalizedWidth));
    this.rowsByWidth.set(normalizedWidth, projected);
    return projected;
  }
}

export function createTerminalMarkdownModel(content: string): TerminalMarkdownModel {
  return new TerminalMarkdownModel(content);
}

type ParsedMarkdown = { kind: "tokens"; tokens: Token[] } | { kind: "fallback"; content: string };

interface InlineStyle {
  readonly bold?: boolean;
  readonly italic?: boolean;
  readonly underline?: boolean;
  readonly strikethrough?: boolean;
  readonly color?: "cyan" | "yellow" | "gray";
}

interface StyledSpan extends InlineStyle {
  readonly text: string;
}

interface StyledVisualRow {
  readonly text: string;
  readonly spans: readonly StyledSpan[];
}

function parseMarkdown(content: string): ParsedMarkdown {
  try {
    return { kind: "tokens", tokens: lexer(content, { gfm: true, breaks: false }) };
  } catch {
    // marked is tolerant of incomplete Markdown, but keep a plain-text
    // fallback for malformed custom extensions or a future parser failure.
    return { kind: "fallback", content };
  }
}

function isSafeLinkTarget(href: string): boolean {
  return isSafeMarkdownHref(href);
}

function tokenChildren(token: Token): Token[] | undefined {
  const children = (token as { tokens?: unknown }).tokens;
  return Array.isArray(children) ? (children as Token[]) : undefined;
}

function tokenText(token: Token): string {
  const text = (token as { text?: unknown }).text;
  return typeof text === "string" ? sanitizeTerminalText(text) : "";
}

/** Build the plain terminal projection used for both measuring and clipping. */
function markdownVisualRows(parsed: ParsedMarkdown, wrapWidth: number): StyledVisualRow[] {
  const normalizedWidth = normalizeWrapWidth(wrapWidth);
  if (parsed.kind === "fallback") {
    return wrapStyledSpans([{ text: parsed.content }], normalizedWidth);
  }
  const rows = parsed.tokens.flatMap((token) => visualRowsForBlock(token, normalizedWidth));
  return (rows.length > 0 ? rows : [visualRow("")]).map((row) =>
    truncateStyledRow(row, normalizedWidth),
  );
}

/**
 * Project one token to the rows Ink emits.  `Text wrap="wrap"` uses soft
 * word wrapping, and nested Boxes reduce the available width while applying
 * an x-offset to continuation rows; modelling those two details here keeps
 * measure/clip in lock-step with render for lists, quotes, and code blocks.
 */
function visualRowsForBlock(token: Token, width: number): StyledVisualRow[] {
  switch (token.type) {
    case "space":
      return [visualRow("")];
    case "hr":
      return wrapStyledSpans([{ text: "────────────", color: "gray" }], width);
    case "code": {
      const code = token as Tokens.Code;
      const lines = sanitizeTerminalText(code.text).split("\n");
      const prefix = width >= 3 ? "  " : "";
      const contentWidth = Math.max(1, width - terminalTextWidth(prefix));
      const rows = [...(code.lang ? [sanitizeTerminalText(code.lang)] : []), ...lines].flatMap(
        (line) => wrapStyledSpans([{ text: line, color: "cyan" }], contentWidth),
      );
      return rows.map((line) => prefixStyledRow(line, prefix));
    }
    case "heading":
      return wrapStyledSpans(
        inlineSpans((token as Tokens.Heading).tokens, { bold: true, color: "cyan" }),
        width,
      );
    case "paragraph":
      return wrapStyledSpans(inlineSpans((token as Tokens.Paragraph).tokens), width);
    case "text": {
      const text = token as Tokens.Text;
      return wrapStyledSpans(
        text.tokens ? inlineSpans(text.tokens) : [{ text: sanitizeTerminalText(text.text) }],
        width,
      );
    }
    case "blockquote": {
      const blockquote = token as Tokens.Blockquote;
      const quotePrefix = "│ ";
      const prefixWidth = terminalTextWidth(quotePrefix);
      const showPrefix = prefixWidth < width;
      const childRows = blockquote.tokens.flatMap((child) =>
        visualRowsForBlock(child, showPrefix ? width - prefixWidth : width),
      );
      if (!showPrefix) return childRows;
      return childRows.map((line, index) =>
        prefixStyledRow(line, index === 0 ? quotePrefix : " ".repeat(prefixWidth), {
          color: "gray",
        }),
      );
    }
    case "list": {
      const list = token as Tokens.List;
      const start = typeof list.start === "number" ? list.start : 1;
      return list.items.flatMap((item, index) => {
        const marker = item.task
          ? item.checked
            ? "☑"
            : "☐"
          : list.ordered
            ? `${start + index}.`
            : "•";
        const markerPrefix = `${marker} `;
        const prefixWidth = terminalTextWidth(markerPrefix);
        const showPrefix = prefixWidth < width;
        const childRows = item.tokens
          .filter((child) => child.type !== "checkbox")
          .flatMap((child) => visualRowsForBlock(child, showPrefix ? width - prefixWidth : width));
        if (childRows.length === 0) return [visualRow(showPrefix ? markerPrefix : "")];
        if (!showPrefix) return childRows;
        const indent = " ".repeat(prefixWidth);
        return childRows.map((line, childIndex) =>
          prefixStyledRow(line, childIndex === 0 ? markerPrefix : indent, { color: "cyan" }),
        );
      });
    }
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: readonly Tokens.TableCell[]) =>
        wrapStyledSpans(tableRowSpans(cells), width);
      return [
        ...row(table.header),
        ...wrapStyledSpans(
          [
            {
              text: `├${table.header.map((_, index) => `${index > 0 ? "┼" : ""}───`).join("")}┤`,
              color: "gray",
            },
          ],
          width,
        ),
        ...table.rows.flatMap((cells) => row(cells)),
      ];
    }
    case "html":
    case "def":
      return [];
    default: {
      const children = tokenChildren(token);
      if (children) return children.flatMap((child) => visualRowsForBlock(child, width));
      const text = tokenText(token);
      return text ? wrapStyledSpans([{ text }], width) : [];
    }
  }
}

function visualRow(text: string, spans: readonly StyledSpan[] = []): StyledVisualRow {
  const normalized = coalesceSpans(spans.length > 0 ? spans : text ? [{ text }] : []);
  return { text, spans: normalized };
}

function prefixStyledRow(
  row: StyledVisualRow,
  prefix: string,
  style: InlineStyle = {},
): StyledVisualRow {
  if (!prefix) return row;
  return visualRow(`${prefix}${row.text}`, [{ text: prefix, ...style }, ...row.spans]);
}

function truncateStyledRow(row: StyledVisualRow, width: number): StyledVisualRow {
  const text = truncateTerminalText(row.text, width);
  if (text === row.text) return row;
  const first = row.spans[0];
  const style: InlineStyle = first
    ? {
        bold: first.bold,
        italic: first.italic,
        underline: first.underline,
        strikethrough: first.strikethrough,
        color: first.color,
      }
    : {};
  return visualRow(text, text ? [{ text, ...style }] : []);
}

function wrapStyledSpans(input: readonly StyledSpan[], width: number): StyledVisualRow[] {
  const spans = coalesceSpans(
    input.flatMap((span) => {
      const text = sanitizeTerminalText(span.text);
      return text ? [{ ...span, text }] : [];
    }),
  );
  const text = spans.map((span) => span.text).join("");
  const rows = wrapTextRows(text, width);
  let cursor = 0;
  return rows.map((rowText) => {
    if (rowText === "") {
      if (text[cursor] === "\n") cursor++;
      return visualRow("");
    }
    const found = text.indexOf(rowText, cursor);
    const start = found >= cursor ? found : cursor;
    const end = start + rowText.length;
    cursor = end;
    return visualRow(rowText, sliceStyledSpans(spans, start, end));
  });
}

function sliceStyledSpans(spans: readonly StyledSpan[], start: number, end: number): StyledSpan[] {
  const sliced: StyledSpan[] = [];
  let offset = 0;
  for (const span of spans) {
    const spanStart = offset;
    const spanEnd = offset + span.text.length;
    offset = spanEnd;
    const overlapStart = Math.max(start, spanStart);
    const overlapEnd = Math.min(end, spanEnd);
    if (overlapStart >= overlapEnd) continue;
    sliced.push({
      ...span,
      text: span.text.slice(overlapStart - spanStart, overlapEnd - spanStart),
    });
  }
  return coalesceSpans(sliced);
}

function inlineSpans(tokens: readonly Token[], inherited: InlineStyle = {}): StyledSpan[] {
  return coalesceSpans(tokens.flatMap((token) => inlineTokenSpans(token, inherited)));
}

function inlineTokenSpans(token: Token, inherited: InlineStyle): StyledSpan[] {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens
        ? inlineSpans(text.tokens, inherited)
        : [{ text: sanitizeTerminalText(text.text), ...inherited }];
    }
    case "escape":
      return [{ text: sanitizeTerminalText((token as Tokens.Escape).text), ...inherited }];
    case "strong":
      return inlineSpans((token as Tokens.Strong).tokens, { ...inherited, bold: true });
    case "em":
      return inlineSpans((token as Tokens.Em).tokens, { ...inherited, italic: true });
    case "del":
      return inlineSpans((token as Tokens.Del).tokens, { ...inherited, strikethrough: true });
    case "codespan":
      return [
        {
          text: sanitizeTerminalText((token as Tokens.Codespan).text),
          ...inherited,
          color: "yellow",
        },
      ];
    case "br":
      return [{ text: "\n", ...inherited }];
    case "link": {
      const link = token as Tokens.Link;
      const href = sanitizeTerminalText(link.href).trim();
      return [
        ...inlineSpans(link.tokens, { ...inherited, color: "cyan", underline: true }),
        ...(isSafeLinkTarget(href)
          ? [{ text: ` (${href})`, ...inherited, color: "gray" as const }]
          : []),
      ];
    }
    case "image":
      return [
        {
          text: `[图片: ${sanitizeTerminalText((token as Tokens.Image).text) || "未命名"}]`,
          ...inherited,
          color: "yellow",
        },
      ];
    case "html":
      return [];
    default: {
      const children = tokenChildren(token);
      return children
        ? inlineSpans(children, inherited)
        : [{ text: tokenText(token), ...inherited }];
    }
  }
}

function tableRowSpans(cells: readonly Tokens.TableCell[]): StyledSpan[] {
  return coalesceSpans([
    { text: "│ ", color: "gray" },
    ...cells.flatMap((cell, index) => [
      ...(index > 0 ? ([{ text: " │ ", color: "gray" }] satisfies StyledSpan[]) : []),
      ...inlineSpans(cell.tokens),
    ]),
    { text: " │", color: "gray" },
  ]);
}

function coalesceSpans(spans: readonly StyledSpan[]): StyledSpan[] {
  const result: StyledSpan[] = [];
  for (const span of spans) {
    if (!span.text) continue;
    const previous = result.at(-1);
    if (previous && sameStyle(previous, span)) {
      result[result.length - 1] = { ...previous, text: previous.text + span.text };
    } else {
      result.push(span);
    }
  }
  return result;
}

function sameStyle(left: InlineStyle, right: InlineStyle): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.underline === right.underline &&
    left.strikethrough === right.strikethrough &&
    left.color === right.color
  );
}

function wrapTextRows(text: string, width: number): string[] {
  const normalizedWidth = normalizeWrapWidth(width);
  return sanitizeTerminalText(text)
    .split("\n")
    .flatMap((line) => {
      if (line.length === 0) return [""];
      return wrapAnsi(line, normalizedWidth, { trim: false, hard: true })
        .split("\n")
        .map((row) => row.trimEnd());
    });
}

function terminalTextWidth(text: string): number {
  return terminalWidth(text);
}

/** Remove ANSI/OSC sequences and non-printing controls, preserving Markdown newlines. */
export function sanitizeTerminalText(content: string): string {
  return sanitizeMarkdownText(stripVTControlCharacters(content));
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width < 1) return 80;
  return Math.max(1, Math.floor(width));
}
