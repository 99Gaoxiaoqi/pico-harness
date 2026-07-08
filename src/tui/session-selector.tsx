import React from "react";
import { Box, Text } from "ink";
import type { CliSessionSummary } from "../cli/session-resolver.js";

export const SESSION_ID_DISPLAY_WIDTH = 35;

export interface SessionSelectorProps {
  sessions: readonly CliSessionSummary[];
  currentSessionId?: string;
  maxItems?: number;
}

export function SessionSelector({
  sessions,
  currentSessionId,
  maxItems,
}: SessionSelectorProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatSessionSelector(sessions, { currentSessionId, maxItems })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function formatSessionSelector(
  sessions: readonly CliSessionSummary[],
  options: { currentSessionId?: string; maxItems?: number } = {},
): string {
  if (sessions.length === 0) {
    return "当前项目暂无可恢复 session。启动一次对话后会自动出现在这里。";
  }

  const maxItems = options.maxItems ?? 20;
  const visible = sessions.slice(0, maxItems);
  const lines = ["当前项目可恢复 sessions:"];
  for (const session of visible) {
    const current = session.id === options.currentSessionId ? " current" : "";
    lines.push(
      [
        `- ${truncateInline(session.id, SESSION_ID_DISPLAY_WIDTH)}${current}`,
        `updated=${session.updatedAt.toISOString()}`,
        `messages=${session.messageCount}`,
        `cwd=${session.cwd}`,
        `use=/resume ${session.id}`,
      ].join(" "),
    );
  }

  const hidden = sessions.length - visible.length;
  if (hidden > 0) lines.push(`... 已隐藏 ${hidden} 个更早 sessions`);
  return lines.join("\n");
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 1))}…`;
}
