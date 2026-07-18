import { stripVTControlCharacters } from "node:util";
import React from "react";
import { Box, Text } from "ink";
import { lexer, type Token, type Tokens } from "marked";
import wrapAnsi from "wrap-ansi";
import { isSafeMarkdownHref, sanitizeMarkdownText } from "@pico/protocol";
import { terminalWidth, truncateTerminalText, visualRows } from "./terminal-width.js";

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

  constructor(content: string) {
    this.content = sanitizeTerminalText(content);
    this.parsed = parseMarkdown(this.content);
  }

  /** Render the token tree as Ink nodes. Width constrains the root when given. */
  render(width?: number, dimColor = false): React.ReactNode {
    if (this.parsed.kind === "fallback") {
      return (
        <Text dimColor={dimColor} wrap="wrap">
          {this.parsed.content}
        </Text>
      );
    }

    const normalizedWidth = width === undefined ? undefined : normalizeWrapWidth(width);
    // Very narrow Ink flex layouts can insert an extra blank row when marker
    // and child boxes overflow by one cell. Use the already-derived visual
    // rows as plain terminal lines in that regime so the render contract
    // remains exact (and the transcript can still scroll deterministically).
    if (normalizedWidth !== undefined && normalizedWidth < 16) {
      return (
        <Box flexDirection="column" width={normalizedWidth}>
          {markdownVisualRows(this.parsed, normalizedWidth).map((line, index) => (
            <Text key={`narrow-${index}`} dimColor={dimColor} wrap="truncate">
              {line}
            </Text>
          ))}
        </Box>
      );
    }
    return (
      <Box flexDirection="column" width={normalizedWidth}>
        {this.parsed.tokens.map((token, index) =>
          renderBlock(token, `${token.type}-${index}`, dimColor),
        )}
      </Box>
    );
  }

  /** Number of terminal rows produced at the supplied content width. */
  measure(width: number): number {
    return markdownVisualRows(this.parsed, width).length;
  }

  /** Return the visual terminal rows in a viewport slice. */
  clip(startRow: number, rows: number | undefined, width: number): string[] {
    const allRows = markdownVisualRows(this.parsed, width);
    const start = Math.max(0, Math.floor(Number.isFinite(startRow) ? startRow : 0));
    const end = rows === undefined ? undefined : start + Math.max(0, Math.floor(rows));
    return allRows.slice(start, end);
  }
}

export function createTerminalMarkdownModel(content: string): TerminalMarkdownModel {
  return new TerminalMarkdownModel(content);
}

type ParsedMarkdown = { kind: "tokens"; tokens: Token[] } | { kind: "fallback"; content: string };

function parseMarkdown(content: string): ParsedMarkdown {
  try {
    return { kind: "tokens", tokens: lexer(content, { gfm: true, breaks: false }) };
  } catch {
    // marked is tolerant of incomplete Markdown, but keep a plain-text
    // fallback for malformed custom extensions or a future parser failure.
    return { kind: "fallback", content };
  }
}

function renderBlock(token: Token, key: string, dimColor: boolean): React.ReactNode {
  switch (token.type) {
    case "space":
      return <Text key={key}> </Text>;
    case "hr":
      return (
        <Text key={key} dimColor>
          ────────────
        </Text>
      );
    case "code":
      return renderCode(token as Tokens.Code, key, dimColor);
    case "heading": {
      const heading = token as Tokens.Heading;
      return (
        <Text key={key} bold color={dimColor ? undefined : "cyan"} dimColor={dimColor} wrap="wrap">
          {renderInlines(heading.tokens, dimColor, key)}
        </Text>
      );
    }
    case "paragraph": {
      const paragraph = token as Tokens.Paragraph;
      return (
        <Text key={key} dimColor={dimColor} wrap="wrap">
          {renderInlines(paragraph.tokens, dimColor, key)}
        </Text>
      );
    }
    case "text": {
      const text = token as Tokens.Text;
      return (
        <Text key={key} dimColor={dimColor} wrap="wrap">
          {text.tokens
            ? renderInlines(text.tokens, dimColor, key)
            : sanitizeTerminalText(text.text)}
        </Text>
      );
    }
    case "blockquote": {
      const blockquote = token as Tokens.Blockquote;
      return (
        <Box key={key} flexDirection="row">
          <Text dimColor={dimColor} color={dimColor ? undefined : "gray"}>
            │{" "}
          </Text>
          <Box flexDirection="column">
            {blockquote.tokens.map((child, index) =>
              renderBlock(child, `${key}-${child.type}-${index}`, dimColor),
            )}
          </Box>
        </Box>
      );
    }
    case "list":
      return renderList(token as Tokens.List, key, dimColor);
    case "table":
      return renderTable(token as Tokens.Table, key, dimColor);
    case "html":
    case "def":
      // Never pass HTML to a renderer and never echo tags or script content.
      return null;
    default:
      return renderUnknownBlock(token, key, dimColor);
  }
}

