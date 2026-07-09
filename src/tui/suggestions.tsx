import React from "react";
import { Box, Text } from "ink";

export const MAX_SUGGESTIONS = 5;
export const SUGGESTION_LABEL_WIDTH = 32;
export const SUGGESTION_DESCRIPTION_WIDTH = 38;

export type SuggestionKind = "slash" | "mention";

export interface InputSuggestion {
  /** Candidate value without the leading "/" or "@". */
  value: string;
  /** Optional replacement text; defaults to value. */
  insertText?: string;
  /** Short help text rendered on the right. */
  description?: string;
  /** Optional argument placeholder rendered after the description. */
  argumentHint?: string;
  /** Alias that matched the current slash-command query. */
  matchedAlias?: string;
}

export interface ActiveSuggestionSession {
  kind: SuggestionKind;
  query: string;
  replaceStart: number;
  replaceEnd: number;
  selectedIndex: number;
  items: InputSuggestion[];
}

export interface SuggestionRow {
  key: string;
  left: string;
  description: string;
  selected: boolean;
}

export interface SuggestionListProps {
  session: ActiveSuggestionSession | null;
}

export function SuggestionList({ session }: SuggestionListProps): React.ReactNode {
  const rows = formatSuggestionRows(session);
  if (rows.length === 0) return null;

  return (
    <Box flexDirection="column" marginLeft={2}>
      {rows.map((row) => (
        <Box key={row.key}>
          <Text color={row.selected ? "green" : "gray"} bold={row.selected}>
            {row.selected ? "› " : "  "}
            {row.left}
          </Text>
          {row.description ? <Text dimColor>  {row.description}</Text> : null}
        </Box>
      ))}
    </Box>
  );
}

export function formatSuggestionRows(
  session: ActiveSuggestionSession | null,
): SuggestionRow[] {
  if (!session) return [];

  return session.items.slice(0, MAX_SUGGESTIONS).map((item, index) => {
    const value = stripMarker(item.value, session.kind);
    const description = formatSuggestionDescription(item, session.kind);
    return {
      key: `${session.kind}:${value}:${index}`,
      left: truncateInline(`${markerForKind(session.kind)}${value}`, SUGGESTION_LABEL_WIDTH),
      description: truncateInline(description, SUGGESTION_DESCRIPTION_WIDTH),
      selected: index === session.selectedIndex,
    };
  });
}

export function markerForKind(kind: SuggestionKind): "/" | "@" {
  return kind === "slash" ? "/" : "@";
}

export function stripMarker(value: string, kind: SuggestionKind): string {
  const marker = markerForKind(kind);
  return value.startsWith(marker) ? value.slice(1) : value;
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (displayWidth(inline) <= maxLength) return inline;

  let result = "";
  let width = 0;
  const maxTextWidth = Math.max(0, maxLength - 1);
  for (const char of inline) {
    const charWidth = displayWidth(char);
    if (width + charWidth > maxTextWidth) break;
    result += char;
    width += charWidth;
  }

  return `${result}…`;
}

function formatSuggestionDescription(
  item: InputSuggestion,
  kind: SuggestionKind,
): string {
  const detail = formatDescriptionDetail(item);
  if (kind !== "slash" || item.matchedAlias === undefined) {
    return detail;
  }

  const alias = stripMarker(item.matchedAlias, "slash");
  const source = `alias /${alias}`;
  return detail.length === 0 ? source : `${source} · ${detail}`;
}

function formatDescriptionDetail(item: InputSuggestion): string {
  const description = item.description?.trim() ?? "";
  const argumentHint = item.argumentHint?.trim() ?? "";
  if (argumentHint.length === 0) return description;
  if (description.length === 0) return argumentHint;
  return `${description} ${argumentHint}`;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const char of value) {
    width += isWideCharacter(char) ? 2 : 1;
  }
  return width;
}

function isWideCharacter(char: string): boolean {
  const codePoint = char.codePointAt(0) ?? 0;
  return (
    (codePoint >= 0x1100 && codePoint <= 0x115f) ||
    (codePoint >= 0x2e80 && codePoint <= 0xa4cf) ||
    (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
    (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
    (codePoint >= 0xff01 && codePoint <= 0xff60) ||
    (codePoint >= 0xffe0 && codePoint <= 0xffe6)
  );
}
