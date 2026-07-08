import React from "react";
import { Box, Text } from "ink";

export const MAX_SUGGESTIONS = 5;

export type SuggestionKind = "slash" | "mention";

export interface InputSuggestion {
  /** Candidate value without the leading "/" or "@". */
  value: string;
  /** Optional replacement text; defaults to value. */
  insertText?: string;
  /** Short help text rendered on the right. */
  description?: string;
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
          <Text color={row.selected ? "green" : "gray"}>
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
    return {
      key: `${session.kind}:${value}:${index}`,
      left: `${markerForKind(session.kind)}${value}`,
      description: item.description ?? "",
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