function renderCode(token: Tokens.Code, key: string, dimColor: boolean): React.ReactNode {
  return (
    <Box key={key} marginLeft={2} flexDirection="column">
      {token.lang && (
        <Text dimColor={dimColor} color="gray">
          {token.lang}
        </Text>
      )}
      <Text dimColor={dimColor} color="cyan" wrap="wrap">
        {sanitizeTerminalText(token.text)}
      </Text>
    </Box>
  );
}

function renderList(token: Tokens.List, key: string, dimColor: boolean): React.ReactNode {
  const start = typeof token.start === "number" ? token.start : 1;
  return (
    <Box key={key} flexDirection="column">
      {token.items.map((item, index) => {
        const marker = item.task
          ? item.checked
            ? "☑"
            : "☐"
          : token.ordered
            ? `${start + index}.`
            : "•";
        const children = item.tokens.filter((child) => child.type !== "checkbox");
        return (
          <Box key={`${key}-item-${index}`} flexDirection="row">
            <Text dimColor={dimColor}>{marker} </Text>
            <Box flexDirection="column" flexGrow={1}>
              {children.map((child, childIndex) =>
                renderBlock(child, `${key}-item-${index}-${child.type}-${childIndex}`, dimColor),
              )}
            </Box>
          </Box>
        );
      })}
    </Box>
  );
}

function renderTable(token: Tokens.Table, key: string, dimColor: boolean): React.ReactNode {
  return (
    <Box key={key} flexDirection="column">
      <Text dimColor={dimColor} wrap="wrap">
        │{" "}
        {token.header.map((cell, index) => (
          <React.Fragment key={`${key}-header-${index}`}>
            {index > 0 && " │ "}
            <Text bold>{renderInlines(cell.tokens, dimColor, `${key}-header-${index}`)}</Text>
          </React.Fragment>
        ))}
        {" │"}
      </Text>
      <Text dimColor>
        ├{token.header.map((_, index) => `${index > 0 ? "┼" : ""}───`).join("")}┤
      </Text>
      {token.rows.map((row, rowIndex) => (
        <Text key={`${key}-row-${rowIndex}`} dimColor={dimColor} wrap="wrap">
          │{" "}
          {row.map((cell, cellIndex) => (
            <React.Fragment key={`${key}-row-${rowIndex}-${cellIndex}`}>
              {cellIndex > 0 && " │ "}
              {renderInlines(cell.tokens, dimColor, `${key}-row-${rowIndex}-${cellIndex}`)}
            </React.Fragment>
          ))}
          {" │"}
        </Text>
      ))}
    </Box>
  );
}

function renderUnknownBlock(token: Token, key: string, dimColor: boolean): React.ReactNode {
  const children = tokenChildren(token);
  if (children) {
    return (
      <Box key={key} flexDirection="column">
        {children.map((child, index) =>
          renderBlock(child, `${key}-${child.type}-${index}`, dimColor),
        )}
      </Box>
    );
  }
  const text = tokenText(token);
  return text ? (
    <Text key={key} dimColor={dimColor} wrap="wrap">
      {text}
    </Text>
  ) : null;
}

