import React from "react";
import { Box, Text } from "ink";
import type { CliSessionSummary } from "../cli/session-resolver.js";

export const SESSION_ID_DISPLAY_WIDTH = 35;
export const SESSION_CWD_DISPLAY_WIDTH = 48;

export interface SessionSelectorProps {
  sessions: readonly CliSessionSummary[];
  currentSessionId?: string;
  currentProjectCwd?: string;
  maxItems?: number;
}

export function SessionSelector({
  sessions,
  currentSessionId,
  currentProjectCwd,
  maxItems,
}: SessionSelectorProps): React.ReactNode {
  return (
    <Box flexDirection="column">
      {formatSessionSelector(sessions, {
        currentProjectCwd,
        currentSessionId,
        maxItems,
      })
        .split("\n")
        .map((line, index) => (
          <Text key={`${index}:${line}`}>{line}</Text>
        ))}
    </Box>
  );
}

export function formatSessionSelector(
  sessions: readonly CliSessionSummary[],
  options: {
    currentSessionId?: string;
    currentProjectCwd?: string;
    maxItems?: number;
  } = {},
): string {
  if (sessions.length === 0) {
    return "当前项目暂无可恢复 session。启动一次对话后会自动出现在这里。";
  }

  const maxItems = options.maxItems ?? 20;
  const currentProjectCwd = resolveCurrentProjectCwd(sessions, options);
  const ordered = orderSessionsForPicker(sessions, currentProjectCwd, options.currentSessionId);
  const visible = ordered.slice(0, maxItems);
  const lines = ["可恢复 sessions:"];
  for (const session of visible) {
    const isCurrent = session.id === options.currentSessionId;
    const isCurrentProject = sameProject(session.cwd, currentProjectCwd);
    const labels = [
      isCurrent ? "[current]" : undefined,
      isCurrentProject ? "[project]" : undefined,
    ].filter(Boolean);
    const labelText = labels.length > 0 ? ` ${labels.join(" ")}` : "";
    lines.push(
      [
        `- ${truncateInline(session.id, SESSION_ID_DISPLAY_WIDTH)}${labelText}`,
        `updated=${session.updatedAt.toISOString()}`,
        `messages=${session.messageCount}`,
        `cwd=${truncateInline(session.cwd, SESSION_CWD_DISPLAY_WIDTH)}`,
      ].join(" "),
    );
    lines.push(
      isCurrentProject
        ? `  use: /resume ${session.id}`
        : `  launch: cd ${formatCdTarget(session.cwd)} && pico --resume ${session.id}`,
    );
  }

  const hidden = sessions.length - visible.length;
  if (hidden > 0) lines.push(`... 已隐藏 ${hidden} 个更早 sessions`);
  return lines.join("\n");
}

function orderSessionsForPicker(
  sessions: readonly CliSessionSummary[],
  currentProjectCwd: string | undefined,
  currentSessionId: string | undefined,
): CliSessionSummary[] {
  return sessions
    .map((session, index) => ({ index, session }))
    .sort((a, b) => {
      const rankDiff =
        sessionRank(a.session, currentProjectCwd, currentSessionId) -
        sessionRank(b.session, currentProjectCwd, currentSessionId);
      return rankDiff || a.index - b.index;
    })
    .map((item) => item.session);
}

function sessionRank(
  session: CliSessionSummary,
  currentProjectCwd: string | undefined,
  currentSessionId: string | undefined,
): number {
  if (session.id === currentSessionId) return 0;
  return sameProject(session.cwd, currentProjectCwd) ? 1 : 2;
}

function resolveCurrentProjectCwd(
  sessions: readonly CliSessionSummary[],
  options: { currentSessionId?: string; currentProjectCwd?: string },
): string | undefined {
  const optionCwd = normalizeProjectCwd(options.currentProjectCwd);
  if (optionCwd) return optionCwd;

  const currentSessionCwd = normalizeProjectCwd(
    sessions.find((session) => session.id === options.currentSessionId)?.cwd,
  );
  if (currentSessionCwd) return currentSessionCwd;

  if (typeof process !== "undefined" && typeof process.cwd === "function") {
    return normalizeProjectCwd(process.cwd());
  }
  return undefined;
}

function sameProject(cwd: string, currentProjectCwd: string | undefined): boolean {
  return currentProjectCwd !== undefined && normalizeProjectCwd(cwd) === currentProjectCwd;
}

function normalizeProjectCwd(value: string | undefined): string | undefined {
  const inline = value?.replace(/\s+/g, " ").trim();
  if (!inline) return undefined;
  const normalized = inline.replace(/[\\/]+$/, "");
  return normalized.length > 0 ? normalized : inline;
}

function formatCdTarget(cwd: string): string {
  const inline = cwd.replace(/\s+/g, " ").trim();
  if (/^[A-Za-z0-9_./:@%+=,-]+$/.test(inline)) return inline;
  return `'${inline.replace(/'/g, "'\\''")}'`;
}

function truncateInline(value: string, maxLength: number): string {
  const inline = value.replace(/\s+/g, " ").trim();
  if (inline.length <= maxLength) return inline;
  return `${inline.slice(0, Math.max(0, maxLength - 1))}…`;
}
