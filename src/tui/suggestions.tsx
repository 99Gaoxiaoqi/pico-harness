import React from "react";
import { Box, Text } from "ink";

export const MAX_SUGGESTIONS = 5;
export const SUGGESTION_LABEL_WIDTH = 32;
export const SUGGESTION_METADATA_WIDTH = 28;
export const SUGGESTION_DESCRIPTION_WIDTH = 38;

export type SuggestionKind = "slash" | "slash-argument" | "mention";

export interface InputSuggestion {
  /** Candidate value without the leading "/" or "@". */
  value: string;
  /** Optional replacement text; defaults to value. */
  insertText?: string;
  /** Short help text rendered on the right. */
  description?: string;
  /** Optional argument placeholder rendered after the command name. */
  argumentHint?: string;
  /** Optional usage string, usually including the command name. */
  usage?: string;
  /** Alias that matched the current slash-command query. */
  matchedAlias?: string;
  /** Alias associated with this slash command. */
  alias?: string;
  /** Optional slash command source tag. */
  source?: string;
  /** Optional slash command type tag. */
  kind?: string;
  /** Whether the suggestion is currently unavailable. */
  disabled?: boolean;
  /** Short reason shown when the suggestion is unavailable. */
  disabledReason?: string;
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
  metadata: string;
  description: string;
  selected: boolean;
  disabled?: boolean;
  disabledReason?: string;
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
          <Text
            color={row.disabled ? "gray" : row.selected ? "green" : "gray"}
            bold={row.selected && !row.disabled}
          >
            {row.selected ? "› " : "  "}
            {row.left}
          </Text>
          {row.metadata ? (
            <Text dimColor>
              {"  "}
              {row.metadata}
            </Text>
          ) : null}
          {row.description ? (
            <Text dimColor>
              {"  "}
              {row.description}
            </Text>
          ) : null}
          {row.disabledReason ? (
            <Text dimColor>
              {"  "}
              {row.disabledReason}
            </Text>
          ) : null}
        </Box>
      ))}
    </Box>
  );
}

export function formatSuggestionRows(session: ActiveSuggestionSession | null): SuggestionRow[] {
  if (!session) return [];

  return session.items.slice(0, MAX_SUGGESTIONS).map((item, index) => {
    const value = stripMarker(item.value, session.kind);
    const left = formatSuggestionLabel(item, session.kind);
    const metadata = formatSuggestionMetadata(item, session.kind);
    const description = formatSuggestionDescription(item);
    const disabled = item.disabled === true;
    const disabledReason = disabled ? formatDisabledReason(item) : "";
    return {
      key: `${session.kind}:${value}:${index}`,
      left: truncateInline(left, SUGGESTION_LABEL_WIDTH),
      metadata: truncateInline(metadata, SUGGESTION_METADATA_WIDTH),
      description: truncateInline(description, SUGGESTION_DESCRIPTION_WIDTH),
      selected: index === session.selectedIndex,
      ...(disabled ? { disabled: true } : {}),
      ...(disabledReason.length === 0
        ? {}
        : { disabledReason: truncateInline(disabledReason, SUGGESTION_DESCRIPTION_WIDTH) }),
    };
  });
}

export function markerForKind(kind: SuggestionKind): "/" | "@" | "" {
  if (kind === "slash") return "/";
  if (kind === "mention") return "@";
  return "";
}

export function stripMarker(value: string, kind: SuggestionKind): string {
  const marker = markerForKind(kind);
  if (marker.length === 0) return value;
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

function formatSuggestionLabel(item: InputSuggestion, kind: SuggestionKind): string {
  const value = stripMarker(item.value, kind);
  const label = `${markerForKind(kind)}${value}`;
  if (kind !== "slash") return label;

  const hint = formatUsageHint(item, value);
  return hint.length === 0 ? label : `${label} ${hint}`;
}

function formatSuggestionMetadata(item: InputSuggestion, kind: SuggestionKind): string {
  if (kind !== "slash") return "";

  const parts = [
    formatAliasTag(item.matchedAlias ?? item.alias),
    item.source?.trim() ?? "",
    item.kind?.trim() ?? "",
  ].filter((part) => part.length > 0);

  return parts.join(" · ");
}

function formatAliasTag(alias: string | undefined): string {
  if (alias === undefined) return "";
  const value = stripMarker(alias, "slash");
  return value.length === 0 ? "" : `alias /${value}`;
}

function formatSuggestionDescription(item: InputSuggestion): string {
  return item.description?.trim() ?? "";
}

function formatDisabledReason(item: InputSuggestion): string {
  return item.disabledReason?.trim() ?? "";
}

function formatUsageHint(item: InputSuggestion, value: string): string {
  const usage = item.usage?.trim();
  if (usage !== undefined && usage.length > 0) {
    const normalized = usage.replace(/\s+/g, " ");
    const prefix = `/${value}`;
    if (normalized === prefix || normalized === value) return "";
    if (normalized.startsWith(`${prefix} `)) return normalized.slice(prefix.length).trim();
    if (normalized.startsWith(`${value} `)) return normalized.slice(value.length).trim();
    return normalized;
  }

  return item.argumentHint?.trim() ?? "";
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