function renderInlines(
  tokens: readonly Token[],
  dimColor: boolean,
  keyPrefix: string,
): React.ReactNode {
  return tokens.map((token, index) => {
    const key = `${keyPrefix}-inline-${token.type}-${index}`;
    switch (token.type) {
      case "text":
        return (token as Tokens.Text).tokens ? (
          <React.Fragment key={key}>
            {renderInlines((token as Tokens.Text).tokens!, dimColor, key)}
          </React.Fragment>
        ) : (
          sanitizeTerminalText((token as Tokens.Text).text)
        );
      case "escape":
        return sanitizeTerminalText((token as Tokens.Escape).text);
      case "strong": {
        const strong = token as Tokens.Strong;
        return (
          <Text key={key} bold dimColor={dimColor}>
            {renderInlines(strong.tokens, dimColor, key)}
          </Text>
        );
      }
      case "em": {
        const emphasis = token as Tokens.Em;
        return (
          <Text key={key} italic dimColor={dimColor}>
            {renderInlines(emphasis.tokens, dimColor, key)}
          </Text>
        );
      }
      case "del": {
        const deletion = token as Tokens.Del;
        return (
          <Text key={key} strikethrough dimColor={dimColor}>
            {renderInlines(deletion.tokens, dimColor, key)}
          </Text>
        );
      }
      case "codespan":
        return (
          <Text key={key} color={dimColor ? undefined : "yellow"} dimColor={dimColor}>
            {sanitizeTerminalText((token as Tokens.Codespan).text)}
          </Text>
        );
      case "br":
        return "\n";
      case "link":
        return renderLink(token as Tokens.Link, key, dimColor);
      case "image":
        return (
          <Text key={key} dimColor={dimColor}>
            [图片: {sanitizeTerminalText((token as Tokens.Image).text) || "未命名"}]
          </Text>
        );
      case "html":
        return null;
      default:
        if (tokenChildren(token)) {
          return (
            <React.Fragment key={key}>
              {renderInlines(tokenChildren(token)!, dimColor, key)}
            </React.Fragment>
          );
        }
        return tokenText(token) || null;
    }
  });
}

function renderLink(token: Tokens.Link, key: string, dimColor: boolean): React.ReactNode {
  const label = renderInlines(token.tokens, dimColor, key);
  const href = sanitizeTerminalText(token.href).trim();
  if (!isSafeLinkTarget(href)) return <React.Fragment key={key}>{label}</React.Fragment>;

  return (
    <Text key={key} underline color={dimColor ? undefined : "cyan"} dimColor={dimColor}>
      {label} ({href})
    </Text>
  );
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
function markdownVisualRows(parsed: ParsedMarkdown, wrapWidth: number): string[] {
  const normalizedWidth = normalizeWrapWidth(wrapWidth);
  if (parsed.kind === "fallback") {
    const rows = wrapTextRows(parsed.content, normalizedWidth);
    return normalizedWidth < 16
      ? rows.map((row) => truncateTerminalText(row, normalizedWidth))
      : rows;
  }
  const rows = parsed.tokens.flatMap((token) => visualRowsForBlock(token, normalizedWidth));
  if (normalizedWidth < 16) {
    return (rows.length > 0 ? rows : [""]).map((row) => truncateTerminalText(row, normalizedWidth));
  }
  return rows.length > 0 ? rows : [""];
}

/**
 * Project one token to the rows Ink emits.  `Text wrap="wrap"` uses soft
 * word wrapping, and nested Boxes reduce the available width while applying
 * an x-offset to continuation rows; modelling those two details here keeps
 * measure/clip in lock-step with render for lists, quotes, and code blocks.
 */
function visualRowsForBlock(token: Token, width: number, listDepth = 0): string[] {
  switch (token.type) {
    case "space":
      return [""];
    case "hr":
      return wrapTextRows("────────────", width);
    case "code": {
      const code = token as Tokens.Code;
      const lines = sanitizeTerminalText(code.text).split("\n");
      const contentWidth = Math.max(1, width - 2);
      const rows = [...(code.lang ? [sanitizeTerminalText(code.lang)] : []), ...lines].flatMap(
        (line) => wrapTextRows(line, contentWidth),
      );
      return rows.map((line) => `  ${line}`);
    }
    case "heading":
      return wrapTextRows(inlineText((token as Tokens.Heading).tokens), width);
    case "paragraph":
      return wrapTextRows(inlineText((token as Tokens.Paragraph).tokens), width);
    case "text": {
      const text = token as Tokens.Text;
      return wrapTextRows(text.tokens ? inlineText(text.tokens) : text.text, width);
    }
    case "blockquote": {
      const blockquote = token as Tokens.Blockquote;
      const childRows = blockquote.tokens.flatMap((child) =>
        visualRowsForBlock(child, Math.max(1, width - 2)),
      );
      return childRows.map((line, index) => `${index === 0 ? "│ " : "  "}${line}`);
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
        const childRows = item.tokens
          .filter((child) => child.type !== "checkbox")
          .flatMap((child) =>
            visualRowsForBlock(
              child,
              Math.max(1, width - terminalTextWidth(`${marker} `) + (listDepth === 0 ? 1 : 0)),
              child.type === "list" ? listDepth + 1 : listDepth,
            ),
          );
        if (childRows.length === 0) return [`${marker} `];
        const indent = " ".repeat(terminalTextWidth(`${marker} `));
        return childRows.map((line, childIndex) =>
          childIndex === 0 ? `${marker} ${line}` : `${indent}${line}`,
        );
      });
    }
    case "table": {
      const table = token as Tokens.Table;
      const row = (cells: readonly Tokens.TableCell[]) =>
        `│ ${cells.map((cell) => inlineText(cell.tokens)).join(" │ ")} │`;
      return [
        row(table.header),
        `├${table.header.map((_, index) => `${index > 0 ? "┼" : ""}───`).join("")}┤`,
        ...table.rows.map((cells) => row(cells)),
      ].flatMap((line) => wrapTextRows(line, width));
    }
    case "html":
    case "def":
      return [];
    default: {
      const children = tokenChildren(token);
      if (children) return children.flatMap((child) => visualRowsForBlock(child, width));
      const text = tokenText(token);
      return text ? wrapTextRows(text, width) : [];
    }
  }
}

function wrapTextRows(text: string, width: number): string[] {
  const normalizedWidth = normalizeWrapWidth(width);
  return sanitizeTerminalText(text)
    .split("\n")
    .flatMap((line) => {
      if (line.length === 0) return [""];
      return wrapAnsi(line, normalizedWidth, { trim: false, hard: false })
        .split("\n")
        .flatMap((row) => {
          const trimmed = row.trimEnd();
          // Ink keeps an over-wide word intact when it contains spaces, but
          // hard-wraps an unbreakable token (URLs, CJK runs, code symbols).
          return terminalWidth(trimmed) > normalizedWidth && !/\s/u.test(trimmed)
            ? visualRows(trimmed, normalizedWidth)
            : [trimmed];
        });
    });
}

function terminalTextWidth(text: string): number {
  return terminalWidth(text);
}

function inlineText(tokens: readonly Token[]): string {
  return tokens.map((token) => inlineTokenText(token)).join("");
}

function inlineTokenText(token: Token): string {
  switch (token.type) {
    case "text": {
      const text = token as Tokens.Text;
      return text.tokens ? inlineText(text.tokens) : sanitizeTerminalText(text.text);
    }
    case "escape":
      return sanitizeTerminalText((token as Tokens.Escape).text);
    case "strong":
      return inlineText((token as Tokens.Strong).tokens);
    case "em":
      return inlineText((token as Tokens.Em).tokens);
    case "del":
      return inlineText((token as Tokens.Del).tokens);
    case "codespan":
      return sanitizeTerminalText((token as Tokens.Codespan).text);
    case "br":
      return "\n";
    case "link": {
      const link = token as Tokens.Link;
      const href = sanitizeTerminalText(link.href).trim();
      return `${inlineText(link.tokens)}${isSafeLinkTarget(href) ? ` (${href})` : ""}`;
    }
    case "image":
      return `[图片: ${sanitizeTerminalText((token as Tokens.Image).text) || "未命名"}]`;
    case "html":
      return "";
    default: {
      const children = tokenChildren(token);
      return children ? inlineText(children) : tokenText(token);
    }
  }
}

/** Remove ANSI/OSC sequences and non-printing controls, preserving Markdown newlines. */
export function sanitizeTerminalText(content: string): string {
  return sanitizeMarkdownText(stripVTControlCharacters(content));
}

function normalizeWrapWidth(width: number): number {
  if (!Number.isFinite(width) || width < 1) return 80;
  return Math.max(1, Math.floor(width));
}
